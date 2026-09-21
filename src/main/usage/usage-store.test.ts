import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { createScopedMissionPaneStore } from '../orch/mission-pane-store';
import { createScopedMissionStore } from '../orch/mission-store';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  computeRealCost,
  createScopedUsageStore,
  type UsageRecord,
} from './usage-store';

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
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-usage-'));
  roots.push(parent);
  const root = path.join(parent, 'checkout');
  fs.mkdirSync(root);
  return {
    baseDir: path.join(parent, 'runtime'),
    scope: Object.freeze({
      version: 1,
      installationId: 'install-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: fs.realpathSync(root),
      identitySource: 'manifest',
    }),
  };
}

function manager(baseDir: string): ProjectRuntimeManager {
  const runtimeManager = new ProjectRuntimeManager({
    baseDir,
    appVersion: 'usage-test',
  });
  managers.push(runtimeManager);
  return runtimeManager;
}

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sessionId: 'session-a',
    messageId: 'message-a',
    model: 'claude-sonnet-4-5',
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 100,
    cacheWrite5mTokens: 50,
    cacheWrite1hTokens: 25,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

afterEach(() => {
  for (const runtimeManager of managers.splice(0)) runtimeManager.closeAll();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('computeRealCost', () => {
  it('includes provider cache tiers without mutating the event', () => {
    const event = usage();
    const before = structuredClone(event);
    expect(computeRealCost(event)).toBeGreaterThan(0);
    expect(event).toEqual(before);
  });
});

describe.skipIf(!sqliteAvailable)('ScopedUsageStore', () => {
  it('upserts MiMo tokens with the CLI-reported cost rather than re-pricing them', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    const event = usage({ model: 'xiaomi/mimo-v2.6-flash', reportedCostUsd: 0.123456 });
    expect(store.record('mimo-code', event)).toBe(true);
    expect(store.totals().costUsd).toBe(0.123456);
    expect(store.record('mimo-code', { ...event, outputTokens: 400, reportedCostUsd: 0.2 })).toBe(false);
    expect(store.totals()).toMatchObject({ costUsd: 0.2, outputTokens: 400, turns: 1 });
    expect(() => store.record('mimo-code', { ...event, reportedCostUsd: -1 })).toThrow();
  });
  it('isolates projects and checkouts even when session ids are identical', () => {
    const { baseDir, scope } = fixture();
    const rootB = path.join(path.dirname(scope.rootRealPath), 'checkout-b');
    const rootC = path.join(path.dirname(scope.rootRealPath), 'project-b');
    fs.mkdirSync(rootB);
    fs.mkdirSync(rootC);
    const checkoutB: ProjectExecutionScope = Object.freeze({
      ...scope,
      checkoutId: 'checkout-b',
      rootRealPath: fs.realpathSync(rootB),
    });
    const projectB: ProjectExecutionScope = Object.freeze({
      ...scope,
      projectId: 'project-b',
      checkoutId: 'checkout-c',
      rootRealPath: fs.realpathSync(rootC),
    });
    const runtimeManager = manager(baseDir);
    const storeA = createScopedUsageStore(runtimeManager, scope);
    const storeB = createScopedUsageStore(runtimeManager, checkoutB);
    const storeC = createScopedUsageStore(runtimeManager, projectB);

    storeA.record('claude', usage());
    storeB.record('claude', usage({ outputTokens: 20 }));
    storeC.record('codex', usage({ inputTokens: 7 }));

    expect(storeA.totals().outputTokens).toBe(200);
    expect(storeB.totals().outputTokens).toBe(20);
    expect(storeC.totals().inputTokens).toBe(7);
    expect(storeA.totals().turns).toBe(1);
    expect(storeB.totals().turns).toBe(1);
  });

  it('deduplicates provider snapshots and survives a manager restart', () => {
    const { baseDir, scope } = fixture();
    const firstManager = manager(baseDir);
    const first = createScopedUsageStore(firstManager, scope);
    first.record('claude', usage({ outputTokens: 1 }));
    first.record('claude', usage({ outputTokens: 9 }));
    expect(first.totalsBySession('session-a')).toMatchObject({
      outputTokens: 9,
      turns: 1,
    });
    firstManager.closeAll();
    managers.splice(managers.indexOf(firstManager), 1);

    const reopened = createScopedUsageStore(manager(baseDir), scope);
    expect(reopened.totals()).toMatchObject({ outputTokens: 9, turns: 1 });
    expect(reopened.hasProviderSession('claude', 'session-a')).toBe(true);
    expect(reopened.hasProviderSession('codex', 'session-a')).toBe(false);
  });

  it('reports only the first deterministic provider event as newly created', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);

    expect(store.record('codex', usage({ outputTokens: 1 }))).toBe(true);
    expect(store.record('codex', usage({ outputTokens: 1 }))).toBe(false);
    expect(store.record('codex', usage({ outputTokens: 9 }))).toBe(false);
    expect(store.totalsBySession('session-a')).toMatchObject({
      outputTokens: 9,
      turns: 1,
    });
  });

  it('counts distinct stable Codex events from the same session and millisecond', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    const timestamp = '2026-07-05T16:54:17.773Z';
    const thread = 'a'.repeat(64);

    expect(
      store.record(
        'codex',
        usage({
          messageId: `codex:v2:${thread}:1:${timestamp}`,
          inputTokens: 10,
          outputTokens: 1,
        }),
      ),
    ).toBe(true);
    expect(
      store.record(
        'codex',
        usage({
          messageId: `codex:v2:${thread}:2:${timestamp}`,
          inputTokens: 20,
          outputTokens: 2,
        }),
      ),
    ).toBe(true);
    expect(store.totalsBySession('session-a')).toMatchObject({
      inputTokens: 30,
      outputTokens: 3,
      turns: 2,
    });
  });

  it('keeps one stable Codex replay idempotent across a manager restart', () => {
    const { baseDir, scope } = fixture();
    const timestamp = '2026-07-05T16:54:17.773Z';
    const event = usage({
      messageId: `codex:v2:${'b'.repeat(64)}:1:${timestamp}`,
      outputTokens: 7,
    });
    const firstManager = manager(baseDir);
    expect(
      createScopedUsageStore(firstManager, scope).record('codex', event),
    ).toBe(true);
    firstManager.closeAll();
    managers.splice(managers.indexOf(firstManager), 1);

    const reopened = createScopedUsageStore(manager(baseDir), scope);
    expect(reopened.record('codex', event)).toBe(false);
    expect(reopened.totalsBySession('session-a')).toMatchObject({
      outputTokens: 7,
      turns: 1,
    });
  });

  it('claims one matching legacy Codex id without duplicating it after upgrade', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    const timestamp = '2026-07-05T16:54:17.773Z';
    const legacy = usage({
      messageId: `codex:${timestamp}`,
      inputTokens: 20,
      outputTokens: 2,
    });
    expect(store.record('codex', legacy)).toBe(true);

    const firstStable = {
      ...legacy,
      messageId: `codex:v2:${'c'.repeat(64)}:1:${timestamp}`,
      inputTokens: 10,
      outputTokens: 1,
    };
    expect(store.record('codex', firstStable)).toBe(true);
    const matchingLegacyStable = {
      ...legacy,
      messageId: `codex:v2:${'c'.repeat(64)}:2:${timestamp}`,
    };
    expect(
      store.record('codex', matchingLegacyStable),
    ).toBe(false);
    expect(store.totalsBySession('session-a')).toMatchObject({
      inputTokens: 30,
      outputTokens: 3,
      turns: 2,
    });

    expect(store.record('codex', firstStable)).toBe(false);
    expect(store.record('codex', matchingLegacyStable)).toBe(false);
    expect(store.totalsBySession('session-a')).toMatchObject({
      inputTokens: 30,
      outputTokens: 3,
      turns: 2,
    });
  });

  it('resolves only one unambiguous persisted Codex pane authority', () => {
    const { baseDir, scope } = fixture();
    const workerPath = path.join(path.dirname(scope.rootRealPath), 'worker-a');
    fs.mkdirSync(workerPath);
    const workerScope: ProjectExecutionScope = Object.freeze({
      ...scope,
      rootRealPath: fs.realpathSync(workerPath),
    });
    const runtimeManager = manager(baseDir);
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Scoped mission',
    });
    createScopedMissionPaneStore(runtimeManager, scope).record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Worker',
      paneId: 'pane-worker',
      cwd: workerScope.rootRealPath,
      executionScope: workerScope,
    });
    const store = createScopedUsageStore(runtimeManager, scope);
    store.record(
      'codex',
      usage({
        sessionId: 'legacy-parent',
        messageId: 'external-event',
        paneId: 'pane-worker',
        missionId: mission.id,
      }),
    );
    expect(store.codexSessionAuthority('legacy-parent')).toEqual({
      paneId: 'pane-worker',
      executionRoot: workerScope.rootRealPath,
    });

    const secondPath = path.join(path.dirname(scope.rootRealPath), 'worker-b');
    fs.mkdirSync(secondPath);
    const secondScope: ProjectExecutionScope = Object.freeze({
      ...scope,
      rootRealPath: fs.realpathSync(secondPath),
    });
    createScopedMissionPaneStore(runtimeManager, scope).record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Second worker',
      paneId: 'pane-worker-b',
      cwd: secondScope.rootRealPath,
      executionScope: secondScope,
    });
    store.record(
      'codex',
      usage({
        sessionId: 'legacy-parent',
        messageId: 'second-event',
        paneId: 'pane-worker-b',
        missionId: mission.id,
      }),
    );
    expect(store.codexSessionAuthority('legacy-parent')).toBeNull();
  });

  it('binds mission attribution to the persisted pane owner', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Scoped mission',
    });
    createScopedMissionPaneStore(runtimeManager, scope).record({
      missionId: mission.id,
      adapterId: 'claude',
      title: 'Worker',
      paneId: 'pane-a',
    });
    const store = createScopedUsageStore(runtimeManager, scope);
    store.record(
      'claude',
      usage({ paneId: 'pane-a', missionId: mission.id }),
    );

    expect(store.totalsByMission(mission.id).turns).toBe(1);
    expect(store.totalsByPane()).toEqual([
      expect.objectContaining({ paneId: 'pane-a', turns: 1 }),
    ]);
    expect(store.latestProviderSessionByPane('pane-a')).toMatchObject({
      provider: 'claude',
      sessionId: 'session-a',
    });
    expect(() =>
      store.record(
        'claude',
        usage({
          messageId: 'wrong-owner',
          paneId: 'pane-a',
          missionId: 'mission-other',
        }),
      ),
    ).toThrow(/does not own/i);
  });

  it('aggregates real token spend by exact vault account and provider', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    store.record(
      'claude',
      usage({ accountId: 'acct-work', messageId: 'work', inputTokens: 30 }),
    );
    store.record(
      'claude',
      usage({ accountId: 'acct-home', messageId: 'home', inputTokens: 70 }),
    );
    store.record(
      'codex',
      usage({ accountId: null, messageId: 'native', inputTokens: 100 }),
    );

    expect(store.totalsByAccount()).toEqual([
      expect.objectContaining({
        provider: 'claude',
        accountId: 'acct-home',
        inputTokens: 70,
        turns: 1,
      }),
      expect.objectContaining({
        provider: 'claude',
        accountId: 'acct-work',
        inputTokens: 30,
        turns: 1,
      }),
    ]);
  });

  it('retains account ownership when a transcript replay omits attribution', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    store.record(
      'claude',
      usage({ accountId: 'acct-work', messageId: 'first', inputTokens: 10 }),
    );
    store.record(
      'claude',
      usage({ accountId: null, messageId: 'first', inputTokens: 20 }),
    );
    store.record(
      'claude',
      usage({ accountId: null, messageId: 'second', inputTokens: 30 }),
    );

    expect(store.totalsByAccount()).toEqual([
      expect.objectContaining({
        accountId: 'acct-work',
        inputTokens: 50,
        turns: 2,
      }),
    ]);
  });

  it('stores scope identity in the database location, never an absolute path row', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    createScopedUsageStore(runtimeManager, scope).record('codex', usage());
    const rows = runtimeManager
      .open(scope)
      .db.prepare('SELECT metadata_json FROM usage_events')
      .all() as Array<{ metadata_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata_json).not.toContain(scope.rootRealPath);
  });

  it('fails closed when its project runtime is not writable', () => {
    const { scope } = fixture();
    const unavailableManager = {
      open: () => ({
        assertWritable: () => {
          throw new Error('safe read-only mode');
        },
        db: null,
      }),
    } as unknown as ProjectRuntimeManager;
    const store = createScopedUsageStore(unavailableManager, scope);
    expect(() => store.record('claude', usage())).toThrow(/read-only/i);
  });
});
