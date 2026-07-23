import { createHash } from "node:crypto";
import type { WebContents } from "electron";
import {
  classifyGoalRisk,
  compileIntentContract,
  defaultBudgetsForRisk,
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  isPrepareProjectPlaceholderGoal,
  missionStatusForIntent,
  PREPARE_PROJECT_PLACEHOLDER_GOAL,
  synthesizeImmediateDispatchContract,
  transitionIntentState,
  type MissionAttachmentSnapshot,
  type MissionOrchestratorRuntimeSnapshot,
  type MissionIntentSource,
} from "../../shared/mission-intent";
import {
  missionGoalNeedsFutureEvidence,
  MISSION_EVIDENCE_WAIT_MESSAGE,
} from "../../shared/mission-evidence";
import { PET_STUDIO_SQUAD_ID } from "../../shared/pet-studio";
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
  normalizeMilestones,
  type Mission,
  type MissionOrchestratorBootstrapResult,
  type MissionPaneSpec,
  type MissionPatch,
  type PaneActivitySummary,
  type Squad,
} from "../../shared/orch-types";
import {
  resolveMissionPaneActivity,
  type MissionPaneActivityInput,
} from "./pane-activity-summary";
import type { ProjectExecutionScope } from "../../shared/types";
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
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
  missionOrchestratorRuntimeReviewStrings,
  resolveProductionMissionOrchestratorRuntime,
  sameMissionOrchestratorRuntime,
  type ResolvedMissionOrchestratorRuntime,
} from "./mission-orchestrator-runtime";
import { resolveMissionPaneAuthoritySeal } from "./mission-pane-authority";

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

interface MissionApprovalFenceInput {
  readonly evidenceAttached: boolean;
  readonly attachmentPaths: readonly string[];
  readonly attachmentSnapshots: readonly MissionAttachmentSnapshot[];
  readonly squadRevisionHash: string;
  readonly orchestratorRuntime: MissionOrchestratorRuntimeSnapshot;
}

const MAX_NATIVE_MISSION_REVIEW_CHARS = 6_000;
const INVISIBLE_AUTHORITY_TEXT =
  /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;

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
    (snapshot) => `${snapshot.path}\nSHA-256 ${snapshot.sha256}\n${snapshot.size} bytes`,
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
    throw new Error('attachment snapshot does not match canonical attachment paths');
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
        approval: approval ?? null,
      }),
    )
    .digest("hex");
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
  readonly #resolveSquad: (squadId: string) => Squad | null;
  readonly #resolveOrchestratorRuntime: (
    squad: Squad,
    orchestrator: Squad["agents"][number],
  ) => ResolvedMissionOrchestratorRuntime;

  constructor(
    stores: ProjectDomainStoreRegistry,
    resolveContextRevision = (
      scope: ProjectExecutionScope,
      missionId: string,
    ): string | undefined =>
      getContextWorkflowService(scope).getMissionWorkflow(missionId)
        .contract?.contract.contextRevision,
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
    ) => ResolvedMissionOrchestratorRuntime =
      resolveProductionMissionOrchestratorRuntime,
    snapshotAttachmentPaths: (
      paths: readonly string[] | undefined,
    ) => MissionAttachmentSnapshot[] | undefined = snapshotDroppedAttachmentPaths,
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
  }

  #attachmentsForApproval(
    paths: readonly string[] | undefined,
  ): {
    readonly present: boolean;
    readonly paths: string[];
    readonly snapshots: MissionAttachmentSnapshot[];
  } {
    const canonical = paths === undefined
      ? []
      : this.#validateAttachmentPaths(paths) ?? [];
    const snapshots = paths === undefined
      ? []
      : this.#snapshotAttachmentPaths(canonical) ?? [];
    assertAttachmentSnapshotPaths(canonical, snapshots);
    return {
      present: paths !== undefined,
      paths: [...canonical],
      snapshots: snapshots.map((snapshot) => ({ ...snapshot })),
    };
  }

  #runtimeForSquad(squad: Squad): MissionOrchestratorRuntimeSnapshot {
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
        throw new Error("blocked/failed mission lifecycle is immutable until explicit resume");
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
    if (
      patch.milestones &&
      current.intentContract
    ) {
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
      throw new Error("only blocked/failed demotion can request native confirmation");
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
      throw new Error("intent fields are only mutable via intent authority APIs");
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

  /**
   * Renderer deletion is intentionally limited to an empty, never-dispatched
   * draft. Running/terminal missions and any row with durable activity keep
   * their audit/dispatch/handoff chain forever; the UI can hide/archive them
   * in a future schema, but it cannot cascade-delete those receipts today.
   */
  missionRemovalCandidateFromRenderer(
    owner: WebContents,
    missionId: string,
  ): { missionId: string; title: string } | null {
    const candidate = this.#removableMission(owner, missionId);
    return candidate
      ? { missionId: candidate.mission.id, title: candidate.mission.title }
      : null;
  }

  removeMissionFromRenderer(owner: WebContents, missionId: string): boolean {
    const candidate = this.#removableMission(owner, missionId);
    if (!candidate) return false;
    return candidate.suite.missions.remove(candidate.mission.id);
  }

  #removableMission(
    owner: WebContents,
    missionId: string,
  ): { suite: ProjectDomainStoreSuite; mission: Mission } | null {
    const scope = requireRendererWorkspaceScope(owner);
    const suite = this.#stores.forScope(scope);
    const mission = suite.missions.get(missionId);
    if (!mission) return null;
    const activeIntent =
      mission.intentState === "dispatched" ||
      mission.intentState === "executing" ||
      mission.intentState === "validating" ||
      mission.intentState === "done" ||
      mission.intentState === "blocked_user" ||
      mission.intentState === "blocked_technical";
    if (
      mission.status !== "pending" ||
      activeIntent ||
      mission.orchestratorSessionId !== undefined
    ) {
      throw new Error(
        "missão ativa/terminal é preservada: remoção não pode apagar receipts duráveis",
      );
    }
    const hasDurableActivity =
      suite.missionPanes.list(mission.id).length > 0 ||
      suite.handoffs.list({
        missionId: mission.id,
        includeDelivered: true,
      }).length > 0 ||
      suite.tasks.list(mission.id).length > 0;
    if (hasDurableActivity) {
      throw new Error(
        "missão com atividade durável é preservada: panes, handoffs, tasks e receipts não podem ser apagados",
      );
    }
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
      rawPolicy === "none" || rawPolicy === "minimal" || rawPolicy === "on-demand"
        ? rawPolicy
        : "on-demand";
    const canReplacePlannedMilestones =
      from === "legacy" ||
      from === "draft" ||
      from === "awaiting_goal" ||
      from === "intent_compiling" ||
      from === "ready_to_start" ||
      from === "awaiting_approval";
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
        needsFutureEvidence && !evidenceAttached ? "awaiting_goal" : compiled.to;
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
      reason:
        missionGoalNeedsFutureEvidence(contract.goal, input.evidenceAttached === true)
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
    if (!contract?.goal?.trim() || isPrepareProjectPlaceholderGoal(contract.goal)) {
      throw new Error("intent_required: compile a real goal before approval");
    }
    if (contract.intentVersion !== current.intentVersion) {
      throw new Error("stale_intent: contract intent version does not match the mission");
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
      throw new Error("squad_required: saved squad is unavailable for approval");
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    const orchestratorRuntime = this.#runtimeForSquad(squad);
    assertNativeMissionReviewable([
      current.title,
      contract.goal,
      ...acceptanceCriteria,
      ...deniedTools,
      ...reviewedAttachments,
      ...attachmentSnapshotReviewStrings(reviewedAttachmentSnapshots),
      ...squadAuthorityReviewStrings(squadSnapshot),
      ...missionOrchestratorRuntimeReviewStrings(orchestratorRuntime),
    ]);
    const approvalSnapshot = {
      evidenceAttached,
      attachmentPaths: reviewedAttachments,
      attachmentSnapshots: reviewedAttachmentSnapshots,
      squadRevisionHash: squadSnapshot.hash,
      orchestratorRuntime,
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
        reviewedAttachmentSnapshots.map((snapshot) => Object.freeze({ ...snapshot })),
      ),
      squad: squadSnapshot,
      orchestratorRuntime: Object.freeze({ ...orchestratorRuntime }),
      intentVersion: current.intentVersion ?? contract.intentVersion,
      budgets: Object.freeze({ ...contract.budgets }),
      fence: missionAuthorityFence(current, approvalSnapshot),
    });
  }

  approveIntentFromRenderer(
    owner: WebContents,
    input: RendererMissionApproveIntentInput,
    expectedFence?: string,
  ): Mission {
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
        : input.evidenceAttached === true) ||
      attachmentPaths.length > 0;
    const squad = current.squadId ? this.#resolveSquad(current.squadId) : null;
    if (!squad) {
      throw new Error("squad_required: saved squad is unavailable for approval");
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    const orchestratorRuntime = this.#runtimeForSquad(squad);
    if (
      expectedFence !== undefined &&
      missionAuthorityFence(current, {
        evidenceAttached,
        attachmentPaths,
        attachmentSnapshots: attachments.snapshots,
        squadRevisionHash: squadSnapshot.hash,
        orchestratorRuntime,
      }) !== expectedFence
    ) {
      throw new Error(
        "approval_stale: mission intent, attachments, squad or runtime changed while native confirmation was open",
      );
    }

    const from = current.intentState ?? "ready_to_start";
    let nextState = from;
    if (from === "awaiting_approval") {
      const approved = transitionIntentState({ from, event: "approve" });
      if (!approved.ok) throw new Error(approved.reason);
      nextState = approved.to;
    } else if (from === "awaiting_goal" || from === "draft" || from === "legacy") {
      // Plan step can still surface a compiled contract while the mission shell
      // is human-waiting (e.g. evidence false-positive, soft-restore, or
      // prepare-project). Explicit "Começar" with a real goal should dispatch
      // instead of hard-failing with a cryptic state error.
      const goal = current.intentContract?.goal?.trim() ?? "";
      if (!goal || isPrepareProjectPlaceholderGoal(goal)) {
        throw new Error(
          "intent_required: descreva o objetivo e compile o plano antes de começar",
        );
      }
      if (
        missionGoalNeedsFutureEvidence(
          goal,
          evidenceAttached,
        )
      ) {
        throw new Error(`evidence_required: ${MISSION_EVIDENCE_WAIT_MESSAGE}`);
      }
      // Synthetic compile_ok: contract already exists; advance to ready_to_start.
      nextState = "ready_to_start";
    } else if (from !== "ready_to_start") {
      if (from === "dispatched" || from === "executing") {
        if (!hasCurrentDispatchAuthority(current)) {
          throw new Error("approval_required: current intent is not authorized");
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
        this.#continueMainOwnedBootstrap(scope, current.id);
        return current;
      }
      throw new Error(
        `approval_required: cannot dispatch from intent state ${from}`,
      );
    }
    if (nextState === "ready_to_start") {
      const started = transitionIntentState({
        from: nextState,
        event: "start",
      });
      if (!started.ok) throw new Error(started.reason);
      nextState = started.to;
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
      dispatchedAt: approvedAt,
      acceptanceCriteria: [...current.intentContract.acceptanceCriteria],
      budgets: { ...current.intentContract.budgets },
      deniedTools: current.intentContract.deniedTools
        ? [...current.intentContract.deniedTools]
        : undefined,
      squadRevisionHash: squadSnapshot.hash,
      orchestratorRuntime: { ...orchestratorRuntime },
    };
    const status = missionStatusForIntent(nextState) ?? "running";
    const updated = missions.update(input.missionId, {
      status,
      intentState: nextState,
      intentVersion: contractVersion,
      intentContract: contract,
      milestones: normalizeMilestones(
        current.intentContract.acceptanceCriteria,
      ),
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
    this.#continueMainOwnedBootstrap(scope, updated.id);
    return updated;
  }

  #continueMainOwnedBootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): void {
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
    const scope = requireRendererWorkspaceScope(owner);
    const current = this.#stores.forScope(scope).missions.get(input.missionId);
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
    const squad = current.squadId ? this.#resolveSquad(current.squadId) : null;
    if (!squad) {
      throw new Error("squad_required: saved squad is unavailable for promotion");
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    const orchestratorRuntime = this.#runtimeForSquad(squad);
    assertNativeMissionReviewable([
      contract.goal,
      ...acceptanceCriteria,
      ...deniedTools,
      ...attachmentPaths,
      ...attachmentSnapshotReviewStrings(attachments.snapshots),
      ...squadAuthorityReviewStrings(squadSnapshot),
      ...missionOrchestratorRuntimeReviewStrings(orchestratorRuntime),
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
      intentVersion: current.intentVersion ?? contract.intentVersion,
      budgets: Object.freeze({ ...defaultBudgetsForRisk(risk) }),
      fence: missionAuthorityFence(current, {
        evidenceAttached: contract.evidenceAttached === true,
        attachmentPaths,
        attachmentSnapshots: attachments.snapshots,
        squadRevisionHash: squadSnapshot.hash,
        orchestratorRuntime,
      }),
    });
  }

  promotePlanLaneFromRenderer(
    owner: WebContents,
    input: { missionId: string },
    expectedFence?: string,
  ): Mission {
    const scope = requireRendererWorkspaceScope(owner);
    const missions = this.#stores.forScope(scope).missions;
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
    const squad = current.squadId ? this.#resolveSquad(current.squadId) : null;
    if (!squad) {
      throw new Error("squad_required: saved squad is unavailable for promotion");
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    const orchestratorRuntime = this.#runtimeForSquad(squad);
    const attachments = this.#attachmentsForApproval(contract.attachmentPaths);
    if (
      expectedFence !== undefined &&
      missionAuthorityFence(current, {
        evidenceAttached: contract.evidenceAttached === true,
        attachmentPaths: contract.attachmentPaths ?? [],
        attachmentSnapshots: attachments.snapshots,
        squadRevisionHash: squadSnapshot.hash,
        orchestratorRuntime,
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
      approvedAt: contract.approvedAt ?? now,
      dispatchedAt: now,
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
    };
    // Stay dispatched/executing if already working; otherwise ready_to_start
    // so the operator can press start again with full code authority.
    const intentState =
      current.intentState === "dispatched" ||
      current.intentState === "executing" ||
      current.intentState === "validating"
        ? current.intentState
        : "ready_to_start";
    const status =
      missionStatusForIntent(intentState) ??
      (intentState === "ready_to_start" ? "pending" : current.status);
    const updated = missions.update(input.missionId, {
      intentContract: nextContract,
      intentVersion: nextVersion,
      intentState,
      status,
      milestones: normalizeMilestones(contract.acceptanceCriteria),
    });
    if (!updated) throw new Error("mission not found");
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
        throw new Error(
          "failed to consume the orchestrator promotion grant",
        );
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
            input.squadId === PET_STUDIO_SQUAD_ID
              ? 'pet-studio'
              : 'standard',
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
    const specs = this.#stores
      .forScope(rendererScope)
      .missionPanes.list(missionId);
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
