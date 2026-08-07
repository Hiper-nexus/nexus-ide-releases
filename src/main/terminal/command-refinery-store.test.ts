import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommandBlock, type CommandBlock } from '../../shared/command-block';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { INITIAL_PROJECT_MIGRATIONS } from '../runtime/project-runtime-schema';
import { computeCommandBlockIdempotencyKey } from './command-block-id';
import { CommandBlockStore } from './command-block-store';
import { CommandRefineryStore } from './command-refinery-store';

const DAY_MS = 24 * 60 * 60 * 1_000;
const PROJECT_ROOT = '/workspace';
let baseDir = '';
let manager: ProjectRuntimeManager;
let now = 40 * DAY_MS;
let sequence = 0;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-command-refinery-'));
  manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.28.0' });
  now = 40 * DAY_MS;
  sequence = 0;
});

afterEach(() => {
  manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function makeBlock(
  command: string,
  options: Partial<CommandBlock> = {},
): CommandBlock {
  sequence += 1;
  const startedAt = options.startedAt ?? now - sequence * 100;
  const cwd = options.cwd ?? `${PROJECT_ROOT}/app`;
  const sessionId = options.sessionId ?? 'session-1';
  return createCommandBlock({
    id: options.id ?? `block-${sequence}`,
    sessionId,
    paneId: options.paneId ?? 'pane-1',
    workspaceId: options.workspaceId ?? 'checkout-test',
    command,
    cwd,
    projectRoot: options.projectRoot ?? PROJECT_ROOT,
    shell: options.shell ?? 'zsh',
    gitBranch: options.gitBranch ?? 'main',
    startedAt,
    endedAt: options.endedAt ?? startedAt + 10,
    durationMs: options.durationMs ?? 10,
    exitCode: options.exitCode ?? 0,
    status: options.status ?? 'success',
    redaction: options.redaction ?? {
      redacted: false,
      denylisted: false,
      secretHits: 0,
    },
    idempotencyKey:
      options.idempotencyKey ??
      computeCommandBlockIdempotencyKey({
        sessionId,
        startedAt,
        command,
        cwd,
      }),
  });
}

function makeStore(): CommandRefineryStore {
  return new CommandRefineryStore(manager, testProjectScope(), {
    now: () => now,
  });
}

describe('CommandRefineryStore', () => {
  it('installs the aggregate and idempotency tables as an append-only migration', () => {
    const runtime = manager.open(testProjectScope());
    const tables = runtime.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'command_stat%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      'command_stat_days',
      'command_stat_observations',
      'command_stats',
    ]);
  });

  it('backfills clean command history captured before the refinery migration', () => {
    manager.closeAll();
    const legacyManager = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.27.0-test',
      migrations: INITIAL_PROJECT_MIGRATIONS.slice(0, -1),
    });
    const scope = testProjectScope();
    new CommandBlockStore(legacyManager, scope).insert(makeBlock('npm legacy'));
    const legacyAwsKey = `AKIA${'A'.repeat(16)}`;
    legacyManager
      .open(scope)
      .db.prepare(
        `INSERT INTO command_blocks (
           id, session_id, pane_id, workspace_id, command, cwd, project_root,
           shell, started_at, ended_at, duration_ms, exit_code, status,
           redacted, denylisted, secret_hits, idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      )
      .run(
        'legacy-secret',
        'legacy-session',
        'pane-1',
        'checkout-test',
        `aws configure set key ${legacyAwsKey}`,
        `${PROJECT_ROOT}/app`,
        PROJECT_ROOT,
        'zsh',
        now - 100,
        now - 90,
        10,
        0,
        'success',
        'f'.repeat(64),
      );
    legacyManager.closeAll();

    manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.28.0' });
    const suggestions = new CommandRefineryStore(manager, scope, {
      now: () => now,
    }).suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
      });
    expect(suggestions).toEqual([
      expect.objectContaining({
        command: 'npm legacy',
        totalCount: 1,
        successCount: 1,
      }),
    ]);
    expect(JSON.stringify(suggestions)).not.toContain(legacyAwsKey);
  });

  it('leaves a running legacy block eligible for backfill after completion', () => {
    const scope = testProjectScope();
    const blocks = new CommandBlockStore(manager, scope);
    const running = makeBlock('npm run watch', {
      status: 'running',
      exitCode: undefined,
    });
    blocks.insert(running);
    const refinery = makeStore();

    expect(
      refinery.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
      }),
    ).toEqual([]);

    blocks.update(
      createCommandBlock({
        ...running,
        endedAt: now + 1,
        durationMs: now + 1 - running.startedAt,
        exitCode: 0,
        status: 'success',
      }),
    );
    expect(
      refinery.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
      }),
    ).toEqual([
      expect.objectContaining({ command: 'npm run watch', successCount: 1 }),
    ]);
  });

  it('records each clean completed block exactly once', () => {
    const store = makeStore();
    const block = makeBlock('npm test');

    expect(store.record(block)).toBe(true);
    expect(store.record(block)).toBe(false);

    expect(
      store.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
      }),
    ).toEqual([
      expect.objectContaining({
        command: 'npm test',
        totalCount: 1,
        successCount: 1,
        distinctDays: 1,
        scope: 'cwd',
      }),
    ]);
  });

  it('orders exact cwd, project and checkout-wide history in three tiers', () => {
    const store = makeStore();
    store.record(makeBlock('npm test', { cwd: `${PROJECT_ROOT}/app` }));
    store.record(makeBlock('npm run build', { cwd: `${PROJECT_ROOT}/packages/api` }));
    store.record(
      makeBlock('npm cache verify', {
        cwd: '/tmp/tooling',
        projectRoot: '/tmp/tooling',
      }),
    );

    expect(
      store
        .suggest({
          cwd: `${PROJECT_ROOT}/app`,
          projectRoot: PROJECT_ROOT,
          prefix: 'npm',
        })
        .map((item) => [item.command, item.scope]),
    ).toEqual([
      ['npm test', 'cwd'],
      ['npm run build', 'project'],
      ['npm cache verify', 'global'],
    ]);
  });

  it('does not let newer global history crowd an exact-directory match out', () => {
    const store = makeStore();
    store.record(
      makeBlock('tool local', {
        cwd: `${PROJECT_ROOT}/app`,
        startedAt: now - DAY_MS,
        endedAt: now - DAY_MS + 10,
      }),
    );
    for (let index = 0; index < 20; index += 1) {
      store.record(
        makeBlock(`tool global-${index}`, {
          cwd: `/tmp/tool-${index}`,
          projectRoot: `/tmp/tool-${index}`,
        }),
      );
    }

    expect(
      store.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
        prefix: 'tool',
        limit: 1,
      })[0],
    ).toMatchObject({ command: 'tool local', scope: 'cwd' });
  });

  it('ranks frequency, success and recency within a scope', () => {
    const store = makeStore();
    store.record(makeBlock('git status'));
    store.record(makeBlock('git status'));
    store.record(makeBlock('git fresh'));
    store.record(makeBlock('git broken', { status: 'failed', exitCode: 1 }));
    store.record(
      makeBlock('git old', {
        startedAt: now - 20 * DAY_MS,
        endedAt: now - 20 * DAY_MS + 10,
      }),
    );

    expect(
      store
        .suggest({
          cwd: `${PROJECT_ROOT}/app`,
          projectRoot: PROJECT_ROOT,
          prefix: 'git',
        })
        .map((item) => item.command),
    ).toEqual(['git status', 'git fresh', 'git old', 'git broken']);
  });

  it('hides an explicit dismissal until that command is used again', () => {
    const store = makeStore();
    store.record(makeBlock('pnpm lint'));

    expect(
      store.dismiss({ command: 'pnpm lint', cwd: `${PROJECT_ROOT}/app` }),
    ).toBe(true);
    expect(
      store.dismiss({ command: 'pnpm lint', cwd: `${PROJECT_ROOT}/app` }),
    ).toBe(true);
    expect(
      store.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
      }),
    ).toEqual([]);

    store.record(
      makeBlock('pnpm lint', {
        startedAt: now,
        endedAt: now,
        durationMs: 0,
      }),
    );
    expect(
      store.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
      }),
    ).toEqual([
      expect.objectContaining({ command: 'pnpm lint', dismissedCount: 1 }),
    ]);
  });

  it('never learns redacted, denylisted or unfinished commands', () => {
    const store = makeStore();
    store.record(
      makeBlock(`aws configure set key AKIA${'B'.repeat(16)}`, {
        redaction: { redacted: false, denylisted: false, secretHits: 0 },
      }),
    );
    store.record(
      makeBlock('curl --token [REDACTED]', {
        redaction: { redacted: true, denylisted: false, secretHits: 1 },
      }),
    );
    store.record(
      makeBlock('[DENYLISTED]', {
        redaction: { redacted: true, denylisted: true, secretHits: 0 },
      }),
    );
    store.record(makeBlock('still running', { status: 'running', endedAt: undefined }));
    store.record(makeBlock('unknown result', { status: 'unknown' }));

    expect(
      store.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
      }),
    ).toEqual([]);
  });

  it('decays stale counts and treats prefix wildcard characters literally', () => {
    const store = makeStore();
    for (let index = 0; index < 4; index += 1) {
      store.record(makeBlock('%deploy'));
    }
    store.record(makeBlock('npm test'));

    expect(
      store
        .suggest({
          cwd: `${PROJECT_ROOT}/app`,
          projectRoot: PROJECT_ROOT,
          prefix: '%',
        })
        .map((item) => item.command),
    ).toEqual(['%deploy']);

    now += 31 * DAY_MS;
    expect(
      store.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
        prefix: '%',
      })[0],
    ).toMatchObject({ totalCount: 2, successCount: 2 });

    store.record(makeBlock('%deploy'));
    expect(
      store.suggest({
        cwd: `${PROJECT_ROOT}/app`,
        projectRoot: PROJECT_ROOT,
        prefix: '%',
      })[0],
    ).toMatchObject({ totalCount: 3, successCount: 3 });
  });
});
