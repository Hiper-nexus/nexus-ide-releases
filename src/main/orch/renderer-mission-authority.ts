import type { WebContents } from "electron";
import {
  classifyGoalRisk,
  compileIntentContract,
  missionStatusForIntent,
  transitionIntentState,
  type MissionIntentSource,
} from "../../shared/mission-intent";
import {
  normalizeMilestones,
  type Mission,
  type MissionPaneSpec,
  type MissionPatch,
} from "../../shared/orch-types";
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
  contextPolicy?: "none" | "minimal" | "on-demand" | "prepare-project";
  acceptanceCriteria?: string[];
}

export interface RendererMissionApproveIntentInput {
  missionId: string;
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

  constructor(
    stores: ProjectDomainStoreRegistry,
    resolveContextRevision = (
      scope: ProjectExecutionScope,
      missionId: string,
    ): string | undefined =>
      getContextWorkflowService(scope).getMissionWorkflow(missionId)
        .contract?.contract.contextRevision,
  ) {
    this.#stores = stores;
    this.#resolveContextRevision = resolveContextRevision;
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
    const contract = compileIntentContract({
      goal: input.goal,
      source: input.source ?? "typed",
      intentVersion: nextVersion,
      contextPolicy: input.contextPolicy ?? "on-demand",
      acceptanceCriteria: input.acceptanceCriteria,
    });
    const risk = classifyGoalRisk(contract.goal);
    const compileEvent =
      risk === "normal" ? ("compile_ok" as const) : ("needs_approval" as const);
    const compiled = transitionIntentState({
      from: "intent_compiling",
      event: compileEvent,
    });
    if (!compiled.ok) throw new Error(compiled.reason);

    const intentState = compiled.to;
    const status = missionStatusForIntent(intentState) ?? current.status;
    const updated = missions.update(input.missionId, {
      description: contract.goal,
      status,
      intentState,
      intentContract: contract,
      intentVersion: nextVersion,
    });
    if (!updated) throw new Error("mission not found");

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
      intentState,
      intentVersion: nextVersion,
      reason: risk,
    });
    return updated;
  }

  /**
   * Explicit UX action "Preparar projeto". Stays in awaiting_goal but marks
   * contextPolicy=prepare-project so bounded bootstrap tools are allowed.
   * Does not dispatch workers or mark the mission running.
   */
  prepareProjectFromRenderer(
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
    const from = current.intentState ?? "awaiting_goal";
    if (
      from !== "awaiting_goal" &&
      from !== "draft" &&
      from !== "legacy" &&
      from !== "intent_compiling" &&
      from !== "ready_to_start"
    ) {
      // Already past goal capture — prepare is a no-op for authorization.
      return current;
    }

    const nextVersion = (current.intentVersion ?? 0) + 1;
    const existingGoal = current.intentContract?.goal?.trim() || current.description.trim();
    const contract = compileIntentContract({
      goal: existingGoal || "Preparar contexto do projeto",
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
    return updated;
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

    const from = current.intentState ?? "ready_to_start";
    let nextState = from;
    if (from === "awaiting_approval") {
      const approved = transitionIntentState({ from, event: "approve" });
      if (!approved.ok) throw new Error(approved.reason);
      nextState = approved.to;
    } else if (from === "ready_to_start") {
      const started = transitionIntentState({ from, event: "start" });
      if (!started.ok) throw new Error(started.reason);
      nextState = started.to;
    } else if (from === "dispatched" || from === "executing") {
      return current;
    } else {
      throw new Error(
        `approval_required: cannot dispatch from intent state ${from}`,
      );
    }

    if (!current.intentContract?.goal) {
      throw new Error("intent_required: compile a goal before dispatch");
    }

    const approvedAt = Date.now();
    const contract = {
      ...current.intentContract,
      approvedAt,
      acceptanceCriteria: [...current.intentContract.acceptanceCriteria],
      budgets: { ...current.intentContract.budgets },
    };
    const status = missionStatusForIntent(nextState) ?? "running";
    const updated = missions.update(input.missionId, {
      status,
      intentState: nextState,
      intentContract: contract,
    });
    if (!updated) throw new Error("mission not found");

    emitMissionIntentEvent({
      name: "plan_approved",
      missionId: updated.id,
      squadId: updated.squadId,
      intentState: nextState,
      intentVersion: updated.intentVersion,
      reason: "user_start",
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
    if (
      existing.intentState &&
      existing.intentState !== "legacy" &&
      existing.intentState !== "dispatched" &&
      existing.intentState !== "executing" &&
      existing.intentState !== "ready_to_start" &&
      existing.intentState !== "awaiting_approval"
    ) {
      throw new Error(
        `dispatch_required: cannot bind orchestrator in state ${existing.intentState}`,
      );
    }

    let gateBound = false;
    let sessionBound = false;
    try {
      paneStore.record({
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
      const updated =
        missionStore.setOrchestratorSession(existing.id, owned.sessionId) ??
        existing;
      if (updated.status !== "running") {
        missionStore.setStatus(existing.id, "running");
      }
      if (
        updated.intentState === "ready_to_start" ||
        updated.intentState === "awaiting_approval"
      ) {
        missionStore.update(existing.id, { intentState: "dispatched" });
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
      if (sessionBound) {
        rollbackOwnedAgentSessionMission(owner, owned.sessionId, existing.id);
      }
      if (gateBound) {
        rollbackSessionAuthorityMission(owned.sessionId, existing.id);
      }
      throw error;
    }
  }

  createMissionFromRenderer(
    owner: WebContents,
    input: RendererMissionCreateInput,
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
    let mission: Mission | null = null;
    let gateBound = false;
    let sessionBound = false;
    try {
      mission = missionStore.create({
        title: input.title,
        squadId: granted.squadId,
        orchestratorSessionId: owned.sessionId,
        // Legacy zero-click path still creates an immediate execution shell.
        intentState: "dispatched",
        intentVersion: 0,
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
    const paneStore = this.#stores.forScope(owned.info.scope).missionPanes;
    const spec = paneStore.findByPaneId(owned.paneId);
    if (
      !spec ||
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
    if (!mission || mission.id !== missionId) return null;

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
}
