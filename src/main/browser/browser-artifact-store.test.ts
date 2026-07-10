import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedBrowserArtifactStore } from './browser-artifact-store';

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

function fixture(): {
  parent: string;
  baseDir: string;
  scope: ProjectExecutionScope;
} {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-artifacts-'));
  roots.push(parent);
  const checkout = path.join(parent, 'checkout-a');
  fs.mkdirSync(checkout);
  return {
    parent,
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
    appVersion: 'browser-artifact-test',
  });
  managers.push(runtimeManager);
  return runtimeManager;
}

function screenshot(paneId = 'pane-shared') {
  return {
    paneId,
    png: Buffer.from('fake-png-content'),
    width: 800,
    height: 600,
    url: 'https://example.com/[REDACTED]',
    title: 'Example',
    capturedAt: 1_700_000_000_000,
  };
}

afterEach(() => {
  for (const runtimeManager of managers.splice(0)) runtimeManager.closeAll();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!sqliteAvailable)('ScopedBrowserArtifactStore', () => {
  it('isolates identical pane ids across projects/checkouts', () => {
    const { parent, baseDir, scope } = fixture();
    const checkoutBPath = path.join(parent, 'checkout-b');
    fs.mkdirSync(checkoutBPath);
    const scopeB: ProjectExecutionScope = Object.freeze({
      ...scope,
      checkoutId: 'checkout-b',
      rootRealPath: fs.realpathSync(checkoutBPath),
    });
    const runtimeManager = manager(baseDir);
    const storeA = createScopedBrowserArtifactStore(runtimeManager, scope);
    const storeB = createScopedBrowserArtifactStore(runtimeManager, scopeB);
    storeA.recordScreenshot(screenshot());
    storeB.recordScreenshot({ ...screenshot(), title: 'Project B' });

    expect(storeA.listScreenshots()).toEqual([
      expect.objectContaining({
        projectId: scope.projectId,
        checkoutId: scope.checkoutId,
        paneId: 'pane-shared',
        title: 'Example',
      }),
    ]);
    expect(storeB.listScreenshots()).toEqual([
      expect.objectContaining({
        checkoutId: scopeB.checkoutId,
        title: 'Project B',
      }),
    ]);
    expect(storeA.listScreenshots()[0].path).not.toBe(
      storeB.listScreenshots()[0].path,
    );
  });

  it('persists a relative storage key and survives restart', () => {
    const { baseDir, scope } = fixture();
    const firstManager = manager(baseDir);
    const artifact = createScopedBrowserArtifactStore(
      firstManager,
      scope,
    ).recordScreenshot(screenshot('pane-a'));
    expect(path.isAbsolute(artifact.storageKey)).toBe(false);
    expect(artifact.storageKey).toMatch(/^browser-artifacts\/browser-/);
    expect(artifact.path).toBe(
      path.join(path.dirname(firstManager.open(scope).databasePath), artifact.storageKey),
    );
    firstManager.closeAll();
    managers.splice(managers.indexOf(firstManager), 1);

    const reopened = createScopedBrowserArtifactStore(manager(baseDir), scope);
    expect(reopened.listScreenshots('pane-a')).toEqual([
      expect.objectContaining({
        id: artifact.id,
        sha256: artifact.sha256,
        storageKey: artifact.storageKey,
      }),
    ]);
  });

  it('detects tampering and unsafe artifact directories', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const store = createScopedBrowserArtifactStore(runtimeManager, scope);
    const artifact = store.recordScreenshot(screenshot());
    fs.writeFileSync(artifact.path, 'tampered');
    expect(() => store.listScreenshots()).toThrow(/invalid scoped browser artifact/i);

    const other = fixture();
    const otherManager = manager(other.baseDir);
    const runtimeDirectory = path.dirname(otherManager.open(other.scope).databasePath);
    const outside = path.join(other.parent, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(runtimeDirectory, 'browser-artifacts'));
    expect(() =>
      createScopedBrowserArtifactStore(otherManager, other.scope).recordScreenshot(
        screenshot(),
      ),
    ).toThrow(/directory is unsafe/i);
  });

  it('removes a partial artifact when the file write fails', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const runtimeDirectory = path.dirname(
      runtimeManager.open(scope).databasePath,
    );
    const write = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementationOnce(() => {
        throw new Error('simulated disk failure');
      });
    try {
      expect(() =>
        createScopedBrowserArtifactStore(
          runtimeManager,
          scope,
        ).recordScreenshot(screenshot()),
      ).toThrow(/simulated disk failure/i);
    } finally {
      write.mockRestore();
    }

    expect(
      fs.readdirSync(path.join(runtimeDirectory, 'browser-artifacts')),
    ).toEqual([]);
  });

  it('fails closed before writing when runtime is safe-read-only', () => {
    const { scope } = fixture();
    const readOnlyManager = {
      open: () => ({
        assertWritable: () => {
          throw new Error('safe read-only mode');
        },
        databasePath: '/unreachable/runtime.sqlite3',
      }),
    } as unknown as ProjectRuntimeManager;
    expect(() =>
      createScopedBrowserArtifactStore(readOnlyManager, scope).recordScreenshot(
        screenshot(),
      ),
    ).toThrow(/read-only/i);
  });

  it('enforces per-checkout count and byte quotas by pruning the oldest artifacts', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const store = createScopedBrowserArtifactStore(runtimeManager, scope, {
      maxArtifacts: 2,
      maxTotalBytes: 40,
      maxAgeMs: 60_000,
      now: () => 10,
    });
    const first = store.recordScreenshot({ ...screenshot('pane-1'), capturedAt: 1 });
    const second = store.recordScreenshot({ ...screenshot('pane-2'), capturedAt: 2 });
    const third = store.recordScreenshot({ ...screenshot('pane-3'), capturedAt: 3 });

    expect(store.listScreenshots().map((artifact) => artifact.id)).toEqual([
      third.id,
      second.id,
    ]);
    expect(fs.existsSync(first.path)).toBe(false);
    expect(fs.existsSync(second.path)).toBe(true);
    expect(fs.existsSync(third.path)).toBe(true);
  });

  it('prunes expired screenshot metadata and files deterministically', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const store = createScopedBrowserArtifactStore(runtimeManager, scope, {
      maxAgeMs: 100,
      now: () => 1_000,
    });
    const expired = store.recordScreenshot({ ...screenshot(), capturedAt: 800 });

    const result = store.prune();

    expect(result).toEqual({ removed: 1, freedBytes: Buffer.byteLength('fake-png-content') });
    expect(store.listScreenshots()).toEqual([]);
    expect(fs.existsSync(expired.path)).toBe(false);
  });
});
