import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommandBlock } from '../../shared/command-block';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { computeCommandBlockIdempotencyKey } from './command-block-id';
import { CommandBlockStore } from './command-block-store';
import { redactCommandLine } from './command-redaction';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cblock-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function makeStore(): CommandBlockStore {
  const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
  managers.push(manager);
  return new CommandBlockStore(manager, testProjectScope(), {
    now: () => 1_700_000_000_000,
  });
}

describe('CommandBlockStore', () => {
  it('persists redacted commands and never stores raw secrets', () => {
    const store = makeStore();
    const raw =
      'curl -H "Authorization: Bearer abcd.efgh.ijkl" https://api.example/v1';
    const redacted = redactCommandLine(raw);
    expect(redacted.denylisted).toBe(false);
    const key = computeCommandBlockIdempotencyKey({
      sessionId: 'sess-1',
      startedAt: 100,
      command: redacted.command,
      cwd: '/workspace',
    });

    const block = store.insert(
      createCommandBlock({
        id: 'cb-1',
        sessionId: 'sess-1',
        paneId: 'pane-1',
        workspaceId: 'ws-1',
        command: raw,
        cwd: '/workspace',
        projectRoot: '/workspace',
        shell: '/bin/zsh',
        gitBranch: 'main',
        startedAt: 100,
        status: 'running',
        redaction: {
          redacted: redacted.redacted,
          denylisted: redacted.denylisted,
          secretHits: redacted.secretHits,
        },
        idempotencyKey: key,
      }),
    );

    expect(block.command).not.toContain('abcd.efgh');
    expect(block.command).toContain('[REDACTED]');

    const found = store.search({ projectRoot: '/workspace' });
    expect(found).toHaveLength(1);
    expect(found[0]?.command).not.toContain('abcd.efgh');
  });

  it('dedupes by idempotency key', () => {
    const store = makeStore();
    const redaction = { redacted: false, denylisted: false, secretHits: 0 };
    const key = computeCommandBlockIdempotencyKey({
      sessionId: 's',
      startedAt: 1,
      command: 'ls',
      cwd: '/tmp',
    });
    const input = createCommandBlock({
      id: 'cb-a',
      sessionId: 's',
      paneId: 'p',
      workspaceId: 'w',
      command: 'ls',
      cwd: '/tmp',
      shell: 'zsh',
      startedAt: 1,
      status: 'success',
      endedAt: 2,
      durationMs: 1,
      exitCode: 0,
      redaction,
      idempotencyKey: key,
    });
    store.insert(input);
    store.insert({ ...input, id: 'cb-b' });
    expect(store.search({ cwd: '/tmp' })).toHaveLength(1);
  });

  it('rejects conflicting reuse of an idempotency key', () => {
    const store = makeStore();
    const key = 'b'.repeat(64);
    const base = {
      sessionId: 's', paneId: 'p', workspaceId: 'w', cwd: '/tmp', shell: 'zsh',
      startedAt: 1, status: 'success' as const,
      redaction: { redacted: false, denylisted: false, secretHits: 0 },
      idempotencyKey: key,
    };
    store.insert(createCommandBlock({ ...base, id: 'cb-a', command: 'echo one' }));
    expect(() => store.insert(createCommandBlock({
      ...base,
      id: 'cb-b',
      command: 'echo two',
    }))).toThrow(/idempotency.*conflict/i);
  });

  it('computes success stats and searches by branch', () => {
    const store = makeStore();
    const redaction = { redacted: false, denylisted: false, secretHits: 0 };
    const rows = [
      { id: 'cb-0', command: 'echo 0', status: 'success' as const, startedAt: 10 },
      { id: 'cb-1', command: 'echo 1', status: 'success' as const, startedAt: 11 },
      { id: 'cb-2', command: 'echo 2', status: 'failed' as const, startedAt: 12 },
    ];
    for (const row of rows) {
      store.insert(
        createCommandBlock({
          id: row.id,
          sessionId: 's',
          paneId: 'p',
          workspaceId: 'w',
          command: row.command,
          cwd: '/workspace',
          projectRoot: '/workspace',
          shell: 'zsh',
          gitBranch: 'feat/x',
          startedAt: row.startedAt,
          status: row.status,
          redaction,
          idempotencyKey: computeCommandBlockIdempotencyKey({
            sessionId: 's',
            startedAt: row.startedAt,
            command: row.command,
            cwd: '/workspace',
          }),
        }),
      );
    }

    const stats = store.stats('/workspace');
    expect(stats.total).toBe(3);
    expect(stats.success).toBe(2);
    expect(stats.failed).toBe(1);
    expect(store.search({ gitBranch: 'feat/x' }).length).toBe(3);
  });

  function plainBlock(id: string, command: string, startedAt: number) {
    return createCommandBlock({
      id,
      sessionId: 's',
      paneId: 'p',
      workspaceId: 'w',
      command,
      cwd: '/workspace',
      shell: 'zsh',
      startedAt,
      status: 'unknown',
      redaction: { redacted: false, denylisted: false, secretHits: 0 },
      idempotencyKey: computeCommandBlockIdempotencyKey({
        sessionId: 's',
        startedAt,
        command,
        cwd: '/workspace',
      }),
    });
  }

  it('F-1171: insertWithOutcome distingue gravado de duplicado', () => {
    const store = makeStore();
    const first = store.insertWithOutcome(plainBlock('cb-a', 'ls', 1));
    const again = store.insertWithOutcome(plainBlock('cb-a', 'ls', 1));
    expect(first.inserted).toBe(true);
    expect(again.inserted).toBe(false);
    expect(again.block.id).toBe('cb-a');
    expect(store.search({}).length).toBe(1);
  });

  it('F-1171: mantém a redação já aplicada pelo chamador (não zera o metadado)', () => {
    const store = makeStore();
    const block = store.insert(
      createCommandBlock({
        ...plainBlock('cb-r', 'export T=[REDACTED]', 2),
        redaction: { redacted: true, denylisted: false, secretHits: 1 },
      }),
    );
    expect(block.redaction.redacted).toBe(true);
    expect(block.redaction.secretHits).toBe(1);
  });

  it('F-1171: search pagina com offset, mais novo primeiro', () => {
    const store = makeStore();
    for (let i = 0; i < 5; i += 1) store.insert(plainBlock(`cb-${i}`, `echo ${i}`, i));
    const page1 = store.search({ limit: 2 });
    const page2 = store.search({ limit: 2, offset: 2 });
    expect(page1.map((b) => b.command)).toEqual(['echo 4', 'echo 3']);
    expect(page2.map((b) => b.command)).toEqual(['echo 2', 'echo 1']);
    expect(store.search({ commandContains: 'echo 1' }).map((b) => b.id)).toEqual(['cb-1']);
  });
});
