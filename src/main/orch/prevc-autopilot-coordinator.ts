import { createHash } from "node:crypto";

import type { Mission, Squad } from "../../shared/orch-types";
import { hasCurrentDispatchAuthority } from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import { CliAutomatedReviewer } from "../context/cli-automated-reviewer";
import { canonicalJson } from "../context/canonical-json";
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
import { requestMissionDriverTick } from "./mission-driver-runtime";
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import { publishFinalValidationHandoff } from "./final-validation-handoff";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { getSquad } from "./squad-store";
import { snapshotTaskPlanRoster, type TaskPlanReceipt } from "./task-store";

const ACTIVE_DISPATCH_STATES = new Set([
  "claimed",
  "routed",
  "spawning",
  "running",
  "handoff_ready",
  "merging",
]);

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

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
  if (!mission || !missionRequiresGuidedPrevc(mission)) {
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
    intentContractHash: sha256(contract),
    planHash: receipt.planHash,
    rosterHash: receipt.rosterHash,
    squadId: receipt.squadId,
    taskIds: Object.freeze(receipt.tasks.map((task) => task.taskId)),
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
      !missionRequiresGuidedPrevc(currentMission) ||
      currentMission.intentVersion !== seal.intentVersion ||
      currentMission.intentContract.intentVersion !== seal.intentVersion ||
      sha256(currentMission.intentContract) !== seal.intentContractHash ||
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
  const reviewer = new CliAutomatedReviewer();
  const reviewInput = {
    scope: input.scope,
    checkoutPath: input.scope.rootRealPath,
    contract: mission.contract.contract,
    binding: mission.workflow.binding,
    author: mission.contract.author,
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
    suite: input.dependencies.storesForScope(input.scope),
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
      const advanced = service.advance(input.missionId, next);
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
      if (!review.ready) {
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
      return Object.freeze({
        applicable: missionRequiresGuidedPrevc(
          dependencies.storesForScope(scope).missions.get(missionId) ?? {},
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
    .catch(() => undefined);
  return flight;
}
