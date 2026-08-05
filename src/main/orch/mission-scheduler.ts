/**
 * Parallel Task Scheduler — pure decision core (P0–P4).
 *
 * Same style as `decideDriveAction` in mission-drive.ts: no IO, `now` injected,
 * deterministic, re-entrant. The runtime driver applies plans via worktree +
 * spawn + MergeQueue; this module only computes who may run next.
 *
 * Gate: two tasks share a wave only when expanded ownership is pairwise-disjoint
 * and neither touches reserved glue files. Sequential is the degenerate case.
 */

export type {
  OwnershipEnforcementResult,
  PlannedScheduleTask,
  PlannerTaskInput,
  ScheduleOwnership,
} from './mission-scheduler-ownership';
export {
  RESERVED_GLUE_PATTERNS,
  emitPlannedTasksWithContract,
  enforceOwnershipOnDiff,
  expandOwnershipTable,
  expandScheduleOwnership,
  independentSubsetTaskIds,
  isReservedGlueFile,
  normalizeSchedulePath,
  ownershipDeclaresParallelSurface,
  ownershipTouchesReservedGlue,
  ownershipsIntersect,
  requiresExclusiveSlot,
  toWorktreeOwnership,
} from './mission-scheduler-ownership';

import {
  expandScheduleOwnership,
  ownershipsIntersect,
  requiresExclusiveSlot,
  type ScheduleOwnership,
} from './mission-scheduler-ownership';

// ── Types ───────────────────────────────────────────────────────────────────

export type ScheduleTaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ScheduleTask {
  readonly id: string;
  readonly status: ScheduleTaskStatus;
  /** Dependency task ids (same mission). All must be done+merged to be ready. */
  readonly dependsOn: readonly string[];
  readonly ownership: ScheduleOwnership;
  /**
   * True after serial MergeQueue integration succeeded.
   * Required for dependents: status `done` alone is not enough.
   */
  readonly merged: boolean;
}

export interface ActiveWorker {
  readonly taskId: string;
  readonly ownership: ScheduleOwnership;
}

export interface ScheduleConfig {
  /** Hard concurrency ceiling for this tick (before cores/pane budget). */
  readonly configuredCap: number;
  /** Logical CPU count; effective cap uses max(1, cores - 2). */
  readonly cores: number;
  /** Remaining pane budget for this mission/scope. */
  readonly paneBudget: number;
}

export type SchedulePlan =
  | {
      readonly kind: 'dispatch';
      readonly taskIds: readonly string[];
      readonly waveSize: number;
      readonly effectiveCap: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'wait';
      readonly reason: string;
      readonly readyCount: number;
      readonly blockedByOverlap: number;
      readonly effectiveCap: number;
    }
  | {
      readonly kind: 'complete';
      readonly reason: string;
    }
  | {
      readonly kind: 'idle-failed';
      readonly reason: string;
      readonly failedTaskIds: readonly string[];
    }
  | {
      readonly kind: 'idle-invalid';
      readonly reason: string;
      readonly invalidTaskIds: readonly string[];
    };

export interface ScheduleDecision {
  readonly plan: SchedulePlan;
  readonly readyIds: readonly string[];
  readonly admittedIds: readonly string[];
  readonly deferredIds: readonly string[];
  readonly at: number;
}

// ── Concurrency ─────────────────────────────────────────────────────────────

export function effectiveConcurrencyCap(config: ScheduleConfig): number {
  const configured = Math.max(0, Math.floor(config.configuredCap));
  const coreBudget = Math.max(1, Math.floor(config.cores) - 2);
  const panes = Math.max(0, Math.floor(config.paneBudget));
  return Math.max(0, Math.min(configured, coreBudget, panes));
}

/** Adaptive cap (P4): start 2–3, widen only with evidence of low conflict. */
export interface AdaptiveCapState {
  readonly currentCap: number;
  readonly wavesObserved: number;
  /** Clean waves since last conflict/violation (recovery window). */
  readonly consecutiveCleanWaves: number;
  readonly conflictCount: number;
  readonly violationCount: number;
  readonly maxCap: number;
}

export const DEFAULT_ADAPTIVE_CAP: AdaptiveCapState = Object.freeze({
  currentCap: 2,
  wavesObserved: 0,
  consecutiveCleanWaves: 0,
  conflictCount: 0,
  violationCount: 0,
  maxCap: 6,
});

export interface AdaptiveCapEvent {
  readonly kind: 'wave' | 'conflict' | 'violation';
  readonly waveSize?: number;
}

/**
 * Update adaptive cap. Widens only after enough *consecutive clean* waves
 * (size ≥ 2). Shrinks immediately on conflict or scope violation and resets
 * the clean streak so lifetime counters never permanently freeze the cap.
 */
export function decideAdaptiveCap(
  state: AdaptiveCapState,
  event: AdaptiveCapEvent,
): AdaptiveCapState {
  const maxCap = Math.max(2, state.maxCap);
  if (event.kind === 'conflict' || event.kind === 'violation') {
    return Object.freeze({
      ...state,
      currentCap: Math.max(1, Math.min(state.currentCap - 1, maxCap)),
      consecutiveCleanWaves: 0,
      conflictCount:
        event.kind === 'conflict'
          ? state.conflictCount + 1
          : state.conflictCount,
      violationCount:
        event.kind === 'violation'
          ? state.violationCount + 1
          : state.violationCount,
    });
  }
  const wavesObserved = state.wavesObserved + 1;
  const waveSize = event.waveSize ?? 0;
  const consecutiveCleanWaves =
    waveSize >= 2 ? state.consecutiveCleanWaves + 1 : 0;
  const cleanEnough = consecutiveCleanWaves >= 3;
  const nextCap = cleanEnough
    ? Math.min(maxCap, state.currentCap + 1)
    : state.currentCap;
  return Object.freeze({
    ...state,
    currentCap: Math.min(Math.max(1, nextCap), maxCap),
    wavesObserved,
    consecutiveCleanWaves: cleanEnough ? 0 : consecutiveCleanWaves,
  });
}

// ── Telemetry (P4 pure counters) ────────────────────────────────────────────

export interface SchedulerTelemetry {
  readonly waves: number;
  readonly totalDispatched: number;
  readonly maxWaveSize: number;
  readonly conflicts: number;
  readonly violations: number;
  readonly sequentialFallbacks: number;
  readonly lastWaveSize: number;
}

export const EMPTY_SCHEDULER_TELEMETRY: SchedulerTelemetry = Object.freeze({
  waves: 0,
  totalDispatched: 0,
  maxWaveSize: 0,
  conflicts: 0,
  violations: 0,
  sequentialFallbacks: 0,
  lastWaveSize: 0,
});

export function recordScheduleTelemetry(
  telemetry: SchedulerTelemetry,
  plan: SchedulePlan,
): SchedulerTelemetry {
  if (plan.kind === 'dispatch') {
    const sequential = plan.waveSize <= 1;
    return Object.freeze({
      waves: telemetry.waves + 1,
      totalDispatched: telemetry.totalDispatched + plan.waveSize,
      maxWaveSize: Math.max(telemetry.maxWaveSize, plan.waveSize),
      conflicts: telemetry.conflicts,
      violations: telemetry.violations,
      sequentialFallbacks:
        telemetry.sequentialFallbacks + (sequential ? 1 : 0),
      lastWaveSize: plan.waveSize,
    });
  }
  return telemetry;
}

export function recordConflictTelemetry(
  telemetry: SchedulerTelemetry,
): SchedulerTelemetry {
  return Object.freeze({
    ...telemetry,
    conflicts: telemetry.conflicts + 1,
  });
}

export function recordViolationTelemetry(
  telemetry: SchedulerTelemetry,
): SchedulerTelemetry {
  return Object.freeze({
    ...telemetry,
    violations: telemetry.violations + 1,
  });
}

// ── Ready set + decideSchedule (P0) ─────────────────────────────────────────

function taskById(
  tasks: readonly ScheduleTask[],
): ReadonlyMap<string, ScheduleTask> {
  const map = new Map<string, ScheduleTask>();
  for (const task of tasks) map.set(task.id, task);
  return map;
}

const GUIDED_IMPLEMENTATION_DOMAIN = 'guided-implementation';

function readyTaskPriority(task: ScheduleTask): number {
  return task.ownership.domains.includes(GUIDED_IMPLEMENTATION_DOMAIN) ? 0 : 1;
}

/**
 * Ready = pending and every dependsOn task exists, is done, and is merged.
 * Unknown dependency ids block the task (fail-closed).
 */
export function computeReadySet(
  tasks: readonly ScheduleTask[],
): readonly ScheduleTask[] {
  const byId = taskById(tasks);
  const ready = tasks.filter((task) => {
    if (task.status !== 'pending') return false;
    return task.dependsOn.every((depId) => {
      const dep = byId.get(depId);
      return dep !== undefined && dep.status === 'done' && dep.merged;
    });
  });
  return Object.freeze(
    [...ready].sort(
      (a, b) =>
        readyTaskPriority(a) - readyTaskPriority(b) ||
        a.id.localeCompare(b.id),
    ),
  );
}

/**
 * P0-10: pending tasks that can NEVER become ready because a dependency failed
 * terminally (a `failed` task is never done+merged, so `computeReadySet` blocks
 * its dependents forever). Transitive: a dependent of a dead dependent is also
 * dead. Only `pending` tasks are reported — running/done/failed are already
 * in-flight or terminal. This is the detector that stops a mission sitting in
 * EXECUÇÃO+QA eternally on a dead executor: the caller cascades these to a
 * terminal, visible state instead of waiting on a dependency that will never
 * resolve. Unknown dependency ids are NOT treated as dead here (they are a
 * fail-closed *validation* error surfaced by validateScheduleDependencies).
 */
export function computeDeadDependents(
  tasks: readonly ScheduleTask[],
): readonly string[] {
  const byId = taskById(tasks);
  const memo = new Map<string, boolean>();
  const dependsOnFailed = (id: string, stack: Set<string>): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    // Cycle guard: an invalid graph is handled by validateScheduleDependencies,
    // not here — never recurse into a back-edge.
    if (stack.has(id)) return false;
    const task = byId.get(id);
    if (!task) return false;
    stack.add(id);
    let dead = false;
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
      if (dep === undefined) continue;
      if (dep.status === 'failed' || dependsOnFailed(depId, stack)) {
        dead = true;
        break;
      }
    }
    stack.delete(id);
    memo.set(id, dead);
    return dead;
  };
  const dead = tasks
    .filter(
      (task) => task.status === 'pending' && dependsOnFailed(task.id, new Set()),
    )
    .map((task) => task.id);
  return Object.freeze([...dead].sort((a, b) => a.localeCompare(b)));
}

export interface DependencyValidationResult {
  readonly valid: boolean;
  readonly invalidTaskIds: readonly string[];
  readonly reason: string;
}

/**
 * Validate the mission dependency graph before readiness checks. Unknown
 * dependencies, self-dependencies, and cycles are invalid rather than a
 * permanent wait state.
 */
export function validateScheduleDependencies(
  tasks: readonly ScheduleTask[],
): DependencyValidationResult {
  const byId = taskById(tasks);
  const invalid = new Set<string>();
  const reasons = new Set<string>();

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        invalid.add(task.id);
        reasons.add(`self-dependency on ${task.id}`);
      } else if (!byId.has(dependencyId)) {
        invalid.add(task.id);
        reasons.add(`${task.id} depends on missing ${dependencyId}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      for (const cycleTaskId of path.slice(cycleStart)) invalid.add(cycleTaskId);
      reasons.add(`dependency cycle involving ${taskId}`);
      return;
    }
    if (visited.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) return;
    visiting.add(taskId);
    path.push(taskId);
    for (const dependencyId of task.dependsOn) {
      if (byId.has(dependencyId)) visit(dependencyId);
    }
    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) visit(task.id);

  const invalidTaskIds = Object.freeze(
    [...invalid].sort((a, b) => a.localeCompare(b)),
  );
  return {
    valid: invalidTaskIds.length === 0,
    invalidTaskIds,
    reason:
      invalidTaskIds.length === 0
        ? 'dependency graph valid'
        : `invalid dependency graph: ${[...reasons].sort().join('; ')}`,
  };
}

/**
 * Greedy wave admission: deterministic by task id order.
 * Skip tasks that:
 *  - touch reserved glue / sequential-only / empty ownership (exclusive slot)
 *  - intersect any already-admitted expanded ownership
 *  - intersect any running worker expanded ownership
 * Exclusive exclusivity is bidirectional among exclusive peers: an exclusive
 * *running* worker blocks all peer admits this tick (ownership intersection
 * alone is insufficient). Parallel-eligible advisors (no sequential-only, no
 * claim intersection) must NOT fence exclusive quality-gate / sequential
 * delivery tasks — otherwise a stuck scout blocks QA forever after reviewer.
 */
export function selectDisjointWave(
  ready: readonly ScheduleTask[],
  running: readonly ActiveWorker[],
  cap: number,
  expandFiles?: (files: readonly string[]) => readonly string[],
): {
  readonly admitted: readonly ScheduleTask[];
  readonly deferred: readonly ScheduleTask[];
} {
  if (cap <= 0) {
    return {
      admitted: Object.freeze([]),
      deferred: Object.freeze([...ready]),
    };
  }

  const expandedRunning = running.map((w) =>
    expandScheduleOwnership(w.ownership, expandFiles),
  );
  const exclusiveRunning = expandedRunning.some((o) =>
    requiresExclusiveSlot(o),
  );
  if (exclusiveRunning) {
    return {
      admitted: Object.freeze([]),
      deferred: Object.freeze([...ready]),
    };
  }

  const admitted: ScheduleTask[] = [];
  const admittedOwnership: ScheduleOwnership[] = [];
  const deferred: ScheduleTask[] = [];

  for (const task of ready) {
    if (admitted.length >= cap) {
      deferred.push(task);
      continue;
    }
    const ownership = expandScheduleOwnership(task.ownership, expandFiles);
    const exclusive = requiresExclusiveSlot(ownership);

    if (exclusive) {
      // Alone among this wave and exclusive peers; do not wait for every
      // parallel-eligible worker still alive (release E2E hang: stuck Grok
      // scout deferred QA for 10+ min after reviewer completed).
      if (admitted.length > 0) {
        deferred.push(task);
        continue;
      }
      if (
        expandedRunning.some((o) => ownershipsIntersect(ownership, o))
      ) {
        deferred.push(task);
        continue;
      }
      admitted.push(task);
      admittedOwnership.push(ownership);
      continue;
    }

    if (admittedOwnership.some((o) => requiresExclusiveSlot(o))) {
      deferred.push(task);
      continue;
    }

    const hitsAdmitted = admittedOwnership.some((o) =>
      ownershipsIntersect(ownership, o),
    );
    const hitsRunning = expandedRunning.some((o) =>
      ownershipsIntersect(ownership, o),
    );
    if (hitsAdmitted || hitsRunning) {
      deferred.push(task);
      continue;
    }

    admitted.push(task);
    admittedOwnership.push(ownership);
  }

  return {
    admitted: Object.freeze(admitted),
    deferred: Object.freeze(deferred),
  };
}

/**
 * Pure schedule decision for one tick.
 */
export function decideSchedule(
  tasks: readonly ScheduleTask[],
  activeWorkers: readonly ActiveWorker[],
  config: ScheduleConfig,
  now: number,
  expandFiles?: (files: readonly string[]) => readonly string[],
): ScheduleDecision {
  const effectiveCap = effectiveConcurrencyCap(config);
  const allTerminal =
    tasks.length > 0 &&
    tasks.every((t) => t.status === 'done' || t.status === 'failed');
  if (tasks.length === 0) {
    return {
      plan: { kind: 'complete', reason: 'no tasks' },
      readyIds: Object.freeze([]),
      admittedIds: Object.freeze([]),
      deferredIds: Object.freeze([]),
      at: now,
    };
  }
  const dependencyValidation = validateScheduleDependencies(tasks);
  if (!dependencyValidation.valid) {
    return {
      plan: {
        kind: 'idle-invalid',
        reason: dependencyValidation.reason,
        invalidTaskIds: dependencyValidation.invalidTaskIds,
      },
      readyIds: Object.freeze([]),
      admittedIds: Object.freeze([]),
      deferredIds: Object.freeze(
        tasks.filter((task) => task.status === 'pending').map((task) => task.id),
      ),
      at: now,
    };
  }
  if (allTerminal) {
    const failed = tasks.filter((t) => t.status === 'failed');
    if (failed.length > 0) {
      return {
        plan: {
          kind: 'idle-failed',
          reason: 'all tasks terminal with failures',
          failedTaskIds: Object.freeze(failed.map((t) => t.id)),
        },
        readyIds: Object.freeze([]),
        admittedIds: Object.freeze([]),
        deferredIds: Object.freeze([]),
        at: now,
      };
    }
    const allMerged = tasks.every((t) => t.merged);
    if (allMerged) {
      return {
        plan: { kind: 'complete', reason: 'all tasks done and merged' },
        readyIds: Object.freeze([]),
        admittedIds: Object.freeze([]),
        deferredIds: Object.freeze([]),
        at: now,
      };
    }
    return {
      plan: {
        kind: 'wait',
        reason: 'tasks done but awaiting merge',
        readyCount: 0,
        blockedByOverlap: 0,
        effectiveCap,
      },
      readyIds: Object.freeze([]),
      admittedIds: Object.freeze([]),
      deferredIds: Object.freeze([]),
      at: now,
    };
  }

  const runningSlots = activeWorkers.length;
  const openSlots = Math.max(0, effectiveCap - runningSlots);
  const ready = computeReadySet(tasks);

  if (openSlots === 0) {
    return {
      plan: {
        kind: 'wait',
        reason:
          effectiveCap === 0
            ? 'concurrency cap is zero'
            : 'all concurrency slots occupied',
        readyCount: ready.length,
        blockedByOverlap: 0,
        effectiveCap,
      },
      readyIds: Object.freeze(ready.map((t) => t.id)),
      admittedIds: Object.freeze([]),
      deferredIds: Object.freeze(ready.map((t) => t.id)),
      at: now,
    };
  }

  if (ready.length === 0) {
    const pending = tasks.filter((t) => t.status === 'pending');
    // P0-10: nothing is ready. If nothing is running to rescue them AND every
    // remaining pending task is a dead dependent (a dependency failed
    // terminally), the plan can never advance — a QA/review lane would otherwise
    // wait on a dead executor forever. Convert the eternal wait into a terminal,
    // visible failure the runtime cascades, instead of an endless EXECUÇÃO+QA.
    const deadDependents = computeDeadDependents(tasks);
    const deadSet = new Set(deadDependents);
    if (
      activeWorkers.length === 0 &&
      pending.length > 0 &&
      pending.every((t) => deadSet.has(t.id))
    ) {
      return {
        plan: {
          kind: 'idle-failed',
          reason:
            `dependency dead: ${deadDependents.length} pending task(s) depend ` +
            'on a terminally failed task and can never run',
          failedTaskIds: deadDependents,
        },
        readyIds: Object.freeze([]),
        admittedIds: Object.freeze([]),
        deferredIds: Object.freeze(pending.map((t) => t.id)),
        at: now,
      };
    }
    return {
      plan: {
        kind: 'wait',
        reason:
          pending.length > 0
            ? 'pending tasks blocked on unfinished dependencies'
            : activeWorkers.length > 0
              ? 'waiting for running workers'
              : 'nothing ready',
        readyCount: 0,
        blockedByOverlap: 0,
        effectiveCap,
      },
      readyIds: Object.freeze([]),
      admittedIds: Object.freeze([]),
      deferredIds: Object.freeze([]),
      at: now,
    };
  }

  const { admitted, deferred } = selectDisjointWave(
    ready,
    activeWorkers,
    openSlots,
    expandFiles,
  );

  if (admitted.length === 0) {
    return {
      plan: {
        kind: 'wait',
        reason: 'ready tasks blocked by ownership overlap or reserved glue',
        readyCount: ready.length,
        blockedByOverlap: deferred.length,
        effectiveCap,
      },
      readyIds: Object.freeze(ready.map((t) => t.id)),
      admittedIds: Object.freeze([]),
      deferredIds: Object.freeze(deferred.map((t) => t.id)),
      at: now,
    };
  }

  const sequential =
    admitted.length === 1 && (effectiveCap <= 1 || deferred.length > 0);
  return {
    plan: {
      kind: 'dispatch',
      taskIds: Object.freeze(admitted.map((t) => t.id)),
      waveSize: admitted.length,
      effectiveCap,
      reason: sequential
        ? 'sequential degenerate (cap=1 or only one disjoint ready task)'
        : `dispatch disjoint wave of ${admitted.length}`,
    },
    readyIds: Object.freeze(ready.map((t) => t.id)),
    admittedIds: Object.freeze(admitted.map((t) => t.id)),
    deferredIds: Object.freeze(deferred.map((t) => t.id)),
    at: now,
  };
}
