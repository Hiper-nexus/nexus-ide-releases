import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { createScopedMissionStore } from '../orch/mission-store';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMediaUsageStore } from './media-usage-store';
import { recordMediaUsage } from './media-usage-recorder';
import {
  configureProjectUsageStoreRegistry,
  disposeProjectUsageStoreRegistry,
} from './usage-store-registry';

let sqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as new (file: string) => {
    close(): void;
  };
  new Database(':memory:').close();
} catch {
  sqliteAvailable = false;
}

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function fixture(): { baseDir: string; scope: ProjectExecutionScope } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-'));
  roots.push(parent);
  const checkout = path.join(parent, 'checkout');
  fs.mkdirSync(checkout);
  return {
    baseDir: path.join(parent, 'runtime'),
    scope: Object.freeze({
      version: 1,
      installationId: 'install-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: fs.realpathSync(checkout),
      identitySource: 'manifest',
    }),
  };
}

function manager(baseDir: string): ProjectRuntimeManager {
  const runtimeManager = new ProjectRuntimeManager({
    baseDir,
    appVersion: 'media-test',
  });
  managers.push(runtimeManager);
  return runtimeManager;
}

afterEach(() => {
  disposeProjectUsageStoreRegistry();
  vi.restoreAllMocks();
  for (const runtimeManager of managers.splice(0)) runtimeManager.closeAll();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!sqliteAvailable)('ScopedMediaUsageStore', () => {
  it('isolates project checkouts and persists totals across restart', () => {
    const { baseDir, scope } = fixture();
    const checkoutBPath = path.join(
      path.dirname(scope.rootRealPath),
      'checkout-b',
    );
    fs.mkdirSync(checkoutBPath);
    const checkoutB: ProjectExecutionScope = Object.freeze({
      ...scope,
      checkoutId: 'checkout-b',
      rootRealPath: fs.realpathSync(checkoutBPath),
    });
    const firstManager = manager(baseDir);
    createScopedMediaUsageStore(firstManager, scope).record({
      kind: 'image',
      provider: 'openai-image',
      model: 'gpt-image-1',
      storageKey: 'assets/a.png',
      sha256: 'a'.repeat(64),
      costUsd: 0.04,
      durationMs: 500,
    });
    createScopedMediaUsageStore(firstManager, checkoutB).record({
      kind: 'audio',
      provider: 'elevenlabs',
      model: 'eleven-v3',
      storageKey: 'assets/b.mp3',
      sha256: 'b'.repeat(64),
      costUsd: 0.01,
      durationMs: 300,
    });
    expect(createScopedMediaUsageStore(firstManager, scope).totals()).toEqual({
      generations: 1,
      costUsd: 0.04,
    });
    expect(
      createScopedMediaUsageStore(firstManager, checkoutB).totals(),
    ).toEqual({ generations: 1, costUsd: 0.01 });
    firstManager.closeAll();
    managers.splice(managers.indexOf(firstManager), 1);

    expect(
      createScopedMediaUsageStore(manager(baseDir), scope).totals(),
    ).toEqual({
      generations: 1,
      costUsd: 0.04,
    });
  });

  it('accounts a generated file by relative storage key and content hash', async () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    configureProjectUsageStoreRegistry(runtimeManager);
    const mediaPath = path.join(scope.rootRealPath, 'artifact.png');
    fs.writeFileSync(mediaPath, 'real-media-bytes');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await recordMediaUsage(
      {
        ok: true,
        path: mediaPath,
        provider: 'openai-image',
        model: 'gpt-image-1',
        kind: 'image',
        estimatedCostUsd: 0.02,
        durationMs: 42,
      },
      {
        label: 'worker',
        scope,
      },
    );

    const row = runtimeManager
      .open(scope)
      .db.prepare(
        'SELECT storage_key, sha256, metadata_json FROM media_artifacts',
      )
      .get() as {
      storage_key: string;
      sha256: string;
      metadata_json: string;
    };
    expect(row.storage_key).toBe('artifact.png');
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.metadata_json).not.toContain(scope.rootRealPath);
  });

  it('does not commit usage when authority is revoked during artifact hashing', async () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    configureProjectUsageStoreRegistry(runtimeManager);
    const mediaPath = path.join(scope.rootRealPath, 'revoked.png');
    fs.writeFileSync(mediaPath, 'bytes-read-before-revocation');
    let checkpoints = 0;

    await expect(
      recordMediaUsage(
        {
          ok: true,
          path: mediaPath,
          provider: 'openai-image',
          model: 'gpt-image-1',
          kind: 'image',
          estimatedCostUsd: 0.02,
          durationMs: 42,
        },
        { label: 'worker', scope },
        {
          assertCurrentAuthority: () => {
            checkpoints += 1;
            if (checkpoints >= 9) {
              throw new Error('session_authority_revoked');
            }
          },
        },
      ),
    ).rejects.toThrow('session_authority_revoked');

    expect(checkpoints).toBeGreaterThanOrEqual(9);
    expect(createScopedMediaUsageStore(runtimeManager, scope).totals()).toEqual(
      {
        generations: 0,
        costUsd: 0,
      },
    );
  });

  it('enforces mission foreign keys and computes mission-only totals', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Media mission',
    });
    const store = createScopedMediaUsageStore(runtimeManager, scope);
    store.record({
      kind: 'video',
      provider: 'replicate-video',
      model: 'seedance',
      storageKey: 'video/out.mp4',
      sha256: 'c'.repeat(64),
      costUsd: 0.5,
      durationMs: 1_000,
      missionId: mission.id,
    });
    expect(store.totalsByMission(mission.id)).toEqual({
      generations: 1,
      costUsd: 0.5,
    });
  });

  it('rejects escaped, symlinked and hardlinked generated artifacts', async () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    configureProjectUsageStoreRegistry(runtimeManager);
    const outside = path.join(path.dirname(scope.rootRealPath), 'outside.png');
    fs.writeFileSync(outside, 'outside');
    const symlink = path.join(scope.rootRealPath, 'link.png');
    fs.symlinkSync(outside, symlink);
    const original = path.join(scope.rootRealPath, 'original.png');
    const hardlink = path.join(scope.rootRealPath, 'hardlink.png');
    fs.writeFileSync(original, 'linked');
    fs.linkSync(original, hardlink);
    const result = (candidate: string) => ({
      ok: true as const,
      path: candidate,
      provider: 'openai-image' as const,
      model: 'gpt-image-1',
      kind: 'image' as const,
      estimatedCostUsd: 0.02,
      durationMs: 1,
    });
    const ctx = { label: 'worker', scope };

    await expect(recordMediaUsage(result(outside), ctx)).rejects.toThrow(
      /escapes/i,
    );
    await expect(recordMediaUsage(result(symlink), ctx)).rejects.toThrow();
    await expect(recordMediaUsage(result(hardlink), ctx)).rejects.toThrow(
      /safe regular file/i,
    );
    expect(createScopedMediaUsageStore(runtimeManager, scope).totals()).toEqual(
      {
        generations: 0,
        costUsd: 0,
      },
    );
  });

  it('rejects absolute/escaping keys and fails closed on read-only runtime', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const store = createScopedMediaUsageStore(runtimeManager, scope);
    const base = {
      kind: 'image',
      provider: 'openai-image',
      model: 'gpt-image-1',
      sha256: 'd'.repeat(64),
      costUsd: null,
      durationMs: 1,
    };
    expect(() =>
      store.record({ ...base, storageKey: '../escape.png' }),
    ).toThrow(/project-relative/i);
    expect(() =>
      store.record({ ...base, storageKey: path.join(scope.rootRealPath, 'x') }),
    ).toThrow(/relative/i);

    const unavailableManager = {
      open: () => ({
        assertWritable: () => {
          throw new Error('safe read-only mode');
        },
        db: null,
      }),
    } as unknown as ProjectRuntimeManager;
    expect(() =>
      createScopedMediaUsageStore(unavailableManager, scope).record({
        ...base,
        storageKey: 'safe.png',
      }),
    ).toThrow(/read-only/i);
  });
});

describe.skipIf(!sqliteAvailable)('ScopedMediaUsageStore.listRecent', () => {
  it('retorna artefatos parseados, mais novos primeiro, com cap', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const store = createScopedMediaUsageStore(runtimeManager, scope);
    for (let i = 0; i < 3; i += 1) {
      store.record({
        kind: i === 2 ? 'video' : 'image',
        provider: 'replicate-video',
        model: `model-${i}`,
        storageKey: `file-${i}.mp4`,
        sha256: String(i).repeat(64).slice(0, 64),
        costUsd: i === 1 ? null : 0.5,
        durationMs: 100 + i,
      });
    }
    const list = store.listRecent(10);
    expect(list).toHaveLength(3);
    expect(list[0].storageKey).toBe('file-2.mp4');
    expect(list[0].kind).toBe('video');
    expect(list[0].model).toBe('model-2');
    expect(list[0].costUsd).toBe(0.5);
    expect(list[1].costUsd).toBeNull();
    expect(list[2].durationMs).toBe(100);
    expect(store.listRecent(2)).toHaveLength(2);
  });
});
