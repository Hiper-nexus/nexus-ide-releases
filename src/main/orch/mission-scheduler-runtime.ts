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
import { throwIfMissionSchedulerAborted } from './mission-scheduler-abort';
import {
  clearOwnershipWaitEdge,
  crossMissionOwnershipConflict,
  decideOwnershipWait,
  ownershipWaitEdges,
  pruneOwnershipWaitEdgesForMission,
  recordOwnershipWaitEdge,
  type OwnershipWaitDecision,
} from './mission-ownership-wait';

export const PARALLEL_SCHEDULER_FLAG_ID = 'orch.parallelScheduler' as const;

/**
 * Consecutive pre-claim retryable dispatch failures tolerated for one task
 * before the failure is escalated through `markFailed` (production persists
 * an observable pre-claim block). Capacity waits are excluded: they carry
 * their own natural bound (lease expiry / sibling completion). At a 5s
 * scheduler tick, six consecutive failures surface in ~30s instead of
 * hanging silently forever.
 */
export const MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES = 6 as const;

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
  /**
   * A bounded, non-mutating wave may use the approved configured ceiling
   * without teaching the adaptive writer cap from conflict-free reads.
   */
  useConfiguredCapForCurrentWave?(
    tasks: readonly SchedulerRuntimeTask[],
  ): boolean;
  /**
   * Adaptive cap ladder gate. When it returns false (operator-choice default:
   * frictionless parallel path), the wave cap is the approved configured
   * ceiling with no adaptive clamp. Defaults to true (governed keeps the
   * conservative ladder).
   */
  isAdaptiveCapEnabled?(): boolean;
  now(): number;
  /** Optional blast-radius expander (pure file set). */
  expandFiles?(files: readonly string[]): readonly string[];
  /** Create worktree + spawn worker pane for one task. */
  dispatchTask(
    request: SchedulerDispatchRequest,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Temporary admission failures (for example a maxWorkers slot claimed
   * between decision and durable claim) leave the task pending for a later
   * scheduler tick instead of fabricating a terminal task failure.
   */
  isRetryableDispatchError?(error: unknown): boolean;
  /**
   * Distinguishes bounded capacity waits (lease/slot reservation) from other
   * retryable failures. Capacity waits never count toward the pre-claim
   * failure bound and need no failure telemetry of their own.
   */
  isCapacityWaitError?(error: unknown): boolean;
  /**
   * Identity of the mission this tick schedules. Required to tell a REAL
   * cross-mission ownership collision (enqueue, naming the holder) from an
   * intra-mission one (`decideSchedule` is the authority there). When absent
   * the cross-mission wait lane is off and every overlap keeps today's
   * behaviour — fail-safe, never fail-open.
   */
  missionId?(): string;
  /**
   * Observability hook for a cross-mission ownership collision: fired once per
   * tick per waiting task, including the tick that expires the ceiling or
   * names a deadlock. This is the only surface a plain `wait` reaches, so
   * production wires the operator-facing log here.
   */
  onOwnershipWait?(wait: {
    readonly taskId: string;
    readonly decision: OwnershipWaitDecision;
  }): void;
  /**
   * Observability hook for retryable pre-claim dispatch failures, called once
   * per failed attempt with the consecutive count for that task. Production
   * wires a throttled warn so a stuck task is never silent; `willBlock`
   * marks the attempt that escalates to `markFailed`.
   */
  onRetryableDispatchFailure?(failure: {
    readonly taskId: string;
    readonly error: unknown;
    readonly consecutiveFailures: number;
    readonly willBlock: boolean;
  }): void;
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

/**
 * Uma tarefa parada por colisão REAL com outra missão. `since` é o começo da
 * espera e nunca é reiniciado enquanto ela dura: o teto mede quanto a tarefa
 * ficou parada, não quanto o detentor da vez segurou.
 */
export interface OwnershipWaitRecord {
  readonly since: number;
  /** Detentor da vez, para não recontar o mesmo como novo a cada tick. */
  readonly holderKey: string;
  /** Quantos detentores distintos já bloquearam a tarefa nesta espera. */
  readonly holdersSeen: number;
}

export interface SchedulerRuntimeState {
  telemetry: SchedulerTelemetry;
  adaptiveCap: AdaptiveCapState;
  /**
   * Consecutive pre-claim retryable dispatch failures per task id. Cleared on
   * the first successful dispatch or terminal mark; capacity waits are never
   * counted.
   */
  preClaimRetryableFailures: Readonly<Record<string, number>>;
  /**
   * Cross-mission ownership waits in flight, per task id. A wait is not a
   * failure and never touches `preClaimRetryableFailures`; its bound is
   * `OWNERSHIP_WAIT_CEILING_MS`, not a failure count.
   */
  ownershipWaits: Readonly<Record<string, OwnershipWaitRecord>>;
}

export function createSchedulerRuntimeState(
  seed?: Partial<SchedulerRuntimeState>,
): SchedulerRuntimeState {
  return {
    telemetry: seed?.telemetry ?? { ...EMPTY_SCHEDULER_TELEMETRY },
    adaptiveCap: seed?.adaptiveCap ?? { ...DEFAULT_ADAPTIVE_CAP },
    preClaimRetryableFailures: seed?.preClaimRetryableFailures ?? {},
    ownershipWaits: seed?.ownershipWaits ?? {},
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
  useConfiguredCap: boolean,
): ScheduleConfig {
  const base = deps.scheduleConfig();
  if (!parallelEnabled) {
    return {
      configuredCap: 1,
      cores: base.cores,
      paneBudget: base.paneBudget,
    };
  }
  if (useConfiguredCap) return base;
  if (deps.isAdaptiveCapEnabled?.() === false) {
    // Operator-choice (default): the approved configured ceiling IS the wave
    // cap — frictionless parallel path, no adaptive clamp. Machine limits
    // (cores/panes) still apply downstream in effectiveConcurrencyCap.
    return base;
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
  signal?: AbortSignal,
): Promise<{
  readonly decision: ScheduleDecision;
  readonly state: SchedulerRuntimeState;
  readonly dispatched: readonly string[];
}> {
  throwIfMissionSchedulerAborted(signal);
  const parallelEnabled = deps.isParallelSchedulerEnabled();
  const runtimeTasks = deps.listTasks();
  const useConfiguredCap =
    parallelEnabled &&
    deps.useConfiguredCapForCurrentWave?.(runtimeTasks) === true;
  const tasks = toScheduleTasks(runtimeTasks);
  const config = resolveConfig(
    deps,
    state,
    parallelEnabled,
    useConfiguredCap,
  );
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
    // Capture the narrowed variant: inside the async closure below TypeScript
    // can no longer prove `decision.plan` is still the dispatch member.
    const dispatchPlan = decision.plan;
    const taskMap = new Map(runtimeTasks.map((t) => [t.id, t]));
    const waveParallel = parallelEnabled && dispatchPlan.waveSize > 1;
    const preClaimFailures = new Map(
      Object.entries(state.preClaimRetryableFailures),
    );
    const ownershipWaits = new Map(Object.entries(state.ownershipWaits));
    const waiterMissionId = deps.missionId?.() ?? null;

    const endOwnershipWait = (taskId: string): void => {
      ownershipWaits.delete(taskId);
      if (waiterMissionId !== null) {
        clearOwnershipWaitEdge(waiterMissionId, taskId);
      }
    };

    /**
     * Colisão REAL com outra missão: enfileirar em vez de matar. Devolve
     * `true` quando este erro foi tratado como espera (ou como o fim nomeado
     * dela) e o caminho de falha normal não deve mais ser percorrido.
     */
    const handleCrossMissionOwnership = async (
      taskId: string,
      error: unknown,
    ): Promise<boolean> => {
      if (waiterMissionId === null) return false;
      const conflict = crossMissionOwnershipConflict(error, waiterMissionId);
      if (conflict === null) return false;

      const holderKey = `${conflict.holderMissionId}/${conflict.holderTaskId}`;
      const previous = ownershipWaits.get(taskId);
      const since = previous?.since ?? deps.now();
      const holdersSeen =
        previous === undefined
          ? 1
          : previous.holderKey === holderKey
            ? previous.holdersSeen
            : previous.holdersSeen + 1;

      // The edge goes in BEFORE the decision so the cycle check sees this
      // mission's own wait: a deadlock is only provable with both halves.
      recordOwnershipWaitEdge({
        waiterMissionId,
        waiterTaskId: taskId,
        holderMissionId: conflict.holderMissionId,
        holderTaskId: conflict.holderTaskId,
        since,
      });
      const decision = decideOwnershipWait({
        conflict,
        waiter: { missionId: waiterMissionId, taskId },
        since,
        now: deps.now(),
        holdersSeen,
        edges: ownershipWaitEdges(),
      });
      deps.onOwnershipWait?.({ taskId, decision });

      if (decision.kind === 'wait') {
        // A wait is not a failure: it must never feed the pre-claim bound,
        // which would turn a healthy queue into the very 5-tasks-in-4s death
        // this lane exists to prevent.
        preClaimFailures.delete(taskId);
        ownershipWaits.set(taskId, { since, holderKey, holdersSeen });
        return true;
      }

      // Ceiling blown or mutual wait: the wait is over and says why.
      endOwnershipWait(taskId);
      preClaimFailures.delete(taskId);
      await deps.markFailed(taskId, decision.reason);
      return true;
    };

    const dispatchOne = async (taskId: string): Promise<string | null> => {
      throwIfMissionSchedulerAborted(signal);
      const task = taskMap.get(taskId);
      if (!task) return null;
      try {
        await deps.dispatchTask(
          {
            taskId,
            ownership: task.ownership,
            dependsOn: task.dependsOn,
          },
          signal,
        );
        throwIfMissionSchedulerAborted(signal);
        preClaimFailures.delete(taskId);
        endOwnershipWait(taskId);
        return taskId;
      } catch (error) {
        throwIfMissionSchedulerAborted(signal);
        const reason =
          error instanceof Error ? error.message : 'dispatch failed';
        if (await handleCrossMissionOwnership(taskId, error)) return null;
        endOwnershipWait(taskId);
        if (deps.isRetryableDispatchError?.(error)) {
          // Capacity waits carry their own natural bound (lease expiry or a
          // sibling freeing its slot); never escalate them to a block.
          if (deps.isCapacityWaitError?.(error)) {
            return null;
          }
          const consecutiveFailures =
            (preClaimFailures.get(taskId) ?? 0) + 1;
          const willBlock =
            consecutiveFailures >=
            MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES;
          if (willBlock) {
            preClaimFailures.delete(taskId);
          } else {
            preClaimFailures.set(taskId, consecutiveFailures);
          }
          deps.onRetryableDispatchFailure?.({
            taskId,
            error,
            consecutiveFailures,
            willBlock,
          });
          if (willBlock) {
            // Bounded silence: a permanently failing pre-claim route becomes
            // one observable terminal block instead of an infinite 5s retry.
            await deps.markFailed(
              taskId,
              `pre-claim dispatch falhou ${consecutiveFailures} ` +
                `vezes seguidas: ${reason}`,
            );
          }
          return null;
        }
        preClaimFailures.delete(taskId);
        await deps.markFailed(taskId, reason);
        return null;
      }
    };

    if (waveParallel) {
      // Parallel wave: siblings dispatch concurrently. A failure marks that
      // task failed without rolling back siblings that already claimed.
      const settled = await Promise.allSettled(
        decision.plan.taskIds.map((taskId) => dispatchOne(taskId)),
      );
      throwIfMissionSchedulerAborted(signal);
      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) {
          dispatched.push(result.value);
        }
      }
    } else {
      // Sequential / exclusive: stop the wave on first dispatch error.
      for (const taskId of decision.plan.taskIds) {
        throwIfMissionSchedulerAborted(signal);
        const ok = await dispatchOne(taskId);
        if (ok) dispatched.push(ok);
        else break;
      }
    }
    const telemetry = recordScheduleTelemetry(nextState.telemetry, decision.plan);
    const adaptiveCap = useConfiguredCap
      ? nextState.adaptiveCap
      : decideAdaptiveCap(nextState.adaptiveCap, {
          kind: 'wave',
          waveSize: decision.plan.waveSize,
        });
    if (waiterMissionId !== null) {
      // Ghost edges forge deadlocks. Every tick this mission runs, its own
      // edges are reconciled against the waits that actually survived it.
      pruneOwnershipWaitEdgesForMission(
        waiterMissionId,
        new Set(ownershipWaits.keys()),
      );
    }
    nextState = {
      telemetry,
      adaptiveCap,
      preClaimRetryableFailures: Object.freeze(
        Object.fromEntries(preClaimFailures),
      ),
      ownershipWaits: Object.freeze(Object.fromEntries(ownershipWaits)),
    };
    deps.onTelemetry?.(telemetry, decision.plan);
  }

  throwIfMissionSchedulerAborted(signal);
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
    const next = {
      telemetry,
      adaptiveCap,
      preClaimRetryableFailures: state.preClaimRetryableFailures,
      ownershipWaits: state.ownershipWaits,
    };
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
      const next = {
        telemetry,
        adaptiveCap,
        preClaimRetryableFailures: state.preClaimRetryableFailures,
        ownershipWaits: state.ownershipWaits,
      };
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
  adaptiveCapEnabled = true,
): number {
  if (!parallelEnabled) {
    return effectiveConcurrencyCap({
      configuredCap: 1,
      cores: base.cores,
      paneBudget: base.paneBudget,
    });
  }
  if (!adaptiveCapEnabled) {
    return effectiveConcurrencyCap(base);
  }
  return effectiveConcurrencyCap({
    configuredCap: Math.min(base.configuredCap, adaptive.currentCap),
    cores: base.cores,
    paneBudget: base.paneBudget,
  });
}
