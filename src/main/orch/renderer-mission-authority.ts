import { createHash } from "node:crypto";
import type { WebContents } from "electron";
import {
  classifyGoalRisk,
  compileIntentContract,
  defaultBudgetsForRisk,
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  isPrepareProjectPlaceholderGoal,
  missionBlockPatch,
  missionStatusForIntent,
  PREPARE_PROJECT_PLACEHOLDER_GOAL,
  synthesizeImmediateDispatchContract,
  transitionIntentState,
  type MissionAttachmentSnapshot,
  type MissionOrchestratorRuntimeSnapshot,
  type MissionIntentSource,
  type PromotedPlanSnapshot,
} from "../../shared/mission-intent";
import {
  missionGoalNeedsFutureEvidence,
  MISSION_EVIDENCE_WAIT_MESSAGE,
} from "../../shared/mission-evidence";
import {
  GUIDED_PLAN_BLOCK_CTA,
  GUIDED_PLAN_BLOCK_MARKER,
} from "../../shared/guided-mission-plan";
import { hasRetiredRosterRouteMarker } from "../../shared/retired-adapter-policy";
import { hasAutomaticTechnicalRecovery } from "../../shared/mission-recovery-policy";
import { PET_STUDIO_SQUAD_ID } from "../../shared/pet-studio";
import {
  NEXUS_PLAN_SQUAD_ID,
  NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
} from "../../shared/builtin-squad-ids";
import {
  bumpMissionPromptIntent,
  cancelMissionPrompt,
  completeMissionPrompt,
  enqueueMissionPrompt,
  getMissionPromptAbortSignal,
  peekMissionPromptQueue,
  startMissionPrompt,
} from "./mission-prompt-queue-registry";
import {
  isEngineGeneratedSquadId,
  isMissionRuntimeSquadId,
  normalizeMilestones,
  type Mission,
  type MissionOrchestratorBootstrapResult,
  type MissionPaneSpec,
  type MissionPatch,
  type PaneActivitySummary,
  type Squad,
} from "../../shared/orch-types";
import { isAutomatedReviewerCompositionPane } from "./mission-pane-store";
import {
  resolveMissionPaneActivity,
  type MissionPaneActivityInput,
} from "./pane-activity-summary";
import type { ProjectExecutionScope } from "../../shared/types";
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import {
  bindOwnedAgentSessionMission,
  consumeMissionOrchestratorGrant,
  getOwnedAgentSessionInfo,
  hasMissionOrchestratorGrant,
  orchTerminateSession,
  rollbackOwnedAgentSessionMission,
  type OwnedAgentSessionInfo,
} from "../pty/pty-manager";
import {
  getContextBySession,
  restoreSessionAuthority,
  rollbackSessionAuthorityMission,
} from "./gate";
import { attachOrchMeta, findPaneOwnedBy } from "./pane-registry";
import type {
  ProjectDomainStoreRegistry,
  ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { emitMissionIntentEvent } from "./mission-intent-events";
import { getOrchSettings } from "../persistence/settings-store";
import { terminalOperationalFailureReason } from "../runtime/operational-failure-policy";
import { tryGetProjectOrientationService } from "../context/orientation/orientation-service";
import {
  snapshotDroppedAttachmentPaths,
  validateDroppedAttachmentPaths,
} from "../persistence/dropped-files";
import { getSquad } from "./squad-store";
import {
  snapshotSquadAuthority,
  squadAuthorityReviewStrings,
  type SquadAuthoritySnapshot,
} from "./squad-authority-snapshot";
import {
  canonicalMissionOrchestratorRuntime,
  missionOrchestratorEvidence,
  missionOrchestratorRuntimeReviewStrings,
  resolveProductionMissionOrchestratorRuntime,
  sameMissionOrchestratorRuntime,
  type ResolvedMissionOrchestratorRuntime,
} from "./mission-orchestrator-runtime";
import {
  resolveMissionPaneAuthoritySeal,
  sameMissionPaneAuthoritySeal,
} from "./mission-pane-authority";
import type { OrchestrationEvidence } from "../../shared/adapter-types";
import {
  revalidatePhysicalPlanHandoff,
  selectPhysicalPlanHandoff,
} from "./plan-promotion-authority";
import { assertLiveGuidedSquadReadiness } from "./squad-runtime-inventory";

export interface RendererMissionCreateInput {
  title: string;
  goal?: string;
  squadId: string;
  orchestratorPane: {
    paneId: string;
    // Legacy renderer fields remain accepted for IPC compatibility but are
    // deliberately ignored as authority and runtime metadata.
    adapterId?: string;
    model?: string;
    accountId?: string;
    cwd?: string;
    title?: string;
    agentName?: string;
  };
}

export interface RendererMissionArmInput {
  title: string;
  squadId: string;
}

export interface RendererMissionSubmitIntentInput {
  missionId: string;
  goal: string;
  source?: MissionIntentSource;
  /** prepare-project is NOT accepted here — use prepareProjectFromRenderer. */
  contextPolicy?: "none" | "minimal" | "on-demand";
  acceptanceCriteria?: string[];
  /**
   * Delivery lane. `consult` = read-only; `plan` = design-only plan.md;
   * `ops` = infra/shell sem PREVC congelado (não altera código do repo);
   * default / omitted = standard PREVC code.
   */
  lane?: "standard" | "consult" | "plan" | "ops";
  /** Set by the renderer only when current print/audio files are attached. */
  evidenceAttached?: boolean;
}

export interface RendererMissionApproveIntentInput {
  missionId: string;
  /** Rechecked at the final pre-pane dispatch boundary. */
  evidenceAttached?: boolean;
  /** Renderer candidates; main canonicalizes and validates before persistence. */
  attachmentPaths?: string[];
}

export interface RendererMissionAuthorityCandidate {
  readonly missionId: string;
  readonly title: string;
  readonly goal: string;
  readonly lane: "standard" | "consult" | "plan" | "ops";
  readonly risk: "normal" | "sensitive" | "destructive";
  readonly executionMode: "manual" | "assisted" | "autopilot";
  readonly contextPolicy: "none" | "minimal" | "on-demand" | "prepare-project";
  readonly acceptanceCriteria: readonly string[];
  readonly deniedTools: readonly string[];
  readonly evidenceAttached: boolean;
  readonly attachmentPaths: readonly string[];
  readonly attachmentSnapshots: readonly MissionAttachmentSnapshot[];
  readonly squad: SquadAuthoritySnapshot;
  readonly orchestratorRuntime: MissionOrchestratorRuntimeSnapshot;
  /** Main-owned evidence shown in the native approval dialog. */
  readonly orchestratorEvidence: OrchestrationEvidence;
  /**
   * Main-selected physical PRD/plan. Present only for plan → standard review;
   * never accepted from renderer input.
   */
  readonly promotedPlan?: PromotedPlanSnapshot;
  readonly intentVersion: number;
  readonly budgets: {
    readonly planningTokens: number;
    readonly executionTokens: number;
    readonly maxWorkers: number;
    readonly maxSteps?: number;
  };
  /** Hash of the exact durable intent/status snapshot shown to the operator. */
  readonly fence: string;
}

export interface RendererMissionLifecycleCandidate {
  readonly missionId: string;
  readonly title: string;
  readonly fromStatus: Mission["status"];
  readonly toStatus: "blocked" | "failed";
  readonly description: string;
  readonly fence: string;
}

export interface RendererMissionRemovalCandidate {
  readonly missionId: string;
  readonly title: string;
  readonly fence: string;
}

interface MissionApprovalFenceInput {
  readonly evidenceAttached: boolean;
  readonly attachmentPaths: readonly string[];
  readonly attachmentSnapshots: readonly MissionAttachmentSnapshot[];
  readonly squadRevisionHash: string;
  readonly orchestratorRuntime: MissionOrchestratorRuntimeSnapshot;
  readonly orchestratorEvidence: OrchestrationEvidence;
  readonly promotedPlan?: PromotedPlanSnapshot;
}

const MAX_NATIVE_MISSION_REVIEW_CHARS = 6_000;
const INVISIBLE_AUTHORITY_TEXT =
  /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;
const APPROVAL_REVIEW_SHA256 = /^[a-f0-9]{64}$/;

function validateApprovalReviewSha256(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (!APPROVAL_REVIEW_SHA256.test(value)) {
    throw new Error(
      "approval_review_receipt_invalid: expected an exact lowercase SHA-256",
    );
  }
  return value;
}

/** Control-character validation without a length veto (hash-pinned content). */
function assertVisibleAuthorityText(values: readonly string[]): void {
  if (values.some((value) => INVISIBLE_AUTHORITY_TEXT.test(value))) {
    throw new Error(
      "approval_review_unsafe: squad content contains invisible control characters",
    );
  }
}

function assertNativeMissionReviewable(values: readonly string[]): void {
  if (values.some((value) => INVISIBLE_AUTHORITY_TEXT.test(value))) {
    throw new Error(
      "approval_review_unsafe: objective contains invisible control characters",
    );
  }
  const total = values.reduce((sum, value) => sum + value.length, 0);
  if (total > MAX_NATIVE_MISSION_REVIEW_CHARS) {
    throw new Error(
      `approval_review_too_large: reduce objective/criteria metadata below ${MAX_NATIVE_MISSION_REVIEW_CHARS} characters before approval`,
    );
  }
}

function assertMissionAuthorityTitle(title: string): void {
  if (/\r|\n/.test(title) || INVISIBLE_AUTHORITY_TEXT.test(title)) {
    throw new Error(
      "approval_review_unsafe: mission title must be one visible line",
    );
  }
}

function attachmentSnapshotReviewStrings(
  snapshots: readonly MissionAttachmentSnapshot[],
): string[] {
  return snapshots.map(
    (snapshot) =>
      `${snapshot.path}\nSHA-256 ${snapshot.sha256}\n${snapshot.size} bytes`,
  );
}

function assertAttachmentSnapshotPaths(
  paths: readonly string[],
  snapshots: readonly MissionAttachmentSnapshot[],
): void {
  if (
    snapshots.length !== paths.length ||
    snapshots.some((snapshot, index) => snapshot.path !== paths[index])
  ) {
    throw new Error(
      "attachment snapshot does not match canonical attachment paths",
    );
  }
}

function missionAuthorityFence(
  mission: Mission,
  approval?: MissionApprovalFenceInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: mission.id,
        title: mission.title,
        description: mission.description,
        milestones: mission.milestones,
        status: mission.status,
        intentState: mission.intentState ?? null,
        intentVersion: mission.intentVersion ?? 0,
        intentContract: mission.intentContract ?? null,
        squadId: mission.squadId ?? null,
        // Promotion tears down this exact v1 runtime after the native review.
        // A pane replacement while the dialog is open must invalidate the
        // candidate even when the human-facing intent bytes did not change.
        orchestratorSessionId: mission.orchestratorSessionId ?? null,
        approval: approval ?? null,
      }),
    )
    .digest("hex");
}

function missionRemovalFence(mission: Readonly<Mission>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: mission.id,
        title: mission.title,
        description: mission.description,
        status: mission.status,
        squadId: mission.squadId ?? null,
        milestones: mission.milestones,
        learnings: mission.learnings,
        orchestratorSessionId: mission.orchestratorSessionId ?? null,
        intentState: mission.intentState ?? null,
        intentContract: mission.intentContract ?? null,
        intentVersion: mission.intentVersion ?? 0,
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
      }),
    )
    .digest("hex");
}

function missionRemovalCandidate(
  mission: Readonly<Mission>,
): RendererMissionRemovalCandidate {
  return Object.freeze({
    missionId: mission.id,
    title: mission.title,
    fence: missionRemovalFence(mission),
  });
}

function rendererMissionUpdateFence(
  mission: Mission,
  patch: MissionPatch,
): string {
  return createHash("sha256")
    .update(missionAuthorityFence(mission))
    .update("\0")
    .update(JSON.stringify(patch))
    .digest("hex");
}

function sameScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return (
    left.version === right.version &&
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
}

function ownedPaneSession(
  owner: WebContents,
  paneRef: string,
): { paneId: string; sessionId: string; info: OwnedAgentSessionInfo } {
  const pane = findPaneOwnedBy(owner, paneRef);
  if (!pane?.sessionId || pane.kind !== "cli-agent") {
    throw new Error(
      "mission requires an owned registered pane with a live agent session",
    );
  }
  const info = getOwnedAgentSessionInfo(owner, pane.sessionId);
  if (!info || info.paneId !== pane.paneId) {
    throw new Error(
      "registered pane does not match its main-owned agent session",
    );
  }
  const rendererScope = requireRendererWorkspaceScope(owner);
  if (!sameScope(rendererScope, info.scope)) {
    throw new Error("agent session is outside renderer workspace scope");
  }
  return { paneId: pane.paneId, sessionId: pane.sessionId, info };
}

function hasMatchingGateContext(
  sessionId: string,
  info: OwnedAgentSessionInfo,
  missionId?: string,
): boolean {
  const context = getContextBySession(sessionId);
  return Boolean(
    context &&
    context.role === info.role &&
    context.role === "orchestrator" &&
    sameScope(context.scope, info.scope) &&
    (missionId === undefined || context.missionId === missionId),
  );
}

function matchesPersistedRuntime(
  info: OwnedAgentSessionInfo,
  spec: MissionPaneSpec,
): boolean {
  return (
    info.source === "persisted-pane" &&
    info.missionId === spec.missionId &&
    info.role === spec.role &&
    info.paneId === spec.paneId &&
    info.adapterId === spec.adapterId &&
    info.cwd === spec.cwd &&
    info.model === spec.model &&
    info.accountId === spec.accountId &&
    info.effort === spec.effort &&
    info.workerIncarnationId === spec.workerIncarnationId &&
    (info.readOnly === true) === (spec.readOnly === true) &&
    Boolean(spec.scope && sameScope(info.scope, spec.scope))
  );
}

export class RendererMissionAuthority {
  readonly #stores: ProjectDomainStoreRegistry;
  readonly #resolveContextRevision: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => string | undefined;
  readonly #allowImmediateDispatch: (squadId: string) => boolean;
  readonly #resolvePaneActivity: (
    input: MissionPaneActivityInput,
  ) => PaneActivitySummary;
  readonly #validateAttachmentPaths: (
    paths: readonly string[] | undefined,
  ) => string[] | undefined;
  readonly #snapshotAttachmentPaths: (
    paths: readonly string[] | undefined,
  ) => MissionAttachmentSnapshot[] | undefined;
  readonly #requestMissionOrchestratorBootstrap: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => Promise<MissionOrchestratorBootstrapResult>;
  readonly #ensureMissionPlanBeforeBootstrap: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => unknown;
  readonly #resolveSquad: (squadId: string) => Squad | null;
  readonly #resolveOrchestratorRuntime: (
    squad: Squad,
    orchestrator: Squad["agents"][number],
  ) => ResolvedMissionOrchestratorRuntime;
  readonly #assertStandardSquadReadiness: (squad: Squad) => void;

  constructor(
    stores: ProjectDomainStoreRegistry,
    resolveContextRevision = (
      scope: ProjectExecutionScope,
      missionId: string,
    ): string | undefined =>
      getContextWorkflowService(scope).getMissionWorkflow(missionId).contract
        ?.contract.contextRevision,
    allowImmediateDispatch = (squadId: string): boolean =>
      squadId === PET_STUDIO_SQUAD_ID ||
      getOrchSettings().intentFirstMissionRuntimeV1 === false,
    resolvePaneActivity: (
      input: MissionPaneActivityInput,
    ) => PaneActivitySummary = resolveMissionPaneActivity,
    validateAttachmentPaths: (
      paths: readonly string[] | undefined,
    ) => string[] | undefined = validateDroppedAttachmentPaths,
    requestMissionOrchestratorBootstrap: (
      scope: ProjectExecutionScope,
      missionId: string,
    ) => Promise<MissionOrchestratorBootstrapResult> = async () => {
      throw new Error("main-owned mission bootstrap is not configured");
    },
    resolveSquad: (squadId: string) => Squad | null = getSquad,
    resolveOrchestratorRuntime: (
      squad: Squad,
      orchestrator: Squad["agents"][number],
    ) => ResolvedMissionOrchestratorRuntime = resolveProductionMissionOrchestratorRuntime,
    snapshotAttachmentPaths: (
      paths: readonly string[] | undefined,
    ) =>
      MissionAttachmentSnapshot[] | undefined = snapshotDroppedAttachmentPaths,
    ensureMissionPlanBeforeBootstrap: (
      scope: ProjectExecutionScope,
      missionId: string,
    ) => unknown = () => undefined,
    assertStandardSquadReadiness: (squad: Squad) => void =
      assertLiveGuidedSquadReadiness,
  ) {
    this.#stores = stores;
    this.#resolveContextRevision = resolveContextRevision;
    this.#allowImmediateDispatch = allowImmediateDispatch;
    this.#resolvePaneActivity = resolvePaneActivity;
    this.#validateAttachmentPaths = validateAttachmentPaths;
    this.#requestMissionOrchestratorBootstrap =
      requestMissionOrchestratorBootstrap;
    this.#resolveSquad = resolveSquad;
    this.#resolveOrchestratorRuntime = resolveOrchestratorRuntime;
    this.#snapshotAttachmentPaths = snapshotAttachmentPaths;
    this.#ensureMissionPlanBeforeBootstrap = ensureMissionPlanBeforeBootstrap;
    this.#assertStandardSquadReadiness = assertStandardSquadReadiness;
  }

  #attachmentsForApproval(paths: readonly string[] | undefined): {
    readonly present: boolean;
    readonly paths: string[];
    readonly snapshots: MissionAttachmentSnapshot[];
  } {
    const canonical =
      paths === undefined ? [] : (this.#validateAttachmentPaths(paths) ?? []);
    const snapshots =
      paths === undefined
        ? []
        : (this.#snapshotAttachmentPaths(canonical) ?? []);
    assertAttachmentSnapshotPaths(canonical, snapshots);
    return {
      present: paths !== undefined,
      paths: [...canonical],
      snapshots: snapshots.map((snapshot) => ({ ...snapshot })),
    };
  }

  #runtimeForSquad(
    squad: Squad,
    requireGuidedWorkers = false,
    planPromotion = false,
  ): MissionOrchestratorRuntimeSnapshot {
    if (
      requireGuidedWorkers &&
      (planPromotion || isEngineGeneratedSquadId(squad.id))
    ) {
      this.#assertStandardSquadReadiness(squad);
    }
    const orchestrator =
      squad.agents.find((agent) => agent.category === "orchestrator") ?? null;
    if (!orchestrator) {
      throw new Error(
        "squad_required: saved squad has no explicit orchestrator runtime",
      );
    }
    return canonicalMissionOrchestratorRuntime(
      this.#resolveOrchestratorRuntime(squad, orchestrator),
    );
  }

  /**
   * The PRD shortcut runs in an immutable `mission-runtime-*` copy, so its
   * current id is intentionally not the builtin template id. Main-owned,
   * hash-sealed lineage is the only sanctioned bridge from that planning
   * runtime to the app-managed delivery squad.
   */
  #executionSquadForPlanPromotion(current: Mission): Squad | null {
    const sourceSquad = current.squadId
      ? this.#resolveSquad(current.squadId)
      : null;
    if (!sourceSquad) return null;
    const cameFromPlanningTemplate =
      sourceSquad.id === NEXUS_PLAN_SQUAD_ID ||
      (isMissionRuntimeSquadId(sourceSquad.id) &&
        sourceSquad.runtimeSourceSquadId === NEXUS_PLAN_SQUAD_ID &&
        sourceSquad.runtimeSourceSquadRevisionHash !== undefined);
    return cameFromPlanningTemplate
      ? this.#resolveSquad(NEXUS_STORY_IMPLEMENTATION_SQUAD_ID)
      : sourceSquad;
  }

  updateMissionFromRenderer(
    owner: WebContents,
    missionId: string,
    patch: MissionPatch,
    expectedFence?: string,
  ): Mission | null {
    if (patch.status === "done") {
      throw new Error(
        "mission done is computed only after the PREVC workflow reaches complete",
      );
    }
    // Intent authority is exclusive to arm/submit/approve/prepare/bind APIs.
    // A compromised renderer must not self-promote awaiting_goal → dispatched.
    if (
      patch.intentState !== undefined ||
      patch.intentContract !== undefined ||
      patch.intentVersion !== undefined
    ) {
      throw new Error(
        "intent fields are only mutable via intent authority APIs",
      );
    }
    const hasForgedCompletion = patch.milestones?.some(
      (milestone) =>
        typeof milestone !== "string" &&
        (milestone.status === "done" ||
          (milestone.evidenceIds?.length ?? 0) > 0),
    );
    if (hasForgedCompletion) {
      throw new Error(
        "milestone completion and evidence are computed only by Nexus PREVC",
      );
    }
    if (patch.milestones) {
      const ids = normalizeMilestones(patch.milestones).map(
        (milestone) => milestone.id,
      );
      if (new Set(ids).size !== ids.length) {
        throw new Error("mission milestone ids must be unique");
      }
    }
    const scope = requireRendererWorkspaceScope(owner);
    const missions = this.#stores.forScope(scope).missions;
    const current = missions.get(missionId);
    if (!current) return null;
    if (current.status === "done") {
      throw new Error("completed missions are immutable");
    }
    if (
      patch.title !== undefined &&
      patch.title !== current.title &&
      hasCurrentApprovedDispatchContract(current)
    ) {
      throw new Error(
        "approved mission title is immutable because it is part of the canonical kickoff",
      );
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      if (patch.status !== "blocked" && patch.status !== "failed") {
        throw new Error(
          "mission lifecycle promotion/reopen is main-owned; use the explicit resume flow",
        );
      }
      if (current.status === "blocked" || current.status === "failed") {
        throw new Error(
          "blocked/failed mission lifecycle is immutable until explicit resume",
        );
      }
      if (
        expectedFence === undefined ||
        rendererMissionUpdateFence(current, patch) !== expectedFence
      ) {
        throw new Error(
          "mission_lifecycle_stale: native confirmation is missing or mission changed",
        );
      }
    }
    if (patch.milestones && current.intentContract) {
      throw new Error(
        "mission milestones are derived from the intent contract and main-owned",
      );
    }
    if (
      patch.milestones &&
      current.milestones.some((milestone) => milestone.status === "done")
    ) {
      throw new Error("completed mission milestones are immutable");
    }
    return missions.update(missionId, patch);
  }

  missionLifecycleCandidateFromRenderer(
    owner: WebContents,
    missionId: string,
    patch: MissionPatch,
  ): RendererMissionLifecycleCandidate {
    const scope = requireRendererWorkspaceScope(owner);
    const current = this.#stores.forScope(scope).missions.get(missionId);
    if (!current) throw new Error("mission not found");
    if (patch.status !== "blocked" && patch.status !== "failed") {
      throw new Error(
        "only blocked/failed demotion can request native confirmation",
      );
    }
    if (
      current.status === "done" ||
      current.status === "blocked" ||
      current.status === "failed"
    ) {
      throw new Error("mission is terminal or already blocked");
    }
    if (
      patch.intentState !== undefined ||
      patch.intentContract !== undefined ||
      patch.intentVersion !== undefined
    ) {
      throw new Error(
        "intent fields are only mutable via intent authority APIs",
      );
    }
    const description = patch.description ?? current.description;
    assertMissionAuthorityTitle(patch.title ?? current.title);
    assertNativeMissionReviewable([patch.title ?? current.title, description]);
    return Object.freeze({
      missionId: current.id,
      title: current.title,
      fromStatus: current.status,
      toStatus: patch.status,
      description,
      fence: rendererMissionUpdateFence(current, patch),
    });
  }

  /** Operator delete candidate. Recovery is revoked in the prepared phase. */
  missionRemovalCandidateFromRenderer(
    owner: WebContents,
    missionId: string,
  ): RendererMissionRemovalCandidate | null {
    const candidate = this.#removableMission(owner, missionId);
    return candidate ? missionRemovalCandidate(candidate.mission) : null;
  }

  /**
   * Revokes a running mission before the first teardown await.
   *
   * This prevents both late spawns and the ordinary physical-exit lifecycle
   * from converting an operator-requested removal into a fresh automatic
   * recovery flight. The initial fence proves this is still the exact mission
   * revision that passed the automatic-recovery refusal above.
   */
  prepareMissionRemovalFromMain(
    owner: WebContents,
    missionId: string,
    expectedFence: string,
  ): RendererMissionRemovalCandidate | null {
    if (!/^[a-f0-9]{64}$/.test(expectedFence)) {
      throw new Error("invalid mission removal fence");
    }
    const candidate = this.#removableMission(owner, missionId);
    if (!candidate) return null;
    if (missionRemovalFence(candidate.mission) !== expectedFence) {
      throw new Error(
        "mission_removal_stale: a missão mudou antes do teardown",
      );
    }
    if (
      candidate.mission.status !== "running" &&
      !hasAutomaticTechnicalRecovery(candidate.mission)
    ) {
      return missionRemovalCandidate(candidate.mission);
    }
    const blocked = candidate.suite.missions.block(
      candidate.mission.id,
      "user",
    );
    if (!blocked) {
      throw new Error(
        "mission_removal_stale: não foi possível revogar a execução antes do teardown",
      );
    }
    return missionRemovalCandidate(blocked);
  }

  removeMissionFromRenderer(
    owner: WebContents,
    missionId: string,
    expectedFence: string,
  ): boolean {
    if (!/^[a-f0-9]{64}$/.test(expectedFence)) {
      throw new Error("invalid mission removal fence");
    }
    const candidate = this.#removableMission(owner, missionId);
    if (!candidate) return false;
    if (hasAutomaticTechnicalRecovery(candidate.mission)) {
      throw new Error(
        "mission_removal_recovery_active: revogue a recuperação automática antes do delete",
      );
    }
    if (missionRemovalFence(candidate.mission) !== expectedFence) {
      throw new Error(
        "mission_removal_stale: a missão mudou durante o teardown; o histórico foi preservado",
      );
    }
    const result = candidate.suite.missions.removeIfUnchanged(
      candidate.mission.id,
      candidate.mission,
    );
    if (result === "changed") {
      throw new Error(
        "mission_removal_stale: a missão mudou durante o teardown; o histórico foi preservado",
      );
    }
    if (result === "removed") {
      // The removed mission may own the scope's durable merge block. Nothing
      // can acknowledge that block anymore, so lift it now instead of letting
      // every future mission of this scope defer merges into a technical
      // block. Best-effort: the scope-construction sweep also covers it.
      try {
        const scope = requireRendererWorkspaceScope(owner);
        requireWorktreeRuntimeRegistry().retireOrphanedMissionMergeBlock(
          scope,
          (ownerMissionId) =>
            Boolean(candidate.suite.missions.get(ownerMissionId)),
        );
      } catch (error) {
        console.warn(
          "[mission-authority] orphan merge block sweep after removal skipped",
          error,
        );
      }
    }
    return result === "removed";
  }

  #removableMission(
    owner: WebContents,
    missionId: string,
  ): { suite: ProjectDomainStoreSuite; mission: Mission } | null {
    const scope = requireRendererWorkspaceScope(owner);
    const suite = this.#stores.forScope(scope);
    const mission = suite.missions.get(missionId);
    if (!mission) return null;
    return { suite, mission };
  }

  /**
   * Intent-first arming: persist a mission shell in `awaiting_goal` with no
   * orchestrator pane, no running status, and zero LLM spend.
   */
  armMissionFromRenderer(
    owner: WebContents,
    input: RendererMissionArmInput,
  ): Mission {
    const scope = requireRendererWorkspaceScope(owner);
    const mission = this.#stores.forScope(scope).missions.create({
      title: input.title,
      squadId: input.squadId,
      intentState: "awaiting_goal",
      intentVersion: 0,
    });
    emitMissionIntentEvent({
      name: "squad_selected",
      missionId: mission.id,
      squadId: input.squadId,
      intentState: "awaiting_goal",
      intentVersion: 0,
      reason: "arm_mission",
    });
    return mission;
  }

  submitIntentFromRenderer(
    owner: WebContents,
    input: RendererMissionSubmitIntentInput,
  ): Mission {
    const scope = requireRendererWorkspaceScope(owner);
    const missions = this.#stores.forScope(scope).missions;
    const current = missions.get(input.missionId);
    if (!current) throw new Error("mission not found");
    if (current.status === "done") {
      throw new Error("completed missions are immutable");
    }

    const from = current.intentState ?? "awaiting_goal";
    const submit = transitionIntentState({ from, event: "submit_goal" });
    if (!submit.ok) {
      // Allow first goal from legacy shells.
      if (from !== "legacy" && from !== "awaiting_goal" && from !== "draft") {
        throw new Error(submit.reason);
      }
    }

    const nextVersion = (current.intentVersion ?? 0) + 1;
    // prepare-project is ONLY granted by prepareProjectFromRenderer — never via submit.
    const rawPolicy = input.contextPolicy;
    const contextPolicy =
      rawPolicy === "none" ||
      rawPolicy === "minimal" ||
      rawPolicy === "on-demand"
        ? rawPolicy
        : "on-demand";
    // A blocked mission has no frozen active workflow, so a redirect replaces
    // the plan wholesale — leaving the previous criteria would show the old
    // plan next to the new contract.
    const canReplacePlannedMilestones =
      from === "legacy" ||
      from === "draft" ||
      from === "awaiting_goal" ||
      from === "intent_compiling" ||
      from === "ready_to_start" ||
      from === "awaiting_approval" ||
      from === "blocked_user" ||
      from === "blocked_technical";
    // The synchronous compiler is the queue consumer for goal prompts. Mark
    // that delivery explicitly so snapshots never expose already-compiled
    // goals as permanently queued work.
    bumpMissionPromptIntent(scope, current.id, nextVersion);
    const queued = enqueueMissionPrompt({
      scope,
      missionId: current.id,
      kind: input.source === "voice" ? "voice_goal" : "user_goal",
      body: input.goal,
      intentVersion: nextVersion,
      source: input.source === "voice" ? "voice" : "typed",
    });
    const prompt = queued.state.items.at(-1);
    if (!prompt || prompt.status !== "queued") {
      throw new Error("intent prompt was preempted before compilation");
    }
    const started = startMissionPrompt(scope, current.id, prompt.id);
    if (started.state.executingId !== prompt.id) {
      cancelMissionPrompt(scope, current.id, prompt.id);
      throw new Error("intent prompt queue is busy");
    }

    let contract: ReturnType<typeof compileIntentContract>;
    let risk: ReturnType<typeof classifyGoalRisk>;
    let updated: Mission | null;
    try {
      const lane =
        input.lane === "consult"
          ? "consult"
          : input.lane === "plan"
            ? "plan"
            : input.lane === "ops"
              ? "ops"
              : "standard";
      contract = compileIntentContract({
        goal: input.goal,
        source: input.source ?? "typed",
        intentVersion: nextVersion,
        contextPolicy,
        acceptanceCriteria: input.acceptanceCriteria,
        lane,
      });
      const evidenceAttached = input.evidenceAttached === true;
      const needsFutureEvidence = missionGoalNeedsFutureEvidence(
        contract.goal,
        evidenceAttached,
      );
      risk = classifyGoalRisk(contract.goal);
      const compileEvent =
        risk === "normal"
          ? ("compile_ok" as const)
          : ("needs_approval" as const);
      const compiled = transitionIntentState({
        from: "intent_compiling",
        event: compileEvent,
      });
      if (!compiled.ok) throw new Error(compiled.reason);

      // A sentence such as "vou mandar os prints na próxima etapa" is not a
      // dispatchable objective yet. Keep the mission human-waiting so recovery
      // and handoff supervisors cannot mistake it for authorized work.
      const intentState =
        needsFutureEvidence && !evidenceAttached
          ? "awaiting_goal"
          : compiled.to;
      const status = missionStatusForIntent(intentState) ?? current.status;
      updated = missions.update(input.missionId, {
        description: contract.goal,
        status,
        intentState,
        intentContract: { ...contract, evidenceAttached },
        intentVersion: nextVersion,
        ...(canReplacePlannedMilestones
          ? { milestones: normalizeMilestones(contract.acceptanceCriteria) }
          : {}),
      });
      if (!updated) throw new Error("mission not found");
      completeMissionPrompt(scope, current.id, prompt.id, true);
    } catch (error) {
      completeMissionPrompt(scope, current.id, prompt.id, false);
      throw error;
    }

    emitMissionIntentEvent({
      name: "goal_submitted",
      missionId: updated.id,
      squadId: updated.squadId,
      intentState: "intent_compiling",
      intentVersion: nextVersion,
    });
    emitMissionIntentEvent({
      name: "intent_compiled",
      missionId: updated.id,
      squadId: updated.squadId,
      intentState: updated.intentState ?? "intent_compiling",
      intentVersion: nextVersion,
      reason: missionGoalNeedsFutureEvidence(
        contract.goal,
        input.evidenceAttached === true,
      )
        ? "awaiting_evidence"
        : risk,
    });
    return updated;
  }

  /**
   * Explicit UX action "Preparar projeto". Stays in awaiting_goal but marks
   * contextPolicy=prepare-project so bounded bootstrap tools are allowed.
   * Does not dispatch workers or mark the mission running.
   */
  async prepareProjectFromRenderer(
    owner: WebContents,
    input: { missionId: string },
  ): Promise<Mission> {
    const scope = requireRendererWorkspaceScope(owner);
    const missions = this.#stores.forScope(scope).missions;
    const current = missions.get(input.missionId);
    if (!current) throw new Error("mission not found");
    if (current.status === "done" || current.status === "failed") {
      throw new Error("mission is terminal");
    }
    const from = current.intentState ?? "awaiting_goal";
    // Only warm context while still waiting for a real goal — never clobber a plan.
    if (from !== "awaiting_goal" && from !== "draft" && from !== "legacy") {
      return current;
    }

    const nextVersion = (current.intentVersion ?? 0) + 1;
    // Preserve a real user goal if present; never invent a dispatchable objective.
    const existingGoal = current.intentContract?.goal?.trim() || "";
    const goal =
      existingGoal && !isPrepareProjectPlaceholderGoal(existingGoal)
        ? existingGoal
        : PREPARE_PROJECT_PLACEHOLDER_GOAL;
    const contract = compileIntentContract({
      goal,
      source: "typed",
      intentVersion: nextVersion,
      contextPolicy: "prepare-project",
      executionMode: "manual",
      acceptanceCriteria: [
        "Mapa estrutural do repositório disponível",
        "Nenhum worker despachado sem objetivo explícito",
      ],
    });

    const updated = missions.update(input.missionId, {
      // Keep human-wait state: prepare must never look like dispatch.
      intentState: "awaiting_goal",
      intentContract: contract,
      intentVersion: nextVersion,
      status: "pending",
    });
    if (!updated) throw new Error("mission not found");

    emitMissionIntentEvent({
      name: "prepare_project",
      missionId: updated.id,
      squadId: updated.squadId,
      intentState: "awaiting_goal",
      intentVersion: nextVersion,
      reason: "user_prepare_project",
    });

    // Production queue: preflight/bootstrap under prepare-project is trackable
    // and cancelled if the user submits a newer intentVersion.
    const queued = enqueueMissionPrompt({
      scope,
      missionId: updated.id,
      kind: "preflight",
      body: "prepare-project: aquecer mapa local",
      intentVersion: nextVersion,
      source: "system",
    });
    const item = queued.state.items.at(-1);
    if (!item || item.status !== "queued") {
      throw new Error("project preparation was preempted by a newer intent");
    }
    const started = startMissionPrompt(scope, updated.id, item.id);
    const isExecuting = started.state.items.some(
      (entry) => entry.id === item.id && entry.status === "executing",
    );
    if (!isExecuting) {
      cancelMissionPrompt(scope, updated.id, item.id);
      throw new Error("project preparation queue is busy");
    }

    const signal = getMissionPromptAbortSignal(scope, updated.id, item.id);
    const orientation = tryGetProjectOrientationService();
    if (!orientation) {
      completeMissionPrompt(scope, updated.id, item.id, false);
      throw new Error("project preparation is unavailable");
    }
    try {
      await orientation.ensure(scope, {
        reason: "pre-kickoff",
        force: true,
        signal,
        waitMs: 8_000,
      });
      if (signal?.aborted) throw new Error("intent_preempted");
      completeMissionPrompt(scope, updated.id, item.id, true);
    } catch (error) {
      completeMissionPrompt(scope, updated.id, item.id, false);
      if (signal?.aborted) {
        throw new Error("project preparation was cancelled by a newer intent");
      }
      console.warn("[mission-authority] project preparation failed:", error);
      throw new Error("project preparation failed");
    }
    return updated;
  }

  cancelPreparationFromRenderer(
    owner: WebContents,
    input: { missionId: string },
  ): { cancelled: boolean } {
    const scope = requireRendererWorkspaceScope(owner);
    const mission = this.#stores.forScope(scope).missions.get(input.missionId);
    if (!mission) throw new Error("mission not found");
    const queue = peekMissionPromptQueue(scope, input.missionId);
    const preparation = [queue.executing, ...queue.queued].find(
      (item) =>
        item?.kind === "preflight" && item.body.startsWith("prepare-project:"),
    );
    if (!preparation) return { cancelled: false };
    const result = cancelMissionPrompt(scope, input.missionId, preparation.id);
    return { cancelled: result.cancelledIds.includes(preparation.id) };
  }

  getPromptQueueFromRenderer(owner: WebContents, input: { missionId: string }) {
    const scope = requireRendererWorkspaceScope(owner);
    const mission = this.#stores.forScope(scope).missions.get(input.missionId);
    if (!mission) throw new Error("mission not found");
    return peekMissionPromptQueue(scope, input.missionId);
  }

  missionApprovalCandidateFromRenderer(
    owner: WebContents,
    input: RendererMissionApproveIntentInput,
  ): RendererMissionAuthorityCandidate {
    const scope = requireRendererWorkspaceScope(owner);
    const current = this.#stores.forScope(scope).missions.get(input.missionId);
    if (!current) throw new Error("mission not found");
    if (current.status === "done" || current.status === "failed") {
      throw new Error("mission is terminal");
    }
    const contract = current.intentContract;
    if (
      !contract?.goal?.trim() ||
      isPrepareProjectPlaceholderGoal(contract.goal)
    ) {
      throw new Error("intent_required: compile a real goal before approval");
    }
    if (contract.intentVersion !== current.intentVersion) {
      throw new Error(
        "stale_intent: contract intent version does not match the mission",
      );
    }
    const requestedAttachmentPaths =
      input.attachmentPaths === undefined
        ? contract.attachmentPaths
        : this.#validateAttachmentPaths(input.attachmentPaths);
    const attachments = this.#attachmentsForApproval(requestedAttachmentPaths);
    const attachmentPaths = attachments.paths;
    const evidenceAttached =
      (input.evidenceAttached === undefined
        ? contract.evidenceAttached === true
        : input.evidenceAttached === true) || attachmentPaths.length > 0;
    if (missionGoalNeedsFutureEvidence(contract.goal, evidenceAttached)) {
      throw new Error(`evidence_required: ${MISSION_EVIDENCE_WAIT_MESSAGE}`);
    }
    assertMissionAuthorityTitle(current.title);
    const acceptanceCriteria = [...contract.acceptanceCriteria];
    const deniedTools = contract.deniedTools ? [...contract.deniedTools] : [];
    const reviewedAttachments = [...attachmentPaths];
    const reviewedAttachmentSnapshots = attachments.snapshots;
    const squad = current.squadId ? this.#resolveSquad(current.squadId) : null;
    if (!squad) {
      throw new Error(
        "squad_required: saved squad is unavailable for approval",
      );
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    const orchestratorRuntime = this.#runtimeForSquad(
      squad,
      (contract.lane ?? "standard") === "standard",
    );
    const orchestratorEvidence = missionOrchestratorEvidence(
      orchestratorRuntime.adapterId,
    );
    // The approval dialog shows a bounded summary; squad instructions and
    // capabilities are pinned by the squad hash, not displayed. They must
    // still be free of invisible control characters (they can surface in
    // other operator dialogs), but their LENGTH must not veto approval — a
    // legitimate squad with long orchestrator instructions wedged the launch
    // with approval_review_too_large.
    assertNativeMissionReviewable([
      current.title,
      contract.goal,
      ...acceptanceCriteria,
      ...deniedTools,
      ...reviewedAttachments,
      ...attachmentSnapshotReviewStrings(reviewedAttachmentSnapshots),
      ...missionOrchestratorRuntimeReviewStrings(
        orchestratorRuntime,
        orchestratorEvidence,
      ),
    ]);
    assertVisibleAuthorityText(squadAuthorityReviewStrings(squadSnapshot));
    const approvalSnapshot = {
      evidenceAttached,
      attachmentPaths: reviewedAttachments,
      attachmentSnapshots: reviewedAttachmentSnapshots,
      squadRevisionHash: squadSnapshot.hash,
      orchestratorRuntime,
      orchestratorEvidence,
    };
    return Object.freeze({
      missionId: current.id,
      title: current.title,
      goal: contract.goal,
      lane: contract.lane ?? "standard",
      risk: contract.risk,
      executionMode: contract.executionMode,
      contextPolicy: contract.contextPolicy,
      acceptanceCriteria: Object.freeze(acceptanceCriteria),
      deniedTools: Object.freeze(deniedTools),
      evidenceAttached,
      attachmentPaths: Object.freeze(reviewedAttachments),
      attachmentSnapshots: Object.freeze(
        reviewedAttachmentSnapshots.map((snapshot) =>
          Object.freeze({ ...snapshot }),
        ),
      ),
      squad: squadSnapshot,
      orchestratorRuntime: Object.freeze({ ...orchestratorRuntime }),
      orchestratorEvidence,
      intentVersion: current.intentVersion ?? contract.intentVersion,
      budgets: Object.freeze({ ...contract.budgets }),
      fence: missionAuthorityFence(current, approvalSnapshot),
    });
  }

  approveIntentFromRenderer(
    owner: WebContents,
    input: RendererMissionApproveIntentInput,
    expectedFence?: string,
    approvalReviewSha256?: string,
  ): Mission {
    const reviewReceipt = validateApprovalReviewSha256(approvalReviewSha256);
    const scope = requireRendererWorkspaceScope(owner);
    const missions = this.#stores.forScope(scope).missions;
    const current = missions.get(input.missionId);
    if (!current) throw new Error("mission not found");
    if (current.status === "done") {
      throw new Error("completed missions are immutable");
    }
    if (
      current.intentContract &&
      current.intentContract.intentVersion !== current.intentVersion
    ) {
      throw new Error(
        "stale_intent: contract intent version does not match the mission",
      );
    }
    const requestedAttachmentPaths =
      input.attachmentPaths === undefined
        ? current.intentContract?.attachmentPaths
          ? [...current.intentContract.attachmentPaths]
          : undefined
        : this.#validateAttachmentPaths(input.attachmentPaths);
    const attachments = this.#attachmentsForApproval(requestedAttachmentPaths);
    const attachmentPaths = attachments.paths;
    const evidenceAttached =
      (input.evidenceAttached === undefined
        ? current.intentContract?.evidenceAttached === true
        : input.evidenceAttached === true) || attachmentPaths.length > 0;
    const squad = current.squadId ? this.#resolveSquad(current.squadId) : null;
    if (!squad) {
      throw new Error(
        "squad_required: saved squad is unavailable for approval",
      );
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    const orchestratorRuntime = this.#runtimeForSquad(
      squad,
      (current.intentContract?.lane ?? "standard") === "standard",
    );
    const orchestratorEvidence = missionOrchestratorEvidence(
      orchestratorRuntime.adapterId,
    );
    if (
      expectedFence !== undefined &&
      missionAuthorityFence(current, {
        evidenceAttached,
        attachmentPaths,
        attachmentSnapshots: attachments.snapshots,
        squadRevisionHash: squadSnapshot.hash,
        orchestratorRuntime,
        orchestratorEvidence,
      }) !== expectedFence
    ) {
      throw new Error(
        "approval_stale: mission intent, attachments, squad or runtime changed while native confirmation was open",
      );
    }

    const from = current.intentState ?? "ready_to_start";
    let nextState = from;
    let retryingFromBlock = false;
    if (from === "awaiting_approval") {
      const approved = transitionIntentState({ from, event: "approve" });
      if (!approved.ok) throw new Error(approved.reason);
      nextState = approved.to;
    } else if (
      from === "awaiting_goal" ||
      from === "draft" ||
      from === "legacy" ||
      from === "blocked_user" ||
      from === "blocked_technical"
    ) {
      // Plan step can still surface a compiled contract while the mission shell
      // is human-waiting (e.g. evidence false-positive, soft-restore, or
      // prepare-project). Explicit "Começar" with a real goal should dispatch
      // instead of hard-failing with a cryptic state error.
      //
      // Blocked states join the same lane. A mission whose preflight failed
      // once could never be approved again — "cannot dispatch from intent
      // state blocked_technical" — so a single transient block (a CLI not yet
      // authenticated, a dirty tree) wedged the mission permanently and the
      // only exit was deleting it. Re-approval does not widen authority: the
      // synchronous preflight below runs again and re-blocks with a fresh
      // reason if the cause is still there, and promotion still demands a
      // current approved dispatch contract.
      retryingFromBlock =
        from === "blocked_user" || from === "blocked_technical";
      const goal = current.intentContract?.goal?.trim() ?? "";
      if (!goal || isPrepareProjectPlaceholderGoal(goal)) {
        throw new Error(
          "intent_required: descreva o objetivo e compile o plano antes de começar",
        );
      }
      if (missionGoalNeedsFutureEvidence(goal, evidenceAttached)) {
        throw new Error(`evidence_required: ${MISSION_EVIDENCE_WAIT_MESSAGE}`);
      }
      // Synthetic compile_ok: contract already exists; advance to ready_to_start.
      nextState = "ready_to_start";
    } else if (from !== "ready_to_start") {
      if (from === "dispatched" || from === "executing") {
        if (!hasCurrentDispatchAuthority(current)) {
          throw new Error(
            "approval_required: current intent is not authorized",
          );
        }
        if (
          !sameMissionOrchestratorRuntime(
            current.intentContract?.orchestratorRuntime,
            orchestratorRuntime,
          )
        ) {
          throw new Error(
            "approval_required: orchestrator runtime changed; revise and approve again",
          );
        }
        return this.#continueMainOwnedBootstrap(scope, current.id) ?? current;
      }
      throw new Error(
        `approval_required: cannot dispatch from intent state ${from}`,
      );
    }
    if (nextState !== "ready_to_start") {
      throw new Error(
        `approval_required: cannot preflight from intent state ${nextState}`,
      );
    }

    if (!current.intentContract?.goal) {
      throw new Error("intent_required: compile a goal before dispatch");
    }
    if (isPrepareProjectPlaceholderGoal(current.intentContract.goal)) {
      throw new Error(
        "intent_required: prepare-project is not a dispatchable goal — submit a real objective first",
      );
    }
    if (
      missionGoalNeedsFutureEvidence(
        current.intentContract.goal,
        evidenceAttached,
      )
    ) {
      throw new Error(`evidence_required: ${MISSION_EVIDENCE_WAIT_MESSAGE}`);
    }

    const approvedAt = Date.now();
    // Keep contract.intentVersion locked to the mission revision being approved.
    const contractVersion = Math.max(
      1,
      current.intentVersion ?? current.intentContract.intentVersion ?? 1,
    );
    const contract = {
      ...current.intentContract,
      evidenceAttached,
      ...(attachments.present
        ? {
            attachmentPaths: [...attachmentPaths],
            attachmentSnapshots: attachments.snapshots.map((snapshot) => ({
              ...snapshot,
            })),
          }
        : {}),
      intentVersion: contractVersion,
      approvedAt,
      approvalReviewSha256: reviewReceipt,
      // Approval authorizes Main to seal the deterministic plan; it does not
      // authorize a provider, scheduler or worker effect yet.
      dispatchedAt: undefined,
      acceptanceCriteria: [...current.intentContract.acceptanceCriteria],
      budgets: { ...current.intentContract.budgets },
      deniedTools: current.intentContract.deniedTools
        ? [...current.intentContract.deniedTools]
        : undefined,
      squadRevisionHash: squadSnapshot.hash,
      orchestratorRuntime: { ...orchestratorRuntime },
    };
    // Approval is not launch. Keep the mission pending while the synchronous
    // main-owned planner proves a sealed task receipt. Only a successful
    // preflight may publish `running`; otherwise the durable transition is
    // pending → blocked and the UI never celebrates a fleet that did not start.
    const updated = missions.update(input.missionId, {
      status: "pending",
      intentState: nextState,
      intentVersion: contractVersion,
      intentContract: contract,
      milestones: normalizeMilestones(
        current.intentContract.acceptanceCriteria,
      ),
      // A retry must not carry the previous failure note as if it were still
      // current. The preflight below writes a fresh one if it blocks again.
      ...(retryingFromBlock
        ? {
            description: current.description
              .split(GUIDED_PLAN_BLOCK_MARKER)[0]!
              .trim(),
          }
        : {}),
    });
    if (!updated) throw new Error("mission not found");

    // Preempt any stale preflight/bootstrap queued for a prior intentVersion.
    // The goal itself was synchronously delivered by submitIntentFromRenderer;
    // approval must not enqueue a duplicate prompt.
    bumpMissionPromptIntent(scope, updated.id, contractVersion);

    emitMissionIntentEvent({
      name: "plan_approved",
      missionId: updated.id,
      squadId: updated.squadId,
      intentState: nextState,
      intentVersion: contractVersion,
      reason: "user_start",
    });
    return (
      this.#continueMainOwnedBootstrap(scope, updated.id, {
        promoteToRunning: true,
        approvedPreflight: {
          intentVersion: contractVersion,
          approvedAt,
          approvalReviewSha256: reviewReceipt,
        },
      }) ?? updated
    );
  }

  #continueMainOwnedBootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
    options: {
      promoteToRunning?: boolean;
      approvedPreflight?: {
        readonly intentVersion: number;
        readonly approvedAt: number;
        readonly approvalReviewSha256?: string;
      };
    } = {},
  ): Mission | null {
    // Guided Planner is a synchronous main-owned preflight: no provider,
    // kickoff or scheduler effect may start while the current approved intent
    // lacks its immutable task receipt.
    try {
      this.#ensureMissionPlanBeforeBootstrap(scope, missionId);
    } catch (error) {
      const missions = this.#stores.forScope(scope).missions;
      const current = missions.get(missionId);
      if (!current) {
        throw new Error(
          "guided_plan_preflight_failed: a missão desapareceu antes do bloqueio durável",
          { cause: error },
        );
      }
      const detail = (error instanceof Error ? error.message : String(error))
        .trim()
        .slice(0, 2_048);
      const durableDetail = hasRetiredRosterRouteMarker(error)
        ? terminalOperationalFailureReason(detail)
        : detail;
      const note =
        `${GUIDED_PLAN_BLOCK_MARKER}\n` +
        `## Execução não iniciada\nO Nexus não conseguiu selar uma tarefa ` +
        `segura antes de abrir qualquer CLI. ${durableDetail || "Preflight sem detalhe."} ` +
        `CTA: ${GUIDED_PLAN_BLOCK_CTA}.`;
      const description = current.description.includes(GUIDED_PLAN_BLOCK_MARKER)
        ? current.description
        : [current.description.trim(), note]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 65_536);
      const blocked = missions.update(missionId, {
        ...missionBlockPatch("technical"),
        description,
      });
      if (!blocked) {
        throw new Error(
          "guided_plan_preflight_failed: o plano falhou e o bloqueio durável não pôde ser persistido",
          { cause: error },
        );
      }
      emitMissionIntentEvent({
        name: "intent_gate_denied",
        missionId: blocked.id,
        squadId: blocked.squadId,
        intentState: blocked.intentState,
        intentVersion: blocked.intentVersion,
        reason: "guided_plan_preflight_failed",
      });
      console.warn(
        `[mission-authority] guided plan blocked ${missionId}:`,
        error,
      );
      // The durable store already carries the actionable blocked snapshot.
      // Reject this one-shot IPC so the renderer stops before resolving
      // conflicting orchestrators or performing any other post-approval work.
      throw new Error(
        `guided_plan_preflight_blocked: ${detail || "preflight sem detalhe"}`,
        { cause: error },
      );
    }
    let ready: Mission | null = null;
    if (options.promoteToRunning) {
      const missions = this.#stores.forScope(scope).missions;
      const current = missions.get(missionId);
      const contract = current?.intentContract;
      const expected = options.approvedPreflight;
      if (
        !current ||
        !contract ||
        !expected ||
        current.status !== "pending" ||
        current.intentState !== "ready_to_start" ||
        current.intentVersion !== expected.intentVersion ||
        contract.intentVersion !== expected.intentVersion ||
        contract.approvedAt !== expected.approvedAt ||
        contract.approvalReviewSha256 !== expected.approvalReviewSha256 ||
        contract.dispatchedAt !== undefined ||
        !hasCurrentApprovedDispatchContract(current)
      ) {
        throw new Error(
          "guided_plan_preflight_stale: a aprovação mudou antes do despacho",
        );
      }
      const started = transitionIntentState({
        from: current.intentState,
        event: "start",
      });
      if (!started.ok) throw new Error(started.reason);
      ready = missions.update(missionId, {
        status: "running",
        intentState: started.to,
        intentContract: {
          ...contract,
          dispatchedAt: Date.now(),
        },
      });
      if (!ready) {
        throw new Error(
          "guided_plan_preflight_failed: o plano foi selado, mas a missão desapareceu antes do bootstrap",
        );
      }
      if (!hasCurrentDispatchAuthority(ready)) {
        throw new Error(
          "guided_plan_preflight_failed: o receipt foi selado, mas a autoridade de despacho não foi persistida",
        );
      }
    }
    try {
      void this.#requestMissionOrchestratorBootstrap(scope, missionId).catch(
        (error) => {
          // Production bootstrap turns every expected/physical failure into a
          // durable blocked mission with one CTA. This guard only prevents an
          // injected or catastrophic rejection from escaping the IPC handler;
          // the coordinator will retry the still-running durable mission.
          console.warn(
            `[mission-authority] bootstrap request failed for ${missionId}:`,
            error,
          );
        },
      );
    } catch (error) {
      console.warn(
        `[mission-authority] bootstrap request failed for ${missionId}:`,
        error,
      );
    }
    return ready;
  }

  /**
   * Operator action after plan-mode design: upgrade lane plan → standard so
   * worktrees/shell/code tools are allowed under the same authorized mission.
   * Keeps goal/acceptance; re-expands budgets for risk; re-stamps dispatch.
   */
  planPromotionCandidateFromRenderer(
    owner: WebContents,
    input: { missionId: string },
  ): RendererMissionAuthorityCandidate {
    return this.#planPromotionCandidate(owner, input);
  }

  /**
   * Main-only second read after plan-v1 teardown. The expected snapshot was
   * selected before the native review; this method reloads that exact durable
   * handoff without asking the revoked session to redeliver anything.
   */
  planPromotionCandidateAfterTeardownFromMain(
    owner: WebContents,
    input: { missionId: string },
    expectedPlan: PromotedPlanSnapshot,
  ): RendererMissionAuthorityCandidate {
    return this.#planPromotionCandidate(owner, input, expectedPlan);
  }

  #planPromotionCandidate(
    owner: WebContents,
    input: { missionId: string },
    expectedPlan?: PromotedPlanSnapshot,
  ): RendererMissionAuthorityCandidate {
    const scope = requireRendererWorkspaceScope(owner);
    const stores = this.#stores.forScope(scope);
    const current = stores.missions.get(input.missionId);
    if (!current) throw new Error("mission not found");
    if (current.status === "done" || current.status === "failed") {
      throw new Error("mission is terminal");
    }
    const contract = current.intentContract;
    if (!contract || contract.lane !== "plan") {
      throw new Error(
        "promote_plan: mission is not in plan lane (or has no contract)",
      );
    }
    if (!contract.goal?.trim()) {
      throw new Error("intent_required: plan mission has empty goal");
    }
    const risk = classifyGoalRisk(contract.goal);
    assertMissionAuthorityTitle(current.title);
    const acceptanceCriteria = [...contract.acceptanceCriteria];
    const deniedTools = contract.deniedTools ? [...contract.deniedTools] : [];
    const attachments = this.#attachmentsForApproval(contract.attachmentPaths);
    const attachmentPaths = attachments.paths;
    const squad = this.#executionSquadForPlanPromotion(current);
    if (!squad) {
      throw new Error(
        "squad_required: saved squad is unavailable for promotion",
      );
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    const orchestratorRuntime = this.#runtimeForSquad(squad, true, true);
    const orchestratorEvidence = missionOrchestratorEvidence(
      orchestratorRuntime.adapterId,
    );
    const promotedPlan =
      expectedPlan === undefined
        ? selectPhysicalPlanHandoff({
            mission: current,
            handoffs: stores.handoffs,
          })
        : revalidatePhysicalPlanHandoff({
            mission: current,
            expected: expectedPlan,
            handoffs: stores.handoffs,
          });
    if (
      expectedPlan !== undefined &&
      current.orchestratorSessionId !== undefined
    ) {
      throw new Error(
        "promotion_runtime_reappeared: a sessão plan voltou após o teardown",
      );
    }
    assertNativeMissionReviewable([
      contract.goal,
      ...acceptanceCriteria,
      ...deniedTools,
      ...attachmentPaths,
      ...attachmentSnapshotReviewStrings(attachments.snapshots),
      ...squadAuthorityReviewStrings(squadSnapshot),
      ...missionOrchestratorRuntimeReviewStrings(
        orchestratorRuntime,
        orchestratorEvidence,
      ),
    ]);
    return Object.freeze({
      missionId: current.id,
      title: current.title,
      goal: contract.goal,
      lane: "plan",
      risk,
      executionMode: contract.executionMode,
      contextPolicy: contract.contextPolicy,
      acceptanceCriteria: Object.freeze(acceptanceCriteria),
      deniedTools: Object.freeze(deniedTools),
      evidenceAttached: contract.evidenceAttached === true,
      attachmentPaths: Object.freeze(attachmentPaths),
      attachmentSnapshots: Object.freeze(
        attachments.snapshots.map((snapshot) => Object.freeze({ ...snapshot })),
      ),
      squad: squadSnapshot,
      orchestratorRuntime: Object.freeze({ ...orchestratorRuntime }),
      orchestratorEvidence,
      promotedPlan,
      intentVersion: current.intentVersion ?? contract.intentVersion,
      budgets: Object.freeze({ ...defaultBudgetsForRisk(risk) }),
      fence: missionAuthorityFence(current, {
        evidenceAttached: contract.evidenceAttached === true,
        attachmentPaths,
        attachmentSnapshots: attachments.snapshots,
        squadRevisionHash: squadSnapshot.hash,
        orchestratorRuntime,
        orchestratorEvidence,
        promotedPlan,
      }),
    });
  }

  promotePlanLaneFromRenderer(
    owner: WebContents,
    input: { missionId: string },
    expectedFence: string,
    expectedPlan: PromotedPlanSnapshot,
    approvalReviewSha256?: string,
  ): Mission {
    const reviewReceipt = validateApprovalReviewSha256(approvalReviewSha256);
    const scope = requireRendererWorkspaceScope(owner);
    const stores = this.#stores.forScope(scope);
    const missions = stores.missions;
    const current = missions.get(input.missionId);
    if (!current) throw new Error("mission not found");
    if (current.status === "done" || current.status === "failed") {
      throw new Error("mission is terminal");
    }
    const contract = current.intentContract;
    if (!contract || contract.lane !== "plan") {
      throw new Error(
        "promote_plan: mission is not in plan lane (or has no contract)",
      );
    }
    if (!contract.goal?.trim()) {
      throw new Error("intent_required: plan mission has empty goal");
    }
    if (current.orchestratorSessionId !== undefined) {
      throw new Error(
        "promotion_runtime_live: a sessão plan precisa estar fisicamente encerrada",
      );
    }
    const promotedPlan = revalidatePhysicalPlanHandoff({
      mission: current,
      expected: expectedPlan,
      handoffs: stores.handoffs,
    });
    const squad = this.#executionSquadForPlanPromotion(current);
    if (!squad) {
      throw new Error(
        "squad_required: saved squad is unavailable for promotion",
      );
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    const orchestratorRuntime = this.#runtimeForSquad(squad, true, true);
    const orchestratorEvidence = missionOrchestratorEvidence(
      orchestratorRuntime.adapterId,
    );
    const attachments = this.#attachmentsForApproval(contract.attachmentPaths);
    if (
      missionAuthorityFence(current, {
        evidenceAttached: contract.evidenceAttached === true,
        attachmentPaths: contract.attachmentPaths ?? [],
        attachmentSnapshots: attachments.snapshots,
        squadRevisionHash: squadSnapshot.hash,
        orchestratorRuntime,
        orchestratorEvidence,
        promotedPlan,
      }) !== expectedFence
    ) {
      throw new Error(
        "promotion_stale: mission, saved squad or runtime changed while native confirmation was open",
      );
    }
    const risk = classifyGoalRisk(contract.goal);
    const nextVersion = (current.intentVersion ?? 0) + 1;
    const now = Date.now();
    const nextContract = {
      ...contract,
      lane: "standard" as const,
      intentVersion: nextVersion,
      risk,
      budgets: defaultBudgetsForRisk(risk),
      // The native promotion click approves revision v+1, but it does not
      // authorize the still-live plan-v1 PTY to inherit code authority. Keep
      // the new revision non-executable until main has physically closed v1,
      // sealed the v2 plan and started a freshly sealed orchestrator.
      approvedAt: now,
      approvalReviewSha256: reviewReceipt,
      dispatchedAt: undefined,
      acceptanceCriteria: [...contract.acceptanceCriteria],
      deniedTools: contract.deniedTools ? [...contract.deniedTools] : undefined,
      attachmentPaths: contract.attachmentPaths
        ? [...contract.attachmentPaths]
        : undefined,
      attachmentSnapshots: attachments.present
        ? attachments.snapshots.map((snapshot) => ({ ...snapshot }))
        : undefined,
      squadRevisionHash: squadSnapshot.hash,
      orchestratorRuntime: { ...orchestratorRuntime },
      promotedPlan: {
        ...promotedPlan,
        physicalReceipt: { ...promotedPlan.physicalReceipt },
        artifacts: structuredClone(promotedPlan.artifacts),
      },
    };
    const intentState = "ready_to_start" as const;
    const updated = missions.commitPlanPromotionRevision(
      input.missionId,
      current,
      squad.id,
      nextContract,
    );
    bumpMissionPromptIntent(scope, updated.id, nextVersion);
    emitMissionIntentEvent({
      name: "plan_approved",
      missionId: updated.id,
      squadId: updated.squadId,
      intentState,
      intentVersion: nextVersion,
      reason: "promote_plan_to_standard",
    });
    return updated;
  }

  /**
   * Bind a live orchestrator pane to an already-armed (intent-first) mission
   * instead of creating a second mission row.
   */
  bindOrchestratorToMissionFromRenderer(
    owner: WebContents,
    input: RendererMissionCreateInput & { missionId: string },
  ): Mission {
    const owned = ownedPaneSession(owner, input.orchestratorPane.paneId);
    if (
      owned.info.source !== "legacy-squad" ||
      owned.info.role !== "orchestrator" ||
      owned.info.squadId !== input.squadId ||
      !hasMatchingGateContext(owned.sessionId, owned.info) ||
      !hasMissionOrchestratorGrant(owner, owned.sessionId, input.squadId)
    ) {
      throw new Error("pane has no main-owned orchestrator promotion grant");
    }
    const granted = owned.info;
    const suite = this.#stores.forScope(granted.scope);
    const missionStore = suite.missions;
    const paneStore = suite.missionPanes;
    const existing = missionStore.get(input.missionId);
    if (!existing) throw new Error("mission not found");
    if (existing.squadId && existing.squadId !== input.squadId) {
      throw new Error("mission squad does not match orchestrator grant");
    }
    // Pane binding is post-dispatch only. Approval persists dispatchedAt before
    // the renderer may create the live CLI pane.
    const intentState = existing.intentState ?? "legacy";
    if (!hasCurrentDispatchAuthority(existing)) {
      throw new Error(
        `approval_required: current intent must be approved and dispatched before binding (state=${intentState})`,
      );
    }
    const savedSquad = this.#resolveSquad(input.squadId);
    const authoritySeal = savedSquad
      ? resolveMissionPaneAuthoritySeal(granted.scope, existing, savedSquad)
      : null;
    if (!authoritySeal) {
      throw new Error(
        "mission pane authority seal is unavailable for the current revision",
      );
    }

    let gateBound = false;
    let sessionBound = false;
    let orchestratorSessionUpdated = false;
    let recordedPaneId: string | null = null;
    try {
      const priorPane = paneStore.findByPaneId(owned.paneId);
      const recordedPane = paneStore.record({
        missionId: existing.id,
        paneId: owned.paneId,
        adapterId: granted.adapterId,
        model: granted.model,
        accountId: granted.accountId,
        effort: granted.effort,
        cwd: granted.cwd,
        title: `${input.title} · orq`,
        agentName: granted.agentName,
        role: "orchestrator",
        allowedTools: granted.allowedTools,
        allowedSkills: granted.allowedSkills,
        authoritySeal,
      });
      recordedPaneId = priorPane ? null : recordedPane.id;
      gateBound = restoreSessionAuthority(owned.sessionId, {
        missionId: existing.id,
        role: "orchestrator",
        agentName: granted.agentName,
        allowedTools: granted.allowedTools,
        allowedSkills: granted.allowedSkills,
      });
      sessionBound =
        gateBound &&
        bindOwnedAgentSessionMission(owner, owned.sessionId, existing.id);
      if (!gateBound || !sessionBound) {
        throw new Error(
          "failed to bind mission to the authorized orchestrator session",
        );
      }
      const updated = missionStore.setOrchestratorSession(
        existing.id,
        owned.sessionId,
      );
      if (!updated) {
        throw new Error("mission disappeared while binding orchestrator");
      }
      orchestratorSessionUpdated = true;
      if (updated.status !== "running") {
        missionStore.setStatus(existing.id, "running");
      }
      const bound = missionStore.get(existing.id) ?? updated;
      attachOrchMeta(owner, owned.paneId, {
        missionId: bound.id,
        agentName: granted.agentName,
        role: "orchestrator",
        scope: granted.scope,
        allowedTools: granted.allowedTools,
        allowedSkills: granted.allowedSkills,
      });
      const consumed = consumeMissionOrchestratorGrant(
        owner,
        owned.sessionId,
        input.squadId,
      );
      if (!consumed) {
        throw new Error("failed to consume the orchestrator promotion grant");
      }
      emitMissionIntentEvent({
        name: "task_dispatched",
        missionId: bound.id,
        squadId: bound.squadId,
        intentState: bound.intentState,
        intentVersion: bound.intentVersion,
        reason: "bind_orchestrator",
      });
      return bound;
    } catch (error) {
      if (orchestratorSessionUpdated) {
        missionStore.setOrchestratorSession(
          existing.id,
          existing.orchestratorSessionId ?? null,
        );
      }
      if (sessionBound) {
        rollbackOwnedAgentSessionMission(owner, owned.sessionId, existing.id);
      }
      if (gateBound) {
        rollbackSessionAuthorityMission(owned.sessionId, existing.id);
      }
      if (recordedPaneId) paneStore.remove(recordedPaneId);
      throw error;
    }
  }

  createMissionFromRenderer(
    owner: WebContents,
    input: RendererMissionCreateInput,
  ): Mission {
    if (!this.#allowImmediateDispatch(input.squadId)) {
      throw new Error(
        "intent-first: immediate mission creation is not authorized for this squad",
      );
    }
    const owned = ownedPaneSession(owner, input.orchestratorPane.paneId);
    if (
      owned.info.source !== "legacy-squad" ||
      owned.info.role !== "orchestrator" ||
      owned.info.squadId !== input.squadId ||
      !hasMatchingGateContext(owned.sessionId, owned.info) ||
      !hasMissionOrchestratorGrant(owner, owned.sessionId, input.squadId)
    ) {
      throw new Error("pane has no main-owned orchestrator promotion grant");
    }
    const granted = owned.info;
    if (granted.immediateMissionTitle !== input.title.trim()) {
      void orchTerminateSession(owned.sessionId);
      throw new Error(
        "immediate mission goal does not match the native-confirmed grant",
      );
    }
    if (granted.immediateMissionGoal !== (input.goal ?? input.title).trim()) {
      void orchTerminateSession(owned.sessionId);
      throw new Error(
        "immediate mission goal does not match the native-confirmed grant",
      );
    }

    const suite = this.#stores.forScope(granted.scope);
    const missionStore = suite.missions;
    const paneStore = suite.missionPanes;
    let mission: Mission | null = null;
    let gateBound = false;
    let sessionBound = false;
    try {
      // Immediate execution shell (forceLegacy / pet-studio): still dispatched,
      // but with a real approved contract so the MCP gate can authorize workers.
      const now = Date.now();
      const savedSquad = this.#resolveSquad(input.squadId);
      if (!savedSquad) {
        throw new Error("immediate mission requires the exact saved squad");
      }
      assertMissionAuthorityTitle(input.title);
      const legacyContract = {
        ...synthesizeImmediateDispatchContract({
          title: input.title,
          goal: input.goal,
          intentVersion: 1,
          now,
          profile:
            input.squadId === PET_STUDIO_SQUAD_ID ? "pet-studio" : "standard",
        }),
        squadRevisionHash: snapshotSquadAuthority(savedSquad).hash,
      };
      mission = missionStore.create({
        title: input.title,
        squadId: granted.squadId,
        orchestratorSessionId: owned.sessionId,
        description: legacyContract.goal,
        intentState: "dispatched",
        intentVersion: 1,
        intentContract: legacyContract,
      });
      const authorizedMission = missionStore.update(mission.id, {
        status: "running",
      });
      if (!authorizedMission) {
        throw new Error("failed to publish authorized mission lifecycle");
      }
      mission = authorizedMission;
      const authoritySeal = resolveMissionPaneAuthoritySeal(
        granted.scope,
        mission,
        savedSquad,
      );
      if (!authoritySeal) {
        throw new Error(
          "immediate mission pane authority seal could not be created",
        );
      }
      paneStore.record({
        missionId: mission.id,
        paneId: owned.paneId,
        adapterId: granted.adapterId,
        model: granted.model,
        accountId: granted.accountId,
        effort: granted.effort,
        cwd: granted.cwd,
        title: `${input.title} · orq`,
        agentName: granted.agentName,
        role: "orchestrator",
        allowedTools: granted.allowedTools,
        allowedSkills: granted.allowedSkills,
        authoritySeal,
      });
      gateBound = restoreSessionAuthority(owned.sessionId, {
        missionId: mission.id,
        role: "orchestrator",
        agentName: granted.agentName,
        allowedTools: granted.allowedTools,
        allowedSkills: granted.allowedSkills,
      });
      sessionBound =
        gateBound &&
        bindOwnedAgentSessionMission(owner, owned.sessionId, mission.id);
      const consumed =
        gateBound && sessionBound
          ? consumeMissionOrchestratorGrant(
              owner,
              owned.sessionId,
              input.squadId,
            )
          : null;
      if (!gateBound || !sessionBound || !consumed) {
        throw new Error(
          "failed to bind mission to the authorized orchestrator session",
        );
      }
    } catch (error) {
      if (mission) {
        if (sessionBound) {
          rollbackOwnedAgentSessionMission(owner, owned.sessionId, mission.id);
        }
        if (gateBound) {
          rollbackSessionAuthorityMission(owned.sessionId, mission.id);
        }
        missionStore.remove(mission.id);
      }
      void orchTerminateSession(owned.sessionId);
      throw error;
    }
    if (!mission) throw new Error("mission creation did not produce a record");

    attachOrchMeta(owner, owned.paneId, {
      missionId: mission.id,
      agentName: granted.agentName,
      role: "orchestrator",
      scope: granted.scope,
      allowedTools: granted.allowedTools,
      allowedSkills: granted.allowedSkills,
    });
    return mission;
  }

  restorePersistedPaneAuthority(owner: WebContents, paneId: string): boolean {
    let owned: ReturnType<typeof ownedPaneSession>;
    try {
      owned = ownedPaneSession(owner, paneId);
    } catch {
      return false;
    }
    const suite = this.#stores.forScope(owned.info.scope);
    const paneStore = suite.missionPanes;
    const spec = paneStore.findByPaneId(owned.paneId);
    const mission = spec ? suite.missions.get(spec.missionId) : null;
    if (
      !spec ||
      !mission ||
      !hasCurrentDispatchAuthority(mission) ||
      !matchesPersistedRuntime(owned.info, spec) ||
      !hasMatchingGateContext(owned.sessionId, owned.info, spec.missionId)
    ) {
      return false;
    }
    const contextRevision = this.#resolveContextRevision(
      owned.info.scope,
      spec.missionId,
    );
    if (
      !restoreSessionAuthority(owned.sessionId, {
        missionId: spec.missionId,
        contextRevision,
        role: spec.role,
        agentName: spec.agentName,
        workerIncarnationId: spec.workerIncarnationId,
        allowedTools: spec.allowedTools,
        allowedSkills: spec.allowedSkills,
        ...(spec.readOnly === true ? { readOnly: true } : {}),
      })
    ) {
      return false;
    }
    attachOrchMeta(owner, owned.paneId, {
      missionId: spec.missionId,
      contextRevision,
      agentName: spec.agentName,
      workerIncarnationId: spec.workerIncarnationId,
      role: spec.role,
      scope: owned.info.scope,
      allowedTools: spec.allowedTools,
      allowedSkills: spec.allowedSkills,
      ...(spec.readOnly === true ? { readOnly: true } : {}),
    });
    return true;
  }

  rebindMissionFromRenderer(
    owner: WebContents,
    missionId: string,
    sessionId: string,
  ): Mission | null {
    const rendererScope = requireRendererWorkspaceScope(owner);
    const suite = this.#stores.forScope(rendererScope);
    const missionStore = suite.missions;
    const paneStore = suite.missionPanes;
    const mission = missionStore.get(missionId);
    if (
      !mission ||
      mission.id !== missionId ||
      !hasCurrentDispatchAuthority(mission)
    ) {
      return null;
    }

    let owned: ReturnType<typeof ownedPaneSession>;
    try {
      owned = ownedPaneSession(owner, sessionId);
    } catch {
      return null;
    }
    if (
      mission.orchestratorSessionId === sessionId &&
      owned.info.missionId === missionId &&
      owned.info.role === "orchestrator" &&
      hasMatchingGateContext(sessionId, owned.info, missionId)
    ) {
      return missionStore.rebindOrchestratorSession(missionId, sessionId);
    }
    const spec = paneStore.findByPaneId(owned.paneId);
    if (
      !spec ||
      spec.missionId !== missionId ||
      spec.role !== "orchestrator" ||
      !this.restorePersistedPaneAuthority(owner, owned.paneId)
    ) {
      return null;
    }
    return missionStore.rebindOrchestratorSession(missionId, sessionId);
  }

  listMissionPanesForRenderer(
    owner: WebContents,
    missionId: string,
  ): MissionPaneSpec[] {
    const rendererScope = requireRendererWorkspaceScope(owner);
    const persistedSpecs = this.#stores
      .forScope(rendererScope)
      .missionPanes.list(missionId);
    // Legacy PREVC reviewers were process-local verification lanes, not
    // mission composition. Never let a stale row recreate a deleted /tmp
    // checkout during renderer reopen, even before startup GC can run.
    const specs = persistedSpecs.filter(
      (spec) => !isAutomatedReviewerCompositionPane(spec),
    );
    if (
      specs.some(
        (spec) =>
          spec.missionId !== missionId ||
          !spec.scope ||
          !sameScope(rendererScope, spec.scope),
      )
    ) {
      throw new Error("mission is outside renderer workspace scope");
    }
    if (
      specs.length > 0 &&
      !specs.some((spec) => spec.role === "orchestrator")
    ) {
      throw new Error("mission has no trusted orchestrator pane");
    }
    return specs.map((spec) => ({
      ...spec,
      // Activity summary (zero-LLM harvest): computed on demand with a 30s
      // mtime-invalidated cache; resolution failures degrade to null, never
      // break the reopen path.
      activity: this.#safePaneActivity(owner, rendererScope, spec),
      scope: spec.scope ? { ...spec.scope } : undefined,
      allowedTools:
        spec.allowedTools === null
          ? null
          : spec.allowedTools
            ? [...spec.allowedTools]
            : undefined,
      allowedSkills:
        spec.allowedSkills === null
          ? null
          : spec.allowedSkills
            ? [...spec.allowedSkills]
            : undefined,
    }));
  }

  /**
   * A saved renderer leaf is only a view model. Confirm the exact physical
   * pane id against Main's scoped, current mission revision before the
   * renderer is allowed to request provider resume.
   */
  canRestoreMissionPaneForRenderer(
    owner: WebContents,
    missionId: string,
    paneId: string,
  ): boolean {
    const rendererScope = requireRendererWorkspaceScope(owner);
    const suite = this.#stores.forScope(rendererScope);
    const mission = suite.missions.get(missionId);
    const spec = suite.missionPanes.findByPaneId(paneId);
    if (
      !mission ||
      !spec ||
      spec.missionId !== missionId ||
      spec.paneId !== paneId ||
      !spec.scope ||
      !sameScope(rendererScope, spec.scope) ||
      !hasCurrentDispatchAuthority(mission) ||
      isAutomatedReviewerCompositionPane(spec)
    ) {
      return false;
    }
    const squad = mission.squadId ? this.#resolveSquad(mission.squadId) : null;
    if (!squad) return false;
    const currentSeal = resolveMissionPaneAuthoritySeal(
      rendererScope,
      mission,
      squad,
    );
    return sameMissionPaneAuthoritySeal(spec.authoritySeal, currentSeal);
  }

  /** Activity is best-effort metadata: a resolver bug must not break reopen. */
  #safePaneActivity(
    owner: WebContents,
    scope: ProjectExecutionScope,
    spec: MissionPaneSpec,
  ): PaneActivitySummary | null {
    try {
      return this.#resolvePaneActivity({
        owner,
        scope,
        paneId: spec.paneId,
        adapterId: spec.adapterId,
        cwd: spec.cwd,
        accountId: spec.accountId,
      });
    } catch {
      return null;
    }
  }
}
