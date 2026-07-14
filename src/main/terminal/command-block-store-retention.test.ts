import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommandBlock } from '../../shared/command-block';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { computeCommandBlockIdempotencyKey } from './command-block-id';
import { CommandBlockStore } from './command-block-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cblock-ret-'));
});

afterEach(() => {
  for (const m of managers.splice(0)) m.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('CommandBlockStore retention', () => {
  it('prunes oldest finished rows and enforces size budget', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
    managers.push(manager);
    const store = new CommandBlockStore(manager, testProjectScope());
    const redaction = { redacted: false, denylisted: false, secretHits: 0 };

    for (let i = 0; i < 20; i += 1) {
      const command = `echo ${i} ${'x'.repeat(200)}`;
      store.insert(
        createCommandBlock({
          id: `cb-${i}`,
          sessionId: 's',
          paneId: 'p',
          workspaceId: 'w',
          command,
          cwd: '/workspace',
          shell: 'zsh',
          startedAt: 1000 + i,
          status: 'success',
          endedAt: 1001 + i,
          durationMs: 1,
          exitCode: 0,
          redaction,
          idempotencyKey: computeCommandBlockIdempotencyKey({
            sessionId: 's',
            startedAt: 1000 + i,
            command,
            cwd: '/workspace',
          }),
        }),
      );
    }

    expect(store.search({ limit: 100 })).toHaveLength(20);
    const pruned = store.prune(5);
    expect(pruned).toBeGreaterThan(0);
    expect(store.search({ limit: 100 }).length).toBeLessThanOrEqual(5);

    // Size budget should be able to delete more when max is small.
    store.enforceSizeBudget(800);
    expect(store.search({ limit: 100 }).length).toBeLessThanOrEqual(5);
  });
});
