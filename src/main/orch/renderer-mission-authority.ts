import type { WebContents } from "electron";
import {
  classifyGoalRisk,
  compileIntentContract,
  defaultBudgetsForRisk,
  hasCurrentDispatchAuthority,
  isPrepareProjectPlaceholderGoal,
  missionStatusForIntent,
  PREPARE_PROJECT_PLACEHOLDER_GOAL,
  synthesizeImmediateDispatchContract,
  transitionIntentState,
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
  type MissionPaneSpec,
  type MissionPatch,
  type PaneActivitySummary,
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
  rollbackOwnedAgentSessionMission,
  type OwnedAgentSessionInfo,
} from "../pty/pty-manager";
import {
  getContextBySession,
  restoreSessionAuthority,
  rollbackSessionAuthorityMission,
} from "./gate";
import { attachOrchMeta, findPaneOwnedBy } from "./pane-registry";
import type { ProjectDomainStoreRegistry } from "./project-domain-store-registry";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { emitMissionIntentEvent } from "./mission-intent-events";
import { getOrchSettings } from "../persistence/settings-store";
import { tryGetProjectOrientationService } from "../context/orientation/orientation-service";

export interface RendererMissionCreateInput {
  title: string;
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
   * default / omitted = standard PREVC code.
   */
  lane?: "standard" | "consult" | "plan";
  /** Set by the renderer only when current print/audio files are attached. */
  evidenceAttached?: boolean;
}

export interface RendererMissionApproveIntentInput {
  missionId: string;
  /** Rechecked at the final pre-pane dispatch boundary. */
  evidenceAttached?: boolean;
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
  ) {
    this.#stores = stores;
    this.#resolveContextRevision = resolveContextRevision;
    this.#allowImmediateDispatch = allowImmediateDispatch;
    this.#resolvePaneActivity = resolvePaneActivity;
  }

  updateMissionFromRenderer(
    owner: WebContents,
    missionId: string,
    patch: MissionPatch,
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
      patch.milestones &&
      current.milestones.some((milestone) => milestone.status === "done")
    ) {
      throw new Error("completed mission milestones are immutable");
    }
    return missions.update(missionId, patch);
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
    bumpMissionPromptIntent(current.id, nextVersion);
    const queued = enqueueMissionPrompt({
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
    const started = startMissionPrompt(current.id, prompt.id);
    if (started.state.executingId !== prompt.id) {
      cancelMissionPrompt(current.id, prompt.id);
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
      completeMissionPrompt(current.id, prompt.id, true);
    } catch (error) {
      completeMissionPrompt(current.id, prompt.id, false);
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
    const started = startMissionPrompt(updated.id, item.id);
    const isExecuting = started.state.items.some(
      (entry) => entry.id === item.id && entry.status === "executing",
    );
    if (!isExecuting) {
      cancelMissionPrompt(updated.id, item.id);
      throw new Error("project preparation queue is busy");
    }

    const signal = getMissionPromptAbortSignal(updated.id, item.id);
    const orientation = tryGetProjectOrientationService();
    if (!orientation) {
      completeMissionPrompt(updated.id, item.id, false);
      throw new Error("project preparation is unavailable");
    }
    try {
      await orientation.ensure(scope, {
        reason: "pre-kickoff",
        force: true,
        signal,
      });
      if (signal?.aborted) throw new Error("intent_preempted");
      completeMissionPrompt(updated.id, item.id, true);
    } catch (error) {
      completeMissionPrompt(updated.id, item.id, false);
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
    const queue = peekMissionPromptQueue(input.missionId);
    const preparation = [queue.executing, ...queue.queued].find(
      (item) =>
        item?.kind === "preflight" && item.body.startsWith("prepare-project:"),
    );
    if (!preparation) return { cancelled: false };
    const result = cancelMissionPrompt(input.missionId, preparation.id);
    return { cancelled: result.cancelledIds.includes(preparation.id) };
  }

  getPromptQueueFromRenderer(owner: WebContents, input: { missionId: string }) {
    const scope = requireRendererWorkspaceScope(owner);
    const mission = this.#stores.forScope(scope).missions.get(input.missionId);
    if (!mission) throw new Error("mission not found");
    return peekMissionPromptQueue(input.missionId);
  }

  approveIntentFromRenderer(
    owner: WebContents,
    input: RendererMissionApproveIntentInput,
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
          input.evidenceAttached === true ||
            current.intentContract?.evidenceAttached === true,
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
        input.evidenceAttached === true,
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
      evidenceAttached: input.evidenceAttached === true,
      intentVersion: contractVersion,
      approvedAt,
      dispatchedAt: approvedAt,
      acceptanceCriteria: [...current.intentContract.acceptanceCriteria],
      budgets: { ...current.intentContract.budgets },
      deniedTools: current.intentContract.deniedTools
        ? [...current.intentContract.deniedTools]
        : undefined,
    };
    const status = missionStatusForIntent(nextState) ?? "running";
    const updated = missions.update(input.missionId, {
      status,
      intentState: nextState,
      intentVersion: contractVersion,
      intentContract: contract,
    });
    if (!updated) throw new Error("mission not found");

    // Preempt any stale preflight/bootstrap queued for a prior intentVersion.
    // The goal itself was synchronously delivered by submitIntentFromRenderer;
    // approval must not enqueue a duplicate prompt.
    bumpMissionPromptIntent(updated.id, contractVersion);

    emitMissionIntentEvent({
      name: "plan_approved",
      missionId: updated.id,
      squadId: updated.squadId,
      intentState: nextState,
      intentVersion: contractVersion,
      reason: "user_start",
    });
    return updated;
  }

  /**
   * Operator action after plan-mode design: upgrade lane plan → standard so
   * worktrees/shell/code tools are allowed under the same authorized mission.
   * Keeps goal/acceptance; re-expands budgets for risk; re-stamps dispatch.
   */
  promotePlanLaneFromRenderer(
    owner: WebContents,
    input: { missionId: string },
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
    });
    if (!updated) throw new Error("mission not found");
    bumpMissionPromptIntent(updated.id, nextVersion);
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
      const legacyContract = synthesizeImmediateDispatchContract({
        title: input.title,
        intentVersion: 1,
        now,
      });
      mission = missionStore.create({
        title: input.title,
        squadId: granted.squadId,
        orchestratorSessionId: owned.sessionId,
        description: legacyContract.goal,
        intentState: "dispatched",
        intentVersion: 1,
        intentContract: legacyContract,
      });
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
        allowedTools: spec.allowedTools,
        allowedSkills: spec.allowedSkills,
      })
    ) {
      return false;
    }
    attachOrchMeta(owner, owned.paneId, {
      missionId: spec.missionId,
      contextRevision,
      agentName: spec.agentName,
      role: spec.role,
      scope: owned.info.scope,
      allowedTools: spec.allowedTools,
      allowedSkills: spec.allowedSkills,
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
      return mission;
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
    return missionStore.setOrchestratorSession(missionId, sessionId);
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
