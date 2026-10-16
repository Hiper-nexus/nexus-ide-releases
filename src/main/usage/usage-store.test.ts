import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';;
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- sonda: o better-sqlite3 pode estar compilado para o ABI do Electron; o require no try decide se a suíte roda
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

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

describe('computeRealCost', () => {
  it('includes provider cache tiers without mutating the event', () => {
    const event = usage();
    const before = structuredClone(event);
    expect(computeRealCost(event)).toBeGreaterThan(0);
    expect(event).toEqual(before);
  });
});

describe.skipIf(!sqliteAvailable)('ScopedUsageStore', () => {
  it('uses proved MiMo message attribution across demotion and a pane reused by another mission', () => {
    const { baseDir, scope } = fixture(); const runtimeManager = manager(baseDir);
    const missions = createScopedMissionStore(runtimeManager, scope);
    const a = missions.create({ title: 'Mission A' }); const b = missions.create({ title: 'Mission B' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    panes.record({ missionId: a.id, adapterId: 'mimo-code', paneId: 'pane-reused', title: 'MiMo' });
    const store = createScopedUsageStore(runtimeManager, scope);
    const owned = { exactNativeAttribution: true as const };
    store.record('mimo-code', usage({ messageId: 'a', paneId: 'pane-reused', missionId: a.id, outputTokens: 2 }), owned);
    store.record('mimo-code', usage({ messageId: 'loose', paneId: 'pane-reused', missionId: null, outputTokens: 3 }), owned);
    expect(store.totalsByMission(a.id).outputTokens).toBe(2);
    missions.setStatus(a.id, 'failed');
    panes.record({ missionId: b.id, adapterId: 'mimo-code', paneId: 'pane-reused', title: 'MiMo reused' });
    store.record('mimo-code', usage({ messageId: 'b', paneId: 'pane-reused', missionId: b.id, outputTokens: 5 }), owned);
    store.record('mimo-code', usage({ messageId: 'a', paneId: 'pane-reused', missionId: a.id, outputTokens: 7 }), owned);
    // Unknown replay preserves previously proved mission/pane attribution.
    store.record('mimo-code', usage({ messageId: 'a', paneId: null, missionId: null, outputTokens: 9 }));
    expect(store.totalsByMission(a.id).outputTokens).toBe(9);
    expect(store.totalsByMission(b.id).outputTokens).toBe(5);
    expect(store.totals().outputTokens).toBe(17);
    expect(() => store.record('codex', usage(), owned)).toThrow(/MiMo/);
    expect(() => store.record('mimo-code', { ...usage(), exactNativeAttribution: true } as UsageRecord)).toThrow();
  });
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

  it('retains mission and pane attribution when a transcript replay omits it', () => {
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
    store.record('claude', usage({ paneId: 'pane-a', missionId: mission.id }));

    // A restart replays the transcript: the session is only "known", so the
    // replay carries no pane or mission. It must not erase the attribution.
    store.record('claude', usage({ paneId: null, missionId: null, outputTokens: 300 }));

    expect(store.totalsByMission(mission.id)).toMatchObject({ turns: 1, outputTokens: 300 });
    expect(store.totalsByPane()).toEqual([
      expect.objectContaining({ paneId: 'pane-a', turns: 1 }),
    ]);
  });

  it('does not rewrite an event that a replay brings back unchanged', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    store.record('claude', usage());
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));

    expect(store.record('claude', usage())).toBe(false);
    expect(changes).toEqual([]);

    store.record('claude', usage({ outputTokens: 999 }));
    expect(changes).toHaveLength(1);
    expect(store.totalsBySession('session-a').outputTokens).toBe(999);
  });

  it('knows a provider session as soon as its first event is recorded', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    expect(store.hasProviderSession('claude', 'session-new')).toBe(false);

    store.record('claude', usage({ sessionId: 'session-new' }));

    expect(store.hasProviderSession('claude', 'session-new')).toBe(true);
    expect(store.hasProviderSession('codex', 'session-new')).toBe(false);
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

// lastContextTokens: o que o modelo viu NA ÚLTIMA rodada (input + cache_read),
// nunca a soma da sessão — é o que o medidor de janela de contexto mostra.
describe.skipIf(!sqliteAvailable)('totalsByPane lastContextTokens', () => {
  it('usa o evento mais recente do pane e ignora a soma', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const missions = createScopedMissionStore(runtimeManager, scope);
    const mission = missions.create({ title: 'Ctx' });
    createScopedMissionPaneStore(runtimeManager, scope).record({
      missionId: mission.id,
      adapterId: 'claude',
      title: 'Worker',
      paneId: 'pane-ctx',
    });
    const store = createScopedUsageStore(runtimeManager, scope);
    store.record(
      'claude',
      usage({
        paneId: 'pane-ctx',
        missionId: mission.id,
        messageId: 'm1',
        inputTokens: 40_000,
        cacheReadTokens: 10_000,
        timestamp: 1_700_000_000_000,
      }),
    );
    store.record(
      'claude',
      usage({
        paneId: 'pane-ctx',
        missionId: mission.id,
        messageId: 'm2',
        inputTokens: 50_000,
        cacheReadTokens: 20_000,
        timestamp: 1_700_000_100_000,
      }),
    );

    const rows = store.totalsByPane();
    const row = rows.find((r) => r.paneId === 'pane-ctx');
    // Soma seria 120k; o contexto da última rodada é 70k.
    expect(row?.lastContextTokens).toBe(70_000);
    expect(row?.inputTokens).toBe(90_000);
  });

  it('sem evento de contexto → lastContextTokens null (nunca 0 confiante)', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const missions = createScopedMissionStore(runtimeManager, scope);
    const mission = missions.create({ title: 'Ctx vazio' });
    createScopedMissionPaneStore(runtimeManager, scope).record({
      missionId: mission.id,
      adapterId: 'claude',
      title: 'Worker',
      paneId: 'pane-sem-ctx',
    });
    const store = createScopedUsageStore(runtimeManager, scope);
    // Evento sem cache_read e com input 0 ainda é leitura; o caso "sem
    // leitura" é a ausência total de evento de token para o pane.
    expect(store.totalsByPane()).toEqual([]);
    // E o Map sem linha devolve undefined → null no snapshot da UI.
    const row = store.totalsByPane().find((r) => r.paneId === 'pane-sem-ctx');
    expect(row?.lastContextTokens ?? null).toBeNull();
  });
});


describe.skipIf(!sqliteAvailable)('token snapshot hot path', () => {
  it('keeps timestamp/id tie-breaking for loose historical panes after an older turn is updated', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const store = createScopedUsageStore(runtimeManager, scope);
    store.record('claude', usage({ paneId: 'loose-tie', messageId: 'first', inputTokens: 10, cacheReadTokens: 5, timestamp: 100 }));
    store.record('claude', usage({ paneId: 'loose-tie', messageId: 'second', inputTokens: 30, cacheReadTokens: 7, timestamp: 100 }));
    const newest = runtimeManager.open(scope).db.prepare('SELECT input_units FROM usage_events ORDER BY occurred_at DESC, id DESC LIMIT 1').get() as { input_units: number };
    const context = newest.input_units === 10 ? 15 : 37;
    expect(store.totalsByPane()[0].lastContextTokens).toBe(context);
    store.record('claude', usage({ paneId: 'loose-tie', messageId: 'old', inputTokens: 90, cacheReadTokens: 9, timestamp: 50 }));
    store.record('claude', usage({ paneId: 'loose-tie', messageId: 'old', inputTokens: 100, cacheReadTokens: 11, timestamp: 50 }));
    expect(store.totalsByPane()[0]).toMatchObject({ inputTokens: 140, cacheReadTokens: 23, turns: 3, lastContextTokens: context });
  });

  it('reuses prepared snapshot queries and reopens after the runtime LRU closes its database', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const store = createScopedUsageStore(runtimeManager, scope);
    store.record('claude', usage({ paneId: 'pane-hot', accountId: 'acct-hot' }));
    const snapshot = () => ({ global: store.totals(), panes: store.totalsByPane(), accounts: store.totalsByAccount() });
    const expected = snapshot();
    const db = runtimeManager.open(scope).db;
    const prepare = vi.spyOn(db, 'prepare');
    expect(snapshot()).toEqual(expected);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    expect(runtimeManager.close(scope)).toBe(true);
    expect(snapshot()).toEqual(expected);
    store.record('claude', usage({ paneId: 'pane-hot', accountId: 'acct-hot', outputTokens: 300 }));
    expect(snapshot().global.outputTokens).toBe(300);
  });

  it('avoids JSON evaluation in indexed snapshot queries and preserves every total on 10,000 events', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'Snapshot benchmark' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const internalPaneIds = Array.from({ length: 6 }, (_, i) => panes.record({
      missionId: mission.id, adapterId: 'claude', paneId: `pane-${i}`, title: `Worker ${i}`,
    }).id);
    const db = runtimeManager.open(scope).db;
    const insert = db.prepare(`INSERT INTO usage_events
      (id, mission_id, pane_id, provider, model, event_type, input_units, output_units, cost_micros, metadata_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, 'token-usage', ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) insert.run(
        `bench-${String(i).padStart(5, '0')}`, i % 7 === 0 ? null : mission.id,
        i % 7 === 0 ? null : internalPaneIds[i % 6], i % 2 === 0 ? 'claude' : 'codex',
        'claude-sonnet-4-5', i % 100, i % 200, i * 3,
        JSON.stringify({ schemaVersion: 1, sessionId: `session-${i % 30}`, messageId: `message-${i}`,
          displayPaneId: i % 7 === 0 ? `loose-${i % 3}` : `fallback-${i % 6}`,
          accountId: i % 5 === 0 ? null : `account-${i % 3}`, cacheReadTokens: i % 50,
          cacheWrite5mTokens: i % 20, cacheWrite1hTokens: i % 10,
          sourceTimestamp: i, recordedAt: i }), Math.floor(i / 2),
      );
    })();
    const store = createScopedUsageStore(runtimeManager, scope);
    const snapshot = () => ({ global: store.totals(), panes: store.totalsByPane(), accounts: store.totalsByAccount() });
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'usage_events_token_snapshot_idx'").get() as { sql: string } | undefined;
    expect(index).toBeDefined();
    db.exec('DROP INDEX usage_events_token_snapshot_idx');
    const prepare = vi.spyOn(db, 'prepare');
    const before = snapshot();
    const queries = prepare.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('SUM(') || sql.includes('ROW_NUMBER()'));
    prepare.mockRestore();
    const measure = () => {
      const elapsed: number[] = [];
      for (let i = 0; i < 9; i++) {
        const started = performance.now(); snapshot(); elapsed.push(performance.now() - started);
      }
      return elapsed.sort((a, b) => a - b)[4];
    };
    const baselineMs = measure();
    db.exec(index!.sql);
    const after = snapshot();
    expect(after).toEqual(before);
    expect(after.global.turns).toBe(10_000);
    expect(after.panes).toHaveLength(9);
    expect(queries).toHaveLength(4);
    process.stdout.write(`[usage snapshot benchmark] 10000 events / 6 mission panes / 3 loose panes / 3 accounts; median of 9: before=${baselineMs.toFixed(3)}ms after=${measure().toFixed(3)}ms\n`);
    for (const sql of queries) {
      const program = db.prepare(`EXPLAIN ${sql}`).all('token-usage') as Array<{ opcode: string; p4: string | null }>;
      expect(program.filter(row => ['Function', 'PureFunc'].includes(row.opcode) && row.p4?.startsWith('json_extract')), sql).toEqual([]);
    }
  });
});

describe.skipIf(!sqliteAvailable)('ScopedUsageStore.analytics', () => {
  const DAY = 86_400_000;
  // Meio-dia local: nenhum fuso empurra o evento para outro dia.
  const noon = (daysAgo: number, now: number) => {
    const date = new Date(now);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysAgo, 12).getTime();
  };

  it('rolls up local days by provider and model, with distinct sessions per window', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    const now = new Date(2026, 9, 15, 18, 30).getTime();
    store.record('claude', usage({ messageId: 'c-today', sessionId: 'claude-1', timestamp: noon(0, now), inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 10_000, cacheWrite5mTokens: 200, cacheWrite1hTokens: 0, model: 'claude-opus-5' }));
    store.record('claude', usage({ messageId: 'c-old', sessionId: 'claude-1', timestamp: noon(20, now), inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, model: 'claude-opus-5' }));
    store.record('claude', usage({ messageId: 'c-80', sessionId: 'claude-2', timestamp: noon(80, now), inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }));
    store.record('codex', usage({ messageId: 'x-3', sessionId: 'codex-1', timestamp: noon(3, now), inputTokens: 300, outputTokens: 30, cacheReadTokens: 3_000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, model: 'gpt-5.6-sol' }));
    // Fora dos 90 dias e no futuro: não entram.
    store.record('codex', usage({ messageId: 'x-old', sessionId: 'codex-old', timestamp: noon(120, now) }));
    store.record('codex', usage({ messageId: 'x-future', sessionId: 'codex-future', timestamp: noon(0, now) + 2 * DAY }));

    const analytics = store.analytics(now);
    expect(analytics.today).toBe('2026-10-15');
    expect(analytics.days.map((day) => day.day)).toEqual(['2026-07-27', '2026-09-25', '2026-10-12', '2026-10-15']);
    const today = analytics.days.at(-1)!;
    expect(today.totalTokens).toBe(1_000 + 500 + 10_000 + 200);
    expect(Object.keys(today.byProvider)).toEqual(['claude']);

    const week = analytics.windows[7];
    expect(week.startDay).toBe('2026-10-09');
    expect(week.byProvider.map((row) => [row.provider, row.sessions])).toEqual(
      expect.arrayContaining([['claude', 1], ['codex', 1]]),
    );
    expect(week.totals).toMatchObject({
      cachedInputTokens: 13_000,
      uncachedInputTokens: 1_000 + 200 + 300,
      outputTokens: 530,
      processedTokens: 13_000 + 1_500 + 530,
      sessions: 2,
      turns: 2,
    });
    // Opus 5: input $5/M, leitura de cache $0.50/M → 10k tokens poupam $0.045.
    expect(week.totals.cacheSavingsUsd).toBeGreaterThan(0.045);
    const shares = week.byProvider.reduce((sum, row) => sum + row.costShare, 0);
    expect(shares).toBeCloseTo(1, 6);
    expect(week.byModel.map((row) => row.model)).toEqual(expect.arrayContaining(['claude-opus-5', 'gpt-5.6-sol']));

    // A sessão claude-1 atravessa 20 dias: conta UMA vez em 30d, nunca duas.
    const month = analytics.windows[30];
    expect(month.byProvider.find((row) => row.provider === 'claude')).toMatchObject({ sessions: 1 });
    expect(month.totals.turns).toBe(3);
    const quarter = analytics.windows[90];
    expect(quarter.byProvider.find((row) => row.provider === 'claude')).toMatchObject({ sessions: 2 });
    expect(quarter.totals.sessions).toBe(3);
    expect(quarter.totals.costUsd).toBeCloseTo(
      analytics.days.reduce((sum, day) => sum + day.costUsd, 0),
      9,
    );
  });

  it('returns empty windows for a project without telemetry', () => {
    const { baseDir, scope } = fixture();
    const store = createScopedUsageStore(manager(baseDir), scope);
    const analytics = store.analytics(new Date(2026, 9, 15, 9).getTime());
    expect(analytics.days).toEqual([]);
    expect(analytics.windows[30]).toMatchObject({ byProvider: [], byModel: [], totals: { processedTokens: 0, costUsd: 0, sessions: 0 } });
  });
});
