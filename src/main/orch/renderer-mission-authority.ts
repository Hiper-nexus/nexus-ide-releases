import { createHash } from "node:crypto";
import type { WebContents } from "electron";
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
  getOwnedAgentSessionInfo,
  updateOwnedAgentSessionRole,
  type OwnedAgentSessionInfo,
} from "../pty/pty-manager";
import {
  getContextBySession,
  promoteMissionSessionAuthority,
  restoreSessionAuthority,
} from "./gate";
import { attachOrchMeta, findPaneOwnedBy } from "./pane-registry";
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
    if (
      !sameScope(rendererScope, owned.info.scope) ||
      (owned.info.missionId && owned.info.missionId !== missionId)
    ) {
      return { ok: false, error: "pane_mission_mismatch" };
    }
    let spec = suite.missionPanes.promotePaneToOrchestrator(
      missionId,
      owned.paneId,
    );
    if (!spec) {
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

    const previousSessionId = mission.orchestratorSessionId ?? null;
    promoteMissionSessionAuthority({
      missionId,
      promotedSessionId: owned.sessionId,
      previousSessionId,
    });
    updateOwnedAgentSessionRole(owned.sessionId, {
      role: "orchestrator",
      missionId,
      allowedTools: null,
      allowedSkills: null,
      workerIncarnationId: null,
    });
    if (previousSessionId && previousSessionId !== owned.sessionId) {
      updateOwnedAgentSessionRole(previousSessionId, {
        role: "worker",
        missionId,
        allowedTools: [],
        allowedSkills: null,
        workerIncarnationId: null,
      });
    }

    const contextRevision = this.#resolveContextRevision(
      owned.info.scope,
      missionId,
    );
    attachOrchMeta(owner, owned.paneId, {
      missionId,
      contextRevision,
      agentName: spec.agentName ?? owned.info.agentName,
      role: "orchestrator",
      scope: owned.info.scope,
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
    // Via Rápida: pane gravado pelo main, escopo conferido acima — sem selo
    // gravado não há o que comparar, e recusar aqui deixava a equipe inteira
    // trabalhando INVISÍVEL ("nenhum pane foi aberto ainda" com 8 CLIs vivas).
    if (!spec.authoritySeal) return true;
    const squad = mission.squadId ? getSquad(mission.squadId) : null;
    if (!squad) return false;
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
}
