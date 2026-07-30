import { describe, expect, it, vi } from 'vitest';
import {
  createSchedulerRuntimeState,
  finalizeTaskForMerge,
  MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES,
  resolveEffectiveCapForTest,
  runSchedulerTick,
  type SchedulerRuntimeDeps,
  type SchedulerRuntimeTask,
} from './mission-scheduler-runtime';
import {
  DEFAULT_ADAPTIVE_CAP,
  type ActiveWorker,
  type ScheduleConfig,
} from './mission-scheduler';
import {
  decodeTaskScheduleDetail,
  encodeTaskScheduleDetail,
  withMergedFlag,
} from './mission-scheduler-meta';
import {
  BUILTIN_FEATURE_FLAGS,
  FEATURE_FLAG_IDS,
  resolveFeatureFlag,
  featureFlagDefinitionSchema,
} from '../../shared/feature-flags';
import { PARALLEL_SCHEDULER_FLAG_ID } from './mission-scheduler-runtime';
import {
  isMissionSchedulerCapacityWait,
  isMissionSchedulerRetryableDispatchError,
  MissionSchedulerCapacityWaitError,
} from './mission-scheduler-dispatch-transaction';

const NOW = 1_700_000_000_000;

function baseTask(
  id: string,
  overrides: Partial<SchedulerRuntimeTask> = {},
): SchedulerRuntimeTask {
  return {
    id,
    status: 'pending',
    dependsOn: [],
    ownership: {
      files: [`src/${id}.ts`],
      symbols: [],
      domains: [],
    },
    merged: false,
    parallelEligible: true,
    ...overrides,
  };
}

function makeDeps(opts: {
  enabled?: boolean;
  tasks?: SchedulerRuntimeTask[];
  workers?: ActiveWorker[];
  config?: ScheduleConfig;
  changedFiles?: Record<string, readonly string[]>;
  mergeThrows?: Record<string, Error>;
  dispatchThrows?: Record<string, Error>;
  dispatchDelayMs?: Record<string, number>;
  isRetryableDispatchError?: (error: unknown) => boolean;
  isCapacityWaitError?: (error: unknown) => boolean;
  onRetryableDispatchFailure?: (failure: {
    readonly taskId: string;
    readonly error: unknown;
    readonly consecutiveFailures: number;
    readonly willBlock: boolean;
  }) => void;
  useConfiguredCapForCurrentWave?: () => boolean;
  isAdaptiveCapEnabled?: () => boolean;
}): {
  deps: SchedulerRuntimeDeps;
  dispatched: string[];
  merged: string[];
  failed: { id: string; reason: string }[];
  reRuns: { id: string; reason: string }[];
} {
  const tasks = [...(opts.tasks ?? [])];
  const dispatched: string[] = [];
  const merged: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  const reRuns: { id: string; reason: string }[] = [];
  const workers = [...(opts.workers ?? [])];

  const deps: SchedulerRuntimeDeps = {
    isParallelSchedulerEnabled: () => opts.enabled ?? false,
    listTasks: () => tasks,
    listActiveWorkers: () => workers,
    scheduleConfig: () =>
      opts.config ?? { configuredCap: 4, cores: 8, paneBudget: 8 },
    ...(opts.useConfiguredCapForCurrentWave
      ? {
          useConfiguredCapForCurrentWave:
            opts.useConfiguredCapForCurrentWave,
        }
      : {}),
    ...(opts.isAdaptiveCapEnabled
      ? { isAdaptiveCapEnabled: opts.isAdaptiveCapEnabled }
      : {}),
    now: () => NOW,
    dispatchTask: async (req) => {
      const delay = opts.dispatchDelayMs?.[req.taskId] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const err = opts.dispatchThrows?.[req.taskId];
      if (err) throw err;
      dispatched.push(req.taskId);
      const t = tasks.find((x) => x.id === req.taskId);
      if (t) {
        const idx = tasks.indexOf(t);
        tasks[idx] = { ...t, status: 'running' };
        workers.push({
          taskId: req.taskId,
          ownership: req.ownership,
        });
      }
    },
    ...(opts.isRetryableDispatchError
      ? { isRetryableDispatchError: opts.isRetryableDispatchError }
      : {}),
    ...(opts.isCapacityWaitError
      ? { isCapacityWaitError: opts.isCapacityWaitError }
      : {}),
    ...(opts.onRetryableDispatchFailure
      ? { onRetryableDispatchFailure: opts.onRetryableDispatchFailure }
      : {}),
    getChangedFiles: async (taskId) =>
      opts.changedFiles?.[taskId] ?? [`src/${taskId}.ts`],
    mergeTask: async (taskId) => {
      const err = opts.mergeThrows?.[taskId];
      if (err) throw err;
    },
    markMerged: async (taskId) => {
      merged.push(taskId);
      const t = tasks.find((x) => x.id === taskId);
      if (t) {
        const idx = tasks.indexOf(t);
        tasks[idx] = { ...t, status: 'done', merged: true };
      }
      const wi = workers.findIndex((w) => w.taskId === taskId);
      if (wi >= 0) workers.splice(wi, 1);
    },
    markFailed: async (taskId, reason) => {
      failed.push({ id: taskId, reason });
      const t = tasks.find((x) => x.id === taskId);
      if (t) {
        const idx = tasks.indexOf(t);
        tasks[idx] = { ...t, status: 'failed', merged: false };
      }
      const wi = workers.findIndex((w) => w.taskId === taskId);
      if (wi >= 0) workers.splice(wi, 1);
    },
    reRunSequentially: async (taskId, reason) => {
      reRuns.push({ id: taskId, reason });
      const t = tasks.find((x) => x.id === taskId);
      if (t) {
        const idx = tasks.indexOf(t);
        tasks[idx] = { ...t, status: 'pending', merged: false };
      }
    },
  };

  return { deps, dispatched, merged, failed, reRuns };
}

describe('mission-scheduler-runtime P2 flag + driver', () => {
  it('flag off → sequential (cap 1), no fan-out of 3', async () => {
    const tasks = [baseTask('a'), baseTask('b'), baseTask('c')];
    const { deps, dispatched } = makeDeps({ enabled: false, tasks });
    const state = createSchedulerRuntimeState();
    const result = await runSchedulerTick(deps, state);
    expect(result.decision.plan.kind).toBe('dispatch');
    if (result.decision.plan.kind !== 'dispatch') return;
    expect(result.decision.plan.waveSize).toBe(1);
    expect(dispatched).toEqual(['a']);
  });

  it('flag on + 3 disjoint ready → one wave of 3', async () => {
    const tasks = [baseTask('a'), baseTask('b'), baseTask('c')];
    const { deps, dispatched } = makeDeps({ enabled: true, tasks });
    const state = createSchedulerRuntimeState({
      adaptiveCap: { ...DEFAULT_ADAPTIVE_CAP, currentCap: 3 },
    });
    const result = await runSchedulerTick(deps, state);
    expect(result.decision.plan.kind).toBe('dispatch');
    if (result.decision.plan.kind !== 'dispatch') return;
    expect(result.decision.plan.waveSize).toBe(3);
    expect(dispatched).toEqual(['a', 'b', 'c']);
    expect(result.state.telemetry.waves).toBe(1);
    expect(result.state.telemetry.maxWaveSize).toBe(3);
  });

  it('keeps ordinary tasks at the adaptive initial cap', async () => {
    const tasks = [
      baseTask('a'),
      baseTask('b'),
      baseTask('c'),
      baseTask('d'),
    ];
    const { deps, dispatched } = makeDeps({
      enabled: true,
      tasks,
      config: { configuredCap: 4, cores: 8, paneBudget: 4 },
    });

    const result = await runSchedulerTick(
      deps,
      createSchedulerRuntimeState(),
    );

    expect(result.decision.plan.kind).toBe('dispatch');
    if (result.decision.plan.kind !== 'dispatch') return;
    expect(result.decision.plan.effectiveCap).toBe(2);
    expect(result.decision.plan.waveSize).toBe(2);
    expect(dispatched).toEqual(['a', 'b']);
  });

  it('operator-choice: adaptive ladder off admits the approved configured cap', async () => {
    const tasks = [
      baseTask('a'),
      baseTask('b'),
      baseTask('c'),
      baseTask('d'),
    ];
    const { deps, dispatched } = makeDeps({
      enabled: true,
      tasks,
      config: { configuredCap: 4, cores: 8, paneBudget: 4 },
      isAdaptiveCapEnabled: () => false,
    });

    const result = await runSchedulerTick(
      deps,
      createSchedulerRuntimeState(),
    );

    expect(result.decision.plan.kind).toBe('dispatch');
    if (result.decision.plan.kind !== 'dispatch') return;
    // DEFAULT_ADAPTIVE_CAP starts at 2, but operator-choice skips the clamp.
    expect(result.decision.plan.effectiveCap).toBe(4);
    expect(result.decision.plan.waveSize).toBe(4);
    expect(dispatched).toEqual(['a', 'b', 'c', 'd']);
  });

  it('operator-choice: machine limits still bound the wave', async () => {
    const tasks = [
      baseTask('a'),
      baseTask('b'),
      baseTask('c'),
      baseTask('d'),
    ];
    const { deps, dispatched } = makeDeps({
      enabled: true,
      tasks,
      config: { configuredCap: 8, cores: 4, paneBudget: 8 },
      isAdaptiveCapEnabled: () => false,
    });

    const result = await runSchedulerTick(
      deps,
      createSchedulerRuntimeState(),
    );

    expect(result.decision.plan.kind).toBe('dispatch');
    if (result.decision.plan.kind !== 'dispatch') return;
    // cores-2 = 2 binds even without the adaptive clamp.
    expect(result.decision.plan.effectiveCap).toBe(2);
    expect(result.decision.plan.waveSize).toBe(2);
    expect(dispatched).toEqual(['a', 'b']);
  });

  it('uses the configured cap for one proven read-only team fan-out wave', async () => {
    const tasks = [
      baseTask('a'),
      baseTask('b'),
      baseTask('c'),
      baseTask('d'),
    ];
    const { deps, dispatched } = makeDeps({
      enabled: true,
      tasks,
      config: { configuredCap: 4, cores: 8, paneBudget: 4 },
      useConfiguredCapForCurrentWave: () => true,
    });

    const result = await runSchedulerTick(
      deps,
      createSchedulerRuntimeState(),
    );

    expect(result.decision.plan.kind).toBe('dispatch');
    if (result.decision.plan.kind !== 'dispatch') return;
    expect(result.decision.plan.effectiveCap).toBe(4);
    expect(result.decision.plan.waveSize).toBe(4);
    expect(dispatched).toEqual(['a', 'b', 'c', 'd']);
    expect(result.state.adaptiveCap).toEqual(DEFAULT_ADAPTIVE_CAP);
  });

  it('still honors the CPU ceiling for a read-only team fan-out wave', async () => {
    const tasks = [
      baseTask('a'),
      baseTask('b'),
      baseTask('c'),
      baseTask('d'),
    ];
    const { deps, dispatched } = makeDeps({
      enabled: true,
      tasks,
      config: { configuredCap: 8, cores: 4, paneBudget: 8 },
      useConfiguredCapForCurrentWave: () => true,
    });

    const result = await runSchedulerTick(
      deps,
      createSchedulerRuntimeState(),
    );

    expect(result.decision.plan.kind).toBe('dispatch');
    if (result.decision.plan.kind !== 'dispatch') return;
    expect(result.decision.plan.effectiveCap).toBe(2);
    expect(result.decision.plan.waveSize).toBe(2);
    expect(dispatched).toEqual(['a', 'b']);
  });

  it('parallel wave keeps siblings and retries a transient spawn failure', async () => {
    const tasks = [baseTask('a'), baseTask('b'), baseTask('c')];
    const { deps, dispatched, failed } = makeDeps({
      enabled: true,
      tasks,
      dispatchThrows: { b: new Error('spawn denied') },
      dispatchDelayMs: { a: 20, c: 20 },
      isRetryableDispatchError: isMissionSchedulerRetryableDispatchError,
    });
    const state = createSchedulerRuntimeState({
      adaptiveCap: { ...DEFAULT_ADAPTIVE_CAP, currentCap: 3 },
    });
    const result = await runSchedulerTick(deps, state);
    expect(result.decision.plan.kind).toBe('dispatch');
    if (result.decision.plan.kind !== 'dispatch') return;
    expect(result.decision.plan.waveSize).toBe(3);
    expect(dispatched.sort()).toEqual(['a', 'c']);
    expect(failed).toEqual([]);
    expect([...result.dispatched].sort()).toEqual(['a', 'c']);
  });

  it('marks proven dispatch corruption terminal', async () => {
    const tasks = [baseTask('a')];
    const corruption = new Error('dispatch store is corrupt');
    corruption.name = 'ScopedStoreCorruptionError';
    const { deps, failed } = makeDeps({
      enabled: true,
      tasks,
      dispatchThrows: { a: corruption },
      isRetryableDispatchError: isMissionSchedulerRetryableDispatchError,
    });

    await runSchedulerTick(deps, createSchedulerRuntimeState());

    expect(failed).toEqual([{ id: 'a', reason: corruption.message }]);
  });

  it('keeps a task pending when worker capacity changed after scheduling', async () => {
    const tasks = [baseTask('a')];
    const capacity = new Error('capacity_wait: maxWorkers=1 is occupied');
    const { deps, dispatched, failed } = makeDeps({
      enabled: true,
      tasks,
      dispatchThrows: { a: capacity },
      isRetryableDispatchError: (error) => error === capacity,
    });

    const result = await runSchedulerTick(
      deps,
      createSchedulerRuntimeState(),
    );

    expect(result.dispatched).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(failed).toEqual([]);
    expect(tasks[0]?.status).toBe('pending');
  });

  it('automatically dispatches on the next tick after a transient spawn clears', async () => {
    const tasks = [baseTask('a')];
    const dispatchThrows: Record<string, Error> = {
      a: new Error('provider process exited during boot'),
    };
    const { deps, dispatched, failed } = makeDeps({
      enabled: true,
      tasks,
      dispatchThrows,
      isRetryableDispatchError: isMissionSchedulerRetryableDispatchError,
    });
    const first = await runSchedulerTick(
      deps,
      createSchedulerRuntimeState(),
    );
    expect(first.dispatched).toEqual([]);
    expect(failed).toEqual([]);

    delete dispatchThrows.a;
    const second = await runSchedulerTick(deps, first.state);

    expect(second.dispatched).toEqual(['a']);
    expect(dispatched).toEqual(['a']);
    expect(failed).toEqual([]);
  });

  it('forwards cancellation into dispatch and rethrows the exact reconciler reason', async () => {
    const tasks = [baseTask('a')];
    const controller = new AbortController();
    const reason = new Error('participant mission-scheduler exceeded 30000ms');
    const fixture = makeDeps({ enabled: false, tasks });
    const dispatchTask = vi.fn(
      async (_request: unknown, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(reason);
      },
    );

    await expect(
      runSchedulerTick(
        {
          ...fixture.deps,
          dispatchTask,
        },
        createSchedulerRuntimeState(),
        controller.signal,
      ),
    ).rejects.toBe(reason);

    expect(dispatchTask).toHaveBeenCalledOnce();
    expect(fixture.failed).toEqual([]);
    expect(tasks[0]?.status).toBe('pending');
  });

  it('dependent task waits for next wave after merge', async () => {
    const tasks = [
      baseTask('a'),
      baseTask('b', { dependsOn: ['a'] }),
      baseTask('c'),
    ];
    const { deps, dispatched } = makeDeps({ enabled: true, tasks });
    const state = createSchedulerRuntimeState({
      adaptiveCap: { ...DEFAULT_ADAPTIVE_CAP, currentCap: 3 },
    });
    const first = await runSchedulerTick(deps, state);
    expect(first.dispatched).toEqual(['a', 'c']);
    expect(dispatched).toEqual(['a', 'c']);

    // Simulate a+c finished merge
    const after: SchedulerRuntimeTask[] = [
      baseTask('a', { status: 'done', merged: true }),
      baseTask('b', { dependsOn: ['a'] }),
      baseTask('c', { status: 'done', merged: true }),
    ];
    const round2 = makeDeps({ enabled: true, tasks: after });
    const second = await runSchedulerTick(round2.deps, first.state);
    expect(second.dispatched).toEqual(['b']);
  });
});

describe('mission-scheduler-runtime pre-claim failure observability + bound', () => {
  it('surfaces consecutive retryable failures and blocks the task at the bound', async () => {
    const tasks = [baseTask('a')];
    const stuck = new Error(
      'roster_route_unavailable: CLI agy do agente Advisor não está instalada',
    );
    const seen: {
      taskId: string;
      consecutiveFailures: number;
      willBlock: boolean;
    }[] = [];
    const { deps, dispatched, failed } = makeDeps({
      enabled: true,
      tasks,
      dispatchThrows: { a: stuck },
      isRetryableDispatchError: isMissionSchedulerRetryableDispatchError,
      isCapacityWaitError: isMissionSchedulerCapacityWait,
      onRetryableDispatchFailure: (failure) => {
        seen.push({
          taskId: failure.taskId,
          consecutiveFailures: failure.consecutiveFailures,
          willBlock: failure.willBlock,
        });
      },
    });

    let state = createSchedulerRuntimeState();
    for (
      let tick = 1;
      tick < MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES;
      tick += 1
    ) {
      const result = await runSchedulerTick(deps, state);
      state = result.state;
      expect(failed).toEqual([]);
      expect(tasks[0]?.status).toBe('pending');
    }
    expect(seen.map((entry) => entry.consecutiveFailures)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(seen.every((entry) => !entry.willBlock)).toBe(true);

    const blocking = await runSchedulerTick(deps, state);
    state = blocking.state;
    expect(seen).toHaveLength(MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES);
    expect(seen.at(-1)).toEqual({
      taskId: 'a',
      consecutiveFailures: MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES,
      willBlock: true,
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toBe('a');
    expect(failed[0]?.reason).toContain('roster_route_unavailable');
    expect(dispatched).toEqual([]);

    // Terminal task leaves the ready set: no further silent retries.
    const after = await runSchedulerTick(deps, state);
    expect(after.decision.plan.kind).toBe('idle-failed');
    expect(seen).toHaveLength(
      MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES,
    );
  });

  it('never counts bounded capacity waits toward the pre-claim failure bound', async () => {
    const tasks = [baseTask('a')];
    const capacity = new MissionSchedulerCapacityWaitError('slot occupied');
    const seen: number[] = [];
    const { deps, failed } = makeDeps({
      enabled: true,
      tasks,
      dispatchThrows: { a: capacity },
      isRetryableDispatchError: isMissionSchedulerRetryableDispatchError,
      isCapacityWaitError: isMissionSchedulerCapacityWait,
      onRetryableDispatchFailure: (failure) => {
        seen.push(failure.consecutiveFailures);
      },
    });

    let state = createSchedulerRuntimeState();
    for (
      let tick = 0;
      tick < MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES + 2;
      tick += 1
    ) {
      const result = await runSchedulerTick(deps, state);
      state = result.state;
    }

    expect(failed).toEqual([]);
    expect(seen).toEqual([]);
    expect(tasks[0]?.status).toBe('pending');
  });

  it('unblocks the exclusive QA gate once the permanently failing advisor is blocked', async () => {
    // Reproduces the physical release E2E stall: the agy advisor (sealed
    // route unresolvable) sorted ahead of the sequential-only QA task in
    // every ready set; each tick admitted the advisor first and deferred the
    // exclusive QA, while the advisor's retryable failure stayed silent.
    const advisorError = new Error(
      'roster_route_unavailable: CLI agy do agente Advisor não está instalada',
    );
    const tasks: SchedulerRuntimeTask[] = [
      baseTask('a-advisor', {
        ownership: { files: [], symbols: [], domains: ['guided-advisory'] },
      }),
      baseTask('q-qa', {
        dependsOn: ['r-reviewer'],
        ownership: {
          files: [],
          symbols: [],
          domains: ['guided-quality-gate'],
        },
        parallelEligible: false,
      }),
      baseTask('r-reviewer', {
        status: 'done',
        merged: true,
        ownership: {
          files: [],
          symbols: [],
          domains: ['guided-independent-review'],
        },
      }),
    ];
    const { deps, dispatched, failed } = makeDeps({
      enabled: true,
      tasks,
      dispatchThrows: { 'a-advisor': advisorError },
      isRetryableDispatchError: isMissionSchedulerRetryableDispatchError,
      isCapacityWaitError: isMissionSchedulerCapacityWait,
    });

    let state = createSchedulerRuntimeState();
    for (
      let tick = 0;
      tick < MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES;
      tick += 1
    ) {
      const result = await runSchedulerTick(deps, state);
      state = result.state;
      // The advisor is admitted first every tick; QA's exclusive slot
      // requires an empty wave, so it never dispatches while the advisor
      // stays pending.
      expect(dispatched).not.toContain('q-qa');
    }
    expect(failed.map((entry) => entry.id)).toEqual(['a-advisor']);

    const unblocked = await runSchedulerTick(deps, state);
    expect(unblocked.dispatched).toEqual(['q-qa']);
    expect(dispatched).toEqual(['q-qa']);
  });
});

describe('mission-scheduler-runtime P3 fail-closed merge', () => {
  it('out-of-scope diff rejects merge and sequential re-run path is taken', async () => {
    const tasks = [
      baseTask('a', {
        status: 'running',
        ownership: { files: ['src/a.ts'], symbols: [], domains: [] },
      }),
    ];
    const { deps, reRuns, failed, merged } = makeDeps({
      enabled: true,
      tasks,
      changedFiles: {
        a: ['src/a.ts', 'src/evil.ts'],
      },
    });
    const state = createSchedulerRuntimeState();
    const { outcome, state: next } = await finalizeTaskForMerge(
      deps,
      state,
      'a',
    );
    expect(outcome.kind).toBe('violation');
    expect(merged).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(reRuns).toEqual([
      expect.objectContaining({ id: 'a' }),
    ]);
    expect(next.telemetry.violations).toBe(1);
    expect(next.adaptiveCap.currentCap).toBe(1);
  });

  it('merge conflict serializes via sequential re-run', async () => {
    const tasks = [
      baseTask('a', {
        status: 'running',
        ownership: { files: ['src/a.ts'], symbols: [], domains: [] },
      }),
    ];
    const conflict = new Error('MergeConflictError: files conflicted');
    conflict.name = 'MergeConflictError';
    const { deps, reRuns, merged } = makeDeps({
      enabled: true,
      tasks,
      changedFiles: { a: ['src/a.ts'] },
      mergeThrows: { a: conflict },
    });
    const state = createSchedulerRuntimeState({
      adaptiveCap: { ...DEFAULT_ADAPTIVE_CAP, currentCap: 3 },
    });
    const { outcome, state: next } = await finalizeTaskForMerge(
      deps,
      state,
      'a',
    );
    expect(outcome.kind).toBe('conflict');
    expect(merged).toEqual([]);
    expect(reRuns).toHaveLength(1);
    expect(next.telemetry.conflicts).toBe(1);
    expect(next.adaptiveCap.currentCap).toBe(2);
  });

  it('clean within-ownership merge marks merged', async () => {
    const tasks = [
      baseTask('a', {
        status: 'running',
        ownership: { files: ['src/a.ts'], symbols: [], domains: [] },
      }),
    ];
    const { deps, merged, reRuns } = makeDeps({
      enabled: true,
      tasks,
      changedFiles: { a: ['src/a.ts'] },
    });
    const { outcome } = await finalizeTaskForMerge(
      deps,
      createSchedulerRuntimeState(),
      'a',
    );
    expect(outcome.kind).toBe('merged');
    expect(merged).toEqual(['a']);
    expect(reRuns).toEqual([]);
  });
});

describe('mission-scheduler-runtime P4 flag registration + adaptive', () => {
  it('registers orch.parallelScheduler enabled for release configuration', () => {
    // Built-in registry uses FEATURE_FLAG_IDS; also assert runtime constant.
    expect(PARALLEL_SCHEDULER_FLAG_ID).toBe('orch.parallelScheduler');
    expect(FEATURE_FLAG_IDS.parallelScheduler).toBe('orch.parallelScheduler');

    const def = BUILTIN_FEATURE_FLAGS.find(
      (f) => f.id === FEATURE_FLAG_IDS.parallelScheduler,
    );
    expect(def).toBeDefined();
    expect(() => featureFlagDefinitionSchema.parse(def)).not.toThrow();
    expect(def!.defaultEnabled).toBe(true);
    expect(def!.killSwitch).toBe(false);

    const resolved = resolveFeatureFlag(def, { runtimeChannel: 'dev' });
    expect(resolved.enabled).toBe(true);
    expect(resolved.reason).toBe('default');

    // Override can enable; kill switch would still win if set.
    expect(
      resolveFeatureFlag(def, { runtimeChannel: 'dev', override: true })
        .enabled,
    ).toBe(true);
  });

  it('adaptive cap starts at 2–3 and effective cap honors flag', () => {
    const base: ScheduleConfig = {
      configuredCap: 8,
      cores: 16,
      paneBudget: 8,
    };
    expect(
      resolveEffectiveCapForTest(base, DEFAULT_ADAPTIVE_CAP, false),
    ).toBe(1);
    expect(
      resolveEffectiveCapForTest(base, DEFAULT_ADAPTIVE_CAP, true),
    ).toBe(2);
    expect(
      resolveEffectiveCapForTest(
        base,
        { ...DEFAULT_ADAPTIVE_CAP, currentCap: 3 },
        true,
      ),
    ).toBe(3);
    // Operator-choice (adaptive ladder off): the configured cap is the wave
    // cap, still bounded by machine limits (cores-2, paneBudget).
    expect(
      resolveEffectiveCapForTest(base, DEFAULT_ADAPTIVE_CAP, true, false),
    ).toBe(8);
    expect(
      resolveEffectiveCapForTest(
        { ...base, configuredCap: 8, cores: 4 },
        DEFAULT_ADAPTIVE_CAP,
        true,
        false,
      ),
    ).toBe(2);
  });
});

describe('task schedule meta codec', () => {
  it('round-trips ownership + dependsOn + merged on detail', () => {
    const encoded = encodeTaskScheduleDetail('implement auth', {
      dependsOn: ['t0'],
      ownership: {
        files: ['src/auth.ts'],
        symbols: ['Auth'],
        domains: ['auth'],
      },
      merged: false,
      parallelEligible: true,
      agentRef: 'backend',
      agentCategory: 'executor',
      executionMode: 'isolated_worktree',
    });
    const decoded = decodeTaskScheduleDetail(encoded);
    expect(decoded.body).toBe('implement auth');
    expect(decoded.meta).toMatchObject({
      dependsOn: ['t0'],
      ownership: {
        files: ['src/auth.ts'],
        symbols: ['Auth'],
        domains: ['auth'],
      },
      merged: false,
      parallelEligible: true,
      agentRef: 'backend',
      agentCategory: 'executor',
      executionMode: 'isolated_worktree',
    });
    const merged = withMergedFlag(encoded, true);
    expect(decodeTaskScheduleDetail(merged).meta?.merged).toBe(true);
  });
});
