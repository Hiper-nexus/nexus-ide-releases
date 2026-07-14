import { describe, expect, it } from 'vitest';
import {
  createSchedulerRuntimeState,
  finalizeTaskForMerge,
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
    now: () => NOW,
    dispatchTask: async (req) => {
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
  it('registers orch.parallelScheduler on by default (internal dogfood)', () => {
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

    // An explicit override still wins over the default (a kill switch would too):
    // an install can force it back on, and — for debugging — off.
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
    });
    const merged = withMergedFlag(encoded, true);
    expect(decodeTaskScheduleDetail(merged).meta?.merged).toBe(true);
  });
});
