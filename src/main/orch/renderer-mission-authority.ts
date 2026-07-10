import type { WebContents } from "electron";
import type {
  Mission,
  MissionPaneSpec,
  MissionPatch,
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
    const scope = requireRendererWorkspaceScope(owner);
    return this.#stores.forScope(scope).missions.update(missionId, patch);
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
