import type { ProjectExecutionScope } from "../../shared/types";
import {
  requireWorktreeRuntimeRegistry,
  type WorktreeRuntimeRegistry,
} from "../runtime/worktree-runtime-registry";
import { INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER } from "../runtime/worktree-manager";
import { getProjectDomainStores } from "./project-domain-store-registry";
import type { TaskDispatchStore } from "./task-dispatch-store";
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
