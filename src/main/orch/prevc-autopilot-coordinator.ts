import type { Mission, Squad } from "../../shared/orch-types";
import { hasCurrentDispatchAuthority } from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import { CliAutomatedReviewer } from "../context/cli-automated-reviewer";
import type { ContextWorkflowService } from "../context/context-workflow-service";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { bindingMatchesGit, inspectGitBinding } from "../context/git-binding";
import type { MergeValidationCoordinatorDependencies } from "../context/merge-validation-coordinator";
import {
  autopilotActionFor,
  canAutopilotAdvanceTo,
} from "../context/prevc-autopilot-policy";
import { workflowStageSchema } from "../context/contract-compiler";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import {
  ACTIVE_WORKTREE_STATUSES,
  type WorktreeRecord,
} from "../runtime/worktree-contract";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";
import { standardTopologyFromSealedTaskDetails } from "./guided-mission-topology-authority";
import { hashMissionIntentAuthority } from "./mission-pane-authority";
import { requestMissionDriverTick } from "./mission-driver-runtime";
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import { publishFinalValidationHandoff } from "./final-validation-handoff";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { getSquad } from "./squad-store";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import { snapshotTaskPlanRoster, type TaskPlanReceipt } from "./task-store";
import { redeliverPendingHandoffs } from "./idle-delivery";

const ACTIVE_DISPATCH_STATES = new Set([
  "claimed",
  "routed",
  "spawning",
  "running",
  "handoff_ready",
  "merging",
]);
const PRE_EXECUTION_PLAN_CONTEXT_MAX_CHARACTERS = 48_000;
const PRE_EXECUTION_PLAN_CONTEXT_MAX_TASKS = 64;
const PRE_EXECUTION_PLAN_CONTEXT_MAX_OWNERSHIP_VALUES = 2;
const PRE_EXECUTION_TASK_ID_MAX_CHARACTERS = 72;
const PRE_EXECUTION_PLANNER_ID_MAX_CHARACTERS = 48;
const PRE_EXECUTION_TITLE_MAX_CHARACTERS = 80;
const PRE_EXECUTION_DETAIL_MAX_CHARACTERS = 160;
const PRE_EXECUTION_AGENT_REF_MAX_CHARACTERS = 64;
const PRE_EXECUTION_OWNERSHIP_VALUE_MAX_CHARACTERS = 56;

function boundedPlanField(value: string, maxCharacters: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const complete = JSON.stringify(compact);
  if (complete.length <= maxCharacters) return complete;

  let prefixLength = Math.min(compact.length, maxCharacters - 3);
  while (prefixLength > 0) {
    const candidate = JSON.stringify(`${compact.slice(0, prefixLength)}…`);
    if (candidate.length <= maxCharacters) return candidate;
    prefixLength -= 1;
  }
  return JSON.stringify("…");
}

function summarizeOwnershipValues(values: readonly string[]): string {
  const visible = values
    .slice(0, PRE_EXECUTION_PLAN_CONTEXT_MAX_OWNERSHIP_VALUES)
    .map((value) =>
      boundedPlanField(
        value,
        PRE_EXECUTION_OWNERSHIP_VALUE_MAX_CHARACTERS,
      ),
    )
    .join(", ");
  const omitted =
    values.length - PRE_EXECUTION_PLAN_CONTEXT_MAX_OWNERSHIP_VALUES;
  return (
    `[${visible}]` +
    (omitted > 0 ? ` (${omitted} ownership values omitted)` : "")
  );
}

function latestDispatchesByTask(
  receipt: TaskPlanReceipt,
  dispatches: readonly TaskDispatchRecord[],
): ReadonlyMap<string, TaskDispatchRecord> {
  const taskIds = new Set(receipt.tasks.map((task) => task.taskId));
  const latest = new Map<string, TaskDispatchRecord>();
  for (const dispatch of dispatches) {
    if (
      dispatch.intentVersion !== receipt.intentVersion ||
      !taskIds.has(dispatch.taskId)
    ) {
      continue;
    }
    const previous = latest.get(dispatch.taskId);
    if (
      !previous ||
      dispatch.revision > previous.revision ||
      (dispatch.revision === previous.revision &&
        dispatch.attempt > previous.attempt)
    ) {
      latest.set(dispatch.taskId, dispatch);
    }
  }
  return latest;
}

function sealedTaskReviewLine(
  task: TaskPlanReceipt["tasks"][number],
  ordinal: number,
  taskCount: number,
  dispatch: TaskDispatchRecord | undefined,
): string {
  return (
    `- [${ordinal}/${taskCount}] ` +
    `taskId=${boundedPlanField(
      task.taskId,
      PRE_EXECUTION_TASK_ID_MAX_CHARACTERS,
    )}; ` +
    `plannerId=${boundedPlanField(
      task.plannerId,
      PRE_EXECUTION_PLANNER_ID_MAX_CHARACTERS,
    )}; ` +
    `title=${boundedPlanField(
      task.title,
      PRE_EXECUTION_TITLE_MAX_CHARACTERS,
    )}; ` +
    `detail=${boundedPlanField(
      task.detail,
      PRE_EXECUTION_DETAIL_MAX_CHARACTERS,
    )}; ` +
    `agentRef=${boundedPlanField(
      task.agentRef,
      PRE_EXECUTION_AGENT_REF_MAX_CHARACTERS,
    )}; ` +
    `agentCategory=${task.agentCategory}; ` +
    `dispatch=${dispatch ? `${dispatch.state}/${dispatch.executionMode}` : "not-created"}`
  );
}

function dispatchOwnershipReviewLine(
  task: TaskPlanReceipt["tasks"][number],
  dispatch: TaskDispatchRecord,
): string {
  return (
    `- taskId=${boundedPlanField(
      task.taskId,
      PRE_EXECUTION_TASK_ID_MAX_CHARACTERS,
    )}; ` +
    `state=${dispatch.state}; mode=${dispatch.executionMode}; ` +
    `agentRef=${boundedPlanField(
      dispatch.agentRef ?? task.agentRef,
      PRE_EXECUTION_AGENT_REF_MAX_CHARACTERS,
    )}; agentCategory=${dispatch.agentCategory ?? task.agentCategory}; ` +
    "ownership " +
    `files=${summarizeOwnershipValues(dispatch.ownership.files)}; ` +
    `symbols=${summarizeOwnershipValues(dispatch.ownership.symbols)}; ` +
    `domains=${summarizeOwnershipValues(dispatch.ownership.domains)}`
  );
}

function appendBoundedOwnershipLines(
  requiredLines: readonly string[],
  ownershipLines: readonly string[],
): string {
  let markdown = requiredLines.join("\n");
  if (markdown.length > PRE_EXECUTION_PLAN_CONTEXT_MAX_CHARACTERS) {
    throw new Error(
      "sealed task plan exceeds the bounded pre-execution review context",
    );
  }
  const ownershipOmissionNotice = (count: number) =>
    `- ${count} ownership summaries omitted by the ` +
    `${PRE_EXECUTION_PLAN_CONTEXT_MAX_CHARACTERS}-character limit; ` +
    "every sealed task remains listed above.";
  if (
    ownershipLines.length > 0 &&
    `${markdown}\n${ownershipOmissionNotice(ownershipLines.length)}`.length >
      PRE_EXECUTION_PLAN_CONTEXT_MAX_CHARACTERS
  ) {
    throw new Error(
      "sealed task plan leaves no bounded room for ownership disclosure",
    );
  }
  for (let index = 0; index < ownershipLines.length; index += 1) {
    const line = ownershipLines[index]!;
    const remaining = ownershipLines.length - index - 1;
    const omissionNotice =
      remaining > 0 ? ownershipOmissionNotice(remaining) : "";
    const candidate = `${markdown}\n${line}`;
    const reservedNoticeCharacters =
      omissionNotice.length > 0 ? omissionNotice.length + 1 : 0;
    if (
      candidate.length + reservedNoticeCharacters >
      PRE_EXECUTION_PLAN_CONTEXT_MAX_CHARACTERS
    ) {
      const omitted = ownershipLines.length - index;
      markdown += `\n${ownershipOmissionNotice(omitted)}`;
      break;
    }
    markdown = candidate;
  }
  return markdown;
}

function compilePreExecutionPlanContext(input: {
  readonly receipt: TaskPlanReceipt;
  readonly dispatches: readonly TaskDispatchRecord[];
}): string {
  if (input.receipt.tasks.length > PRE_EXECUTION_PLAN_CONTEXT_MAX_TASKS) {
    throw new Error(
      `sealed task plan exceeds ${PRE_EXECUTION_PLAN_CONTEXT_MAX_TASKS} tasks`,
    );
  }
  const latestDispatches = latestDispatchesByTask(
    input.receipt,
    input.dispatches,
  );
  const dispatchLines = input.receipt.tasks.flatMap((task) => {
    const dispatch = latestDispatches.get(task.taskId);
    return dispatch ? [dispatchOwnershipReviewLine(task, dispatch)] : [];
  });
  const requiredLines = [
    "## Current sealed execution plan",
    "",
    "This is the Main-owned plan authority for pre-execution review. " +
      "It describes future work; it is not candidate or completion evidence.",
    `Plan hash: ${input.receipt.planHash}`,
    `Intent version: ${input.receipt.intentVersion}`,
    `Task count: ${input.receipt.tasks.length}`,
    `Plan context limit: ${PRE_EXECUTION_PLAN_CONTEXT_MAX_CHARACTERS} characters`,
    `Sealed task entries: ${input.receipt.tasks.length}/${input.receipt.tasks.length}`,
    "",
    "### Sealed tasks",
    ...input.receipt.tasks.map((task, index) =>
      sealedTaskReviewLine(
        task,
        index + 1,
        input.receipt.tasks.length,
        latestDispatches.get(task.taskId),
      ),
    ),
    "",
    "### Current dispatch ownership",
    ...(dispatchLines.length > 0
      ? []
      : [
          "- No current dispatch row exists yet. Ownership allocation is future " +
            "execution work and its absence is not a pre-execution finding.",
        ]),
  ];
  return appendBoundedOwnershipLines(requiredLines, dispatchLines);
}

export interface PrevcAutopilotResult {
  readonly state: string;
  readonly transitions: readonly string[];
  readonly reason?: string;
  readonly finalHandoffId?: string;
}

export interface GuidedPrevcPostMergeResult {
  readonly applicable: boolean;
  readonly ready: boolean;
  readonly reason?: string;
  readonly autopilot?: PrevcAutopilotResult;
  readonly driverWakeRequested: boolean;
}

export interface PrevcAutopilotCoordinatorDependencies {
  readonly storesForScope: (
    scope: ProjectExecutionScope,
  ) => ProjectDomainStoreSuite;
  readonly workflowForScope: (
    scope: ProjectExecutionScope,
  ) => ContextWorkflowService;
  readonly getSquad: (squadId: string) => Squad | null;
  readonly listMissionWorktrees: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => readonly WorktreeRecord[];
  readonly inspectGit: typeof inspectGitBinding;
  readonly hasVerifiedPhysicalPlanAuthority: (input: {
    readonly suite: ProjectDomainStoreSuite;
    readonly missionId: string;
    readonly intentVersion: number;
  }) => boolean;
  readonly reviewDependencies: (input: {
    readonly suite: ProjectDomainStoreSuite;
    readonly missionId: string;
    readonly scope: ProjectExecutionScope;
  }) => MergeValidationCoordinatorDependencies;
  readonly publishFinalHandoff: typeof publishFinalValidationHandoff;
  readonly requestDriverTick: () => boolean;
}

const PRODUCTION_DEPS: PrevcAutopilotCoordinatorDependencies = {
  storesForScope: getProjectDomainStores,
  workflowForScope: getContextWorkflowService,
  getSquad,
  listMissionWorktrees: (scope, missionId) =>
    requireWorktreeRuntimeRegistry().listMission(scope, missionId),
  inspectGit: inspectGitBinding,
  hasVerifiedPhysicalPlanAuthority: ({ suite, missionId, intentVersion }) =>
    suite.taskDispatches.hasVerifiedGuidedPlanAuthority({
      missionId,
      intentVersion,
    }),
  // Release E2E and ordinary missions both use the live CliAutomatedReviewer.
  // Only unit tests may inject a review dependency through an explicitly
  // constructed coordinator dependency object.
  reviewDependencies: () => ({}),
  publishFinalHandoff: publishFinalValidationHandoff,
  // Keep this lazy: Mission Driver IO also consumes the post-merge authority
  // predicate, so eagerly reading the runtime export would create an ESM
  // initialization cycle.
  requestDriverTick: () => requestMissionDriverTick(),
};

function scopeMissionKey(
  scope: ProjectExecutionScope,
  missionId: string,
): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    missionId,
  ].join("\0");
}

/*
 * One mission may be driven by the scheduler, a merge tool and an explicit
 * validation tool at nearly the same time. This keyed queue is process-wide,
 * so all of those Main-owned entrypoints serialize around the same PREVC CAS.
 */
const missionOperationTails = new Map<string, Promise<void>>();
const guidedBridgeFlights = new Map<
  string,
  Promise<GuidedPrevcPostMergeResult>
>();

async function withMissionOperation<T>(
  scope: ProjectExecutionScope,
  missionId: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const key = scopeMissionKey(scope, missionId);
  const previous = missionOperationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  missionOperationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("PREVC operation authority was revoked");
    }
    return await operation();
  } finally {
    release();
    if (missionOperationTails.get(key) === tail) {
      missionOperationTails.delete(key);
    }
  }
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value.trim() === right[index]?.trim())
  );
}

function exactApprovedWorkflow(
  mission: Mission,
  workflow: ReturnType<ContextWorkflowService["getMissionWorkflow"]>,
): boolean {
  const approved = mission.intentContract;
  const frozen = workflow.contract?.contract;
  return Boolean(
      approved &&
      frozen &&
      frozen.missionId === mission.id &&
      frozen.goal === approved.goal.trim() &&
    sameOrderedStrings(
      frozen.acceptanceCriteria.map((criterion) => criterion.statement),
      approved.acceptanceCriteria,
    ),
  );
}

/**
 * The approved squad revision and the task-plan roster are intentionally
 * different hash domains. The mission contract seals the complete executable
 * squad (playbook, lineage and agents); the task receipt seals only the
 * canonical roster envelope used by task assignment.
 */
function assertGuidedPlanSquadAuthority(input: {
  readonly mission: Mission;
  readonly receipt: TaskPlanReceipt;
  readonly getSquad: PrevcAutopilotCoordinatorDependencies["getSquad"];
}): void {
  const squadId = input.mission.squadId;
  if (!squadId || input.receipt.squadId !== squadId) {
    throw new Error("guided post-merge plan/squad identity authority diverged");
  }
  const squad = input.getSquad(squadId);
  if (
    !squad ||
    squad.id !== squadId ||
    snapshotSquadAuthority(squad).hash !==
      input.mission.intentContract?.squadRevisionHash
  ) {
    throw new Error("guided post-merge squad revision authority diverged");
  }
  if (snapshotTaskPlanRoster(squad.agents).hash !== input.receipt.rosterHash) {
    throw new Error("guided post-merge plan roster authority diverged");
  }
}

function currentPlanDispatchesCompleted(input: {
  readonly mission: Mission;
  readonly receipt: TaskPlanReceipt;
  readonly suite: ProjectDomainStoreSuite;
  readonly worktrees: readonly WorktreeRecord[];
}): boolean {
  const taskIds = input.receipt.tasks.map((task) => task.taskId);
  const taskIdSet = new Set(taskIds);
  const planned = input.suite.tasks.listPlannedTasks(
    input.mission.id,
    input.receipt.intentVersion,
  );
  if (
    planned.length !== taskIds.length ||
    planned.some(
      (task) =>
        !taskIdSet.has(task.taskId) ||
        task.intentVersion !== input.receipt.intentVersion ||
        task.task.status !== "done",
    )
  ) {
    return false;
  }
  const currentDispatches = input.suite.taskDispatches
    .list(input.mission.id)
    .filter(
      (dispatch) => dispatch.intentVersion === input.receipt.intentVersion,
    );
  if (
    currentDispatches.length !== taskIds.length ||
    currentDispatches.some(
      (dispatch) =>
        !taskIdSet.has(dispatch.taskId) ||
        dispatch.state !== "completed" ||
        !dispatch.integrationReceipt ||
        dispatch.completedAt === undefined,
    )
  ) {
    return false;
  }
  const worktreesByTask = new Map(
    input.worktrees.map((worktree) => [worktree.taskId, worktree]),
  );
  if (
    currentDispatches.some((dispatch) => {
      if (dispatch.executionMode !== "isolated_worktree") return false;
      const worktree = worktreesByTask.get(dispatch.taskId);
      return (
        !worktree ||
        worktree.missionId !== input.mission.id ||
        worktree.status !== "integrated"
      );
    })
  ) {
    return false;
  }
  return !input.suite.taskDispatches
    .list(input.mission.id)
    .some((dispatch) => ACTIVE_DISPATCH_STATES.has(dispatch.state));
}

interface GuidedPostMergeAuthoritySeal {
  readonly intentVersion: number;
  readonly intentContractHash: string;
  readonly planHash: string;
  readonly rosterHash: string;
  readonly squadId: string;
  readonly taskIds: readonly string[];
  readonly topology: "delivery";
  readonly frozenContractHash: string;
  readonly contextRevision: string;
  readonly baseSha: string;
}

type GuidedPostMergeInspection =
  | Readonly<{
      ready: false;
      reason: string;
    }>
  | Readonly<{
      ready: true;
      seal: GuidedPostMergeAuthoritySeal;
      assertCurrentAuthority: () => void;
    }>;

/**
 * Captures the immutable post-merge authority and returns a closure that
 * re-reads every durable source. The closure intentionally permits only the
 * workflow revision/stage changes made by PREVC itself; intent, plan, roster,
 * task receipts, context and integrated Git binding may never drift.
 */
export function inspectGuidedPrevcPostMergeAuthority(
  scope: ProjectExecutionScope,
  missionId: string,
  dependencies: PrevcAutopilotCoordinatorDependencies = PRODUCTION_DEPS,
): GuidedPostMergeInspection {
  const suite = dependencies.storesForScope(scope);
  const mission = suite.missions.get(missionId);
  if (!mission || !missionRequiresGuidedPrevc(mission, "delivery")) {
    return Object.freeze({
      ready: false,
      reason: "mission is outside Main-owned guided PREVC",
    });
  }
  if (mission.status !== "running") {
    return Object.freeze({
      ready: false,
      reason: "mission is not running",
    });
  }
  const contract = mission.intentContract;
  if (!contract || mission.intentVersion !== contract.intentVersion) {
    throw new Error("guided post-merge intent authority is stale");
  }
  const receipt = suite.tasks.getPlanReceipt(missionId, contract.intentVersion);
  if (!receipt) {
    return Object.freeze({
      ready: false,
      reason: "current sealed Guided v2 plan is missing",
    });
  }
  const topology = standardTopologyFromSealedTaskDetails(
    receipt.tasks.map((task) => task.detail),
  );
  if (topology === "invalid") {
    throw new Error(
      "guided post-merge mission topology is mixed; replan and reapprove",
    );
  }
  if (!missionRequiresGuidedPrevc(mission, topology)) {
    return Object.freeze({
      ready: false,
      reason: "mission is outside Main-owned guided PREVC",
    });
  }
  assertGuidedPlanSquadAuthority({
    mission,
    receipt,
    getSquad: dependencies.getSquad,
  });
  if (
    !dependencies.hasVerifiedPhysicalPlanAuthority({
      suite,
      missionId,
      intentVersion: contract.intentVersion,
    })
  ) {
    const undeliveredSuccess = suite.handoffs
      .list({ missionId, includeDelivered: false })
      .filter(
        (handoff) =>
          handoff.status === "success" &&
          handoff.authorityOrigin === "agent" &&
          handoff.deliveryState === "queued",
      );
    if (undeliveredSuccess.length > 0) {
      // Best-effort flush: Maestro pode ter sido rebound/recuperado desde a
      // submissão. Sem isso a ponte fica eternamente em "physical authority"
      // com o trabalho dos workers já concluído.
      try {
        redeliverPendingHandoffs(scope, missionId, suite);
      } catch (error) {
        console.warn(
          `[prevc-autopilot] reentrega de handoffs pendentes falhou para ${missionId}:`,
          error,
        );
      }
      return Object.freeze({
        ready: false,
        reason:
          `current sealed task plan lacks complete physical authority: ` +
          `${undeliveredSuccess.length} success handoff(s) still queued for Maestro delivery`,
      });
    }
    return Object.freeze({
      ready: false,
      reason: "current sealed task plan lacks complete physical authority",
    });
  }
  const worktrees = dependencies.listMissionWorktrees(scope, missionId);
  if (
    !currentPlanDispatchesCompleted({
      mission,
      receipt,
      suite,
      worktrees,
    })
  ) {
    return Object.freeze({
      ready: false,
      reason: "current sealed task dispatches are not all completed",
    });
  }
  if (
    worktrees.some((worktree) => ACTIVE_WORKTREE_STATUSES.has(worktree.status))
  ) {
    return Object.freeze({
      ready: false,
      reason: "mission still has an active worktree",
    });
  }
  const workflowService = dependencies.workflowForScope(scope);
  const frozen = workflowService.getMissionWorkflow(missionId);
  if (
    !frozen.contract ||
    !frozen.workflow ||
    !exactApprovedWorkflow(mission, frozen)
  ) {
    throw new Error("guided post-merge frozen workflow authority diverged");
  }
  if (
    !suite.missions.hasCurrentKickoffAcceptance(missionId) ||
    !hasCurrentDispatchAuthority(mission, {
      taskCount: receipt.tasks.length,
      workerPaneCount: suite.missionPanes
        .list(missionId)
        .filter((pane) => pane.role === "worker").length,
    })
  ) {
    throw new Error("guided post-merge kickoff/dispatch authority is stale");
  }
  workflowService.compileMissionSnapshot(missionId);
  if (frozen.workflow.stage !== "execution") {
    const git = dependencies.inspectGit(
      scope,
      frozen.contract.contract.baseCommit,
    );
    if (!bindingMatchesGit(frozen.workflow.binding, git)) {
      throw new Error("guided post-merge HEAD/diff binding diverged");
    }
  }
  const seal: GuidedPostMergeAuthoritySeal = Object.freeze({
    intentVersion: contract.intentVersion,
    intentContractHash: hashMissionIntentAuthority(contract),
    planHash: receipt.planHash,
    rosterHash: receipt.rosterHash,
    squadId: receipt.squadId,
    taskIds: Object.freeze(receipt.tasks.map((task) => task.taskId)),
    topology: "delivery",
    frozenContractHash: frozen.contract.contract.contractHash,
    contextRevision: frozen.contract.contract.contextRevision,
    baseSha: frozen.contract.contract.baseCommit,
  });
  const assertCurrentAuthority = (): void => {
    const currentSuite = dependencies.storesForScope(scope);
    const currentMission = currentSuite.missions.get(missionId);
    if (
      !currentMission ||
      !currentMission.intentContract ||
      currentMission.status !== "running" ||
      currentMission.intentVersion !== seal.intentVersion ||
      currentMission.intentContract.intentVersion !== seal.intentVersion ||
      hashMissionIntentAuthority(currentMission.intentContract) !==
        seal.intentContractHash ||
      !currentSuite.missions.hasCurrentKickoffAcceptance(missionId) ||
      !hasCurrentDispatchAuthority(currentMission, {
        taskCount: seal.taskIds.length,
        workerPaneCount: currentSuite.missionPanes
          .list(missionId)
          .filter((pane) => pane.role === "worker").length,
      })
    ) {
      throw new Error("guided post-merge mission authority was revoked");
    }
    const currentReceipt = currentSuite.tasks.getPlanReceipt(
      missionId,
      seal.intentVersion,
    );
    if (!currentReceipt) {
      throw new Error("guided post-merge task authority was revoked");
    }
    const currentTopology = standardTopologyFromSealedTaskDetails(
      currentReceipt.tasks.map((task) => task.detail),
    );
    if (currentTopology === "invalid") {
      throw new Error(
        "guided post-merge mission topology was replaced by a mixed receipt",
      );
    }
    if (
      currentTopology !== seal.topology ||
      !missionRequiresGuidedPrevc(currentMission, currentTopology)
    ) {
      throw new Error("guided post-merge mission topology was revoked");
    }
    assertGuidedPlanSquadAuthority({
      mission: currentMission,
      receipt: currentReceipt,
      getSquad: dependencies.getSquad,
    });
    if (
      currentReceipt.planHash !== seal.planHash ||
      currentReceipt.rosterHash !== seal.rosterHash ||
      currentReceipt.squadId !== seal.squadId ||
      !sameOrderedStrings(
        currentReceipt.tasks.map((task) => task.taskId),
        seal.taskIds,
      ) ||
      !currentPlanDispatchesCompleted({
        mission: currentMission,
        receipt: currentReceipt,
        suite: currentSuite,
        worktrees: dependencies.listMissionWorktrees(scope, missionId),
      }) ||
      dependencies
        .listMissionWorktrees(scope, missionId)
        .some((worktree) => ACTIVE_WORKTREE_STATUSES.has(worktree.status))
    ) {
      throw new Error("guided post-merge task authority was revoked");
    }
    if (
      !dependencies.hasVerifiedPhysicalPlanAuthority({
        suite: currentSuite,
        missionId,
        intentVersion: seal.intentVersion,
      })
    ) {
      throw new Error("guided post-merge physical task authority was revoked");
    }
    const currentService = dependencies.workflowForScope(scope);
    const currentWorkflow = currentService.getMissionWorkflow(missionId);
    if (
      !currentWorkflow.contract ||
      !currentWorkflow.workflow ||
      !exactApprovedWorkflow(currentMission, currentWorkflow) ||
      currentWorkflow.contract.contract.contractHash !==
        seal.frozenContractHash ||
      currentWorkflow.contract.contract.contextRevision !==
        seal.contextRevision ||
      currentWorkflow.contract.contract.baseCommit !== seal.baseSha
    ) {
      throw new Error("guided post-merge workflow authority was revoked");
    }
    // Re-ingestion proves the context revision and all required facts are
    // still current. At validation/confirmation the checkout must additionally
    // equal the exact integrated HEAD/diff reviewed by PREVC.
    currentService.compileMissionSnapshot(missionId);
    if (currentWorkflow.workflow.stage !== "execution") {
      const git = dependencies.inspectGit(scope, seal.baseSha);
      if (!bindingMatchesGit(currentWorkflow.workflow.binding, git)) {
        throw new Error("guided post-merge integrated HEAD/diff drifted");
      }
    }
  };
  return Object.freeze({
    ready: true,
    seal,
    assertCurrentAuthority,
  });
}

function nextWorkflowStage(route: readonly string[], stage: string): string {
  const index = route.indexOf(stage);
  if (index < 0) throw new Error("workflow stage is outside its frozen route");
  return route[index + 1] ?? "complete";
}

/**
 * A pre-execution review inspects the immutable plan, not a merge candidate.
 * Once that plan is sealed there is no honest in-place mutation that can make
 * a report bound to the same {intentVersion, planHash} disappear. Treat its
 * HIGH/CRITICAL findings as durable repair guidance for candidate validation;
 * only missing physical reviewer quorum still waits before execution.
 */
export function shouldAdvanceAfterPreExecutionReview(input: {
  readonly ready: boolean;
  readonly reason: string;
}): boolean {
  return input.ready || input.reason === "blocking-findings";
}

function resolveCodeAuthors(input: {
  readonly suite: ProjectDomainStoreSuite;
  readonly worktrees: readonly WorktreeRecord[];
  readonly taskIds: ReadonlySet<string>;
}) {
  const panes = input.suite.missionPanes.list(
    input.worktrees[0]?.missionId ?? "",
  );
  return input.worktrees
    .filter(
      (worktree) =>
        worktree.status === "integrated" && input.taskIds.has(worktree.taskId),
    )
    .map((worktree) => {
      const pane = panes.find(
        (candidate) =>
          candidate.role === "worker" &&
          candidate.agentName === worktree.workerId &&
          candidate.cwd === worktree.worktreePath,
      );
      if (!pane) {
        throw new Error(
          `code author identity missing for task ${worktree.taskId}`,
        );
      }
      return {
        id: worktree.workerId,
        sessionId: pane.paneId ?? pane.id,
        provider: pane.adapterId,
      };
    });
}

async function runCouncilReviewUnlocked(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly assertCurrentAuthority: () => void;
  readonly signal?: AbortSignal;
  readonly dependencies: PrevcAutopilotCoordinatorDependencies;
}) {
  input.assertCurrentAuthority();
  const service = input.dependencies.workflowForScope(input.scope);
  const mission = service.getMissionWorkflow(input.missionId);
  if (!mission.contract || !mission.workflow) {
    throw new Error("mission has no frozen workflow");
  }
  const suite = input.dependencies.storesForScope(input.scope);
  const approved = suite.missions.get(input.missionId);
  const intentVersion = approved?.intentContract?.intentVersion;
  const receipt =
    intentVersion === undefined
      ? null
      : suite.tasks.getPlanReceipt(input.missionId, intentVersion);
  if (!receipt) {
    throw new Error(
      "pre-execution review requires the current sealed task plan",
    );
  }
  const preExecutionPlanBinding = Object.freeze({
    intentVersion: receipt.intentVersion,
    planHash: receipt.planHash,
  });
  const persisted = service.inspectCurrentPreExecutionReviewGate(
    input.missionId,
    preExecutionPlanBinding,
  );
  const requiredReviewerCount =
    mission.contract.contract.risk === "critical" ? 2 : 1;
  if (
    persisted.ready ||
    (persisted.reportCount > 0 &&
      persisted.reason !== "review-quorum-missing" &&
      persisted.quorumReportCount >= requiredReviewerCount)
  ) {
    return Object.freeze({
      ready: persisted.ready,
      gate: Object.freeze({
        ready: persisted.ready,
        reason: persisted.reason,
        blockingFindingCount: persisted.blockingFindingCount,
        reportCount: persisted.quorumReportCount,
      }),
      reports: Object.freeze([]),
      evidenceIds: persisted.evidenceIds,
    });
  }
  const contextMarkdown = [
    service.compileMissionSnapshot(input.missionId).markdown.trimEnd(),
    compilePreExecutionPlanContext({
      receipt,
      dispatches: suite.taskDispatches.list(input.missionId),
    }),
  ].join("\n\n");
  const reviewer = new CliAutomatedReviewer();
  const reviewInput = {
    scope: input.scope,
    checkoutPath: input.scope.rootRealPath,
    contract: mission.contract.contract,
    binding: mission.workflow.binding,
    author: mission.contract.author,
    reviewPurpose: "pre-execution" as const,
    preExecutionPlanBinding,
    designInspection: "deferred" as const,
    contextMarkdown,
    persist: (
      report: Parameters<typeof service.recordMergeReviewReport>[0],
    ) => {
      input.assertCurrentAuthority();
      service.recordMergeReviewReport(report);
    },
    ...(input.signal ? { signal: input.signal } : {}),
    assertCurrentAuthority: input.assertCurrentAuthority,
  };
  const override = input.dependencies.reviewDependencies({
    suite,
    missionId: input.missionId,
    scope: input.scope,
  }).runReview;
  const result = override
    ? await override(reviewInput)
    : await reviewer.run(reviewInput);
  input.assertCurrentAuthority();
  return result;
}

async function runFinalValidationUnlocked(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly assertCurrentAuthority: () => void;
  readonly signal?: AbortSignal;
  readonly dependencies: PrevcAutopilotCoordinatorDependencies;
}) {
  input.assertCurrentAuthority();
  const service = input.dependencies.workflowForScope(input.scope);
  const mission = service.getMissionWorkflow(input.missionId);
  if (!mission.contract || !mission.workflow) {
    throw new Error("mission has no frozen workflow");
  }
  const sensorEvidence = [];
  for (const sensorId of mission.contract.contract.requiredSensors) {
    input.assertCurrentAuthority();
    const evidence = await service.runSensor(input.missionId, sensorId, {
      ...(input.signal ? { signal: input.signal } : {}),
      assertCurrentAuthority: input.assertCurrentAuthority,
    });
    input.assertCurrentAuthority();
    sensorEvidence.push(evidence);
    if (evidence.exitCode !== 0 || evidence.timedOut) {
      return {
        ready: false,
        reason: `sensor failed: ${sensorId}`,
        sensorEvidence,
        review: null,
      };
    }
  }
  const suite = input.dependencies.storesForScope(input.scope);
  const approved = suite.missions.get(input.missionId);
  const intentVersion = approved?.intentContract?.intentVersion;
  const receipt =
    intentVersion === undefined
      ? null
      : suite.tasks.getPlanReceipt(input.missionId, intentVersion);
  if (!receipt) {
    throw new Error("final validation has no current sealed task plan");
  }
  const authors = resolveCodeAuthors({
    suite,
    worktrees: input.dependencies.listMissionWorktrees(
      input.scope,
      input.missionId,
    ),
    taskIds: new Set(receipt.tasks.map((task) => task.taskId)),
  });
  if (authors.length === 0) {
    throw new Error("final validation has no integrated code author");
  }
  input.assertCurrentAuthority();
  // Prefer durable council evidence already on the current binding. Re-spawning
  // a reviewer CLI with a stable pane title collides on mission-pane identity
  // and fails closed with "authority revision is immutable".
  const durableReview = service.inspectCurrentBindingReviewGate(
    input.missionId,
  );
  if (durableReview.ready) {
    return {
      ready: true,
      reason: durableReview.reason,
      sensorEvidence,
      review: {
        ready: true,
        gate: {
          ready: true,
          reason: durableReview.reason,
          blockingFindingCount: 0,
          reportCount: durableReview.reportCount,
        },
        reports: [],
        evidenceIds: durableReview.evidenceIds,
      },
    };
  }
  const reviewer = new CliAutomatedReviewer();
  const reviewInput = {
    scope: input.scope,
    checkoutPath: input.scope.rootRealPath,
    contract: mission.contract.contract,
    binding: mission.workflow.binding,
    author: authors[0]!,
    additionalAuthors: authors.slice(1),
    reviewPurpose: "candidate" as const,
    designInspection: "required" as const,
    contextMarkdown: service.compileMissionSnapshot(input.missionId).markdown,
    persist: (
      report: Parameters<typeof service.recordMergeReviewReport>[0],
    ) => {
      input.assertCurrentAuthority();
      service.recordMergeReviewReport(report);
    },
    ...(input.signal ? { signal: input.signal } : {}),
    assertCurrentAuthority: input.assertCurrentAuthority,
  };
  const override = input.dependencies.reviewDependencies({
    suite,
    missionId: input.missionId,
    scope: input.scope,
  }).runReview;
  const review = override
    ? await override(reviewInput)
    : await reviewer.run(reviewInput);
  input.assertCurrentAuthority();
  return {
    ready: review.ready,
    reason: review.gate.reason,
    sensorEvidence,
    review,
  };
}

async function drivePrevcAutopilotUnlocked(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly allowExecutionExit: boolean;
  readonly assertCurrentAuthority: () => void;
  readonly signal?: AbortSignal;
  readonly dependencies: PrevcAutopilotCoordinatorDependencies;
}): Promise<PrevcAutopilotResult> {
  const service = input.dependencies.workflowForScope(input.scope);
  const transitions: string[] = [];
  let validatedEvidenceIds: readonly string[] = [];
  const initial = service.getMissionWorkflow(input.missionId);
  if (!initial.workflow) throw new Error("mission has no frozen workflow");
  let expectedWorkflowRevision = initial.workflow.revision;
  const assertRevisionAuthority = (): void => {
    input.assertCurrentAuthority();
    const current = service.getMissionWorkflow(input.missionId).workflow;
    if (!current || current.revision !== expectedWorkflowRevision) {
      throw new Error(
        "PREVC workflow revision changed outside its coordinator",
      );
    }
  };
  for (let guard = 0; guard < 8; guard += 1) {
    assertRevisionAuthority();
    const mission = service.getMissionWorkflow(input.missionId);
    if (!mission.contract || !mission.workflow) {
      throw new Error("mission has no frozen workflow");
    }
    const { stage, route } = mission.workflow;
    const workflowRevision = mission.workflow.revision;
    const suite = input.dependencies.storesForScope(input.scope);
    const approved = suite.missions.get(input.missionId);
    const intentVersion = approved?.intentContract?.intentVersion;
    const receipt =
      intentVersion === undefined
        ? null
        : suite.tasks.getPlanReceipt(input.missionId, intentVersion);
    const worktrees = input.dependencies.listMissionWorktrees(
      input.scope,
      input.missionId,
    );
    const sealedPlanCompleted = Boolean(
      approved &&
      receipt &&
      currentPlanDispatchesCompleted({
        mission: approved,
        receipt,
        suite,
        worktrees,
      }),
    );
    const action = autopilotActionFor(
      stage,
      input.allowExecutionExit,
      sealedPlanCompleted,
    );
    const advanceCurrentStage = () => {
      assertRevisionAuthority();
      const next = workflowStageSchema.parse(nextWorkflowStage(route, stage));
      if (!canAutopilotAdvanceTo(next)) return null;
      const isLeavingPreExecutionReview =
        stage === "review-primary" || stage === "review-secondary";
      if (isLeavingPreExecutionReview && !receipt) {
        throw new Error(
          "pre-execution advance requires the current sealed task plan",
        );
      }
      const advanced = service.advance(input.missionId, next, {
        ...(isLeavingPreExecutionReview
          ? {
              preExecutionPlanBinding: {
                intentVersion: receipt!.intentVersion,
                planHash: receipt!.planHash,
              },
            }
          : {}),
      });
      expectedWorkflowRevision = advanced.revision;
      input.assertCurrentAuthority();
      transitions.push(`${stage}->${next}`);
      return next;
    };
    const awaitingFinalReceipt = (finalHandoffId?: string) =>
      Object.freeze({
        state: stage,
        transitions: Object.freeze([...transitions]),
        reason: "final PREVC transition awaits the atomic mission-step receipt",
        ...(finalHandoffId ? { finalHandoffId } : {}),
      });
    const publishFinalReceiptEvidence = () => {
      assertRevisionAuthority();
      const currentEvidenceIds = service.listCurrentPersistedEvidenceIds(
        input.missionId,
      );
      const recoveredAttestations = currentEvidenceIds.filter((id) =>
        id.startsWith("milestone:"),
      );
      const evidenceIds =
        validatedEvidenceIds.length > 0
          ? validatedEvidenceIds
          : recoveredAttestations.length > 0
            ? recoveredAttestations
            : currentEvidenceIds;
      return input.dependencies.publishFinalHandoff(
        {
          missionId: input.missionId,
          workflowRevision,
          evidenceIds,
        },
        suite.handoffs,
      );
    };
    const findFinalHandoff = () =>
      suite.handoffs
        .list({
          missionId: input.missionId,
          includeDelivered: true,
        })
        .find(
          (handoff) =>
            handoff.fromAgent === "nexus-prevc-autopilot" &&
            handoff.evidenceTrust === "nexus-trusted" &&
            handoff.evidenceBinding?.workflowRevision === workflowRevision &&
            handoff.evidenceIds.length > 0 &&
            handoff.evidenceIds.every((id) => id.startsWith("milestone:")),
        );
    if (action === "complete") {
      // Orchestrators may have advanced PREVC to complete before the atomic
      // receipt existed. Recover the final trusted handoff so Ralph can close.
      const existing = findFinalHandoff();
      if (existing) {
        return Object.freeze({
          state: "complete",
          transitions,
          finalHandoffId: existing.id,
          reason: "final PREVC transition awaits the atomic mission-step receipt",
        });
      }
      const currentEvidenceIds = service.listCurrentPersistedEvidenceIds(
        input.missionId,
      );
      const recoveredAttestationIds = currentEvidenceIds.filter((id) =>
        id.startsWith("milestone:"),
      );
      if (recoveredAttestationIds.length > 0) {
        // The mission driver may have consumed every pending milestone after
        // validation but before this recovery pass. Those immutable
        // attestations remain the exact authority for the final receipt;
        // asking the service to create attestations again would correctly
        // fail because no pending step remains.
        validatedEvidenceIds = recoveredAttestationIds;
        const handoff = publishFinalReceiptEvidence();
        return Object.freeze({
          state: "complete",
          transitions,
          finalHandoffId: handoff.id,
          reason: "final PREVC transition awaits the atomic mission-step receipt",
        });
      }
      const sourceEvidenceIds = currentEvidenceIds.filter(
        (id) => !id.startsWith("milestone:"),
      );
      if (sourceEvidenceIds.length === 0) {
        return Object.freeze({
          state: "complete",
          transitions,
          reason: "complete without recoverable final validation evidence",
        });
      }
      validatedEvidenceIds = service.recordMilestoneValidationEvidence(
        input.missionId,
        sourceEvidenceIds,
      );
      const handoff = publishFinalReceiptEvidence();
      return Object.freeze({
        state: "complete",
        transitions,
        finalHandoffId: handoff.id,
        reason: "final PREVC transition awaits the atomic mission-step receipt",
      });
    }
    if (action === "wait-execution") {
      return Object.freeze({
        state: "execution",
        transitions,
        reason: "planned tasks are not all integrated",
      });
    }
    const recoveredFinalHandoff = findFinalHandoff();
    if (
      recoveredFinalHandoff &&
      (stage.startsWith("validation") || stage === "confirmation")
    ) {
      return awaitingFinalReceipt(recoveredFinalHandoff.id);
    }
    if (stage === "execution" || stage === "planning") {
      if (!advanceCurrentStage()) return awaitingFinalReceipt();
      continue;
    }
    if (action === "review") {
      const review = await runCouncilReviewUnlocked({
        ...input,
        assertCurrentAuthority: assertRevisionAuthority,
      });
      assertRevisionAuthority();
      if (!shouldAdvanceAfterPreExecutionReview(review.gate)) {
        return Object.freeze({
          state: stage,
          transitions,
          reason: review.gate.reason,
        });
      }
      if (!advanceCurrentStage()) return awaitingFinalReceipt();
      continue;
    }
    if (action === "validate") {
      const validation = await runFinalValidationUnlocked({
        ...input,
        assertCurrentAuthority: assertRevisionAuthority,
      });
      assertRevisionAuthority();
      if (!validation.ready) {
        return Object.freeze({
          state: stage,
          transitions,
          reason: validation.reason,
        });
      }
      validatedEvidenceIds = [
        ...validation.sensorEvidence.map((evidence) => evidence.id),
        ...(validation.review?.evidenceIds ?? []),
      ];
      validatedEvidenceIds = service.recordMilestoneValidationEvidence(
        input.missionId,
        validatedEvidenceIds,
      );
      assertRevisionAuthority();
      if (!advanceCurrentStage()) {
        const handoff = publishFinalReceiptEvidence();
        return awaitingFinalReceipt(handoff.id);
      }
      continue;
    }
    if (stage === "confirmation") {
      if (!advanceCurrentStage()) {
        const handoff = publishFinalReceiptEvidence();
        return awaitingFinalReceipt(handoff.id);
      }
      continue;
    }
    return Object.freeze({
      state: stage,
      transitions,
      reason: "stage requires explicit operator action",
    });
  }
  throw new Error("PREVC autopilot transition guard exceeded");
}

export function drivePrevcAutopilot(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly allowExecutionExit: boolean;
  readonly assertCurrentAuthority?: () => void;
  readonly signal?: AbortSignal;
  readonly dependencies?: PrevcAutopilotCoordinatorDependencies;
}): Promise<PrevcAutopilotResult> {
  const dependencies = input.dependencies ?? PRODUCTION_DEPS;
  return withMissionOperation(input.scope, input.missionId, input.signal, () =>
    drivePrevcAutopilotUnlocked({
      scope: input.scope,
      missionId: input.missionId,
      allowExecutionExit: input.allowExecutionExit,
      assertCurrentAuthority: input.assertCurrentAuthority ?? (() => {}),
      ...(input.signal ? { signal: input.signal } : {}),
      dependencies,
    }),
  );
}

export function runPrevcCouncilReview(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly assertCurrentAuthority?: () => void;
  readonly signal?: AbortSignal;
  readonly dependencies?: PrevcAutopilotCoordinatorDependencies;
}) {
  const dependencies = input.dependencies ?? PRODUCTION_DEPS;
  return withMissionOperation(input.scope, input.missionId, input.signal, () =>
    runCouncilReviewUnlocked({
      scope: input.scope,
      missionId: input.missionId,
      assertCurrentAuthority: input.assertCurrentAuthority ?? (() => {}),
      ...(input.signal ? { signal: input.signal } : {}),
      dependencies,
    }),
  );
}

export function runPrevcFinalValidation(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly assertCurrentAuthority?: () => void;
  readonly signal?: AbortSignal;
  readonly dependencies?: PrevcAutopilotCoordinatorDependencies;
}) {
  const dependencies = input.dependencies ?? PRODUCTION_DEPS;
  return withMissionOperation(input.scope, input.missionId, input.signal, () =>
    runFinalValidationUnlocked({
      scope: input.scope,
      missionId: input.missionId,
      assertCurrentAuthority: input.assertCurrentAuthority ?? (() => {}),
      ...(input.signal ? { signal: input.signal } : {}),
      dependencies,
    }),
  );
}

/**
 * Scheduler-owned bridge after the last durable merge receipt. It publishes
 * only the trusted final-validation handoff and wakes the Mission Driver; it
 * never writes mission/milestone completion itself.
 */
/**
 * Grava o motivo de o autopilot não fechar. Diagnóstico nunca pode derrubar a
 * ponte: a missão continua sendo conduzida mesmo que o registro falhe, e a
 * linha de drive state pode ainda não existir (o driver a cria no início da
 * missão) — nesse caso o UPDATE simplesmente não afeta ninguém.
 */
function recordAutopilotStall(
  dependencies: PrevcAutopilotCoordinatorDependencies,
  scope: ProjectExecutionScope,
  missionId: string,
  reason: string,
): void {
  try {
    dependencies
      .storesForScope(scope)
      .missions.recordDriveStallReason?.(missionId, "autopilot", reason);
  } catch (error) {
    console.warn(
      `[prevc-autopilot] registro de motivo de parada falhou para ${missionId}:`,
      error,
    );
  }
}

export function runGuidedPrevcPostMergeBridge(
  scope: ProjectExecutionScope,
  missionId: string,
  dependencies: PrevcAutopilotCoordinatorDependencies = PRODUCTION_DEPS,
): Promise<GuidedPrevcPostMergeResult> {
  const key = scopeMissionKey(scope, missionId);
  const existing = guidedBridgeFlights.get(key);
  if (existing) return existing;
  const flight = withMissionOperation(scope, missionId, undefined, async () => {
    const inspection = inspectGuidedPrevcPostMergeAuthority(
      scope,
      missionId,
      dependencies,
    );
    if (!inspection.ready) {
      const suite = dependencies.storesForScope(scope);
      const currentMission = suite.missions.get(missionId);
      const currentIntentVersion =
        currentMission?.intentContract?.intentVersion;
      const currentReceipt =
        currentIntentVersion === undefined
          ? null
          : suite.tasks.getPlanReceipt(missionId, currentIntentVersion);
      const currentTopology = standardTopologyFromSealedTaskDetails(
        currentReceipt?.tasks.map((task) => task.detail) ?? [],
      );
      if (currentTopology === "invalid") {
        throw new Error(
          "guided post-merge mission topology is mixed; replan and reapprove",
        );
      }
      recordAutopilotStall(dependencies, scope, missionId, inspection.reason);
      return Object.freeze({
        applicable: missionRequiresGuidedPrevc(
          currentMission ?? {},
          currentTopology,
        ),
        ready: false,
        reason: inspection.reason,
        driverWakeRequested: false,
      });
    }
    inspection.assertCurrentAuthority();
    const autopilot = await drivePrevcAutopilotUnlocked({
      scope,
      missionId,
      allowExecutionExit: true,
      assertCurrentAuthority: inspection.assertCurrentAuthority,
      dependencies,
    });
    inspection.assertCurrentAuthority();
    const ready = Boolean(
      autopilot.finalHandoffId ||
      autopilot.state === "complete" ||
      autopilot.reason?.includes("atomic mission-step receipt"),
    );
    const driverWakeRequested = ready
      ? dependencies.requestDriverTick()
      : false;
    // Uma ponte que não fica ready deixa a missão em `running` para sempre com
    // o trabalho todo entregue, e o motivo morria aqui: o gate de release via
    // só o timeout. Persistir é o que transforma "travou" em "travou por X".
    if (!ready) {
      recordAutopilotStall(
        dependencies,
        scope,
        missionId,
        autopilot.reason ?? `autopilot parou em ${autopilot.state}`,
      );
    }
    return Object.freeze({
      applicable: true,
      ready,
      ...(autopilot.reason ? { reason: autopilot.reason } : {}),
      autopilot,
      driverWakeRequested,
    });
  });
  guidedBridgeFlights.set(key, flight);
  void flight
    .finally(() => {
      if (guidedBridgeFlights.get(key) === flight) {
        guidedBridgeFlights.delete(key);
      }
    })
    .catch((error) => {
      const detail =
        error instanceof Error ? error.message : String(error ?? "unknown");
      recordAutopilotStall(
        dependencies,
        scope,
        missionId,
        `guided post-merge bridge failed: ${detail}`.slice(0, 500),
      );
      console.warn(
        `[prevc-autopilot] ponte pós-merge falhou para ${missionId}:`,
        error,
      );
    });
  return flight;
}
