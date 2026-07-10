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
