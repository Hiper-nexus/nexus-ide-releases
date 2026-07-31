import type { ProjectExecutionScope } from "../../shared/types";
import {
  requireWorktreeRuntimeRegistry,
  type WorktreeRuntimeRegistry,
} from "../runtime/worktree-runtime-registry";
import {
  DEAD_OWNER_WORKTREE_RELEASE_MARKER,
  INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER,
} from "../runtime/worktree-manager";
import { ACTIVE_WORKTREE_STATUSES } from "../runtime/worktree-contract";
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import type { TaskDispatchStore } from "./task-dispatch-store";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import { terminalOperationalFailureReason } from "../runtime/operational-failure-policy";

type WorktreeCreationFailureDispatchAuthority = Pick<
  TaskDispatchStore,
  "get" | "list" | "blockWorktreeCreationFailureByCoordinator"
>;

interface WorktreeCreationFailureReconciliationDeps {
  readonly registry: Pick<WorktreeRuntimeRegistry, "get">;
  readonly getDispatches: (
    scope: ProjectExecutionScope,
  ) => WorktreeCreationFailureDispatchAuthority;
}

/**
 * Startup worktree recovery runs before this projection. If exact Git identity
 * could not be proved, converge the still-pre-spawn claim immediately instead
 * of waiting for its ordinary ten-minute worker lease to expire.
 */
export function reconcileInterruptedWorktreeReservationFailuresForScope(
  scope: ProjectExecutionScope,
  dependencies?: WorktreeCreationFailureReconciliationDeps,
): number {
  const deps = dependencies ?? {
    registry: requireWorktreeRuntimeRegistry(),
    getDispatches: (currentScope: ProjectExecutionScope) =>
      getProjectDomainStores(currentScope).taskDispatches,
  };
  const dispatches = deps.getDispatches(scope);
  let projected = 0;
  for (const dispatch of dispatches.list()) {
    if (dispatch.state !== "claimed") continue;
    const worktree = deps.registry.get(
      scope,
      dispatch.missionId,
      dispatch.taskId,
    );
    if (
      worktree?.status !== "failed" ||
      !worktree.failureReason?.startsWith(
        INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER,
      )
    ) {
      continue;
    }
    try {
      dispatches.blockWorktreeCreationFailureByCoordinator({
        taskId: dispatch.taskId,
        revision: dispatch.revision,
        reason:
          "Falha terminal de criação do worktree após restart: " +
          worktree.failureReason
            .slice(INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER.length)
            .trim(),
      });
      projected += 1;
    } catch (error) {
      const current = dispatches.get(dispatch.taskId);
      if (current?.state === "blocked") continue;
      throw error;
    }
  }
  return projected;
}

type MergeTerminalDispatchAuthority = Pick<
  TaskDispatchStore,
  "get" | "blockMergeFailureByCoordinator"
>;

interface MergeTerminalReconciliationDeps {
  readonly registry: Pick<
    WorktreeRuntimeRegistry,
    "reconcile" | "mergeSnapshot"
  >;
  readonly getDispatches: (
    scope: ProjectExecutionScope,
  ) => MergeTerminalDispatchAuthority;
}

function terminalMergeFailureReason(reason: string): string {
  const detail =
    reason.trim().slice(0, 60_000) ||
    "o coordenador não obteve prova válida da integração";
  return (
    `${terminalOperationalFailureReason(`Falha terminal de merge: ${detail}`)} ` +
    "A integração não foi aceita e exige revisão explícita."
  ).slice(0, 65_536);
}

/**
 * Projects an already-terminal merge effect into the SQLite mission authority.
 * Completed receipts are deliberately immutable; only the current pre-receipt
 * merge states may cross this boundary.
 */
export function projectTerminalMergeFailure(
  input: {
    readonly missionId: string;
    readonly taskId: string;
    readonly reason: string;
  },
  dispatches: MergeTerminalDispatchAuthority,
): boolean {
  const current = dispatches.get(input.taskId);
  if (!current) return false;
  if (current.missionId !== input.missionId) {
    throw new Error(`merge terminal ${input.taskId} pertence a outra missão`);
  }
  if (current.state === "blocked" || current.state === "completed") {
    return false;
  }
  if (!["handoff_ready", "merging"].includes(current.state)) return false;
  dispatches.blockMergeFailureByCoordinator({
    taskId: input.taskId,
    revision: current.revision,
    reason: terminalMergeFailureReason(input.reason),
  });
  return true;
}

/**
 * Restart projection runs inside the existing mission-scheduler participant.
 * MergeQueue remains the Git authority; this closes its durable blocked result
 * into dispatch/task/mission state without introducing another timer or loop.
 */
export function reconcileTerminalMergeFailureForScope(
  scope: ProjectExecutionScope,
  dependencies?: MergeTerminalReconciliationDeps,
): boolean {
  const deps = dependencies ?? {
    registry: requireWorktreeRuntimeRegistry(),
    getDispatches: (currentScope: ProjectExecutionScope) =>
      getProjectDomainStores(currentScope).taskDispatches,
  };
  const reconciliation = deps.registry.reconcile(scope);
  if (reconciliation.action === "none") return false;
  const snapshot = deps.registry.mergeSnapshot(scope);
  if ((snapshot.blocked?.disposition ?? "terminal") !== "terminal") {
    return false;
  }
  const blockedTaskKey = reconciliation.taskKey ?? snapshot.blocked?.taskKey;
  if (!blockedTaskKey) return false;
  const entry = snapshot.entries.find(
    (candidate) => candidate.taskKey === blockedTaskKey,
  );
  if (!entry || entry.status !== "blocked") {
    throw new Error(
      `merge queue bloqueada sem entry terminal: ${blockedTaskKey}`,
    );
  }
  const reason =
    snapshot.blocked?.taskKey === blockedTaskKey
      ? snapshot.blocked.reason
      : entry.failureReason;
  return projectTerminalMergeFailure(
    {
      missionId: entry.missionId,
      taskId: entry.taskId,
      reason:
        reason ??
        "o merge persistido foi interrompido e não possui prova de integração",
    },
    deps.getDispatches(scope),
  );
}

type OrphanedMergeBlockStoreAuthority = Pick<ProjectDomainStoreSuite, "missions">;

interface OrphanedMergeBlockReconciliationDeps {
  readonly registry: Pick<
    WorktreeRuntimeRegistry,
    "retireOrphanedMissionMergeBlock"
  >;
  readonly getStores: (
    scope: ProjectExecutionScope,
  ) => OrphanedMergeBlockStoreAuthority;
}

/**
 * Scope-construction and mission-removal sweeps miss one window: a block
 * whose mission disappears AFTER the memoized scope runtime was built (the
 * registry is per-process, so the init sweep never re-runs). Left alone, the
 * unacknowledgeable block turns every later mission of the scope into "merge
 * diferido 12 vezes" → technical block. This tick-level layer closes that
 * window; it is a no-op while the blocked mission still exists.
 */
export function reconcileOrphanedMissionMergeBlockForScope(
  scope: ProjectExecutionScope,
  dependencies?: OrphanedMergeBlockReconciliationDeps,
): boolean {
  const deps = dependencies ?? {
    registry: requireWorktreeRuntimeRegistry(),
    getStores: (currentScope: ProjectExecutionScope) =>
      getProjectDomainStores(currentScope),
  };
  try {
    const missions = deps.getStores(scope).missions;
    const retired = deps.registry.retireOrphanedMissionMergeBlock(
      scope,
      (missionId) => Boolean(missions.get(missionId)),
    );
    if (retired) {
      console.warn(
        "[mission-scheduler] lifted an orphaned merge block " +
          `(${retired.errorName}: ${retired.reason.slice(0, 120)}); ` +
          "the owning mission no longer exists",
      );
      return true;
    }
  } catch (error) {
    // Opportunistic cleanup: a contended CAS just retries next tick.
    console.warn(
      "[mission-scheduler] orphan merge block sweep deferred:",
      error,
    );
  }
  return false;
}

export const SUPERSEDED_PLAN_GENERATION_WORKTREE_REASON =
  "geração do plano selado substituída; ownership do worktree liberada";

type SupersededPlanGenerationStoreAuthority = Pick<
  ProjectDomainStoreSuite,
  "missions" | "taskDispatches"
>;

interface SupersededPlanGenerationReconciliationDeps {
  readonly registry: Pick<WorktreeRuntimeRegistry, "get" | "markFailed">;
  readonly getStores: (
    scope: ProjectExecutionScope,
  ) => SupersededPlanGenerationStoreAuthority;
}

/**
 * A PREVC refreeze/reapproval seals a fresh plan generation under a new
 * intentVersion; scheduler admission and mission completion authority bind to
 * the current sealed plan only, so an older generation's pending task can
 * never dispatch again. Left pending, that row — and any reusable worktree
 * reserved before a retryable bootstrap failure — claims ownership forever
 * and wedges the current executor behind OwnershipOverlapError. Retire
 * exactly those orphan pending rows in the dispatch store, then terminalize
 * their active worktree records so the overlap check and the worker-slot
 * projection release the surface. Tasks with physical work (running/done,
 * active dispatch, receipts) are never touched by the store transition.
 */
export function reconcileSupersededPlanGenerations(
  scope: ProjectExecutionScope,
  missionId: string,
  dependencies?: SupersededPlanGenerationReconciliationDeps,
): readonly string[] {
  const deps = dependencies ?? {
    registry: requireWorktreeRuntimeRegistry(),
    getStores: (currentScope: ProjectExecutionScope) =>
      getProjectDomainStores(currentScope),
  };
  const stores = deps.getStores(scope);
  const intentVersion = stores.missions.get(missionId)?.intentContract
    ?.intentVersion;
  if (intentVersion === undefined) return Object.freeze([]);
  const retired = stores.taskDispatches.retireSupersededPlanGenerations({
    missionId,
    intentVersion,
  });
  for (const taskId of retired) {
    const record = deps.registry.get(scope, missionId, taskId);
    if (!record || !ACTIVE_WORKTREE_STATUSES.has(record.status)) continue;
    try {
      deps.registry.markFailed(
        scope,
        missionId,
        taskId,
        SUPERSEDED_PLAN_GENERATION_WORKTREE_REASON,
      );
    } catch (error) {
      console.warn(
        `[mission-scheduler] stale-generation worktree release deferred for ` +
          `${missionId}/${taskId}:`,
        error,
      );
    }
  }
  return retired;
}

export const TERMINAL_DISPATCH_WORKTREE_RELEASE_REASON =
  `${DEAD_OWNER_WORKTREE_RELEASE_MARKER} dispatch alcançou estado terminal ` +
  "(blocked/failed); ownership do worktree liberada";

const TERMINAL_DISPATCH_STATES = new Set<TaskDispatchRecord["state"]>([
  "blocked",
  "failed",
]);

type TerminalDispatchWorktreeReleaseAuthority = Pick<
  TaskDispatchStore,
  "list"
>;

interface TerminalDispatchWorktreeReleaseDeps {
  readonly registry: Pick<WorktreeRuntimeRegistry, "get" | "markFailed">;
  readonly getDispatches: (
    scope: ProjectExecutionScope,
  ) => TerminalDispatchWorktreeReleaseAuthority;
}

/**
 * A dispatch reaching blocked/failed is terminal for that task, but its
 * owning mission may reach a terminal status of its own (or simply stop
 * being 'running') in the very same beat — the scheduler tick() only lists
 * running missions, so that mission may never tick again to release the
 * worktree via its own per-mission reconciliation. Left reserved, that
 * worktree's ownership (routinely the unscoped "everything" default) blocks
 * every future mission's overlapping claim forever, across mission
 * boundaries. This mirrors reconcileSupersededPlanGenerations but runs at
 * scope granularity, every tick, independent of any single mission's status,
 * so a dispatch that already went terminal is healed even if its mission
 * never ticks again. Tasks with physical work already integrated
 * ("integrated" worktree status) are never touched — only still-active
 * reservations for an already-terminal dispatch are released.
 */
export function reconcileTerminalDispatchWorktreeReleaseForScope(
  scope: ProjectExecutionScope,
  dependencies?: TerminalDispatchWorktreeReleaseDeps,
): readonly string[] {
  const deps = dependencies ?? {
    registry: requireWorktreeRuntimeRegistry(),
    getDispatches: (currentScope: ProjectExecutionScope) =>
      getProjectDomainStores(currentScope).taskDispatches,
  };
  const dispatches = deps.getDispatches(scope);
  const released: string[] = [];
  for (const dispatch of dispatches.list()) {
    if (!TERMINAL_DISPATCH_STATES.has(dispatch.state)) continue;
    const record = deps.registry.get(scope, dispatch.missionId, dispatch.taskId);
    if (!record || !ACTIVE_WORKTREE_STATUSES.has(record.status)) continue;
    try {
      deps.registry.markFailed(
        scope,
        dispatch.missionId,
        dispatch.taskId,
        TERMINAL_DISPATCH_WORKTREE_RELEASE_REASON,
      );
      released.push(dispatch.taskId);
    } catch (error) {
      console.warn(
        `[mission-scheduler] terminal-dispatch worktree release deferred for ` +
          `${dispatch.missionId}/${dispatch.taskId}:`,
        error,
      );
    }
  }
  return released;
}
