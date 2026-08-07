import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandBlock } from '../../shared/command-block';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { computeCommandBlockIdempotencyKey } from './command-block-id';
import { createCommandBlockPersister } from './command-block-persist';
import { registerCommandBlockScope } from './command-block-scope-registry';
import { CommandBlockStore } from './command-block-store';
import { CommandRefineryStore } from './command-refinery-store';

let baseDir = '';
let manager: ProjectRuntimeManager;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-persist-'));
  manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
  getFeatureFlagRegistry().setOverride(
    FEATURE_FLAG_IDS.terminalCommandBlocks,
    true,
  );
});

afterEach(() => {
  manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('command block production persist', () => {
  it('writes finished blocks to SQLite via onBlock path', () => {
    const scope = testProjectScope();
    registerCommandBlockScope('sess-1', scope);
    const persist = createCommandBlockPersister({
      runtimeManager: manager,
      isEnabled: () => true,
    });

    const command = 'echo persist-me';
    const block = createCommandBlock({
      id: 'cb-persist',
      sessionId: 'sess-1',
      paneId: 'p1',
      workspaceId: scope.checkoutId,
      command,
      cwd: '/workspace',
      projectRoot: scope.rootRealPath,
      shell: 'zsh',
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      exitCode: 0,
      status: 'success',
      redaction: { redacted: false, denylisted: false, secretHits: 0 },
      idempotencyKey: computeCommandBlockIdempotencyKey({
        sessionId: 'sess-1',
        startedAt: 10,
        command,
        cwd: '/workspace',
      }),
    });

    persist(block);

    const store = new CommandBlockStore(manager, scope);
    const found = store.search({ projectRoot: scope.rootRealPath });
    expect(found.some((b) => b.id === 'cb-persist')).toBe(true);

    const refinery = new CommandRefineryStore(manager, scope);
    expect(
      refinery.suggest({
        cwd: '/workspace',
        projectRoot: scope.rootRealPath,
      }),
    ).toEqual([
      expect.objectContaining({
        command: 'echo persist-me',
        totalCount: 1,
        successCount: 1,
      }),
    ]);

    // A delivery replay may retry both writes, but must not inflate ranking.
    persist(block);
    expect(
      refinery.suggest({
        cwd: '/workspace',
        projectRoot: scope.rootRealPath,
      })[0]?.totalCount,
    ).toBe(1);
  });

  it('keeps canonical retention running when the derived refinery is unavailable', () => {
    const scope = testProjectScope();
    registerCommandBlockScope('sess-degraded', scope);
    manager.open(scope).db.exec('DROP TABLE command_stats');
    const persist = createCommandBlockPersister({
      runtimeManager: manager,
      isEnabled: () => true,
      keepLatest: 1,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      for (let index = 0; index < 51; index += 1) {
        const command = `echo ${index}`;
        persist(
          createCommandBlock({
            id: `cb-degraded-${index}`,
            sessionId: 'sess-degraded',
            paneId: 'p1',
            workspaceId: scope.checkoutId,
            command,
            cwd: '/workspace',
            projectRoot: scope.rootRealPath,
            shell: 'zsh',
            startedAt: index + 1,
            endedAt: index + 2,
            durationMs: 1,
            exitCode: 0,
            status: 'success',
            redaction: {
              redacted: false,
              denylisted: false,
              secretHits: 0,
            },
            idempotencyKey: computeCommandBlockIdempotencyKey({
              sessionId: 'sess-degraded',
              startedAt: index + 1,
              command,
              cwd: '/workspace',
            }),
          }),
        );
      }
    } finally {
      warn.mockRestore();
    }

    const row = manager
      .open(scope)
      .db.prepare('SELECT COUNT(*) AS count FROM command_blocks')
      .get() as { count: number };
    expect(row.count).toBe(2);
  });
});
