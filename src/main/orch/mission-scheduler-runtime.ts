/**
 * Parallel Task Scheduler runtime driver (P2–P4).
 *
 * Thin apply layer: pure `decideSchedule` → worktree create → worker spawn →
 * MergeQueue enqueue. All IO is injected. Behind flag `orch.parallelScheduler`.
 *
 * Fail-closed (P3): pre-merge ownership diff enforcement; conflict/violation
 * → sequential re-run on merged base (no concurrent peers).
 */

import {
  decideAdaptiveCap,
  decideSchedule,
  enforceOwnershipOnDiff,
  recordConflictTelemetry,
  recordScheduleTelemetry,
  recordViolationTelemetry,
  type ActiveWorker,
  type AdaptiveCapState,
  type ScheduleConfig,
  type ScheduleDecision,
  type ScheduleOwnership,
  type SchedulePlan,
  type ScheduleTask,
  type SchedulerTelemetry,
  DEFAULT_ADAPTIVE_CAP,
  EMPTY_SCHEDULER_TELEMETRY,
  effectiveConcurrencyCap,
} from './mission-scheduler';

export const PARALLEL_SCHEDULER_FLAG_ID = 'orch.parallelScheduler' as const;

export interface SchedulerRuntimeTask {
  readonly id: string;
  readonly status: ScheduleTask['status'];
  readonly dependsOn: readonly string[];
  readonly ownership: ScheduleOwnership;
  readonly merged: boolean;
  /** When false, task is never admitted under parallel policy (sequential only). */
  readonly parallelEligible?: boolean;
}

export interface SchedulerDispatchRequest {
  readonly taskId: string;
  readonly ownership: ScheduleOwnership;
  readonly dependsOn: readonly string[];
  readonly sequentialOnly: boolean;
}

export type SchedulerMergeOutcome =
  | { readonly kind: 'merged'; readonly taskId: string }
  | {
      readonly kind: 'conflict';
      readonly taskId: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'violation';
      readonly taskId: string;
      readonly undeclaredFiles: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: 'failed';
      readonly taskId: string;
      readonly reason: string;
    };

export interface SchedulerRuntimeDeps {
  /** Feature flag resolution; must fail closed when unknown. */
  isParallelSchedulerEnabled(): boolean;
  listTasks(): readonly SchedulerRuntimeTask[];
  listActiveWorkers(): readonly ActiveWorker[];
  scheduleConfig(): ScheduleConfig;
  now(): number;
  /** Optional blast-radius expander (pure file set). */
  expandFiles?(files: readonly string[]): readonly string[];
  /** Create worktree + spawn worker pane for one task. */
  dispatchTask(request: SchedulerDispatchRequest): Promise<void>;
  /**
   * Prepare merge: return changed files for ownership enforcement, then
   * caller invokes mergeTask after enforcement passes.
   */
  getChangedFiles(taskId: string): Promise<readonly string[]>;
  /** Serial merge via MergeQueue. Throws on git conflict. */
  mergeTask(taskId: string): Promise<void>;
  /** Mark task status / merged flag after outcomes. */
  markMerged(taskId: string): Promise<void>;
  markFailed(taskId: string, reason: string): Promise<void>;
  /**
   * Sequential re-run: abandon parallel worktree and re-dispatch alone
   * on the current merged base (no other workers for this mission).
   */
  reRunSequentially(taskId: string, reason: string): Promise<void>;
  onTelemetry?(telemetry: SchedulerTelemetry, plan: SchedulePlan): void;
  onDecision?(decision: ScheduleDecision): void;
}

export interface SchedulerRuntimeState {
  telemetry: SchedulerTelemetry;
  adaptiveCap: AdaptiveCapState;
}

export function createSchedulerRuntimeState(
  seed?: Partial<SchedulerRuntimeState>,
): SchedulerRuntimeState {
  return {
    telemetry: seed?.telemetry ?? { ...EMPTY_SCHEDULER_TELEMETRY },
    adaptiveCap: seed?.adaptiveCap ?? { ...DEFAULT_ADAPTIVE_CAP },
  };
}

function toScheduleTasks(
  tasks: readonly SchedulerRuntimeTask[],
): ScheduleTask[] {
  return tasks.map((t) => {
    // Non-eligible tasks force sequential-only domain so pure decideSchedule
    // never fans them out with peers (exclusive slot).
    const ownership =
      t.parallelEligible === false
        ? {
            files: t.ownership.files,
            symbols: t.ownership.symbols,
            domains: Object.freeze(
              t.ownership.domains.includes('sequential-only')
                ? [...t.ownership.domains]
                : [...t.ownership.domains, 'sequential-only'],
            ),
          }
        : t.ownership;
    return {
      id: t.id,
      status: t.status,
      dependsOn: t.dependsOn,
      ownership,
      merged: t.merged,
    };
  });
}

function resolveConfig(
  deps: SchedulerRuntimeDeps,
  state: SchedulerRuntimeState,
  parallelEnabled: boolean,
): ScheduleConfig {
  const base = deps.scheduleConfig();
  if (!parallelEnabled) {
    return {
      configuredCap: 1,
      cores: base.cores,
      paneBudget: base.paneBudget,
    };
  }
  // Adaptive cap is the configured ceiling when flag is on (starts 2–3).
  return {
    configuredCap: Math.min(base.configuredCap, state.adaptiveCap.currentCap),
    cores: base.cores,
    paneBudget: base.paneBudget,
  };
}

/**
 * One scheduler tick: decide + optionally dispatch admitted tasks.
 * Does not process merges (use `finalizeTaskForMerge` on task completion).
 */
export async function runSchedulerTick(
  deps: SchedulerRuntimeDeps,
  state: SchedulerRuntimeState,
): Promise<{
  readonly decision: ScheduleDecision;
  readonly state: SchedulerRuntimeState;
  readonly dispatched: readonly string[];
}> {
  const parallelEnabled = deps.isParallelSchedulerEnabled();
  const tasks = toScheduleTasks(deps.listTasks());
  const config = resolveConfig(deps, state, parallelEnabled);
  const decision = decideSchedule(
    tasks,
    deps.listActiveWorkers(),
    config,
    deps.now(),
    deps.expandFiles,
  );
  deps.onDecision?.(decision);

  let nextState = state;
  const dispatched: string[] = [];

  if (decision.plan.kind === 'dispatch') {
    const taskMap = new Map(deps.listTasks().map((t) => [t.id, t]));
    // Partial dispatch failure must not leave siblings marked dispatched without
    // a real spawn — fail closed: stop the wave on first dispatch error.
    for (const taskId of decision.plan.taskIds) {
      const task = taskMap.get(taskId);
      if (!task) continue;
      const sequentialOnly =
        !parallelEnabled ||
        task.parallelEligible === false ||
        decision.plan.waveSize <= 1;
      try {
        await deps.dispatchTask({
          taskId,
          ownership: task.ownership,
          dependsOn: task.dependsOn,
          sequentialOnly,
        });
        dispatched.push(taskId);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'dispatch failed';
        await deps.markFailed(taskId, reason);
        break;
      }
    }
    const telemetry = recordScheduleTelemetry(nextState.telemetry, decision.plan);
    const adaptiveCap = decideAdaptiveCap(nextState.adaptiveCap, {
      kind: 'wave',
      waveSize: decision.plan.waveSize,
    });
    nextState = { telemetry, adaptiveCap };
    deps.onTelemetry?.(telemetry, decision.plan);
  }

  return {
    decision,
    state: nextState,
    dispatched: Object.freeze(dispatched),
  };
}

/**
 * Pre-merge ownership enforcement + merge. Fail-closed on violation/conflict.
 */
export async function finalizeTaskForMerge(
  deps: SchedulerRuntimeDeps,
  state: SchedulerRuntimeState,
  taskId: string,
): Promise<{
  readonly outcome: SchedulerMergeOutcome;
  readonly state: SchedulerRuntimeState;
}> {
  const tasks = deps.listTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      outcome: {
        kind: 'failed',
        taskId,
        reason: 'task not found',
      },
      state,
    };
  }

  let changedFiles: readonly string[];
  try {
    changedFiles = await deps.getChangedFiles(taskId);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'failed to read worktree diff';
    await deps.markFailed(taskId, reason);
    return {
      outcome: { kind: 'failed', taskId, reason },
      state,
    };
  }

  const enforcement = enforceOwnershipOnDiff(
    changedFiles,
    task.ownership,
    deps.expandFiles,
  );
  if (!enforcement.ok) {
    const telemetry = recordViolationTelemetry(state.telemetry);
    const adaptiveCap = decideAdaptiveCap(state.adaptiveCap, {
      kind: 'violation',
    });
    const next = { telemetry, adaptiveCap };
    await deps.markFailed(taskId, enforcement.reason);
    await deps.reRunSequentially(taskId, enforcement.reason);
    return {
      outcome: {
        kind: 'violation',
        taskId,
        undeclaredFiles: enforcement.undeclaredFiles,
        reason: enforcement.reason,
      },
      state: next,
    };
  }

  try {
    await deps.mergeTask(taskId);
    await deps.markMerged(taskId);
    return {
      outcome: { kind: 'merged', taskId },
      state,
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'merge failed';
    const isConflict =
      /conflict/i.test(reason) ||
      (error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        String((error as { name: unknown }).name).includes('Conflict'));
    if (isConflict) {
      const telemetry = recordConflictTelemetry(state.telemetry);
      const adaptiveCap = decideAdaptiveCap(state.adaptiveCap, {
        kind: 'conflict',
      });
      const next = { telemetry, adaptiveCap };
      await deps.markFailed(taskId, reason);
      await deps.reRunSequentially(taskId, reason);
      return {
        outcome: { kind: 'conflict', taskId, reason },
        state: next,
      };
    }
    await deps.markFailed(taskId, reason);
    return {
      outcome: { kind: 'failed', taskId, reason },
      state,
    };
  }
}

/** Test helper: expose effective cap with adaptive state + flag. */
export function resolveEffectiveCapForTest(
  base: ScheduleConfig,
  adaptive: AdaptiveCapState,
  parallelEnabled: boolean,
): number {
  if (!parallelEnabled) {
    return effectiveConcurrencyCap({
      configuredCap: 1,
      cores: base.cores,
      paneBudget: base.paneBudget,
    });
  }
  return effectiveConcurrencyCap({
    configuredCap: Math.min(base.configuredCap, adaptive.currentCap),
    cores: base.cores,
    paneBudget: base.paneBudget,
  });
}
