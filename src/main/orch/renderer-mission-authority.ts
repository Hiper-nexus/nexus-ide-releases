import { createHash } from "node:crypto";
import type { WebContents } from "electron";
import { adoptedMissionWorkspaceBinding, missionExecutionScope } from './mission-execution-scope';
import { operatorHandMissionContract } from './operator-hand-mission';
import { isOperatorTabResumeTransferSource } from './operator-tab-mission-resume';
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  type MissionAttachmentSnapshot,
  type MissionOrchestratorRuntimeSnapshot,
  type PromotedPlanSnapshot,
} from "../../shared/mission-intent";
import { hasAutomaticTechnicalRecovery } from "../../shared/mission-recovery-policy";
import {
  normalizeMilestones,
  type Mission,
  type MissionPaneSpec,
  type MissionPatch,
  type PaneActivitySummary,
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
  adoptUserAgentSessionAsMissionOrchestrator,
  getAgentSessionInfo,
  getOwnedAgentSessionInfo,
  returnAdoptedAgentSessionToUser,
  updateOwnedAgentSessionRole,
  type OwnedAgentSessionInfo,
} from "../pty/pty-manager";
import {
  adoptUserSessionAsMissionOrchestrator,
  demoteMissionOrchestratorSession,
  getContextBySession,
  promoteMissionSessionAuthority,
  restoreSessionAuthority,
  rollbackMissionSessionAuthorities,
  rollbackSessionAuthorityMission,
} from "./gate";
import {
  attachOrchMeta,
  detachOrchMissionMeta,
  findPaneOwnedBy,
  getPaneRuntimeAuthorityBySession,
  getRenderedPaneTabKey,
  spawnMainOwnedMissionPaneAsync,
} from "./pane-registry";
import { makeId } from "./store-util";
import type {
  ProjectDomainStoreRegistry,
  ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { releaseSealedAttachmentSnapshots } from "../persistence/dropped-files";
import { getSquad } from "./squad-store";
import { type SquadAuthoritySnapshot } from "./squad-authority-snapshot";
import {
  resolveMissionPaneAuthoritySeal,
  sameMissionPaneApprovalSeal,
  sameMissionPaneAuthoritySeal,
} from "./mission-pane-authority";
import type { OrchestrationEvidence } from "../../shared/adapter-types";
import {
  getAdapter,
  isAdapterInstalled,
  isBuiltinAdapter,
  orchestrationEvidenceForAdapter,
} from "../adapters/adapter-registry";


export interface RendererMissionAuthorityCandidate {
  readonly missionId: string;
  readonly title: string;
  readonly goal: string;
  readonly lane: "standard" | "consult" | "plan" | "ops";
  readonly risk: "normal" | "sensitive" | "destructive";
  readonly executionMode: "manual" | "assisted" | "autopilot";
  /** Operator Livre / Pack / Guiado — shown in native approval. */
  readonly orchestrationMode?: "livre" | "pack" | "guided";
  readonly wavePackTemplateId?: "landing" | "saas" | "fix";
  /** Canonical Pack story count (structured or markdown preview). */
  readonly wavePackStoryCount?: number;
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
  /**
   * Main-computed: a missão já está viva com autoridade de dispatch vigente
   * para este mesmo runtime, então o approve cai na lane de continuar bootstrap
   * e não concede autoridade nova. O diálogo nativo não repergunta nesse caso
   * (fix do re-prompt infinito, 05/08). Nunca aceito do renderer.
   */
  readonly approvalAlreadyCurrent: boolean;
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

export interface PromoteMissionOrchestratorInput {
  readonly paneId?: string;
  readonly sessionId?: string;
}

export interface PromoteMissionOrchestratorResult {
  readonly ok: boolean;
  readonly mission?: Mission;
  readonly warning?: string;
  readonly error?: string;
  /** A missão da aba nasceu nesta chamada (não foi reusada). */
  readonly created?: true;
}

interface MissionApprovalFenceInput {
  readonly evidenceAttached: boolean;
  readonly attachmentPaths: readonly string[];
  readonly attachmentSnapshots: readonly MissionAttachmentSnapshot[];
  readonly squadRevisionHash: string;
  readonly orchestratorRuntime: MissionOrchestratorRuntimeSnapshot;
  readonly orchestratorEvidence: OrchestrationEvidence;
  readonly promotedPlan?: PromotedPlanSnapshot;
  /** Bound into promote fence so reviewed Pack/Guiado cannot diverge on commit. */
  readonly orchestrationMode?: "livre" | "pack" | "guided";
  readonly wavePackTemplateId?: "landing" | "saas" | "fix";
  readonly wavePackStoryCount?: number;
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
    left.rootRealPath === right.rootRealPath &&
    left.workspaceRootDevice === right.workspaceRootDevice &&
    left.workspaceRootInode === right.workspaceRootInode
  );
}

function ownedPaneSession(
  owner: WebContents,
  paneRef: string,
): { paneId: string; sessionId: string; info: OwnedAgentSessionInfo; scope: ProjectExecutionScope } {
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
  const context = getContextBySession(pane.sessionId);
  if (!sameScope(rendererScope, context?.scope ?? info.scope) ||
      !sameScope(context?.executionScope ?? context?.scope ?? info.scope, info.scope)) {
    throw new Error("agent session is outside renderer workspace scope");
  }
  return { paneId: pane.paneId, sessionId: pane.sessionId, info, scope: rendererScope };
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
    sameScope(context.executionScope ?? context.scope, info.scope) &&
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
    Boolean(spec.scope && sameScope(info.scope, spec.executionScope ?? spec.scope))
  );
}

export class RendererMissionAuthority {
  readonly #stores: ProjectDomainStoreRegistry;
  readonly #resolveContextRevision: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => string | undefined;
  readonly #resolvePaneActivity: (
    input: MissionPaneActivityInput,
  ) => PaneActivitySummary;

  constructor(
    stores: ProjectDomainStoreRegistry,
    resolveContextRevision = (
      scope: ProjectExecutionScope,
      missionId: string,
    ): string | undefined =>
      getContextWorkflowService(scope).getMissionWorkflow(missionId).contract
        ?.contract.contextRevision,
    resolvePaneActivity: (
      input: MissionPaneActivityInput,
    ) => PaneActivitySummary = resolveMissionPaneActivity,
  ) {
    this.#stores = stores;
    this.#resolveContextRevision = resolveContextRevision;
    this.#resolvePaneActivity = resolvePaneActivity;
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
    // Intent authority is exclusive to the canonical MissionEngine.
    // A compromised renderer must not self-promote awaiting_goal → dispatched.
    if (
      patch.intentState !== undefined ||
      patch.intentContract !== undefined ||
      patch.intentVersion !== undefined
    ) {
      throw new Error(
        "intent fields are only mutable via the canonical MissionEngine",
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
        "intent fields are only mutable via the canonical MissionEngine",
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
      // Sessões presas à missão que acabou de sumir: sem isto o pane que a
      // criou continuava `orchestrator` apontando para uma missão inexistente
      // e nunca mais conseguia criar outra (campo 09/09).
      rollbackMissionSessionAuthorities(candidate.mission.id);
      // The removed mission may own the scope's durable merge block. Nothing
      // can acknowledge that block anymore, so lift it now instead of letting
      // every future mission of this scope defer merges into a technical
      // block. Best-effort: the scope-construction sweep also covers it.
      try {
        const scope = candidate.scope;
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
      const sealedSnapshots =
        candidate.mission.intentContract?.attachmentSnapshots?.filter(
          (snapshot) =>
            snapshot.sourcePath !== undefined &&
            snapshot.sealId !== undefined &&
            snapshot.device !== undefined &&
            snapshot.inode !== undefined,
        ) ?? [];
      if (sealedSnapshots.length > 0) {
        try {
          const scope = candidate.scope;
          releaseSealedAttachmentSnapshots(sealedSnapshots, {
            checkoutId: scope.checkoutId,
          });
        } catch (error) {
          console.warn(
            "[mission-authority] sealed attachment cleanup after removal skipped",
            error,
          );
        }
      }
    }
    return result === "removed";
  }

  #removableMission(
    owner: WebContents,
    missionId: string,
  ): {
    scope: ProjectExecutionScope;
    suite: ProjectDomainStoreSuite;
    mission: Mission;
  } | null {
    const scope = requireRendererWorkspaceScope(owner);
    const suite = this.#stores.forScope(scope);
    const mission = suite.missions.get(missionId);
    if (!mission) return null;
    return { scope, suite, mission };
  }



    restorePersistedPaneAuthority(owner: WebContents, paneId: string): boolean {
    let owned: ReturnType<typeof ownedPaneSession>;
    try {
      owned = ownedPaneSession(owner, paneId);
    } catch {
      return false;
    }
    const suite = this.#stores.forScope(owned.scope);
    const paneStore = suite.missionPanes;
    const spec = paneStore.findByPaneId(owned.paneId);
    const mission = spec ? suite.missions.get(spec.missionId) : null;
    if (
      !spec ||
      !mission ||
      !hasCurrentDispatchAuthority(mission) ||
      (mission.intentContract?.workspaceBinding !== undefined && !sameScope(owned.info.scope, missionExecutionScope(owned.scope, mission))) ||
      !matchesPersistedRuntime(owned.info, spec) ||
      !hasMatchingGateContext(owned.sessionId, owned.info, spec.missionId)
    ) {
      return false;
    }
    const contextRevision = this.#resolveContextRevision(
      owned.scope,
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
      scope: owned.scope,
      executionScope: owned.info.scope,
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
    if (!sameScope(owned.info.scope, missionExecutionScope(rendererScope, mission))) return null;
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

  /**
   * Resolve o painel que o operador escolheu para LIDERAR uma missão que ainda
   * vai nascer. Devolve só o que a reserva de adoção precisa saber; a
   * autoridade em si continua sendo concedida por promoteOrchestratorFromRenderer,
   * depois que a missão existir e tiver autoridade de despacho.
   */
  resolveOwnedPaneForAdoption(
    owner: WebContents,
    paneRef: string,
  ): { paneId: string; sessionId: string; adapterId: string } | null {
    let owned: ReturnType<typeof ownedPaneSession>;
    try {
      owned = ownedPaneSession(owner, paneRef);
    } catch {
      return null;
    }
    // Painel que já pertence a outra missão nunca é candidato: adotá-lo
    // arrancaria o Maestro de uma missão viva para dar a outra.
    if (owned.info.missionId) return null;
    if (!owned.info.adapterId) return null;
    return {
      paneId: owned.paneId,
      sessionId: owned.sessionId,
      adapterId: owned.info.adapterId,
    };
  }

  /**
   * Missão LEVE da aba: "Tornar orquestrador" num pane solto cria a missão
   * daquele grupo de panes, como se o operador a tivesse iniciado — Autopilot,
   * Escolha livre de agentes, sem squad e sem revisão (é o próprio operador
   * clicando). O pane vira o orquestrador DELA e só dela: missões e
   * orquestradores de outras abas não são tocados. A aba (worktree isolada,
   * quando houver) vem da proveniência main-owned da sessão, nunca do renderer.
   */
  createPaneMissionFromRenderer(
    owner: WebContents,
    input: {
      readonly paneId: string;
      readonly title: string;
      /** Aba no renderer: só desempata criação/reuso, nunca concede nada. */
      readonly tabKey?: string;
      /**
       * Missão sob demanda: a missão é do GRUPO do pane (ele + helpers dele).
       * Nunca entra na missão viva da aba — isso tomaria a coroa de outro pane
       * implicitamente; a coroa só muda pelo "Tornar orquestrador" explícito.
       */
      readonly ownGroup?: boolean;
    },
  ): PromoteMissionOrchestratorResult {
    let owned: ReturnType<typeof ownedPaneSession>;
    try {
      owned = ownedPaneSession(owner, input.paneId);
    } catch {
      return { ok: false, error: "pane_unavailable" };
    }
    owned = this.#releaseReturnedOperatorHand(owner, owned);
    // Pane que já lidera/serve outra missão não é arrancado dela.
    if (owned.info.missionId) return { ok: false, error: "pane_mission_mismatch" };
    try {
      assertMissionAuthorityTitle(input.title);
    } catch {
      return { ok: false, error: "invalid_payload" };
    }
    let workspaceBinding: ReturnType<typeof adoptedMissionWorkspaceBinding>;
    try {
      workspaceBinding = adoptedMissionWorkspaceBinding(
        owned.scope,
        owned.info.scope,
        owned.paneId,
      );
    } catch {
      return { ok: false, error: "pane_unavailable" };
    }
    const suite = this.#stores.forScope(owned.scope);
    // Uma missão por aba: a segunda promoção (ou o segundo clique antes da
    // primeira resposta) reusa a que já nasceu. Tudo aqui é síncrono no Main,
    // então procurar e criar é atômico. A aba fica gravada no vínculo da
    // missão (não num mapa em memória): sobrevive ao reinício do Main.
    const existing = this.#liveTabMission(suite, owned, workspaceBinding.spaceId, input.tabKey);
    if (existing && !input.ownGroup) {
      return this.promoteOrchestratorFromRenderer(owner, existing.id, {
        paneId: owned.paneId,
      });
    }
    // A 1ª missão da aba segue sendo "a da aba" para o clique explícito.
    const tabKey = input.tabKey && !existing ? input.tabKey : undefined;
    const created = suite.missions.create({
      title: input.title,
      milestones: [],
      orchestratorSessionId: owned.sessionId,
      intentState: "dispatched",
      intentVersion: 1,
      intentContract: {
        ...operatorHandMissionContract(input.title, undefined, []),
        workspaceBinding: tabKey ? { ...workspaceBinding, tabKey } : workspaceBinding,
      },
    });
    suite.missions.update(created.id, { status: "running" });
    let result: PromoteMissionOrchestratorResult;
    try {
      result = this.promoteOrchestratorFromRenderer(owner, created.id, {
        paneId: owned.paneId,
      });
    } catch (error) {
      console.warn("[mission-authority] promoção da missão da aba falhou", error);
      result = { ok: false, error: "promotion_failed" };
    }
    // Sem orquestrador a missão não existe para o operador: nada fica pendurado.
    if (!result.ok) {
      this.#discardPaneMission(suite, created.id, owned.sessionId);
      return result;
    }
    return { ...result, created: true };
  }

  /**
   * O spawn que motivou a missão sob demanda falhou: a missão que nasceu para
   * ele some e o pane volta a ser a mão do operador — desde que ninguém mais
   * tenha entrado nela (worker gravado = a missão já é de verdade).
   */
  discardUnusedTabMission(sessionId: string, missionId: string): boolean {
    const ctx = getContextBySession(sessionId);
    if (!ctx || ctx.missionId !== missionId || !ctx.promotedFromUserSession) return false;
    const suite = this.#stores.forScope(ctx.scope);
    const mission = suite.missions.get(missionId);
    if (!mission || mission.orchestratorSessionId !== sessionId) return false;
    const runtime = getPaneRuntimeAuthorityBySession(sessionId);
    if (suite.missionPanes.list(missionId).some((spec) => spec.paneId !== runtime?.paneId)) {
      return false;
    }
    this.#discardPaneMission(suite, missionId, sessionId);
    if (runtime?.owner) detachOrchMissionMeta(runtime.owner, runtime.paneId, missionId);
    return true;
  }

  /**
   * Missão SOB DEMANDA: o primeiro helper que um pane do "+ Pane" abre cria a
   * missão leve DESTE pane e o adota — o mesmo caminho do "Tornar
   * orquestrador", achando a janela dona pela sessão (autoridade do Main).
   * Outro pane da mesma aba que delega ganha a sua: a aba pode ter várias
   * missões, uma por grupo, e ninguém perde a coroa (nem as entregas).
   */
  adoptOperatorHandForSpawn(
    sessionId: string,
    task: string | null,
  ): PromoteMissionOrchestratorResult {
    const runtime = getPaneRuntimeAuthorityBySession(sessionId);
    if (!runtime?.owner || runtime.kind !== "cli-agent") {
      return { ok: false, error: "pane_unavailable" };
    }
    const summary = (task ?? "")
      .replace(new RegExp(INVISIBLE_AUTHORITY_TEXT.source, "g"), " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60)
      .trim();
    // A aba vem do espelho do renderer: no checkout principal (sem worktree da
    // aba) é ela que marca a 1ª missão como a da aba para o clique explícito.
    const tabKey = getRenderedPaneTabKey(runtime.owner, runtime.paneId);
    return this.createPaneMissionFromRenderer(runtime.owner, {
      paneId: runtime.paneId,
      title: summary ? `Missão · ${summary}` : "Missão da aba",
      ...(tabKey ? { tabKey } : {}),
      ownGroup: true,
    });
  }

  /** Missão viva desta aba: a da worktree dela, ou a que a aba já criou (vínculo persistido). */
  #liveTabMission(
    suite: ProjectDomainStoreSuite,
    owned: ReturnType<typeof ownedPaneSession>,
    spaceId: string | undefined,
    tabKey: string | undefined,
  ): Mission | null {
    const live = (mission: Mission | null | undefined): mission is Mission =>
      Boolean(
        mission &&
          (mission.status === "running" || mission.status === "blocked") &&
          hasCurrentDispatchAuthority(mission) &&
          sameScope(missionExecutionScope(owned.scope, mission), owned.info.scope),
      );
    if (spaceId) {
      const bound = suite.missions
        .list()
        .find(
          (mission) =>
            mission.intentContract?.workspaceBinding?.spaceId === spaceId &&
            live(mission),
        );
      if (bound) return bound;
    }
    if (!tabKey) return null;
    // O checkout (suite) e a raiz (`live` → mesmo escopo) já isolam a aba;
    // a chave do renderer é o que resta para distinguir abas do mesmo checkout.
    return (
      suite.missions
        .list()
        .find(
          (mission) =>
            mission.intentContract?.workspaceBinding?.tabKey === tabKey && live(mission),
        ) ?? null
    );
  }

  /**
   * Ficha PTY, composição da missão e meta do pane acompanham a devolução do
   * gate: sem isto a retomada restauraria o pane como worker da missão.
   */
  #releasePreviousOperatorHand(
    suite: ProjectDomainStoreSuite,
    missionId: string,
    sessionId: string,
  ): void {
    returnAdoptedAgentSessionToUser(sessionId, missionId);
    const runtime = getPaneRuntimeAuthorityBySession(sessionId);
    if (!runtime) return;
    const spec = suite.missionPanes.findByPaneId(runtime.paneId);
    if (spec?.missionId === missionId) suite.missionPanes.remove(spec.id);
    if (runtime.owner) detachOrchMissionMeta(runtime.owner, runtime.paneId, missionId);
  }

  /** Desfaz a missão leve que não ganhou orquestrador (compensação). */
  #discardPaneMission(
    suite: ProjectDomainStoreSuite,
    missionId: string,
    sessionId: string,
  ): void {
    for (const spec of suite.missionPanes.list(missionId)) {
      suite.missionPanes.remove(spec.id);
    }
    suite.missions.remove(missionId);
    rollbackSessionAuthorityMission(sessionId, missionId);
    returnAdoptedAgentSessionToUser(sessionId, missionId);
  }

  /**
   * A missão que adotou este pane acabou e o gate já devolveu a mão do
   * operador (`user` sem missão), mas a ficha PTY ainda aponta a missão
   * morta. Alinha a ficha antes de adotar de novo — sem isto o pane seria
   * recusado como "de outra missão" para sempre.
   */
  #releaseReturnedOperatorHand(
    owner: WebContents,
    owned: ReturnType<typeof ownedPaneSession>,
  ): ReturnType<typeof ownedPaneSession> {
    const ctx = getContextBySession(owned.sessionId);
    if (
      !owned.info.promotedFromUser ||
      !owned.info.missionId ||
      ctx?.role !== "user" ||
      ctx.missionId ||
      !returnAdoptedAgentSessionToUser(owned.sessionId, owned.info.missionId)
    ) {
      return owned;
    }
    const info = getOwnedAgentSessionInfo(owner, owned.sessionId);
    return info ? { ...owned, info } : owned;
  }

  promoteOrchestratorFromRenderer(
    owner: WebContents,
    missionId: string,
    input: PromoteMissionOrchestratorInput,
  ): PromoteMissionOrchestratorResult {
    const paneRef = input.paneId ?? input.sessionId;
    if (!paneRef) return { ok: false, error: "invalid_payload" };
    const rendererScope = requireRendererWorkspaceScope(owner);
    const suite = this.#stores.forScope(rendererScope);
    const mission = suite.missions.get(missionId);
    if (
      !mission ||
      mission.id !== missionId ||
      !hasCurrentDispatchAuthority(mission)
    ) {
      return { ok: false, error: "mission_unavailable" };
    }

    let owned: ReturnType<typeof ownedPaneSession>;
    try {
      owned = ownedPaneSession(owner, paneRef);
    } catch {
      return { ok: false, error: "pane_unavailable" };
    }
    owned = this.#releaseReturnedOperatorHand(owner, owned);
    if (
      !sameScope(missionExecutionScope(rendererScope, mission), owned.info.scope) ||
      (owned.info.missionId && owned.info.missionId !== missionId)
    ) {
      return { ok: false, error: "pane_mission_mismatch" };
    }
    // Quem vai liderar: a mão do operador (`user` sem missão) é ADOTADA pelo
    // mesmo caminho do nexus_mission_create; um pane da missão troca de papel.
    // Conferido ANTES de gravar: gate e ficha PTY precisam aceitar, senão o
    // banco diria orquestrador enquanto o MCP continua `user` sem missão.
    const gateCtx = getContextBySession(owned.sessionId);
    const adopting =
      gateCtx?.role === "user" &&
      !gateCtx.missionId &&
      owned.info.role === "user" &&
      !owned.info.missionId;
    // Criadora via nexus_mission_create de antes desta release: gate já é a
    // orquestradora, só a ficha PTY ficou `user`.
    const alignCreatorPty =
      gateCtx?.missionId === missionId &&
      gateCtx.role === "orchestrator" &&
      gateCtx.promotedFromUserSession === true &&
      owned.info.role === "user" &&
      !owned.info.missionId;
    const switching =
      gateCtx?.missionId === missionId &&
      (gateCtx.role === "worker" || gateCtx.role === "orchestrator") &&
      (owned.info.role !== "user" || alignCreatorPty);
    if (!adopting && !switching) return { ok: false, error: "promotion_failed" };
    // F-996: um pane somente leitura (revisor, auditor) nunca recebe a coroa.
    // A missão de 07/10 foi re-hospedada num revisor Codex readOnly e o pane
    // do operador que a liderava voltou a `user`: o "orquestrador" novo não
    // podia delegar nem escrever. Só o líder que já é desta missão (Maestro
    // delegate-only nascido readOnly) pode ser reconfirmado; qualquer outro
    // pane readOnly é recusado ANTES de qualquer escrita.
    const alreadyLeader =
      gateCtx?.role === "orchestrator" && gateCtx.missionId === missionId;
    if (
      !alreadyLeader &&
      (owned.info.readOnly === true ||
        gateCtx?.readOnly === true ||
        suite.missionPanes.findByPaneId(owned.paneId)?.readOnly === true)
    ) {
      return { ok: false, error: "pane_read_only" };
    }
    let spec = suite.missionPanes.promotePaneToOrchestrator(
      missionId,
      owned.paneId,
    );
    if (!spec) {
      const squad = mission.squadId ? getSquad(mission.squadId) : null;
      const authoritySeal =
        squad || !mission.squadId
          ? resolveMissionPaneAuthoritySeal(rendererScope, mission, squad)
          : null;
      try {
        spec = suite.missionPanes.record({
          missionId,
          paneId: owned.paneId,
          adapterId: owned.info.adapterId,
          role: "orchestrator",
          agentName: owned.info.agentName ?? "Orquestrador",
          model: owned.info.model,
          accountId: owned.info.accountId,
          effort: owned.info.effort,
          cwd: owned.info.cwd,
          executionScope: owned.info.scope,
          // Selo gravado na composição: é ele que a retomada confere.
          ...(authoritySeal ? { authoritySeal } : {}),
        });
      } catch {
        spec = null;
      }
    }
    if (!spec) return { ok: false, error: "pane_mission_mismatch" };

    const rebound = suite.missions.rebindOrchestratorSession(
      missionId,
      owned.sessionId,
    );
    if (!rebound) return { ok: false, error: "mission_unavailable" };

    const contextRevision = this.#resolveContextRevision(
      owned.scope,
      missionId,
    );
    const previousSessionId = mission.orchestratorSessionId ?? null;
    const granted = adopting
      ? adoptUserSessionAsMissionOrchestrator(owned.sessionId, missionId, contextRevision) &&
        adoptUserAgentSessionAsMissionOrchestrator(owned.sessionId, missionId)
      : promoteMissionSessionAuthority({
          missionId,
          promotedSessionId: owned.sessionId,
          previousSessionId,
        }) &&
        (alignCreatorPty
          ? adoptUserAgentSessionAsMissionOrchestrator(owned.sessionId, missionId)
          : updateOwnedAgentSessionRole(owned.sessionId, {
              role: "orchestrator",
              missionId,
              allowedTools: null,
              allowedSkills: null,
              workerIncarnationId: null,
            }));
    if (!granted) {
      // Falha fechada: nenhuma autoridade pela metade.
      if (adopting) {
        rollbackSessionAuthorityMission(owned.sessionId, missionId);
        returnAdoptedAgentSessionToUser(owned.sessionId, missionId);
      }
      return { ok: false, error: "promotion_failed" };
    }
    if (previousSessionId && previousSessionId !== owned.sessionId) {
      if (adopting) demoteMissionOrchestratorSession(missionId, previousSessionId);
      // Troca de coroa não é adoção: a mão do operador que liderava volta a
      // `user` com o que tinha (o gate já devolveu); nunca vira worker estéril.
      const previousCtx = getContextBySession(previousSessionId);
      if (previousCtx?.role === "user" && !previousCtx.missionId) {
        this.#releasePreviousOperatorHand(suite, missionId, previousSessionId);
      } else {
        updateOwnedAgentSessionRole(previousSessionId, {
          role: "worker",
          missionId,
          allowedTools: [],
          allowedSkills: null,
          workerIncarnationId: null,
        });
      }
    }

    attachOrchMeta(owner, owned.paneId, {
      missionId,
      contextRevision,
      agentName: spec.agentName ?? owned.info.agentName,
      role: "orchestrator",
      scope: owned.scope,
      executionScope: owned.info.scope,
      allowedTools: null,
      allowedSkills: null,
      ...(spec.readOnly === true ? { readOnly: true } : {}),
    });

    return {
      ok: true,
      mission: rebound,
      warning: this.#promotionWarning(owned.info.adapterId),
    };
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
    // F-721: a conversa deste líder está sendo levada pelo Main para outro
    // pane. O restore do renderer o deixa parado em vez de subir um segundo
    // Maestro (e sem a conversa) na mesma missão.
    if (isOperatorTabResumeTransferSource(missionId, paneId)) return false;
    // Via Rápida: pane gravado pelo main, escopo conferido acima — sem selo
    // gravado não há o que comparar, e recusar aqui deixava a equipe inteira
    // trabalhando INVISÍVEL ("nenhum pane foi aberto ainda" com 8 CLIs vivas).
    if (!spec.authoritySeal) return true;
    const squad = mission.squadId ? getSquad(mission.squadId) : null;
    if (!squad && mission.squadId) return false;
    const currentSeal = resolveMissionPaneAuthoritySeal(
      rendererScope,
      mission,
      squad,
    );
    if (sameMissionPaneAuthoritySeal(spec.authoritySeal, currentSeal)) {
      return true;
    }
    // Restart / PREVC pode rotacionar só a metade workflow. Aprovação
    // (intent + squad) intacta: reconcilia — não some com a equipe.
    return sameMissionPaneApprovalSeal(spec.authoritySeal, currentSeal);
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

  #promotionWarning(adapterId: string): string | undefined {
    const adapter = getAdapter(adapterId);
    const evidence = adapter
      ? orchestrationEvidenceForAdapter(
          adapter,
          isBuiltinAdapter(adapter.id) ? "builtin" : "user",
        )
      : "unsupported";
    if (evidence === "verified") return undefined;
    return `Provider "${adapterId}" não é orquestrador verificado; promoção livre aplicada por ação explícita do operador.`;
  }

  /**
   * F-231 — "+ Pane" dentro da aba da missão com destino "Nesta missão".
   *
   * O pane nasce pelo MESMO caminho Main-owned dos workers do Maestro
   * (`spawnMainOwnedMissionPaneAsync` resolve e revalida o selo de
   * autoridade — sem invocação MCP, porque a autoridade aqui é a ação do
   * operador vinda do renderer do próprio workspace). A diferença é a marca
   * `operatorOpened`: participa do Quadro/`nexus_pane_list`/ledger como
   * worker, mas mortalidade, TTL pós-handoff e teardown nunca o fecham —
   * no fim da missão a ficha volta a `user` (ver mission-runtime-termination).
   *
   * Escolhas do renderer NUNCA viram autoridade: escopo, missão, status,
   * adapter instalado, `cli-pty` e roster selado são conferidos aqui no
   * Main, e adapter/modelo são explícitos (nenhum roteador é consultado).
   */
  async spawnOperatorPaneFromRenderer(
    owner: WebContents,
    input: {
      readonly missionId: string;
      readonly adapterId: string;
      readonly model?: string;
      readonly prompt?: string;
      readonly tabKey?: string;
    },
  ): Promise<
    | { ok: true; paneId: string; sessionId: string }
    | { ok: false; error: string }
  > {
    const rendererScope = requireRendererWorkspaceScope(owner);
    const suite = this.#stores.forScope(rendererScope);
    const mission = suite.missions.get(input.missionId);
    if (!mission) return { ok: false, error: "mission_unavailable" };
    if (mission.status !== "running" && mission.status !== "pending") {
      return { ok: false, error: "mission_not_running" };
    }
    const adapter = getAdapter(input.adapterId);
    if (!adapter) return { ok: false, error: "adapter_not_installed" };
    if (adapter.kind === "api-provider") {
      return { ok: false, error: "adapter_not_spawnable" };
    }
    if (!isAdapterInstalled(adapter.id)) {
      return { ok: false, error: "adapter_not_installed" };
    }
    // Roster selado (squad aprovado): adapter fora da composição é recusado
    // com erro legível — o picker mostra a recusa em vez de abrir e morrer.
    const squad = mission.squadId ? getSquad(mission.squadId) : null;
    if (mission.squadId) {
      if (!squad) return { ok: false, error: "roster_rejected" };
      const inRoster = squad.agents.some((agent) => agent.cli === adapter.id);
      if (!inRoster) return { ok: false, error: "roster_rejected" };
    }
    const executionScope = missionExecutionScope(rendererScope, mission);
    const authoritySeal = resolveMissionPaneAuthoritySeal(
      rendererScope,
      mission,
      squad,
    );
    if (!authoritySeal) {
      return { ok: false, error: "mission_authority_stale" };
    }
    const title = `${adapter.label} · operador`;
    // A encarnação nasce no spawn e vai à mesma linha durável — sem ela o
    // fechamento mecânico nem os receptáculos de handoff reconhecem o worker.
    const workerIncarnationId = makeId("workerinc");
    const spawned = await spawnMainOwnedMissionPaneAsync({
      adapterId: adapter.id,
      ...(input.model ? { model: input.model } : {}),
      scope: rendererScope,
      executionScope,
      cwd: executionScope.rootRealPath,
      missionId: mission.id,
      role: "worker",
      operatorOpened: true,
      title,
      agentName: title,
      authoritySeal,
      workerIncarnationId,
      ...(input.prompt ? { initialPrompt: input.prompt } : {}),
    });
    if (!spawned.ok || !spawned.paneId || !spawned.sessionId) {
      return {
        ok: false,
        error: spawned.error ?? "pane spawn failed",
      };
    }
    // F-1002: a linha durável leva a seleção FÍSICA do Main — a conta e o
    // esforço selados no PTY, como recordSpawnedMissionPane faz para os
    // workers do Maestro. Sem a conta, a apresentação do pane (que lê o PTY)
    // pedia a adoção com `accountId` e a cerca do spawn persistido recusava
    // em 1 ms, para sempre (07/10: "Claude · operador", 53 recusas).
    const physical = getAgentSessionInfo(spawned.sessionId);
    const sealedRuntime =
      physical?.paneId === spawned.paneId &&
      physical.missionId === mission.id &&
      physical.adapterId === adapter.id
        ? physical
        : null;
    try {
      suite.missionPanes.record({
        missionId: mission.id,
        paneId: spawned.paneId,
        adapterId: adapter.id,
        role: "worker",
        model: input.model,
        accountId: sealedRuntime?.accountId,
        effort: sealedRuntime?.effort,
        cwd: executionScope.rootRealPath,
        title,
        agentName: title,
        workerIncarnationId,
        executionScope,
        authoritySeal,
        operatorOpened: true,
      });
    } catch (error) {
      // O pane físico já nasceu e é do operador — a linha durável é histórico
      // da composição; falhar aqui não mata o pane, mas reporta legível.
      return {
        ok: false,
        error:
          error instanceof Error
            ? `mission_pane_record_failed: ${error.message}`
            : "mission_pane_record_failed",
      };
    }
    return {
      ok: true,
      paneId: spawned.paneId,
      sessionId: spawned.sessionId,
    };
  }
}
