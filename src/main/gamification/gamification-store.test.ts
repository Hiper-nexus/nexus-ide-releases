import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { XpEventInput } from '../../shared/gamification-types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  countTodaySameBucket,
  dumpMeta,
  getMeta,
  initGamificationStore,
  insertXpEvent,
  listXpEvents,
  replaceProfile,
  setMeta,
} from './gamification-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  managers.push(value);
  return value;
}

function ev(overrides: Partial<XpEventInput> = {}): XpEventInput {
  return {
    kind: 'handoff_green',
    entityKey: 'handoff:h1',
    effort: 'medium',
    createdAt: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gamification-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('gamification-store on project runtime SQLite', () => {
  it('uses migrated schema and preserves event points/idempotency', () => {
    const runtime = manager().open(testProjectScope());
    initGamificationStore(runtime.db);

    expect(insertXpEvent(runtime.db, ev(), 8_000)).toBe(true);
    expect(insertXpEvent(runtime.db, ev(), 8_000)).toBe(false);
    expect(listXpEvents(runtime.db)).toEqual([
      expect.objectContaining({
        entityKey: 'handoff:h1',
        points: 8_000,
        ruleVersion: 1,
      }),
    ]);
  });

  it('accepts agent_turn events (everyday libre XP path)', () => {
    const db = manager().open(testProjectScope()).db;
    initGamificationStore(db);
    expect(
      insertXpEvent(
        db,
        {
          kind: 'agent_turn',
          entityKey: 'agent_turn:claude:1',
          createdAt: 1,
        },
        300,
      ),
    ).toBe(true);
    expect(listXpEvents(db)[0]).toEqual(
      expect.objectContaining({ kind: 'agent_turn', points: 300 }),
    );
  });

  it('counts only same live day and effort bucket', () => {
    const db = manager().open(testProjectScope()).db;
    insertXpEvent(db, ev({ entityKey: 'handoff:a', createdAt: 100 }), 1);
    insertXpEvent(db, ev({ entityKey: 'handoff:b', createdAt: 200 }), 1);
    insertXpEvent(
      db,
      ev({ entityKey: 'handoff:c', createdAt: 300, effort: 'high' }),
      1,
    );
    insertXpEvent(
      db,
      ev({ entityKey: 'handoff:retro', createdAt: 400, retro: true }),
      1,
    );

    expect(countTodaySameBucket(db, 'handoff_green', 'medium', 0)).toBe(2);
    expect(countTodaySameBucket(db, 'handoff_green', 'high', 0)).toBe(1);
  });

  it('round-trips profile atomically and rolls back invalid input', () => {
    const runtimeManager = manager();
    const first = runtimeManager.open(
      testProjectScope({ checkoutId: 'profile-source' }),
    ).db;
    insertXpEvent(first, ev(), 8_000);
    setMeta(first, 'prestige', '1');
    const events = listXpEvents(first);
    const meta = dumpMeta(first);

    const second = runtimeManager.open(
      testProjectScope({ checkoutId: 'profile-target' }),
    ).db;
    replaceProfile(second, events, meta);
    expect(listXpEvents(second)).toEqual(events);
    expect(dumpMeta(second)).toEqual({ prestige: '1' });

    const broken = [{ ...events[0], id: 2, entityKey: 'x', points: {} }];
    expect(() =>
      replaceProfile(second, broken as unknown as typeof events, meta),
    ).toThrow();
    expect(listXpEvents(second)).toEqual(events);
  });

  it('keeps identical entity keys physically isolated across projects/checkouts', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'main',
      rootRealPath: '/workspace/a',
    });
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'main',
      rootRealPath: '/workspace/b',
    });
    const scopeAFeature = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'feature',
      rootRealPath: '/workspace/a-feature',
    });
    const runtimeA = runtimeManager.open(scopeA);
    const runtimeB = runtimeManager.open(scopeB);
    const runtimeAFeature = runtimeManager.open(scopeAFeature);

    insertXpEvent(runtimeA.db, ev(), 8_000);
    insertXpEvent(runtimeB.db, ev(), 3_000);

    expect(listXpEvents(runtimeA.db)[0].points).toBe(8_000);
    expect(listXpEvents(runtimeB.db)[0].points).toBe(3_000);
    expect(listXpEvents(runtimeAFeature.db)).toEqual([]);
    expect(runtimeA.databasePath).not.toBe(runtimeB.databasePath);
    expect(runtimeA.databasePath).not.toBe(runtimeAFeature.databasePath);
  });

  it('stores metadata in the selected project runtime only', () => {
    const runtimeManager = manager();
    const first = runtimeManager.open(
      testProjectScope({ checkoutId: 'meta-first' }),
    ).db;
    const second = runtimeManager.open(
      testProjectScope({ checkoutId: 'meta-second' }),
    ).db;

    expect(getMeta(first, 'streak')).toBeNull();
    setMeta(first, 'streak', JSON.stringify({ streakDays: 3 }));
    expect(JSON.parse(getMeta(first, 'streak')!)).toEqual({ streakDays: 3 });
    expect(getMeta(second, 'streak')).toBeNull();
  });
});
