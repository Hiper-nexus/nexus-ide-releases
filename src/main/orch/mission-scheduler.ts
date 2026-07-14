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

import {
  type WorktreeOwnership,
} from '../runtime/worktree-contract';

// ── Types ───────────────────────────────────────────────────────────────────

export type ScheduleTaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ScheduleOwnership {
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];
}

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

// ── Reserved glue (never parallel) ──────────────────────────────────────────

/**
 * Paths / path prefixes that must never be owned by a parallel wave member.
 * Tasks that need these run only when effective cap is forced sequential
 * (cap=1 or alone with no other admitted peers — but still blocked if another
 * worker is running, via the normal overlap path when declared).
 */
export const RESERVED_GLUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^package-lock\.json$/i,
  /^npm-shrinkwrap\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^bun\.lockb?$/i,
  /^Cargo\.lock$/i,
  /^Gemfile\.lock$/i,
  /^poetry\.lock$/i,
  /^composer\.lock$/i,
  /^go\.sum$/i,
  /(^|\/)index\.ts$/i,
  /(^|\/)index\.tsx$/i,
  /(^|\/)index\.js$/i,
  /(^|\/)index\.mjs$/i,
  /(^|\/)index\.cjs$/i,
  /(^|\/)__init__\.py$/i,
  /(^|\/)migrations?\//i,
  /^\.nexus(\/|$)/i,
  /^\.context(\/|$)/i,
  /^\.nexus-memory(\/|$)/i,
]);

export function normalizeSchedulePath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isReservedGlueFile(file: string): boolean {
  const normalized = normalizeSchedulePath(file);
  return RESERVED_GLUE_PATTERNS.some((re) => re.test(normalized));
}

export function ownershipTouchesReservedGlue(
  ownership: ScheduleOwnership,
): boolean {
  return ownership.files.some(isReservedGlueFile);
}

/**
 * Tasks that must never share a wave: reserved glue, empty ownership
 * (cannot prove disjointness), or explicit sequential-only domain.
 */
export function requiresExclusiveSlot(ownership: ScheduleOwnership): boolean {
  if (ownershipTouchesReservedGlue(ownership)) return true;
  if (ownership.domains.some((d) => d.toLowerCase() === 'sequential-only')) {
    return true;
  }
  const claims =
    ownership.files.length + ownership.symbols.length + ownership.domains.length;
  return claims === 0;
}

// ── Ownership intersection (P1) ─────────────────────────────────────────────

export function toWorktreeOwnership(
  ownership: ScheduleOwnership,
): WorktreeOwnership {
  return Object.freeze({
    files: Object.freeze([...ownership.files.map(normalizeSchedulePath)]),
    symbols: Object.freeze([...ownership.symbols]),
    domains: Object.freeze(
      ownership.domains.map((d) => d.toLocaleLowerCase('en-US')),
    ),
  });
}

export function ownershipsIntersect(
  left: ScheduleOwnership,
  right: ScheduleOwnership,
): boolean {
  const leftFiles = left.files.map(normalizeSchedulePath);
  const rightFiles = right.files.map(normalizeSchedulePath);
  const fileOverlap = leftFiles.some((leftFile) =>
    rightFiles.some((rightFile) => fileClaimsOverlap(leftFile, rightFile)),
  );
  const exactOverlap = (a: readonly string[], b: readonly string[]) => {
    const rightValues = new Set(b);
    return a.some((value) => rightValues.has(value));
  };
  return (
    fileOverlap ||
    exactOverlap(left.symbols, right.symbols) ||
    exactOverlap(left.domains, right.domains)
  );
}

function fileClaimsOverlap(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\/+$/, '');
  const normalizedRight = right.replace(/\/+$/, '');
  if (normalizedLeft === normalizedRight) return true;
  return (
    (isDirectoryClaim(normalizedLeft) &&
      normalizedRight.startsWith(`${normalizedLeft}/`)) ||
    (isDirectoryClaim(normalizedRight) &&
      normalizedLeft.startsWith(`${normalizedRight}/`))
  );
}

function isDirectoryClaim(file: string): boolean {
  const basename = file.split('/').pop() ?? file;
  return file.endsWith('/') || !basename.includes('.');
}

/**
 * Expand ownership with a pure file-set expander (blast-radius adapter).
 * When expander is omitted, ownership is used as-is.
 */
export function expandScheduleOwnership(
  ownership: ScheduleOwnership,
  expandFiles?: (files: readonly string[]) => readonly string[],
): ScheduleOwnership {
  if (!expandFiles || ownership.files.length === 0) {
    return Object.freeze({
      files: Object.freeze(ownership.files.map(normalizeSchedulePath)),
      symbols: Object.freeze([...ownership.symbols]),
      domains: Object.freeze([...ownership.domains]),
    });
  }
  const expanded = expandFiles(ownership.files.map(normalizeSchedulePath));
  const files = [
    ...new Set([
      ...ownership.files.map(normalizeSchedulePath),
      ...expanded.map(normalizeSchedulePath),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return Object.freeze({
    files: Object.freeze(files),
    symbols: Object.freeze([...ownership.symbols]),
    domains: Object.freeze([...ownership.domains]),
  });
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
  // wave
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
    [...ready].sort((a, b) => a.id.localeCompare(b.id)),
  );
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

  const invalidTaskIds = Object.freeze([...invalid].sort((a, b) => a.localeCompare(b)));
  return {
    valid: invalidTaskIds.length === 0,
    invalidTaskIds,
    reason:
      invalidTaskIds.length === 0
        ? 'dependency graph valid'
        : `invalid dependency graph: ${[...reasons].sort().join('; ')}`,
  };
}

function expandAll(
  tasks: readonly ScheduleTask[],
  expandFiles?: (files: readonly string[]) => readonly string[],
): ReadonlyMap<string, ScheduleOwnership> {
  const map = new Map<string, ScheduleOwnership>();
  for (const task of tasks) {
    map.set(task.id, expandScheduleOwnership(task.ownership, expandFiles));
  }
  return map;
}

/**
 * Greedy wave admission: deterministic by task id order.
 * Skip tasks that:
 *  - touch reserved glue / sequential-only / empty ownership (exclusive slot)
 *  - intersect any already-admitted expanded ownership
 *  - intersect any running worker expanded ownership
 * Exclusive exclusivity is bidirectional: an exclusive *running* worker also
 * blocks all peer admits this tick (ownership intersection alone is insufficient).
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
  // Exclusive worker already on the machine → no fan-out this tick at all.
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

    // Exclusive tasks (glue / sequential-only / empty ownership) only run alone:
    // no running workers and empty wave so far.
    if (exclusive) {
      if (running.length > 0 || admitted.length > 0) {
        deferred.push(task);
        continue;
      }
      admitted.push(task);
      admittedOwnership.push(ownership);
      continue;
    }

    // Non-exclusive never joins a wave that already has an exclusive task.
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

  // Slots already occupied by running workers reduce available fan-out.
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

  // Force sequential when flag-off path uses cap=1; otherwise greedy disjoint.
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

// ── Fail-closed ownership check (P3 pure) ───────────────────────────────────

export interface OwnershipEnforcementResult {
  readonly ok: boolean;
  readonly undeclaredFiles: readonly string[];
  readonly reason: string;
}

/**
 * Every changed path must fall within expanded ownership files.
 * Paths may match exact ownership entries or be under an owned directory prefix.
 */
export function enforceOwnershipOnDiff(
  changedFiles: readonly string[],
  ownership: ScheduleOwnership,
  expandFiles?: (files: readonly string[]) => readonly string[],
): OwnershipEnforcementResult {
  const expanded = expandScheduleOwnership(ownership, expandFiles);
  const owned = new Set(expanded.files.map(normalizeSchedulePath));
  const undeclared: string[] = [];
  for (const raw of changedFiles) {
    const file = normalizeSchedulePath(raw);
    if (owned.has(file)) continue;
    // Directory ownership only when claim ends with '/' or has no file extension
    // in the final segment (e.g. "src/foo" or "src/foo/"). Avoid treating
    // "src/foo.ts" as a directory prefix of "src/foo.ts.bak".
    const underDir = [...owned].some((claim) => {
      if (claim.endsWith('/')) {
        return file.startsWith(claim) || file === claim.slice(0, -1);
      }
      const base = claim.split('/').pop() ?? claim;
      const looksLikeFile = base.includes('.');
      if (looksLikeFile) return false;
      return file === claim || file.startsWith(`${claim}/`);
    });
    if (underDir) continue;
    undeclared.push(file);
  }
  if (undeclared.length > 0) {
    return {
      ok: false,
      undeclaredFiles: Object.freeze(undeclared.sort()),
      reason: `out-of-scope changes: ${undeclared.join(', ')}`,
    };
  }
  return {
    ok: true,
    undeclaredFiles: Object.freeze([]),
    reason: 'within ownership',
  };
}

// ── Planner contract (P3) ───────────────────────────────────────────────────

export interface PlannerTaskInput {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly ownership?: ScheduleOwnership;
  readonly dependsOn?: readonly string[];
}

export interface PlannedScheduleTask {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly dependsOn: readonly string[];
  readonly ownership: ScheduleOwnership;
  /** True when ownership was confidently declared (eligible for parallel). */
  readonly parallelEligible: boolean;
}

/**
 * Ensure every planned task carries dependsOn + ownership.
 * When disjoint ownership cannot be declared, emit a sequential chain
 * (each task depends on the previous) with empty ownership files so the
 * scheduler will not fan out (empty ownership cannot prove disjointness —
 * we mark parallelEligible false and attach a sentinel sequential-only domain).
 */
export function emitPlannedTasksWithContract(
  inputs: readonly PlannerTaskInput[],
): readonly PlannedScheduleTask[] {
  if (inputs.length === 0) return Object.freeze([]);

  const allHaveFiles = inputs.every(
    (t) => (t.ownership?.files.length ?? 0) > 0,
  );

  if (!allHaveFiles) {
    // Safe sequential chain.
    return Object.freeze(
      inputs.map((input, index) => {
        const prev = index > 0 ? inputs[index - 1]!.id : undefined;
        const dependsOn =
          input.dependsOn && input.dependsOn.length > 0
            ? input.dependsOn
            : prev
              ? Object.freeze([prev])
              : Object.freeze([]);
        const ownership: ScheduleOwnership = input.ownership ?? {
          files: Object.freeze([]),
          symbols: Object.freeze([]),
          domains: Object.freeze(['sequential-only']),
        };
        return Object.freeze({
          id: input.id,
          title: input.title,
          detail: input.detail ?? '',
          dependsOn: Object.freeze([...dependsOn]),
          ownership: Object.freeze({
            files: Object.freeze([...(ownership.files ?? [])]),
            symbols: Object.freeze([...(ownership.symbols ?? [])]),
            domains: Object.freeze([...(ownership.domains ?? [])]),
          }),
          parallelEligible: false,
        });
      }),
    );
  }

  return Object.freeze(
    inputs.map((input) => {
      const ownership = input.ownership!;
      const parallelEligible =
        ownership.files.length > 0 && !ownershipTouchesReservedGlue(ownership);
      return Object.freeze({
        id: input.id,
        title: input.title,
        detail: input.detail ?? '',
        dependsOn: Object.freeze([...(input.dependsOn ?? [])]),
        ownership: Object.freeze({
          files: Object.freeze(ownership.files.map(normalizeSchedulePath)),
          symbols: Object.freeze([...(ownership.symbols ?? [])]),
          domains: Object.freeze([...(ownership.domains ?? [])]),
        }),
        parallelEligible,
      });
    }),
  );
}

/**
 * Tasks eligible for parallel fan-out under flag-on policy (P3):
 * parallelEligible, non-empty ownership, no reserved glue.
 */
export function independentSubsetTaskIds(
  planned: readonly PlannedScheduleTask[],
): readonly string[] {
  return Object.freeze(
    planned.filter((t) => t.parallelEligible).map((t) => t.id),
  );
}

// Keep expand map helper available for tests that need full expansion table.
export function expandOwnershipTable(
  tasks: readonly ScheduleTask[],
  expandFiles?: (files: readonly string[]) => readonly string[],
): ReadonlyMap<string, ScheduleOwnership> {
  return expandAll(tasks, expandFiles);
}
