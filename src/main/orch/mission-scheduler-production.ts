import type { ProjectExecutionScope } from "../../shared/types";
import os from "node:os";
import { FEATURE_FLAG_IDS } from "../../shared/feature-flags";
import type { MissionIntentContract } from "../../shared/mission-intent";
import { MAX_LIVE_PANES_SOFT } from "../../shared/pane-limits";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { getFeatureFlagRegistry } from "../feature-flags/feature-flag-registry";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { MergeValidationCoordinator } from "../context/merge-validation-coordinator";
import { getOrchSettings } from "../persistence/settings-store";
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
} from "./project-domain-store-registry";
import {
  requireWorktreeRuntimeRegistry,
} from "../runtime/worktree-runtime-registry";
import { requestMissionWorkerPaneRetirement } from "./pane-registry";
import {
  productionTaskDispatchWorkerRetirement,
} from "./task-dispatch-worker-retirement";
import {
  createSchedulerRuntimeState,
  runSchedulerTick,
  type SchedulerRuntimeTask,
} from "./mission-scheduler-runtime";
import { taskRecordToSchedulerTask } from "./mission-scheduler-io";
import {
  createAdaptiveCapState,
  diagnoseWaveConcurrency,
  resolveAdaptiveLadderPolicy,
  type AdaptiveCapState,
} from "./mission-scheduler";
import { reportWaveConcurrency } from "./wave-concurrency-verdict";
import {
  MISSION_SCHEDULER_CONCURRENCY_LIMITS,
  runBoundedMissionSchedulerPass,
} from "./mission-scheduler-concurrency";
import { runGuidedPrevcPostMergeBridge } from "./prevc-autopilot-coordinator";
import {
  classifyPrevcMergeFailure,
  ensurePrevcMergeReady,
} from "./prevc-merge-preparation";
import {
  missionSchedulerHasKickoffAuthority,
  reconcileMissionCompletionAfterSchedulerTick,
} from "./mission-scheduler-authority";
import {
  dispatchMissionSchedulerTask,
  isMissionSchedulerCapacityWait,
  isMissionSchedulerRetryableDispatchError,
  MissionSchedulerDispatchAuthorityError,
} from "./mission-scheduler-dispatch-transaction";
import {
  finalizeGuidedImplementationNoChange,
  finalizeGuidedIsolatedAdvisory,
  finalizeGuidedNoChangeQualityGate,
  isGuidedImplementationDelivery,
  isGuidedIsolatedAdvisory,
  isGuidedNoChangeQualityGate,
} from "./mission-scheduler-guided-finalization";
import { MISSION_SCHEDULER_TICK_MS } from "./mission-scheduler-policy";
import {
  projectTerminalMergeFailure,
  reconcileExhaustedProviderRerouteForScope,
  reconcileInterruptedWorktreeReservationFailuresForScope,
  reconcileOrphanedMissionMergeBlockForScope,
  reconcileSupersededPlanGenerations,
  reconcileTerminalDispatchWorktreeReleaseForScope,
  reconcileTerminalMergeFailureForScope,
} from "./mission-scheduler-reconciliation";
import { runMissionSchedulerLaunchPass } from "./mission-scheduler-pass";
import { createMissionSchedulerTickLifecycle } from "./mission-scheduler-tick-lifecycle";
import { throwIfMissionSchedulerAborted } from "./mission-scheduler-abort";
import {
  classifyOperationalFailure,
  terminalOperationalFailureReason,
} from "../runtime/operational-failure-policy";
import type {
  MergeQueueEntry,
  MergeQueueStateSnapshot,
} from "../runtime/merge-queue-contract";
import { WorktreeStateConflictError } from "../runtime/worktree-contract";
import { TASK_WORKTREE_NOT_CLEAN_MESSAGE } from "../runtime/worktree-manager-git";
import type { WorktreeRecord } from "../runtime/worktree-contract";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import {
  taskDispatchQualityRepairReason,
  type TaskDispatchStore,
} from "./task-dispatch-store";
import { reconcileLegacyGuidedDirtyCheckoutBootstrap } from "./task-dispatch-lifecycle";
import { hasTeamReadOnlyFanoutDomain } from "../../shared/mission-topology";

export {
  awaitMissionSchedulerAuthorityFence,
  missionSchedulerHasKickoffAuthority,
  reconcileMissionCompletionAfterSchedulerTick,
  validateMissionMergeWithLifecycleFence,
} from "./mission-scheduler-authority";
export {
  loadMissionSchedulerDependencyHandoffs,
  type MissionSchedulerDependencyHandoff,
} from "./mission-scheduler-dependency-context";
export {
  assertMissionSchedulerPreProviderAuthority,
  captureMissionSchedulerPreProviderAuthority,
  missionAccountQuotaScores,
  missionSchedulerLiveRosterAdapter,
  missionSchedulerRouteRequiresAccount,
} from "./mission-scheduler-dispatch-transaction";
export {
  finalizeGuidedImplementationNoChange,
  finalizeGuidedIsolatedAdvisory,
  finalizeGuidedNoChangeQualityGate,
  isGuidedDeliveryOwnership,
  type GuidedImplementationNoChangeDeps,
  type GuidedIsolatedAdvisoryDeps,
  type GuidedNoChangeQualityGateDeps,
} from "./mission-scheduler-guided-finalization";
export {
  MISSION_SCHEDULER_TICK_MS,
  MISSION_SCHEDULER_WORKER_LEASE_POLICY,
} from "./mission-scheduler-policy";
export {
  projectTerminalMergeFailure,
  reconcileExhaustedProviderRerouteForScope,
  reconcileInterruptedWorktreeReservationFailuresForScope,
  reconcileSupersededPlanGenerations,
  reconcileTerminalDispatchWorktreeReleaseForScope,
  reconcileTerminalMergeFailureForScope,
} from "./mission-scheduler-reconciliation";

/** The scheduler and the atomic claim must enforce the same approved ceiling. */
export function missionSchedulerConfiguredWorkerCap(
  contract: Pick<MissionIntentContract, "budgets">,
): number {
  return contract.budgets.maxWorkers;
}

/**
 * Seed the Hardened adaptive ladder from operator settings and the REAL machine
 * ceiling. The old hardcoded `maxCap: 6` capped a host that affords `cores - 2`
 * (8 here) below its own hardware, invisibly and with no way for the operator to
 * raise it. `adaptiveWaveLadder.maxCap: null` (default) now means "align with
 * what this machine can actually run"; an explicit setting always wins.
 *
 * Only the governed policy consults this ladder — Autopilot uses the approved
 * `maxWorkers` directly (see `isAdaptiveCapEnabled` in the tick deps).
 */
export function productionAdaptiveCapSeed(
  contract?: Pick<MissionIntentContract, "budgets"> | null,
  settings: {
    readonly adaptiveWaveLadder?: {
      readonly startCap?: number | null;
      readonly maxCap?: number | null;
      readonly rampAfterCleanWaves?: number | null;
    };
  } = getOrchSettings(),
  limits = missionSchedulerMachineLimits(),
): AdaptiveCapState {
  const contractCap = contract
    ? missionSchedulerConfiguredWorkerCap(contract)
    : Number.POSITIVE_INFINITY;
  const ladder = settings.adaptiveWaveLadder ?? {};
  return createAdaptiveCapState(
    resolveAdaptiveLadderPolicy({
      startCap: ladder.startCap ?? null,
      maxCap: ladder.maxCap ?? null,
      rampAfterCleanWaves: ladder.rampAfterCleanWaves ?? null,
      // Never promise a wave the approved contract or the host cannot honour;
      // effectiveConcurrencyCap would clamp it anyway, silently.
      hardwareCeiling: Math.min(contractCap, limits.cores - 2, limits.paneBudget),
    }),
  );
}

/**
 * Real machine limits feeding the scheduler's effective cap: host cores and
 * the pane budget derived from the renderer live-pane soft cap, reserving the
 * orchestrator + one operator pane so an admitted wave never exceeds what the
 * layout would refuse.
 */
export function missionSchedulerMachineLimits(
  cores: number = os.cpus().length,
  paneSoftCap: number = MAX_LIVE_PANES_SOFT,
): { readonly cores: number; readonly paneBudget: number } {
  return { cores, paneBudget: Math.max(0, paneSoftCap - 2) };
}

/**
 * The fast path is restricted to the sealed, root-only, non-mutating team
 * topology. A mixed, legacy, dependent, or write-owning plan keeps the
 * adaptive concurrency ceiling.
 */
export function isTeamReadOnlyFanoutSchedulerWave(
  tasks: readonly SchedulerRuntimeTask[],
): boolean {
  return (
    tasks.some((task) => task.status === "pending") &&
    tasks.every(
      (task) =>
        task.parallelEligible === true &&
        task.dependsOn.length === 0 &&
        task.ownership.files.length === 0 &&
        task.ownership.symbols.length === 0 &&
        hasTeamReadOnlyFanoutDomain(task.ownership.domains),
    )
  );
}

/**
 * A finalizer may touch Git, SQLite and the filesystem after a valid handoff.
 * Those operational failures keep the dispatch in its current retryable state;
 * only a classified authority/conflict boundary may condemn the mission.
 */
export function projectTerminalFinalizationFailure(
  input: {
    readonly missionId: string;
    readonly taskId: string;
    readonly error: unknown;
  },
  dispatches: Parameters<typeof projectTerminalMergeFailure>[1],
): boolean {
  if (classifyOperationalFailure(input.error) !== "terminal") return false;
  return projectTerminalMergeFailure(
    {
      missionId: input.missionId,
      taskId: input.taskId,
      reason:
        input.error instanceof Error
          ? input.error.message
          : String(input.error),
    },
    dispatches,
  );
}
export { buildMissionSchedulerTaskPrompt } from "./mission-scheduler-task-prompt";

export async function prepareMissionSchedulerPrevcPromotion(
  input: {
    readonly scope: ProjectExecutionScope;
    readonly missionId: string;
    readonly signal?: AbortSignal;
    readonly assertCurrentAuthority: () => void;
  },
  prepare: typeof ensurePrevcMergeReady = ensurePrevcMergeReady,
): Promise<void> {
  throwIfMissionSchedulerAborted(input.signal);
  await prepare(input.scope, input.missionId, {
    assertCurrentAuthority: input.assertCurrentAuthority,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  throwIfMissionSchedulerAborted(input.signal);
  input.assertCurrentAuthority();
  throwIfMissionSchedulerAborted(input.signal);
}

interface ReconciliationOrderDispatch {
  readonly state: string;
  readonly executionMode: string;
  readonly ownership: {
    readonly domains: readonly string[];
  };
}

/**
 * Settle bounded/no-change handoffs before entering a model-backed merge.
 *
 * One executor review may legitimately take minutes. It must not keep already
 * finished read-only advisors looking active merely because their rows happen
 * to sort after the executor.
 */
export function orderMissionDispatchesForReconciliation<
  T extends ReconciliationOrderDispatch,
>(dispatches: readonly T[]): readonly T[] {
  const priority = (dispatch: ReconciliationOrderDispatch): number => {
    if (!["handoff_ready", "merging"].includes(dispatch.state)) return 4;
    if (dispatch.executionMode === "same_checkout") return 0;
    if (dispatch.executionMode === "read_only") return 1;
    if (
      dispatch.ownership.domains.includes("guided-isolated-advisory")
    ) {
      return 2;
    }
    return 3;
  };
  return Object.freeze(
    dispatches
      .map((dispatch, index) => ({ dispatch, index }))
      .sort(
        (left, right) =>
          priority(left.dispatch) - priority(right.dispatch) ||
          left.index - right.index,
      )
      .map(({ dispatch }) => dispatch),
  );
}

/**
 * A restart during post-validation/finalization leaves Git integrated but the
 * durable task receipt unfinished. This exact retryable block is executable
 * work for Main, not a terminal state and not a reason to wait for a new
 * worker handoff.
 */
export function recoverableIntegratedMergeEntry(
  snapshot: MergeQueueStateSnapshot,
  missionId: string,
  taskId: string,
): MergeQueueEntry | null {
  if (
    !snapshot.blocked ||
    (snapshot.blocked.disposition ?? "terminal") === "terminal"
  ) {
    return null;
  }
  const entry = snapshot.entries.find(
    (candidate) =>
      candidate.taskKey === snapshot.blocked?.taskKey &&
      candidate.missionId === missionId &&
      candidate.taskId === taskId &&
      candidate.status === "blocked" &&
      Boolean(candidate.integratedSha),
  );
  return entry ?? null;
}

interface RestartedIntegratedMergeEntry {
  readonly taskHeadSha?: string;
  readonly integratedSha: string;
  readonly evidenceIds: readonly string[];
}

interface RestartedIntegratedMergeDeps {
  assertLifecycleAuthority(): void;
  assertPhysicalHandoffTaskHead(): string;
  complete(
    revision: number,
    receipt: {
      readonly kind: "worktree_integrated";
      readonly reference: string;
      readonly completedAt: number;
      readonly evidenceIds: readonly string[];
    },
  ): void;
  now(): number;
}

/**
 * Close the crash window after MergeQueue durably integrated Git but before
 * task completion persisted.
 *
 * Physical ancestry is intentionally insufficient here: a later worker commit
 * W2 is a descendant of the accepted handoff W and would pass the final store's
 * ancestry check. The durable queue entry must name W exactly before Main may
 * mint the recovered integration receipt.
 */
export function finalizeRestartedIntegratedMerge(
  input: {
    readonly dispatchRevision: number;
    readonly mergeEntry: RestartedIntegratedMergeEntry;
  },
  deps: RestartedIntegratedMergeDeps,
): true {
  deps.assertLifecycleAuthority();
  const physicalTaskHeadSha = deps.assertPhysicalHandoffTaskHead();
  if (
    !input.mergeEntry.taskHeadSha ||
    input.mergeEntry.taskHeadSha !== physicalTaskHeadSha
  ) {
    throw new MissionSchedulerDispatchAuthorityError(
      "restart integrated merge task HEAD does not match the physical handoff HEAD",
    );
  }
  deps.assertLifecycleAuthority();
  deps.complete(input.dispatchRevision, {
    kind: "worktree_integrated",
    reference: input.mergeEntry.integratedSha,
    completedAt: deps.now(),
    evidenceIds: [...input.mergeEntry.evidenceIds],
  });
  return true;
}

interface QualityRepairDispatchSnapshot {
  readonly taskId: string;
  readonly revision: number;
  readonly state: string;
  readonly sessionId?: string;
  readonly workerIncarnationId?: string;
  readonly lastError?: string;
}

interface QualityRepairDispatchStore {
  get(taskId: string): QualityRepairDispatchSnapshot | null;
  blockQualityRepairByCoordinator(input: {
    readonly taskId: string;
    readonly revision: number;
    readonly reason: string;
  }): unknown;
  requeueQualityRepairAfterWorkerExit(input: {
    readonly taskId: string;
    readonly revision: number;
    readonly sessionId: string;
    readonly workerIncarnationId: string;
  }): unknown;
}

function qualityRepairFailureDetail(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error);
  const evidenceIds =
    error &&
    typeof error === "object" &&
    "evidenceIds" in error &&
    Array.isArray(error.evidenceIds)
      ? error.evidenceIds
          .filter((value): value is string => typeof value === "string")
          .slice(0, 32)
      : [];
  return evidenceIds.length > 0
    ? `${message}; evidence=${evidenceIds.join(",")}`.slice(0, 65_536)
    : message.slice(0, 65_536);
}

export function projectQualityRepairFailure(
  input: {
    readonly taskId: string;
    readonly error: unknown;
  },
  dispatches: QualityRepairDispatchStore,
): boolean {
  if (classifyOperationalFailure(input.error) !== "repair") return false;
  const current = dispatches.get(input.taskId);
  if (!current) return false;
  if (taskDispatchQualityRepairReason(current)) return true;
  if (!["handoff_ready", "merging"].includes(current.state)) return false;
  dispatches.blockQualityRepairByCoordinator({
    taskId: input.taskId,
    revision: current.revision,
    reason: qualityRepairFailureDetail(input.error),
  });
  return true;
}

export function projectUnchangedQueueRepair(
  input: {
    readonly taskId: string;
    readonly error: unknown;
    readonly snapshot: MergeQueueStateSnapshot;
  },
  dispatches: QualityRepairDispatchStore,
): boolean {
  if (
    !(input.error instanceof Error) ||
    input.error.name !== "MergeRetryRequiredError" ||
    input.snapshot.blocked?.disposition !== "repair" ||
    !input.snapshot.entries.some(
      (entry) =>
        entry.taskKey === input.snapshot.blocked?.taskKey &&
        entry.taskId === input.taskId,
    )
  ) {
    return false;
  }
  const current = dispatches.get(input.taskId);
  if (!current) return false;
  if (taskDispatchQualityRepairReason(current)) return true;
  if (!["handoff_ready", "merging"].includes(current.state)) return false;
  dispatches.blockQualityRepairByCoordinator({
    taskId: input.taskId,
    revision: current.revision,
    reason: input.snapshot.blocked.reason,
  });
  return true;
}

export function requeueRetiredQualityRepairs(input: {
  readonly dispatches: readonly QualityRepairDispatchSnapshot[];
  readonly retiredTaskIds: readonly string[];
  readonly alreadyRetiredTaskIds: readonly string[];
  readonly store: Pick<
    QualityRepairDispatchStore,
    "requeueQualityRepairAfterWorkerExit"
  >;
}): readonly string[] {
  const provenExited = new Set([
    ...input.retiredTaskIds,
    ...input.alreadyRetiredTaskIds,
  ]);
  const requeued: string[] = [];
  for (const dispatch of input.dispatches) {
    if (
      !provenExited.has(dispatch.taskId) ||
      dispatch.state !== "blocked" ||
      !taskDispatchQualityRepairReason(dispatch) ||
      !dispatch.sessionId ||
      !dispatch.workerIncarnationId
    ) {
      continue;
    }
    input.store.requeueQualityRepairAfterWorkerExit({
      taskId: dispatch.taskId,
      revision: dispatch.revision,
      sessionId: dispatch.sessionId,
      workerIncarnationId: dispatch.workerIncarnationId,
    });
    requeued.push(dispatch.taskId);
  }
  return Object.freeze(requeued);
}

interface MissionSchedulerOptions {
  readonly listScopes: () => readonly ProjectExecutionScope[];
  readonly now?: () => number;
}

const states = new Map<
  string,
  ReturnType<typeof createSchedulerRuntimeState>
>();
const merging = new Set<string>();

/**
 * Retryable merge-lane deferrals lack their own natural bound (unlike lease
 * expiry or sibling completion). At a 5s scheduler tick, twelve consecutive
 * deferrals surface in ~1min as an observable technical block instead of
 * hanging the mission silently forever — the same philosophy as
 * MISSION_SCHEDULER_MAX_PRECLAIM_RETRYABLE_FAILURES for pre-claim failures.
 */
export const MISSION_SCHEDULER_MAX_MERGE_DEFERRALS = 12 as const;
const mergeDeferrals = new Map<string, number>();

type MergeDeferralDispatchAuthority = Pick<
  TaskDispatchStore,
  "get" | "blockMergeFailureByCoordinator"
>;

/**
 * Count one consecutive merge-lane deferral for the exact task and, past the
 * bound, project an observable technical block with the last deferral reason.
 * Returns true once the dispatch was blocked (the silent loop ends there).
 * A genuinely busy merge queue (MergeQueueBusyError) is a bounded wait for
 * the in-flight sibling merge and never counts toward the bound.
 */
export function projectBoundedMergeDeferral(
  input: {
    readonly key: string;
    readonly missionId: string;
    readonly taskId: string;
    readonly error: unknown;
  },
  dispatches: MergeDeferralDispatchAuthority,
): boolean {
  if (
    input.error instanceof Error &&
    input.error.name === "MergeQueueBusyError"
  ) {
    return false;
  }
  const consecutive = (mergeDeferrals.get(input.key) ?? 0) + 1;
  if (consecutive < MISSION_SCHEDULER_MAX_MERGE_DEFERRALS) {
    mergeDeferrals.set(input.key, consecutive);
    return false;
  }
  mergeDeferrals.delete(input.key);
  const lastReason =
    input.error instanceof Error ? input.error.message : String(input.error);
  return projectTerminalMergeFailure(
    {
      missionId: input.missionId,
      taskId: input.taskId,
      reason:
        `merge diferido ${consecutive} vezes consecutivas sem progresso ` +
        `(último motivo: ${lastReason}). ` +
        "O coordenador bloqueou a task para encerrar o retry silencioso; " +
        "verifique o worktree e o handoff físico e replaneje a missão.",
    },
    dispatches,
  );
}

/**
 * A dirty executor worktree is a worker contract violation (workers must
 * commit or clean their changes), never a no-change candidate. Translate the
 * generic Git cleanliness conflict into the exact operator-facing reason.
 */
export function explainUncommittedWorktreeConflict(error: unknown): unknown {
  if (
    error instanceof WorktreeStateConflictError &&
    error.message === TASK_WORKTREE_NOT_CLEAN_MESSAGE
  ) {
    return new WorktreeStateConflictError(
      "mudanças não comitadas no worktree — o worker deveria ter comitado",
    );
  }
  return error;
}

let configured: MissionSchedulerOptions | null = null;
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let externalReconcileRequest: (() => boolean) | null = null;
const tickLifecycle = createMissionSchedulerTickLifecycle({
  runPass: (signal) => tick(signal),
  isLegacyLoopRunning: () => started,
});

function missionKey(scope: ProjectExecutionScope, missionId: string): string {
  return `${scope.projectId}:${scope.checkoutId}:${missionId}`;
}

const ACTIVE_SCHEDULER_DISPATCH_STATES = new Set<
  TaskDispatchRecord["state"]
>([
  "claimed",
  "routed",
  "spawning",
  "running",
  "handoff_ready",
  "merging",
]);

type SchedulerActiveWorkerInput = Pick<
  TaskDispatchRecord,
  "taskId" | "state" | "ownership"
>;

type SchedulerWorktreeInput = Pick<
  WorktreeRecord,
  "taskId" | "status" | "ownership"
>;

/**
 * Project physical scheduler capacity without letting a retained retry
 * worktree reserve the slot that its next worker incarnation must reclaim.
 *
 * A superseded dispatch is a durable proof that the previous runtime no
 * longer owns capacity. Worktrees without any durable scheduler identity stay
 * conservative because they may represent an interrupted legacy reservation.
 */
export function projectMissionSchedulerActiveWorkers(
  dispatches: readonly SchedulerActiveWorkerInput[],
  worktrees: readonly SchedulerWorktreeInput[],
): readonly {
  readonly taskId: string;
  readonly ownership: SchedulerRuntimeTask["ownership"];
}[] {
  const durable = dispatches
    .filter((record) =>
      ACTIVE_SCHEDULER_DISPATCH_STATES.has(record.state),
    )
    .map((record) => ({
      taskId: record.taskId,
      ownership: record.ownership,
    }));
  const durableIds = new Set(durable.map((record) => record.taskId));
  const retryableIds = new Set(
    dispatches
      .filter((record) => record.state === "superseded")
      .map((record) => record.taskId),
  );
  const unmanagedWorktrees = worktrees
    .filter(
      (record) => record.status === "ready" || record.status === "queued",
    )
    .filter(
      (record) =>
        !durableIds.has(record.taskId) &&
        !retryableIds.has(record.taskId),
    )
    .map((record) => ({
      taskId: record.taskId,
      ownership: record.ownership,
    }));
  return Object.freeze([...durable, ...unmanagedWorktrees]);
}

function activeWorkers(
  scope: ProjectExecutionScope,
  missionId: string,
): readonly {
  readonly taskId: string;
  readonly ownership: SchedulerRuntimeTask["ownership"];
}[] {
  return projectMissionSchedulerActiveWorkers(
    getProjectDomainStores(scope).taskDispatches.list(missionId),
    requireWorktreeRuntimeRegistry().listMission(scope, missionId),
  );
}

function schedulerTasks(
  scope: ProjectExecutionScope,
  missionId: string,
): readonly SchedulerRuntimeTask[] {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  const intentVersion = mission?.intentContract?.intentVersion;
  if (intentVersion === undefined) return [];
  const dispatches = new Map(
    stores.taskDispatches
      .list(missionId)
      .map((record) => [record.taskId, record]),
  );
  // Only the immutable receipt is schedulable. Ad-hoc task rows are never
  // allowed to leak into an approved mission's worker queue.
  return stores.tasks
    .listPlannedTasks(missionId, intentVersion)
    .map((planned) => {
      const mapped = taskRecordToSchedulerTask(planned.task);
      const dispatch = dispatches.get(planned.taskId);
      return {
        ...mapped,
        // A dependency advances only after the durable coordinator receipt.
        // `worktree.status=integrated` alone is an incomplete crash window.
        merged: dispatch?.state === "completed",
      };
    });
}

async function mergeCompletedTask(
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfMissionSchedulerAborted(signal);
  const key = missionKey(scope, missionId) + `:${taskId}`;
  const mergeSkip = (reason: string) =>
    console.warn(
      `[mission-scheduler] merge skip ${missionId}/${taskId}: ${reason}`,
    );
  if (merging.has(key)) {
    mergeSkip("merge em voo (merging.has)");
    return;
  }
  const worktree = requireWorktreeRuntimeRegistry().get(
    scope,
    missionId,
    taskId,
  );
  if (!worktree) {
    mergeSkip("worktree ausente no registry em memória");
    return;
  }
  const domainStores = getProjectDomainStores(scope);
  let dispatch = domainStores.taskDispatches.get(taskId);
  if (!dispatch || !["handoff_ready", "merging"].includes(dispatch.state)) {
    // A terminal dispatch (completed/blocked) leaves the merge lane: drop any
    // stale deferral counter so a future task reusing the key starts fresh.
    mergeDeferrals.delete(key);
    mergeSkip(`dispatch state=${dispatch?.state ?? "ausente"}`);
    return;
  }
  const mergeIntentVersion = dispatch.intentVersion;
  const noChangeMarker =
    worktree.status === "integrated" &&
    worktree.taskHeadSha === worktree.baseSha &&
    worktree.integratedSha === worktree.baseSha;
  if (isGuidedIsolatedAdvisory(dispatch)) {
    merging.add(key);
    try {
      const expectedTaskHeadSha =
        domainStores.taskDispatches.assertPhysicalHandoffTaskHead({
          taskId,
          missionId,
          intentVersion: mergeIntentVersion,
          expectedStates: ["handoff_ready", "merging"],
        });
      if (worktree.status !== "ready" && !noChangeMarker) {
        throw new MissionSchedulerDispatchAuthorityError(
          `guided isolated advisory cannot finalize from worktree status ${worktree.status}`,
        );
      }
      const registry = requireWorktreeRuntimeRegistry();
      finalizeGuidedIsolatedAdvisory(
        {
          scope,
          missionId,
          taskId,
          dispatch,
          expectedTaskHeadSha,
        },
        {
          prepare: () =>
            registry.prepareNoChangeValidation(scope, missionId, taskId),
          beginMerge: (revision) =>
            domainStores.taskDispatches.beginMerge({ taskId, revision }),
          assertAuthority: () => {
            const current =
              domainStores.taskDispatches.assertLifecycleAuthority({
                taskId,
                missionId,
                intentVersion: mergeIntentVersion,
                expectedStates: ["merging"],
              });
            const currentPhysicalHead =
              domainStores.taskDispatches.assertPhysicalHandoffTaskHead({
                taskId,
                missionId,
                intentVersion: mergeIntentVersion,
                expectedStates: ["merging"],
              });
            if (currentPhysicalHead !== expectedTaskHeadSha) {
              throw new MissionSchedulerDispatchAuthorityError(
                "guided isolated advisory physical handoff HEAD changed",
              );
            }
            return current;
          },
          markValidated: (prepared) => {
            registry.markValidatedNoChange(
              scope,
              missionId,
              taskId,
              prepared.taskHeadSha,
              prepared.integrationHeadSha,
            );
          },
          complete: (revision, reference) => {
            domainStores.taskDispatches.completeIsolatedAdvisoryFromPhysicalHandoff(
              {
                taskId,
                revision,
                reference,
              },
            );
          },
        },
      );
    } catch (error) {
      throwIfMissionSchedulerAborted(signal);
      const terminal = projectTerminalFinalizationFailure(
        {
          missionId,
          taskId,
          error,
        },
        domainStores.taskDispatches,
      );
      console.warn(
        `[mission-scheduler] isolated advisory ${
          terminal ? "blocked" : "finalization deferred"
        } for ${missionId}/${taskId}:`,
        error,
      );
    } finally {
      merging.delete(key);
    }
    // This sealed domain never falls through to the generic MergeQueue, even
    // when a worker committed or dirtied the disposable worktree.
    return;
  }
  if (
    isGuidedNoChangeQualityGate(dispatch) &&
    (worktree.status === "ready" || noChangeMarker)
  ) {
    merging.add(key);
    try {
      const expectedTaskHeadSha =
        domainStores.taskDispatches.assertPhysicalHandoffTaskHead({
          taskId,
          missionId,
          intentVersion: mergeIntentVersion,
          expectedStates: ["handoff_ready", "merging"],
        });
      const assertPreparationAuthority = () => {
        const stores = getProjectDomainStores(scope);
        stores.taskDispatches.assertLifecycleAuthority({
          taskId,
          missionId,
          intentVersion: mergeIntentVersion,
          expectedStates: ["handoff_ready", "merging"],
        });
        if (
          stores.taskDispatches.assertPhysicalHandoffTaskHead({
            taskId,
            missionId,
            intentVersion: mergeIntentVersion,
            expectedStates: ["handoff_ready", "merging"],
          }) !== expectedTaskHeadSha
        ) {
          throw new MissionSchedulerDispatchAuthorityError(
            "guided no-change physical handoff HEAD changed",
          );
        }
      };
      try {
        await prepareMissionSchedulerPrevcPromotion({
          scope,
          missionId,
          assertCurrentAuthority: assertPreparationAuthority,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throwIfMissionSchedulerAborted(signal);
        // The no-change QA path bypasses MergeQueue, but it is still a final
        // promotion. Capacity stays retryable; corrupt/stale authority is
        // projected once instead of leaving the mission in an infinite loop.
        if (classifyPrevcMergeFailure(error) === "terminal") {
          projectTerminalMergeFailure(
            {
              missionId,
              taskId,
              reason: error instanceof Error ? error.message : String(error),
            },
            domainStores.taskDispatches,
          );
        }
        console.warn(
          `[mission-scheduler] PREVC no-change promotion pending for ${missionId}/${taskId}:`,
          error,
        );
        return;
      }
      const registry = requireWorktreeRuntimeRegistry();
      const service = getContextWorkflowService(scope);
      const validator = new MergeValidationCoordinator(service);
      const handled = await finalizeGuidedNoChangeQualityGate(
        {
          scope,
          missionId,
          taskId,
          dispatch,
          expectedTaskHeadSha,
        },
        {
          prepare: () =>
            registry.prepareNoChangeValidation(scope, missionId, taskId),
          beginMerge: (revision) =>
            domainStores.taskDispatches.beginMerge({ taskId, revision }),
          assertAuthority: () => {
            const current =
              domainStores.taskDispatches.assertLifecycleAuthority({
                taskId,
                missionId,
                intentVersion: mergeIntentVersion,
                expectedStates: ["merging"],
              });
            if (
              domainStores.taskDispatches.assertPhysicalHandoffTaskHead({
                taskId,
                missionId,
                intentVersion: mergeIntentVersion,
                expectedStates: ["merging"],
              }) !== expectedTaskHeadSha
            ) {
              throw new MissionSchedulerDispatchAuthorityError(
                "guided no-change physical handoff HEAD changed",
              );
            }
            return current;
          },
          validate: (context) => validator.validate(context),
          markValidated: (prepared) => {
            registry.markValidatedNoChange(
              scope,
              missionId,
              taskId,
              prepared.taskHeadSha,
              prepared.integrationHeadSha,
            );
          },
          complete: (revision, receipt) => {
            domainStores.taskDispatches.completeByCoordinator({
              taskId,
              revision,
              receipt: {
                ...receipt,
                evidenceIds: [...receipt.evidenceIds],
              },
            });
          },
          now: () => configured?.now?.() ?? Date.now(),
        },
      );
      if (handled) return;
    } catch (error) {
      throwIfMissionSchedulerAborted(signal);
      if (classifyOperationalFailure(error) === "terminal") {
        projectTerminalMergeFailure(
          {
            missionId,
            taskId,
            reason: error instanceof Error ? error.message : String(error),
          },
          domainStores.taskDispatches,
        );
      }
      console.warn(
        `[mission-scheduler] no-change validation deferred for ${missionId}/${taskId}:`,
        error,
      );
      return;
    } finally {
      merging.delete(key);
    }
  }
  // Honest zero-commit executor: when the guided implementation worktree is
  // still exactly its sealed base (clean tree, HEAD == base), the MergeQueue
  // would defer forever on "task has no committed changes". Mint the audited
  // no-change receipt instead and let the reviewer/QA chain judge the
  // outcome. Real commits (`handled === false`) fall through to MergeQueue.
  if (
    isGuidedImplementationDelivery(dispatch) &&
    (worktree.status === "ready" || noChangeMarker)
  ) {
    merging.add(key);
    try {
      const expectedTaskHeadSha =
        domainStores.taskDispatches.assertPhysicalHandoffTaskHead({
          taskId,
          missionId,
          intentVersion: mergeIntentVersion,
          expectedStates: ["handoff_ready", "merging"],
        });
      const registry = requireWorktreeRuntimeRegistry();
      const handled = finalizeGuidedImplementationNoChange(
        {
          scope,
          missionId,
          taskId,
          dispatch,
          expectedTaskHeadSha,
        },
        {
          prepare: () => {
            try {
              return registry.prepareNoChangeValidation(
                scope,
                missionId,
                taskId,
              );
            } catch (error) {
              throw explainUncommittedWorktreeConflict(error);
            }
          },
          beginMerge: (revision) =>
            domainStores.taskDispatches.beginMerge({ taskId, revision }),
          assertAuthority: () => {
            const current =
              domainStores.taskDispatches.assertLifecycleAuthority({
                taskId,
                missionId,
                intentVersion: mergeIntentVersion,
                expectedStates: ["merging"],
              });
            if (
              domainStores.taskDispatches.assertPhysicalHandoffTaskHead({
                taskId,
                missionId,
                intentVersion: mergeIntentVersion,
                expectedStates: ["merging"],
              }) !== expectedTaskHeadSha
            ) {
              throw new MissionSchedulerDispatchAuthorityError(
                "implementation no-change physical handoff HEAD changed",
              );
            }
            return current;
          },
          markValidated: (prepared) => {
            registry.markValidatedNoChange(
              scope,
              missionId,
              taskId,
              prepared.taskHeadSha,
              prepared.integrationHeadSha,
            );
          },
          complete: (revision, receipt) => {
            domainStores.taskDispatches.completeByCoordinator({
              taskId,
              revision,
              receipt: {
                ...receipt,
                evidenceIds: [...receipt.evidenceIds],
              },
            });
          },
          now: () => configured?.now?.() ?? Date.now(),
        },
      );
      if (handled) {
        mergeDeferrals.delete(key);
        return;
      }
      // Real committed changes: the ordinary MergeQueue path below owns them.
    } catch (error) {
      throwIfMissionSchedulerAborted(signal);
      const blocked =
        projectTerminalFinalizationFailure(
          {
            missionId,
            taskId,
            error,
          },
          domainStores.taskDispatches,
        ) ||
        projectBoundedMergeDeferral(
          { key, missionId, taskId, error },
          domainStores.taskDispatches,
        );
      if (blocked) mergeDeferrals.delete(key);
      console.warn(
        `[mission-scheduler] implementation no-change ${
          blocked ? "blocked" : "finalization deferred"
        } for ${missionId}/${taskId}:`,
        error,
      );
      return;
    } finally {
      merging.delete(key);
    }
  }
  const registry = requireWorktreeRuntimeRegistry();
  registry.reconcileMergeIfIdle(scope);
  const queueSnapshot = registry.mergeSnapshot(scope);
  const recoverableIntegratedEntry =
    worktree.status === "integrated"
      ? recoverableIntegratedMergeEntry(queueSnapshot, missionId, taskId)
      : null;
  if (worktree.status === "integrated" && !recoverableIntegratedEntry) {
    const mergeEntry = queueSnapshot
      .entries.find(
        (entry) =>
          entry.missionId === missionId &&
          entry.taskId === taskId &&
          ["finalizing", "integrated"].includes(entry.status) &&
          Boolean(entry.integratedSha),
    );
    if (!mergeEntry?.integratedSha) return;
    try {
      finalizeRestartedIntegratedMerge(
        {
          dispatchRevision: dispatch.revision,
          mergeEntry: {
            taskHeadSha: mergeEntry.taskHeadSha,
            integratedSha: mergeEntry.integratedSha,
            evidenceIds: mergeEntry.evidenceIds,
          },
        },
        {
          assertLifecycleAuthority: () => {
            domainStores.taskDispatches.assertLifecycleAuthority({
              taskId,
              missionId,
              intentVersion: mergeIntentVersion,
              expectedStates: ["handoff_ready", "merging"],
            });
          },
          assertPhysicalHandoffTaskHead: () =>
            domainStores.taskDispatches.assertPhysicalHandoffTaskHead({
              taskId,
              missionId,
              intentVersion: mergeIntentVersion,
              expectedStates: ["handoff_ready", "merging"],
            }),
          complete: (revision, receipt) => {
            domainStores.taskDispatches.completeByCoordinator({
              taskId,
              revision,
              receipt: {
                ...receipt,
                evidenceIds: [...receipt.evidenceIds],
              },
            });
          },
          now: () => Date.now(),
        },
      );
    } catch (error) {
      const terminal = projectTerminalFinalizationFailure(
        {
          missionId,
          taskId,
          error,
        },
        domainStores.taskDispatches,
      );
      console.warn(
        `[mission-scheduler] restarted integration ${
          terminal ? "blocked" : "finalization deferred"
        } for ${missionId}/${taskId}:`,
        error,
      );
    }
    return;
  }
  if (worktree.status === "failed") {
    projectTerminalMergeFailure(
      {
        missionId,
        taskId,
        reason:
          worktree.failureReason ??
          "o worktree de integração entrou em estado failed sem receipt",
      },
      domainStores.taskDispatches,
    );
    return;
  }
  if (
    worktree.status !== "ready" &&
    worktree.status !== "queued" &&
    !recoverableIntegratedEntry
  ) {
    mergeSkip(`worktree status=${worktree.status}`);
    return;
  }
  merging.add(key);
  try {
    const expectedTaskHeadSha =
      domainStores.taskDispatches.assertPhysicalHandoffTaskHead({
        taskId,
        missionId,
        intentVersion: mergeIntentVersion,
        expectedStates: ["handoff_ready", "merging"],
      });
    const assertPreparationAuthority = () => {
      const stores = getProjectDomainStores(scope);
      stores.taskDispatches.assertLifecycleAuthority({
        taskId,
        missionId,
        intentVersion: mergeIntentVersion,
        expectedStates: ["handoff_ready", "merging"],
      });
      if (
        stores.taskDispatches.assertPhysicalHandoffTaskHead({
          taskId,
          missionId,
          intentVersion: mergeIntentVersion,
          expectedStates: ["handoff_ready", "merging"],
        }) !== expectedTaskHeadSha
      ) {
        throw new MissionSchedulerDispatchAuthorityError(
          "merge physical handoff HEAD changed",
        );
      }
    };
    try {
      await prepareMissionSchedulerPrevcPromotion({
        scope,
        missionId,
        assertCurrentAuthority: assertPreparationAuthority,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throwIfMissionSchedulerAborted(signal);
      // PREVC preparation is deliberately opportunistic while workers run and
      // mandatory only at promotion. Capacity remains a retryable wait, while
      // durable authority/configuration failures receive an actionable state.
      if (classifyPrevcMergeFailure(error) === "terminal") {
        projectTerminalMergeFailure(
          {
            missionId,
            taskId,
            reason: error instanceof Error ? error.message : String(error),
          },
          domainStores.taskDispatches,
        );
      }
      console.warn(
        `[mission-scheduler] PREVC promotion preparation pending for ${missionId}/${taskId}:`,
        error,
      );
      return;
    }
    if (dispatch.state === "handoff_ready") {
      dispatch = domainStores.taskDispatches.beginMerge({
        taskId,
        revision: dispatch.revision,
      });
    }
    let finalizedIntegrationReference: string | null = null;
    const assertCurrentMergeAuthority = () => {
      const stores = getProjectDomainStores(scope);
      const current = stores.taskDispatches.assertLifecycleAuthority({
        taskId,
        missionId,
        intentVersion: mergeIntentVersion,
        expectedStates: finalizedIntegrationReference
          ? ["completed"]
          : ["merging"],
      });
      if (
        !finalizedIntegrationReference &&
        stores.taskDispatches.assertPhysicalHandoffTaskHead({
          taskId,
          missionId,
          intentVersion: mergeIntentVersion,
          expectedStates: ["merging"],
        }) !== expectedTaskHeadSha
      ) {
        throw new MissionSchedulerDispatchAuthorityError(
          "merge physical handoff HEAD changed",
        );
      }
      if (
        finalizedIntegrationReference &&
        (current.integrationReceipt?.kind !== "worktree_integrated" ||
          current.integrationReceipt.reference !==
            finalizedIntegrationReference)
      ) {
        throw new Error(
          "receipt final divergiu da integração autorizada pelo merge queue",
        );
      }
    };
    assertCurrentMergeAuthority();
    const service = getContextWorkflowService(scope);
    const validator = new MergeValidationCoordinator(service);
    const blockedEntry = queueSnapshot.blocked
      ? queueSnapshot.entries.find(
          (entry) =>
            entry.taskKey === queueSnapshot.blocked?.taskKey &&
            entry.missionId === missionId &&
            entry.taskId === taskId,
        )
      : undefined;
    const enqueue =
      blockedEntry &&
      (queueSnapshot.blocked?.disposition ?? "terminal") !== "terminal"
        ? registry.retryRecoverable.bind(registry)
        : registry.enqueue.bind(registry);
    await enqueue({
      scope,
      missionId,
      taskId,
      expectedTaskHeadSha,
      ...(signal ? { signal } : {}),
      assertCurrentAuthority: assertCurrentMergeAuthority,
      validate: (context) => validator.validate(context),
      finalize: (result) => {
        const finalStores = getProjectDomainStores(scope);
        assertCurrentMergeAuthority();
        const currentDispatch = finalStores.taskDispatches.get(taskId);
        if (
          currentDispatch?.state === "handoff_ready" ||
          currentDispatch?.state === "merging"
        ) {
          finalStores.taskDispatches.completeByCoordinator({
            taskId,
            revision: currentDispatch.revision,
            receipt: {
              kind: "worktree_integrated",
              reference: result.integratedSha,
              completedAt: Date.now(),
              evidenceIds: [...result.evidenceIds],
            },
          });
          finalizedIntegrationReference = result.integratedSha;
        }
      },
    });
    mergeDeferrals.delete(key);
    throwIfMissionSchedulerAborted(signal);
  } catch (error) {
    throwIfMissionSchedulerAborted(signal);
    let repairProjected = projectQualityRepairFailure(
      { taskId, error },
      getProjectDomainStores(scope).taskDispatches,
    );
    if (!repairProjected) {
      repairProjected = projectUnchangedQueueRepair(
        { taskId, error, snapshot: queueSnapshot },
        getProjectDomainStores(scope).taskDispatches,
      );
    }
    if (
      !repairProjected &&
      classifyOperationalFailure(error) === "terminal"
    ) {
      repairProjected = projectTerminalMergeFailure(
        {
          missionId,
          taskId,
          reason: error instanceof Error ? error.message : String(error),
        },
        getProjectDomainStores(scope).taskDispatches,
      );
    }
    if (!repairProjected) {
      // Retryable deferrals (capacity waits, blocked queue, transient Git
      // conflicts) are bounded: past the limit the task receives an
      // observable technical block instead of looping silently forever.
      repairProjected = projectBoundedMergeDeferral(
        { key, missionId, taskId, error },
        getProjectDomainStores(scope).taskDispatches,
      );
    }
    if (repairProjected) mergeDeferrals.delete(key);
    console.warn(
      `[mission-scheduler] merge deferred for ${missionId}/${taskId}:`,
      error,
    );
  } finally {
    merging.delete(key);
  }
}

async function retireMissionTaskWorkers(
  scope: ProjectExecutionScope,
  missionId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfMissionSchedulerAborted(signal);
  const stores = getProjectDomainStores(scope);
  const dispatches = stores.taskDispatches.list(missionId);
  const retired = await productionTaskDispatchWorkerRetirement.retireMissionWorkers({
    scope,
    missionId,
    dispatches,
    ...(signal ? { signal } : {}),
    deps: {
      getDispatch: (taskId) => stores.taskDispatches.get(taskId),
      closeWorker: ({
        paneId,
        sessionId,
        missionId: workerMissionId,
        workerIncarnationId,
        scope: workerScope,
      }) =>
        requestMissionWorkerPaneRetirement({
          paneId,
          sessionId,
          missionId: workerMissionId,
          workerIncarnationId,
          scope: workerScope,
      }),
    },
  });
  throwIfMissionSchedulerAborted(signal);
  requeueRetiredQualityRepairs({
    dispatches,
    retiredTaskIds: retired.retiredTaskIds,
    alreadyRetiredTaskIds: retired.alreadyRetiredTaskIds,
    store: stores.taskDispatches,
  });
}

async function tickMission(
  scope: ProjectExecutionScope,
  missionId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfMissionSchedulerAborted(signal);
  const stores = getProjectDomainStores(scope);
  // Nothing downstream—merge, spawn or mission completion—may advance before
  // the finite idle→busy kickoff proof commits for the current revision and
  // physical orchestrator session. The mission-store change wakes this tick.
  if (!missionSchedulerHasKickoffAuthority(stores.missions, missionId)) {
    const pendingMerge = stores.taskDispatches
      .list(missionId)
      .some((dispatch) =>
        ["handoff_ready", "merging"].includes(dispatch.state),
      );
    if (pendingMerge) {
      console.warn(
        `[mission-scheduler] tick skip ${missionId}: kickoff authority ausente com merge pendente`,
      );
    }
    return;
  }
  const mission = stores.missions.get(missionId);
  const key = missionKey(scope, missionId);
  const state =
    states.get(key) ??
    createSchedulerRuntimeState({
      adaptiveCap: productionAdaptiveCapSeed(mission?.intentContract),
    });
  // Heal superseded plan generations before admission: a PREVC refreeze or
  // reapproval seals a fresh generation, and older generations' orphan
  // pending tasks (plus their reusable worktrees) otherwise hold ownership
  // forever and wedge the current executor behind OwnershipOverlapError.
  try {
    reconcileSupersededPlanGenerations(scope, missionId);
  } catch (error) {
    throwIfMissionSchedulerAborted(signal);
    console.warn(
      `[mission-scheduler] stale plan generation retirement deferred for ${missionId}:`,
      error,
    );
  }
  const result = await runMissionSchedulerLaunchPass({
    ...(signal ? { signal } : {}),
    reconcile: async (passSignal) => {
      const dispatches = orderMissionDispatchesForReconciliation(
        stores.taskDispatches.list(missionId),
      );
      for (const dispatch of dispatches) {
        throwIfMissionSchedulerAborted(passSignal);
        if (!["handoff_ready", "merging"].includes(dispatch.state)) continue;
        if (
          dispatch.executionMode === "same_checkout" &&
          dispatch.state === "handoff_ready"
        ) {
          // 06/08: era aqui que TODA missão do caminho simples morria na
          // ENTREGA — bloqueada com "replaneje com ownership e worktree
          // isolado", mandando o operador refazer a cerimônia que acabáramos
          // de remover. `same_checkout` agora tem forma de conclusão própria
          // (kind `simple-implementation`, receipt `same_checkout_validated`),
          // então o handoff conclui em vez de estacionar.
          try {
            stores.taskDispatches.completeSameCheckoutFromTrustedHandoff({
              taskId: dispatch.taskId,
              revision: dispatch.revision,
            });
          } catch (error) {
            const terminal = projectTerminalFinalizationFailure(
              { missionId, taskId: dispatch.taskId, error },
              stores.taskDispatches,
            );
            console.warn(
              `[mission-scheduler] same_checkout ${
                terminal ? "blocked" : "finalization deferred"
              } for ${missionId}/${dispatch.taskId}:`,
              error,
            );
          }
          continue;
        }
        if (
          dispatch.executionMode === "read_only" &&
          dispatch.state === "handoff_ready"
        ) {
          try {
            const registry = requireWorktreeRuntimeRegistry();
            const disposable = registry.get(
              scope,
              missionId,
              dispatch.taskId,
            );
            if (disposable) {
              const prepared = registry.prepareDiscardedNoChangeValidation(
                scope,
                missionId,
                dispatch.taskId,
              );
              if (!prepared) {
                throw new MissionSchedulerDispatchAuthorityError(
                  "o reviewer alterou ou commitou arquivos no worktree descartável",
                );
              }
              registry.markDiscardedNoChange(
                scope,
                missionId,
                dispatch.taskId,
                prepared.taskHeadSha,
                prepared.integrationHeadSha,
              );
            }
            stores.taskDispatches.completeReadOnlyFromTrustedHandoff({
              taskId: dispatch.taskId,
              revision: dispatch.revision,
            });
          } catch (error) {
            const terminal = projectTerminalFinalizationFailure(
              {
                missionId,
                taskId: dispatch.taskId,
                error,
              },
              stores.taskDispatches,
            );
            console.warn(
              `[mission-scheduler] read-only ${
                terminal ? "blocked" : "finalization deferred"
              } for ${missionId}/${dispatch.taskId}:`,
              error,
            );
          }
          continue;
        }
        await mergeCompletedTask(
          scope,
          missionId,
          dispatch.taskId,
          passSignal,
        );
      }
    },
    // A terminal task no longer reserves logical maxWorkers capacity. Attempt
    // exact task/session/incarnation cleanup before launching the next wave;
    // an unproven exit stays retryable without aborting same-tick completion,
    // PREVC or sibling cleanup.
    retireWorkers: async (passSignal) => {
      throwIfMissionSchedulerAborted(passSignal);
      try {
        await retireMissionTaskWorkers(scope, missionId, passSignal);
      } catch (error) {
        throwIfMissionSchedulerAborted(passSignal);
        console.warn(
          `[mission-scheduler] worker retirement deferred for ${missionId}:`,
          error,
        );
      }
      throwIfMissionSchedulerAborted(passSignal);
    },
    snapshot: (passSignal) => {
      throwIfMissionSchedulerAborted(passSignal);
      return schedulerTasks(scope, missionId);
    },
    launchNext: (currentSchedulerTasks, passSignal) =>
      runSchedulerTick(
        {
          isParallelSchedulerEnabled: () =>
            getFeatureFlagRegistry().isEnabled(
              FEATURE_FLAG_IDS.parallelScheduler,
            ),
          listTasks: () => currentSchedulerTasks,
          listActiveWorkers: () => activeWorkers(scope, missionId),
          scheduleConfig: () => ({
            configuredCap: mission?.intentContract
              ? missionSchedulerConfiguredWorkerCap(mission.intentContract)
              : 0,
            // Real machine limits, not pretend config (host cores + renderer
            // pane budget — see missionSchedulerMachineLimits).
            ...missionSchedulerMachineLimits(),
          }),
          // Operator-choice (frictionless default): the approved maxWorkers
          // IS the wave cap, no adaptive clamp. Governed keeps the
          // conservative adaptive ladder.
          isAdaptiveCapEnabled: () =>
            !isOperatorChoicePolicy(getOrchSettings().squadCliPolicy),
          useConfiguredCapForCurrentWave: () =>
            isTeamReadOnlyFanoutSchedulerWave(currentSchedulerTasks),
          // P0-9: every number needed to answer "why are only N panes alive?"
          // is computed here and was previously dropped on the floor, which is
          // exactly how a legitimate ceiling becomes indistinguishable from a
          // broken fan-out. Diagnose against the SAME config the wave used —
          // the adaptive/operator-choice resolution the tick applied — so the
          // reported ceiling is the one that actually bound it.
          onDecision: (decision, waveConfig) => {
            reportWaveConcurrency(
              scope,
              missionId,
              diagnoseWaveConcurrency(waveConfig, decision, {
                // The APPROVED ceiling, so a wave narrowed by the governed
                // adaptive ladder is not misreported as a contract limit the
                // operator should raise (the contract is already wider).
                contractCap: mission?.intentContract
                  ? missionSchedulerConfiguredWorkerCap(mission.intentContract)
                  : 0,
                // Total do plano selado: sem ele o veredito diz "1 unidade
                // elegível" e o operador lê "a máquina se segurou". Dizendo
                // "1 de 6", ele lê o GRAFO — as outras 5 aguardam dependências.
                plannedTotal: currentSchedulerTasks.length,
              }),
            );
          },
          now: () => configured?.now?.() ?? Date.now(),
          dispatchTask: (request, dispatchSignal) =>
            dispatchMissionSchedulerTask(
              scope,
              missionId,
              request,
              dispatchSignal,
            ),
          isRetryableDispatchError: isMissionSchedulerRetryableDispatchError,
          isCapacityWaitError: isMissionSchedulerCapacityWait,
          // Identity of the waiter: without it a real cross-mission collision
          // cannot be told from an intra-mission race, and the wait lane
          // correctly stays off.
          missionId: () => missionId,
          onOwnershipWait: (wait) => {
            // A plain wait reaches no durable surface (nothing is blocked),
            // so this log is the only place it is visible. `expired` and
            // `deadlock` also go through markFailed → blockBeforeClaim, which
            // missionBlockCause presents to the operator as an ownership
            // conflict. Throttle the plain wait to ~1 line/minute at the 5s
            // tick; never throttle an outcome that ends the wait.
            if (
              wait.decision.kind === 'wait' &&
              wait.decision.waitedMs > 0 &&
              wait.decision.waitedMs % 60_000 >= MISSION_SCHEDULER_TICK_MS
            ) {
              return;
            }
            console.warn(
              `[mission-scheduler] ownership ${wait.decision.kind} for ` +
                `${missionId}/${wait.taskId}: ${wait.decision.reason}`,
            );
          },
          onRetryableDispatchFailure: (failure) => {
            // First failure and the blocking one always log; in between,
            // ~1 line/minute at the 5s tick keeps the stuck task visible
            // without flooding the child stdout.
            if (
              !failure.willBlock &&
              failure.consecutiveFailures !== 1 &&
              failure.consecutiveFailures % 12 !== 0
            ) {
              return;
            }
            console.warn(
              `[mission-scheduler] pre-claim dispatch failure for ` +
                `${missionId}/${failure.taskId} (attempt ` +
                `${failure.consecutiveFailures}` +
                `${failure.willBlock ? ", blocking task" : ""}):`,
              failure.error,
            );
          },
          getChangedFiles: async () => [],
          mergeTask: async () => undefined,
          markMerged: async () => undefined,
          markFailed: async (taskId, reason) => {
            const currentMission = stores.missions.get(missionId);
            const intentVersion =
              currentMission?.intentContract?.intentVersion;
            if (intentVersion === undefined) return;
            const durableReason =
              classifyOperationalFailure(new Error(reason)) === "terminal"
                ? terminalOperationalFailureReason(reason)
                : reason;
            stores.taskDispatches.blockBeforeClaim({
              missionId,
              taskId,
              intentVersion,
              reason: durableReason,
            });
          },
          reRunSequentially: async () => undefined,
        },
        state,
        passSignal,
      ),
  });
  throwIfMissionSchedulerAborted(signal);
  states.set(key, result.state);
  const currentMission = stores.missions.get(missionId);
  await reconcileMissionCompletionAfterSchedulerTick({
    mission: currentMission,
    dispatches: stores.taskDispatches.list(missionId),
    // Guided completion is PREVC/Mission Driver-owned. The bridge proves the
    // exact current sealed wave is terminal, validates the integrated binding,
    // publishes one idempotent final handoff and only wakes the Driver.
    runGuidedBridge: () =>
      runGuidedPrevcPostMergeBridge(scope, missionId),
    completeLegacy: (intentVersion) => {
      stores.taskDispatches.completeMissionFromVerifiedPlan({
        missionId,
        intentVersion,
      });
    },
  });
  throwIfMissionSchedulerAborted(signal);
}

async function tick(signal?: AbortSignal): Promise<void> {
  throwIfMissionSchedulerAborted(signal);
  if (!configured) return;
  await runBoundedMissionSchedulerPass({
    scopes: configured.listScopes(),
    scopeConcurrency: MISSION_SCHEDULER_CONCURRENCY_LIMITS.scopes,
    missionConcurrency: MISSION_SCHEDULER_CONCURRENCY_LIMITS.missionsPerScope,
    reconcileScope: async (scope) => {
      throwIfMissionSchedulerAborted(signal);
      // Cada projeção isolada: uma que lança cronicamente silenciava TODAS as
      // seguintes — o sweep de reroute nunca rodava e ninguém via erro algum.
      const guarded = (label: string, run: () => unknown): void => {
        try {
          run();
        } catch (error) {
          console.warn(
            `[mission-scheduler] projeção ${label} falhou no scope:`,
            error,
          );
        }
      };
      await reconcileLegacyGuidedDirtyCheckoutBootstrap(
        getProjectDomainStores(scope),
      ).catch((error) => {
        console.warn(
          '[mission-scheduler] projeção legacy-bootstrap falhou no scope:',
          error,
        );
      });
      throwIfMissionSchedulerAborted(signal);
      guarded('interrupted-worktree', () =>
        reconcileInterruptedWorktreeReservationFailuresForScope(scope),
      );
      // Merge abandonado pelo PRÓPRIO processo: por idade, antes das projeções
      // terminais — sem isto a missão espera para sempre sem erro nenhum.
      guarded('stalled-merge', () =>
        requireWorktreeRuntimeRegistry().reconcileMergeIfStalled(scope),
      );
      // Before projecting merge failures: a block orphaned mid-process (its
      // mission removed after scope construction) must lift here, or every
      // later mission of the scope inherits it as a terminal deferral chain.
      guarded('orphaned-merge-block', () =>
        reconcileOrphanedMissionMergeBlockForScope(scope),
      );
      guarded('terminal-merge', () =>
        reconcileTerminalMergeFailureForScope(scope),
      );
      guarded('terminal-dispatch-worktree', () =>
        reconcileTerminalDispatchWorktreeReleaseForScope(scope),
      );
      // After the terminal projections above: a worker whose CLI exhausted
      // physical spawn attempts gets re-routed to another live agent of the
      // SAME sealed roster, and the mission reopens for the recovery loop.
      guarded('exhausted-provider-reroute', () =>
        reconcileExhaustedProviderRerouteForScope(scope),
      );
    },
    listMissions: (scope) => {
      throwIfMissionSchedulerAborted(signal);
      return getProjectDomainStores(scope).missions.list("running");
    },
    runMission: async (scope, mission) => {
      try {
        await tickMission(scope, mission.id, signal);
      } catch (error) {
        throwIfMissionSchedulerAborted(signal);
        console.warn(
          `[mission-scheduler] tick failed for ${mission.id}:`,
          error,
        );
      }
    },
  });
  throwIfMissionSchedulerAborted(signal);
}

export function requestMissionSchedulerTick(): void {
  if (externalReconcileRequest) {
    externalReconcileRequest();
    return;
  }
  tickLifecycle.requestLegacyPass();
}

export function setMissionSchedulerReconcileRequest(
  request: (() => boolean) | null,
): void {
  externalReconcileRequest = request;
}

/** One single-flight pass for the main-owned orchestration coordinator. */
export async function reconcileMissionScheduler(
  signal?: AbortSignal,
): Promise<void> {
  throwIfMissionSchedulerAborted(signal);
  if (!configured) {
    console.warn(
      "[mission-scheduler] reconcile ignorado: scheduler não configurado",
    );
    return;
  }
  await tickLifecycle.reconcile(signal);
  throwIfMissionSchedulerAborted(signal);
}

export function configureMissionScheduler(
  options: MissionSchedulerOptions,
): void {
  disposeMissionScheduler();
  configured = options;
  unsubscribe = requireProjectDomainStoreRegistry().onChange(
    (_scope, store) => {
      if (
        store === "tasks" ||
        store === "task-dispatches" ||
        store === "handoffs" ||
        store === "missions" ||
        store === "mission-panes"
      ) {
        requestMissionSchedulerTick();
      }
    },
  );
}

export function startMissionSchedulerLoop(): void {
  if (started) return;
  started = true;
  timer = setInterval(requestMissionSchedulerTick, MISSION_SCHEDULER_TICK_MS);
  timer.unref?.();
  requestMissionSchedulerTick();
}

export function stopMissionSchedulerLoop(): void {
  started = false;
  tickLifecycle.reset();
  if (timer) clearInterval(timer);
  timer = null;
}

export function disposeMissionScheduler(): void {
  stopMissionSchedulerLoop();
  unsubscribe?.();
  unsubscribe = null;
  configured = null;
  externalReconcileRequest = null;
  states.clear();
  merging.clear();
  mergeDeferrals.clear();
}
