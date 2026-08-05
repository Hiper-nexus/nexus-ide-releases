import { describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  defaultGoalDriverConfig,
  evaluatePredicate,
  readMetric,
  shouldFireGoal,
  type GoalDriverConfig,
  type GoalLiveState,
  type GoalTrigger,
} from './goal-driver';
import {
  runGoalDriverTick,
  startGoalDriverLoop,
  stopGoalDriverLoop,
  type GoalDriverDeps,
} from './goal-driver-runtime';
import {
  runCronTick,
  type CronRuntimeDeps,
} from './cron-runtime';
import type { CronJob } from './cron-loop';

const SCOPE: ProjectExecutionScope = {
  version: 1,
  projectId: 'proj-1',
  checkoutId: 'checkout-1',
  installationId: 'install-1',
  rootRealPath: '/tmp/proj-1',
  identitySource: 'manifest',
};

function liveState(overrides: Partial<GoalLiveState> = {}): GoalLiveState {
  return {
    runningMissions: 0,
    pendingMissions: 0,
    blockedMissions: 0,
    queueDepth: 0,
    providerAvailable: true,
    ...overrides,
  };
}

function trigger(overrides: Partial<GoalTrigger> = {}): GoalTrigger {
  return {
    id: 'goal-1',
    name: 'drain the queue',
    status: 'active',
    brief: 'work the backlog',
    predicate: { metric: 'queueDepth', comparator: 'gte', value: 3 },
    ...overrides,
  };
}

const CONFIG: GoalDriverConfig = defaultGoalDriverConfig;

describe('readMetric', () => {
  it('reads every live-state metric, coercing providerAvailable to 0/1', () => {
    const state = liveState({
      runningMissions: 2,
      pendingMissions: 5,
      blockedMissions: 1,
      queueDepth: 7,
      providerAvailable: false,
    });
    expect(readMetric(state, 'runningMissions')).toBe(2);
    expect(readMetric(state, 'pendingMissions')).toBe(5);
    expect(readMetric(state, 'blockedMissions')).toBe(1);
    expect(readMetric(state, 'queueDepth')).toBe(7);
    expect(readMetric(state, 'providerAvailable')).toBe(0);
    expect(readMetric(liveState({ providerAvailable: true }), 'providerAvailable')).toBe(1);
  });
});

describe('evaluatePredicate', () => {
  it('supports every comparator against live state', () => {
    const state = liveState({ queueDepth: 5 });
    expect(evaluatePredicate({ metric: 'queueDepth', comparator: 'gte', value: 5 }, state)).toBe(true);
    expect(evaluatePredicate({ metric: 'queueDepth', comparator: 'gt', value: 5 }, state)).toBe(false);
    expect(evaluatePredicate({ metric: 'queueDepth', comparator: 'lte', value: 5 }, state)).toBe(true);
    expect(evaluatePredicate({ metric: 'queueDepth', comparator: 'lt', value: 5 }, state)).toBe(false);
    expect(evaluatePredicate({ metric: 'queueDepth', comparator: 'eq', value: 5 }, state)).toBe(true);
    expect(evaluatePredicate({ metric: 'queueDepth', comparator: 'eq', value: 4 }, state)).toBe(false);
  });

  it('reads provider availability as a live boolean metric', () => {
    const pred = { metric: 'providerAvailable', comparator: 'eq', value: 1 } as const;
    expect(evaluatePredicate(pred, liveState({ providerAvailable: true }))).toBe(true);
    expect(evaluatePredicate(pred, liveState({ providerAvailable: false }))).toBe(false);
  });
});

describe('shouldFireGoal — pure goal predicate', () => {
  it('(acceptance a) fires when the predicate over live state is satisfied', () => {
    const decision = shouldFireGoal(trigger(), liveState({ queueDepth: 4 }), 1_000, CONFIG);
    expect(decision.fire).toBe(true);
  });

  it('(acceptance c) the predicate reads LIVE state — same trigger flips with state', () => {
    const t = trigger({ predicate: { metric: 'queueDepth', comparator: 'gte', value: 3 } });
    // Low queue depth: predicate false → no fire.
    expect(shouldFireGoal(t, liveState({ queueDepth: 1 }), 1_000, CONFIG).fire).toBe(false);
    // Queue grows past threshold: same trigger, live state changed → fire.
    expect(shouldFireGoal(t, liveState({ queueDepth: 3 }), 1_000, CONFIG).fire).toBe(true);
  });

  it('reads provider availability from live state as a firing gate', () => {
    const t = trigger({ predicate: { metric: 'providerAvailable', comparator: 'eq', value: 1 } });
    expect(shouldFireGoal(t, liveState({ providerAvailable: false }), 1_000, CONFIG).fire).toBe(false);
    expect(shouldFireGoal(t, liveState({ providerAvailable: true }), 1_000, CONFIG).fire).toBe(true);
  });

  it('never fires a paused trigger', () => {
    const decision = shouldFireGoal(
      trigger({ status: 'paused' }),
      liveState({ queueDepth: 10 }),
      1_000,
      CONFIG,
    );
    expect(decision.fire).toBe(false);
  });

  it('respects the finite fire budget (fail-closed to human re-arm)', () => {
    const decision = shouldFireGoal(
      trigger({ fireCount: CONFIG.maxFires }),
      liveState({ queueDepth: 10 }),
      1_000,
      CONFIG,
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toMatch(/maxFires/);
  });

  it('never piles missions above the concurrency cap', () => {
    const decision = shouldFireGoal(
      trigger(),
      liveState({ queueDepth: 10, runningMissions: CONFIG.maxConcurrentMissions }),
      1_000,
      CONFIG,
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toMatch(/concurrency/);
  });

  it('debounces via cooldown between two fires of the same trigger', () => {
    const t = trigger({ lastFiredAt: 1_000 });
    // Inside cooldown window → no fire.
    expect(shouldFireGoal(t, liveState({ queueDepth: 10 }), 1_000 + CONFIG.cooldownMs - 1, CONFIG).fire).toBe(false);
    // Cooldown elapsed → fire.
    expect(shouldFireGoal(t, liveState({ queueDepth: 10 }), 1_000 + CONFIG.cooldownMs, CONFIG).fire).toBe(true);
  });

  it('tolerates clock skew (lastFiredAt in the future never masks a fire forever)', () => {
    const t = trigger({ lastFiredAt: 10_000 });
    // now < lastFiredAt (negative elapsed) must not silently suppress; still gated by cooldown safely.
    const decision = shouldFireGoal(t, liveState({ queueDepth: 10 }), 5_000, CONFIG);
    expect(typeof decision.fire).toBe('boolean');
  });
});

describe('runGoalDriverTick — runtime loop', () => {
  function baseDeps(overrides: Partial<GoalDriverDeps> = {}): GoalDriverDeps {
    return {
      listScopes: () => [SCOPE],
      loadTriggers: () => [trigger()],
      readLiveState: () => liveState({ queueDepth: 5 }),
      fire: vi.fn(async () => {}),
      recordFire: vi.fn(),
      now: () => 1_000,
      ...overrides,
    };
  }

  it('(acceptance a) fires the mission when the predicate holds and records the fire', async () => {
    const fire = vi.fn(async () => {});
    const recordFire = vi.fn();
    const deps = baseDeps({ fire, recordFire });
    const result = await runGoalDriverTick(deps, CONFIG);
    expect(result.fired).toBe(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(recordFire).toHaveBeenCalledWith('goal-1', SCOPE, 1_000);
  });

  it('does not fire when the predicate is unsatisfied', async () => {
    const fire = vi.fn(async () => {});
    const deps = baseDeps({ fire, readLiveState: () => liveState({ queueDepth: 0 }) });
    const result = await runGoalDriverTick(deps, CONFIG);
    expect(result.fired).toBe(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it('(acceptance c) the tick reads live state per scope — decision follows the live snapshot', async () => {
    const fire = vi.fn(async () => {});
    let depth = 0;
    const deps = baseDeps({ fire, readLiveState: () => liveState({ queueDepth: depth }) });
    expect((await runGoalDriverTick(deps, CONFIG)).fired).toBe(0);
    depth = 9; // live state changed between ticks
    expect((await runGoalDriverTick(deps, CONFIG)).fired).toBe(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('accounts for in-tick fires so it never overshoots the concurrency cap', async () => {
    const fire = vi.fn(async () => {});
    // maxConcurrentMissions - 1 already running; two triggers both want to fire.
    const deps = baseDeps({
      fire,
      readLiveState: () => liveState({ queueDepth: 9, runningMissions: CONFIG.maxConcurrentMissions - 1 }),
      loadTriggers: () => [trigger({ id: 'g-a' }), trigger({ id: 'g-b' })],
    });
    const result = await runGoalDriverTick(deps, CONFIG);
    // Only one slot free → exactly one fires this tick.
    expect(result.fired).toBe(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing fire per trigger without aborting the tick', async () => {
    const fire = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const deps = baseDeps({
      fire,
      loadTriggers: () => [trigger({ id: 'g-a' }), trigger({ id: 'g-b' })],
    });
    const result = await runGoalDriverTick(deps, CONFIG);
    expect(result.errors).toBe(1);
    expect(result.fired).toBe(1);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('isolates a failing readLiveState per scope', async () => {
    const fire = vi.fn(async () => {});
    const deps = baseDeps({
      fire,
      listScopes: () => [SCOPE, { ...SCOPE, projectId: 'proj-2' }],
      readLiveState: (scope) => {
        if (scope.projectId === 'proj-1') throw new Error('read failed');
        return liveState({ queueDepth: 9 });
      },
    });
    const result = await runGoalDriverTick(deps, CONFIG);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.fired).toBe(1); // proj-2 still fired
  });
});

describe('coexistence with the cron (time-driven) driver', () => {
  it('(acceptance b) a goal tick and a cron tick both fire in one process without conflict', async () => {
    // Minute-aligned epoch ms: cron requires nextFireAt on a whole-minute
    // boundary (seconds=0, ms=0). 60_000_000 ms = minute 1000 exactly.
    const now = 60_000_000;

    // Goal (predicate-driven) driver fires its trigger.
    const goalFired: string[] = [];
    const goalDeps: GoalDriverDeps = {
      listScopes: () => [SCOPE],
      loadTriggers: () => [trigger()],
      readLiveState: () => liveState({ queueDepth: 5 }),
      fire: async (t) => {
        goalFired.push(t.id);
      },
      recordFire: () => {},
      now: () => now,
    };

    // Cron (time-driven) driver fires its due job — real runCronTick, faked IO.
    const cronJob: CronJob = {
      id: 'cron-1',
      name: 'nightly',
      schedule: '* * * * *',
      brief: 'scheduled work',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
      nextFireAt: now - 60_000, // previous whole minute: due, within stale window
    };
    const cronFired: string[] = [];
    const cronDeps: CronRuntimeDeps = {
      load: () => [cronJob],
      save: () => {},
      fire: async (job) => {
        cronFired.push(job.id);
      },
      executeOccurrence: async (job, _scheduledFor, fire) => {
        await fire(job);
        return { fired: true, disposition: 'completed' as const };
      },
      now: () => now,
    };

    const goalResult = await runGoalDriverTick(goalDeps, CONFIG);
    const cronCount = await runCronTick(cronDeps);

    expect(goalResult.fired).toBe(1);
    expect(goalFired).toEqual(['goal-1']);
    expect(cronCount).toBe(1);
    expect(cronFired).toEqual(['cron-1']);
    // Neither driver touched the other's fired-set: no shared mutable state.
    expect(goalFired).not.toContain('cron-1');
    expect(cronFired).not.toContain('goal-1');
  });

  it('(acceptance b) the goal loop lifecycle is independent and idempotent', () => {
    const deps: GoalDriverDeps = {
      listScopes: () => [],
      loadTriggers: () => [],
      readLiveState: () => liveState(),
      fire: async () => {},
      recordFire: () => {},
      now: () => 0,
    };
    // Idempotent start + clean stop, no throw, never touches the cron loop.
    expect(() => startGoalDriverLoop(deps, CONFIG)).not.toThrow();
    expect(() => startGoalDriverLoop(deps, CONFIG)).not.toThrow();
    expect(() => stopGoalDriverLoop()).not.toThrow();
    expect(() => stopGoalDriverLoop()).not.toThrow();
  });
});
