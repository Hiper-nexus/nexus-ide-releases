import type { WebContents } from "electron";
import { z } from "zod";
import { GUIDED_PLAN_BLOCK_MARKER } from "../../shared/guided-mission-plan";
import { buildIntentDispatchKickoffPrompt } from "../../shared/mission-dispatch-kickoff";
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  missionBlockPatch,
  type MissionAttachmentSnapshot,
  type MissionOrchestratorRuntimeSnapshot,
} from "../../shared/mission-intent";
import type {
  Mission,
  MissionOrchestratorBootstrapResult,
  MissionOrchestratorPane,
  MissionPaneSpec,
  MissionPatch,
  PaneSnapshot,
  Squad,
  SquadAgent,
} from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import {
  snapshotDroppedAttachmentPaths,
  validateDroppedAttachmentPaths,
} from "../persistence/dropped-files";
import {
  getAgentSessionInfo,
  getSessionState,
  type OwnedAgentSessionInfo,
} from "../pty/pty-manager";
import { releaseSession } from "./gate";
import type {
  RebindOrchestratorAuthorityInput,
  RecordMissionPaneInput,
} from "./mission-pane-store";
import {
  hasPendingMissionKickoffFlight,
  submitMissionKickoffFromMain,
  type MissionKickoffResult,
} from "./mission-kickoff";
import { emitMissionIntentEvent } from "./mission-intent-events";
import {
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  requestMissionPaneClose,
  requestPaneClose,
  spawnMainOwnedMissionPane,
  type MissionPaneCloseRequest,
  type PaneRuntimeAuthority,
  type PaneSpawnOptions,
} from "./pane-registry";
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
} from "./project-domain-store-registry";
import { getSquad } from "./squad-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import {
  canonicalMissionOrchestratorRuntime,
  resolveProductionMissionOrchestratorRuntime,
  sameMissionOrchestratorRuntime,
  type ResolvedMissionOrchestratorRuntime,
} from "./mission-orchestrator-runtime";
import {
  ensureGuidedMissionPlanForScope,
  type GuidedMissionPlanResult,
} from "./guided-mission-planner";
import {
  ensureGuidedMissionPrevcForScope,
  type GuidedMissionPrevcResult,
} from "./guided-mission-prevc";
import { assertPromotedPlanSnapshot } from "./plan-promotion-authority";
import { ensurePlanLaneGitBaseline } from "../runtime/guided-greenfield-baseline";
import { commitPromotedPlanToGit } from "./promoted-plan-git-authority";
import type {
  TaskDispatchRecord,
  TaskDispatchState,
} from "./task-dispatch-store";

export {
  preferredMissionOrchestratorAdapterId,
  type ResolvedMissionOrchestratorRuntime,
} from "./mission-orchestrator-runtime";
import {
  resolveMissionPaneAuthoritySeal,
  sameMissionPaneApprovalSeal,
  sameMissionPaneAuthoritySeal,
} from "./mission-pane-authority";

const BOOTSTRAP_BLOCK_MARKER = "<!-- nexus:orchestrator-bootstrap-blocked -->";
const BOOTSTRAP_TERMINATION_PENDING_MARKER =
  "<!-- nexus:orchestrator-termination-pending -->";
const PLAN_PROMOTION_BLOCK_MARKER =
  "<!-- nexus:plan-promotion-restart-blocked -->";
const PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER =
  "<!-- nexus:plan-promotion-teardown-blocked -->";
const BOOTSTRAP_CTA = "Retomar missão";

function bootstrapFlightKey(
  scope: Readonly<ProjectExecutionScope>,
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

function bootstrapMissionSnapshot(mission: Mission): string {
  return JSON.stringify({
    id: mission.id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    squadId: mission.squadId ?? null,
    orchestratorSessionId: mission.orchestratorSessionId ?? null,
    intentState: mission.intentState ?? null,
    intentVersion: mission.intentVersion ?? 0,
    intentContract: mission.intentContract ?? null,
  });
}

function bootstrapMissionApprovalSnapshot(mission: Mission): string {
  return JSON.stringify({
    id: mission.id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    squadId: mission.squadId ?? null,
    intentState: mission.intentState ?? null,
    intentVersion: mission.intentVersion ?? 0,
    intentContract: mission.intentContract ?? null,
  });
}

function sameAttachmentSnapshots(
  expected: readonly MissionAttachmentSnapshot[] | undefined,
  actual: readonly MissionAttachmentSnapshot[] | undefined,
): boolean {
  const left = expected ?? [];
  const right = actual ?? [];
  return (
    left.length === right.length &&
    left.every((snapshot, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        snapshot.path === candidate.path &&
        snapshot.sha256 === candidate.sha256 &&
        snapshot.size === candidate.size
      );
    })
  );
}

export const missionOrchestratorBootstrapRequestSchema = z
  .object({
    missionId: z.string().min(1).max(128),
  })
  .strict();

export interface MissionOrchestratorBootstrapDeps {
  getMission(scope: ProjectExecutionScope, missionId: string): Mission | null;
  updateMission(
    scope: ProjectExecutionScope,
    missionId: string,
    patch: MissionPatch,
  ): Mission | null;
  setOrchestratorSession(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string | null,
  ): Mission | null;
  hasCurrentKickoffAcceptance(
    scope: ProjectExecutionScope,
    missionId: string,
  ): boolean;
  /** Aceite de kickoff em voo — recibo a caminho, não ausência de recibo. */
  hasPendingKickoffFlight(missionId: string): boolean;
  listMissionPanes(
    scope: ProjectExecutionScope,
    missionId: string,
  ): MissionPaneSpec[];
  recordMissionPane(
    scope: ProjectExecutionScope,
    input: RecordMissionPaneInput,
  ): MissionPaneSpec;
  rebindMissionPaneAuthority?(
    scope: ProjectExecutionScope,
    input: RebindOrchestratorAuthorityInput,
  ): MissionPaneSpec;
  removeMissionPane(scope: ProjectExecutionScope, paneRowId: string): boolean;
  getSquad(squadId: string): Squad | null;
  resolveRuntime(
    squad: Squad,
    orchestrator: SquadAgent,
  ): ResolvedMissionOrchestratorRuntime;
  spawnMainOwnedPane(
    input: PaneSpawnOptions & {
      missionId: string;
      role: "orchestrator";
    },
  ): ReturnType<typeof spawnMainOwnedMissionPane>;
  closePane(paneId: string): boolean | Promise<boolean>;
  getSessionState: typeof getSessionState;
  getAgentSessionInfo(sessionId: string): OwnedAgentSessionInfo | null;
  getRuntimeAuthority(sessionId: string): PaneRuntimeAuthority | null;
  submitKickoff(
    scope: Readonly<ProjectExecutionScope>,
    input: { missionId: string; sessionId: string; prompt: string },
  ): Promise<MissionKickoffResult>;
  emitDispatched(mission: Mission): void;
  validateAttachmentPaths(
    paths: readonly string[] | undefined,
  ): string[] | undefined;
  snapshotAttachmentPaths(
    paths: readonly string[] | undefined,
  ): MissionAttachmentSnapshot[] | undefined;
  /** Main-owned planning preflight; runs before every external bootstrap effect. */
  ensureMissionPlan?(scope: ProjectExecutionScope, missionId: string): unknown;
  /** Proves the Git baseline/source for plan and promoted-plan journeys. */
  ensurePlanGitBaseline?(
    scope: ProjectExecutionScope,
    missionId: string,
  ): unknown;
  /** Main-owned guided PREVC freeze; runs before every provider effect. */
  ensureMissionPrevc?(
    scope: ProjectExecutionScope,
    missionId: string,
  ): GuidedMissionPrevcResult | Promise<GuidedMissionPrevcResult>;
}

export interface MissionOrchestratorBootstrapRecoveryDeps {
  listScopes(): readonly ProjectExecutionScope[];
  listBootstrapCandidates(scope: ProjectExecutionScope): readonly Mission[];
  bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult>;
  warn?(message: string, error: unknown): void;
}

export const MISSION_ORCHESTRATOR_BOOTSTRAP_RECONCILE_MS = 5_000;

export function needsMissionOrchestratorBootstrapRecovery(
  mission: Pick<Mission, "orchestratorSessionId">,
  panes: readonly Pick<MissionPaneSpec, "role">[],
  hasCurrentKickoffAcceptance: boolean,
): boolean {
  const hasPersistedOrchestrator = panes.some(
    (pane) => pane.role === "orchestrator",
  );
  return (
    !mission.orchestratorSessionId ||
    !hasPersistedOrchestrator ||
    !hasCurrentKickoffAcceptance
  );
}

function sameScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
}

function chooseOrchestrator(squad: Squad): SquadAgent | null {
  return (
    squad.agents.find((agent) => agent.category === "orchestrator") ?? null
  );
}

/** Bounded printable value for mismatch diagnostics (ids/models/paths only). */
function mismatchValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.slice(0, 96) || "''";
  return String(value);
}

/**
 * Every failing check of the exact-authority seal, by name and with both
 * sides' values. The seal compares ~20 fields across four sources (live agent
 * session, persisted pane row, approved runtime snapshot, runtime authority);
 * a boolean-only verdict made real field drifts (model alias, null-vs-undefined
 * accountId/effort, confinement flags) undiagnosable in the field — the
 * operator only ever saw "did not retain exact mission authority" with no
 * cause. Never weakens the check: callers still fail on any entry.
 */
export function runtimeAuthorityMismatches(
  scope: ProjectExecutionScope,
  mission: Mission,
  pane: MissionPaneSpec,
  agent: OwnedAgentSessionInfo | null,
  authority: PaneRuntimeAuthority | null,
  approvedRuntime: MissionOrchestratorRuntimeSnapshot,
): string[] {
  if (!mission.orchestratorSessionId)
    return ["mission.orchestratorSessionId ausente"];
  if (!agent) return ["agent session info ausente"];
  if (!authority) return ["runtime authority ausente"];
  // Canonical authority, not representation: "unspecified" arrives as
  // undefined from the durable pane row but as null from the PTY session
  // (pty-manager coalesces undefined→null). Both grant the same thing, so the
  // seal must not fail on the spelling — architect-designed squads omit the
  // field entirely and hit exactly this (field: agent.allowedSkills×pane).
  // An explicit [] stays distinct: it blocks everything.
  const sameCapabilities = (
    rawLeft: readonly string[] | null | undefined,
    rawRight: readonly string[] | null | undefined,
  ) => {
    const left = rawLeft ?? null;
    const right = rawRight ?? null;
    return (
      left === right ||
      (Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => value === right[index]))
    );
  };
  const mismatches: string[] = [];
  const check = (name: string, left: unknown, right: unknown) => {
    if (left !== right) {
      mismatches.push(
        `${name}[${mismatchValue(left)} != ${mismatchValue(right)}]`,
      );
    }
  };
  check(
    "agent.sessionId×mission",
    agent.sessionId,
    mission.orchestratorSessionId,
  );
  check("agent.paneId×pane", agent.paneId, pane.paneId);
  check("agent.adapterId×pane", agent.adapterId, pane.adapterId);
  // Compare the REQUESTED model (0.19.27 fix): providers normalize the
  // model alias in agent.model; the seal validates what was requested and
  // approved, never the provider's normalized spelling.
  check("agent.requestedModel×pane", agent.requestedModel, pane.model);
  check("agent.accountId×pane", agent.accountId, pane.accountId);
  check("agent.effort×pane", agent.effort, pane.effort);
  check("agent.cwd×pane", agent.cwd, pane.cwd);
  check("agent.missionId", agent.missionId, mission.id);
  check("agent.role", agent.role, "orchestrator");
  check("agent.readOnly×pane", agent.readOnly, pane.readOnly === true);
  check("pane.adapterId×runtime", pane.adapterId, approvedRuntime.adapterId);
  check("pane.model×runtime", pane.model, approvedRuntime.model);
  check("pane.accountId×runtime", pane.accountId, approvedRuntime.accountId);
  check("pane.effort×runtime", pane.effort, approvedRuntime.effort);
  check(
    "pane.readOnly×runtime",
    pane.readOnly === true,
    approvedRuntime.readOnly,
  );
  check("agent.readOnly×runtime", agent.readOnly, approvedRuntime.readOnly);
  check(
    "agent.nativeReadOnly×runtime",
    agent.nativeReadOnly,
    approvedRuntime.nativeReadOnly,
  );
  if (!sameMissionPaneAuthoritySeal(agent.authoritySeal, pane.authoritySeal)) {
    mismatches.push("agent.authoritySeal×pane");
  }
  if (!sameCapabilities(agent.allowedTools, pane.allowedTools)) {
    mismatches.push("agent.allowedTools×pane");
  }
  if (!sameCapabilities(agent.allowedSkills, pane.allowedSkills)) {
    mismatches.push("agent.allowedSkills×pane");
  }
  if (!sameScope(agent.scope, scope)) mismatches.push("agent.scope");
  check("authority.sessionId×agent", authority.sessionId, agent.sessionId);
  check("authority.paneId×pane", authority.paneId, pane.paneId);
  check("authority.kind", authority.kind, "cli-agent");
  check("authority.missionId", authority.missionId, mission.id);
  check("authority.role", authority.role, "orchestrator");
  if (!authority.scope || !sameScope(authority.scope, scope)) {
    mismatches.push("authority.scope");
  }
  return mismatches;
}

function paneResult(
  pane: MissionPaneSpec,
  sessionId: string,
): MissionOrchestratorPane {
  if (!pane.paneId || !pane.cwd || !pane.agentName) {
    throw new Error("persisted orchestrator pane identity is incomplete");
  }
  return {
    paneId: pane.paneId,
    sessionId,
    adapterId: pane.adapterId,
    model: pane.model,
    accountId: pane.accountId,
    effort: pane.effort,
    cwd: pane.cwd,
    title: pane.title,
    agentName: pane.agentName,
    role: "orchestrator",
  };
}

function failureDetail(reason: string, cause?: unknown): string {
  const suffix =
    cause instanceof Error && cause.message.trim()
      ? ` ${cause.message.trim()}`
      : "";
  return `${reason}${suffix}`.slice(0, 4_096);
}

const productionDeps: MissionOrchestratorBootstrapDeps = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  updateMission: (scope, missionId, patch) =>
    getProjectDomainStores(scope).missions.update(missionId, patch),
  setOrchestratorSession: (scope, missionId, sessionId) =>
    getProjectDomainStores(scope).missions.setOrchestratorSession(
      missionId,
      sessionId,
    ),
  hasCurrentKickoffAcceptance: (scope, missionId) =>
    getProjectDomainStores(scope).missions.hasCurrentKickoffAcceptance(
      missionId,
    ),
  hasPendingKickoffFlight: (missionId) =>
    hasPendingMissionKickoffFlight(missionId),
  listMissionPanes: (scope, missionId) =>
    getProjectDomainStores(scope).missionPanes.list(missionId),
  recordMissionPane: (scope, input) =>
    getProjectDomainStores(scope).missionPanes.record(input),
  rebindMissionPaneAuthority: (scope, input) =>
    getProjectDomainStores(scope).missionPanes.rebindOrchestratorAuthority(
      input,
    ),
  removeMissionPane: (scope, paneRowId) =>
    getProjectDomainStores(scope).missionPanes.remove(paneRowId),
  getSquad: (squadId) => getSquad(squadId),
  resolveRuntime: (squad, orchestrator) =>
    resolveProductionMissionOrchestratorRuntime(squad, orchestrator),
  spawnMainOwnedPane: (input) => spawnMainOwnedMissionPane(input),
  closePane: (paneId) => requestPaneClose(paneId),
  getSessionState: (sessionId) => getSessionState(sessionId),
  getAgentSessionInfo: (sessionId) => getAgentSessionInfo(sessionId),
  getRuntimeAuthority: (sessionId) =>
    getPaneRuntimeAuthorityBySession(sessionId),
  submitKickoff: (scope, input) => submitMissionKickoffFromMain(scope, input),
  emitDispatched: (mission) => {
    emitMissionIntentEvent({
      name: "task_dispatched",
      missionId: mission.id,
      squadId: mission.squadId,
      intentState: mission.intentState,
      intentVersion: mission.intentVersion,
      reason: "main_orchestrator_bootstrap",
    });
  },
  validateAttachmentPaths: (paths) => validateDroppedAttachmentPaths(paths),
  snapshotAttachmentPaths: (paths) => snapshotDroppedAttachmentPaths(paths),
  ensurePlanGitBaseline: (scope, missionId) => {
    const mission = getProjectDomainStores(scope).missions.get(missionId);
    if (mission?.intentContract?.lane === "plan") {
      ensurePlanLaneGitBaseline(scope);
    } else if (mission?.intentContract?.promotedPlan) {
      commitPromotedPlanToGit(
        scope,
        assertPromotedPlanSnapshot(mission.intentContract.promotedPlan),
      );
    }
  },
  ensureMissionPlan: (scope, missionId) =>
    ensureGuidedMissionPlanForScope(scope, missionId),
  ensureMissionPrevc: (scope, missionId) =>
    ensureGuidedMissionPrevcForScope(scope, missionId),
};

/**
 * The only initial-orchestrator materializer. The public input is scope +
 * mission id; provider, account, model, cwd, roster and grants are derived
 * from trusted main stores immediately before each external effect.
 */
export class MissionOrchestratorBootstrapService {
  readonly #deps: MissionOrchestratorBootstrapDeps;
  readonly #flights = new Map<
    string,
    Promise<MissionOrchestratorBootstrapResult>
  >();
  readonly #authorizedSnapshots = new Map<string, string>();
  readonly #authorizedApprovalSnapshots = new Map<string, string>();

  constructor(deps: MissionOrchestratorBootstrapDeps = productionDeps) {
    this.#deps = deps;
  }

  bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult> {
    const key = bootstrapFlightKey(scope, missionId);
    const existing = this.#flights.get(key);
    if (existing) return existing;
    const flight = this.#bootstrap(scope, missionId)
      .catch((error) =>
        this.#failure(
          scope,
          missionId,
          "materialization_failed",
          failureDetail(
            "O bootstrap main-owned falhou inesperadamente.",
            error,
          ),
        ),
      )
      .finally(() => {
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
        this.#authorizedSnapshots.delete(key);
        this.#authorizedApprovalSnapshots.delete(key);
      });
    this.#flights.set(key, flight);
    return flight;
  }

  async #bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult> {
    const initial = this.#deps.getMission(scope, missionId);
    if (
      !initial ||
      initial.status !== "running" ||
      !hasCurrentDispatchAuthority(initial)
    ) {
      return this.#failure(
        scope,
        missionId,
        "not_authorized",
        "O bootstrap exige uma missão running com intenção aprovada.",
      );
    }
    this.#authorizedSnapshots.set(
      bootstrapFlightKey(scope, missionId),
      bootstrapMissionSnapshot(initial),
    );
    this.#authorizedApprovalSnapshots.set(
      bootstrapFlightKey(scope, missionId),
      bootstrapMissionApprovalSnapshot(initial),
    );
    let guidedPrevcRequired = false;
    let guidedPrevcFrozen = false;
    try {
      this.#deps.ensurePlanGitBaseline?.(scope, missionId);
      this.#deps.ensureMissionPlan?.(scope, missionId);
      const prevcCandidate = this.#deps.ensureMissionPrevc?.(
        scope,
        missionId,
      );
      let prevc: GuidedMissionPrevcResult | undefined;
      if (
        prevcCandidate &&
        typeof (prevcCandidate as PromiseLike<GuidedMissionPrevcResult>).then ===
          "function"
      ) {
        prevc = await Promise.resolve(prevcCandidate);
      } else {
        prevc = prevcCandidate as GuidedMissionPrevcResult | undefined;
      }
      guidedPrevcRequired = prevc?.required === true;
      guidedPrevcFrozen = prevc?.frozen === true;
      if (guidedPrevcRequired && !guidedPrevcFrozen) {
        throw new Error(
          "guided_prevc_freeze_incomplete: Main não persistiu " +
            "mission_contracts antes do scheduler",
        );
      }
    } catch (error) {
      return this.#failure(
        scope,
        missionId,
        "preflight_failed",
        failureDetail(
          "O preflight main-owned (plano/PREVC) não pôde ser selado antes de iniciar qualquer provider.",
          error,
        ),
      );
    }

    const squad = initial.squadId ? this.#deps.getSquad(initial.squadId) : null;
    const orchestrator = squad ? chooseOrchestrator(squad) : null;
    if (!squad || !orchestrator) {
      return this.#failure(
        scope,
        missionId,
        "squad_missing",
        "O squad salvo ou seu orquestrador não está disponível.",
      );
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    if (initial.intentContract?.squadRevisionHash !== squadSnapshot.hash) {
      return this.#failure(
        scope,
        missionId,
        "preflight_failed",
        "O squad salvo mudou depois da aprovação. Revise a intenção e aprove " +
          "novamente antes de iniciar qualquer provider.",
      );
    }
    const authoritySeal = resolveMissionPaneAuthoritySeal(
      scope,
      initial,
      squad,
    );
    if (!authoritySeal) {
      return this.#failure(
        scope,
        missionId,
        "preflight_failed",
        "A revisão aprovada não pôde ser selada para o pane. Replaneje e aprove novamente.",
      );
    }

    const approvedRuntime = initial.intentContract?.orchestratorRuntime;
    if (!approvedRuntime) {
      return this.#failure(
        scope,
        missionId,
        "preflight_failed",
        "O contrato aprovado não contém o snapshot do runtime inicial. " +
          "Revise a intenção e reaprove antes de iniciar qualquer provider.",
      );
    }

    let resolvedRuntime: MissionOrchestratorRuntimeSnapshot;
    try {
      resolvedRuntime = canonicalMissionOrchestratorRuntime(
        this.#deps.resolveRuntime(squad, orchestrator),
      );
    } catch (error) {
      return this.#failure(
        scope,
        missionId,
        "preflight_failed",
        failureDetail("O preflight do runtime do orquestrador falhou.", error),
      );
    }
    if (!sameMissionOrchestratorRuntime(approvedRuntime, resolvedRuntime)) {
      return this.#failure(
        scope,
        missionId,
        "preflight_failed",
        "O runtime do orquestrador mudou desde a aprovação (provider, modelo, " +
          "conta, esforço ou confinamento). Revise e reaprove antes de iniciar.",
      );
    }
    // External effects consume the persisted approval, never a mutable
    // settings object. Equality above proves that it remains currently valid.
    const runtime = approvedRuntime;

    let persistedOrchestrator = this.#deps
      .listMissionPanes(scope, missionId)
      .find((pane) => pane.role === "orchestrator");
    if (
      persistedOrchestrator &&
      !sameMissionPaneAuthoritySeal(
        persistedOrchestrator.authoritySeal,
        authoritySeal,
      )
    ) {
      if (
        persistedOrchestrator.paneId &&
        persistedOrchestrator.authoritySeal &&
        sameMissionPaneApprovalSeal(
          persistedOrchestrator.authoritySeal,
          authoritySeal,
        ) &&
        this.#deps.rebindMissionPaneAuthority
      ) {
        try {
          persistedOrchestrator = this.#deps.rebindMissionPaneAuthority(scope, {
            missionId,
            paneId: persistedOrchestrator.paneId,
            expectedAuthoritySeal: persistedOrchestrator.authoritySeal,
            authoritySeal,
          });
        } catch (error) {
          return this.#failure(
            scope,
            missionId,
            "preflight_failed",
            failureDetail(
              "O reseal do orquestrador após freeze/refreeze falhou.",
              error,
            ),
          );
        }
      } else {
        return this.#failure(
          scope,
          missionId,
          "preflight_failed",
          "O pane persistido pertence a outra revisão de intenção, contexto, " +
            "contrato ou squad. Replaneje e aprove antes de retomar.",
        );
      }
    }
    if (initial.orchestratorSessionId || persistedOrchestrator) {
      const sessionId = initial.orchestratorSessionId;
      const agent = sessionId
        ? this.#deps.getAgentSessionInfo(sessionId)
        : null;
      const authority = sessionId
        ? this.#deps.getRuntimeAuthority(sessionId)
        : null;
      if (
        sessionId &&
        persistedOrchestrator &&
        this.#deps.getSessionState(sessionId) !== null &&
        runtimeAuthorityMismatches(
          scope,
          initial,
          persistedOrchestrator,
          agent,
          authority,
          runtime,
        ).length === 0
      ) {
        if (!this.#deps.hasCurrentKickoffAcceptance(scope, missionId)) {
          // Recibo a caminho ≠ recibo ausente. O aceite leva de segundos a
          // minutos e o reconciliador re-entra a cada 5s; falhar aqui matava o
          // orquestrador no meio do próprio kickoff que ia gerar o recibo.
          if (this.#deps.hasPendingKickoffFlight(missionId)) {
            return {
              ok: true,
              missionId,
              pane: paneResult(persistedOrchestrator, sessionId),
              kickoff: { accepted: true },
              reused: true,
            };
          }
          return this.#failure(
            scope,
            missionId,
            "materialization_failed",
            "A sessão existe, mas não há recibo durável do aceite idle→busy " +
              "para esta revisão. O Nexus não repetiu o kickoff para evitar " +
              "execução duplicada.",
          );
        }
        return {
          ok: true,
          missionId,
          pane: paneResult(persistedOrchestrator, sessionId),
          kickoff: { accepted: true },
          reused: true,
        };
      }
      return this.#failure(
        scope,
        missionId,
        "provider_exited",
        "O provider do orquestrador encerrou. O Nexus preservou a missão e " +
          "não repetiu o kickoff automaticamente; clique em “Retomar missão” " +
          "para revisar e iniciar uma nova sessão.",
      );
    }

    let attachmentPaths: string[] | undefined;
    let attachmentSnapshots: MissionAttachmentSnapshot[] | undefined;
    try {
      attachmentPaths = this.#deps.validateAttachmentPaths(
        initial.intentContract?.attachmentPaths,
      );
      attachmentSnapshots = this.#deps.snapshotAttachmentPaths(attachmentPaths);
      if (
        !sameAttachmentSnapshots(
          initial.intentContract?.attachmentSnapshots,
          attachmentSnapshots,
        )
      ) {
        throw new Error(
          "o conteúdo dos anexos mudou desde a aprovação; nova aprovação é obrigatória",
        );
      }
    } catch (error) {
      return this.#failure(
        scope,
        missionId,
        "preflight_failed",
        failureDetail("A validação dos anexos da missão falhou.", error),
      );
    }

    const title = `${squad.name} · orq`;
    const spawn = this.#deps.spawnMainOwnedPane({
      adapterId: runtime.adapterId,
      model: runtime.model,
      accountId: runtime.accountId,
      effort: runtime.effort,
      cwd: scope.rootRealPath,
      title,
      missionId,
      agentName: orchestrator.agentName,
      allowedTools: orchestrator.allowedTools,
      allowedSkills: orchestrator.allowedSkills,
      role: "orchestrator",
      scope,
      executionScope: scope,
      // MCP remains delegation-capable. Native Bash/Edit/git is independently
      // denied by the provider confinement selected above.
      readOnly: runtime.readOnly,
      nativeReadOnly: runtime.nativeReadOnly,
      authoritySeal,
    });
    if (!spawn.ok || !spawn.paneId || !spawn.sessionId) {
      return this.#failure(
        scope,
        missionId,
        "spawn_failed",
        `O provider do orquestrador não iniciou. ${
          spawn.error ?? "Falha física sem detalhe."
        }`,
      );
    }

    let paneRow: MissionPaneSpec | null = null;
    let sessionBound = false;
    try {
      paneRow = this.#deps.recordMissionPane(scope, {
        missionId,
        paneId: spawn.paneId,
        adapterId: runtime.adapterId,
        model: runtime.model,
        accountId: runtime.accountId,
        effort: runtime.effort,
        cwd: scope.rootRealPath,
        title,
        agentName: orchestrator.agentName,
        role: "orchestrator",
        allowedTools: orchestrator.allowedTools,
        allowedSkills: orchestrator.allowedSkills,
        readOnly: runtime.readOnly,
        executionScope: scope,
        authoritySeal,
      });
      const bound = this.#deps.setOrchestratorSession(
        scope,
        missionId,
        spawn.sessionId,
      );
      if (!bound) throw new Error("mission disappeared during bootstrap");
      sessionBound = true;
      const current = this.#deps.getMission(scope, missionId);
      const agent = this.#deps.getAgentSessionInfo(spawn.sessionId);
      const authority = this.#deps.getRuntimeAuthority(spawn.sessionId);
      if (!current) {
        throw new Error("mission disappeared before authority seal");
      }
      const mismatches = runtimeAuthorityMismatches(
        scope,
        current,
        paneRow,
        agent,
        authority,
        runtime,
      );
      if (mismatches.length > 0) {
        throw new Error(
          "spawned PTY did not retain exact mission authority — divergências: " +
            mismatches.slice(0, 8).join("; "),
        );
      }

      this.#deps.emitDispatched(current);
      const prompt = buildIntentDispatchKickoffPrompt({
        squad,
        missionId,
        missionTitle: current.title,
        goal: current.intentContract!.goal,
        acceptanceCriteria: current.intentContract!.acceptanceCriteria,
        risk: current.intentContract!.risk,
        maxWorkers: current.intentContract!.budgets.maxWorkers,
        lane: current.intentContract!.lane ?? "standard",
        attachmentPaths,
        promotedPlan: current.intentContract!.promotedPlan
          ? assertPromotedPlanSnapshot(current.intentContract!.promotedPlan)
          : undefined,
        guidedPrevcRequired,
        guidedPrevcFrozen,
      });
      const kickoff = await this.#deps.submitKickoff(scope, {
        missionId,
        sessionId: spawn.sessionId,
        prompt,
      });
      return {
        ok: true,
        missionId,
        pane: paneResult(paneRow, spawn.sessionId),
        kickoff,
      };
    } catch (error) {
      const detail = failureDetail(
        "O bootstrap não pôde selar a autoridade da sessão.",
        error,
      );
      const currentBeforeTeardown = this.#deps.getMission(scope, missionId);
      const failure = this.#failure(
        scope,
        missionId,
        "materialization_failed",
        detail,
        currentBeforeTeardown
          ? bootstrapMissionSnapshot(currentBeforeTeardown)
          : undefined,
      );

      // Revoke durable mission authority before waiting for the physical
      // process. The binding remains the source of truth until closePane
      // returns an affirmative exit proof.
      let physicallyClosed = false;
      try {
        physicallyClosed = await this.#deps.closePane(spawn.paneId);
      } catch {
        physicallyClosed = false;
      }
      if (physicallyClosed) {
        const current = this.#deps.getMission(scope, missionId);
        if (
          sessionBound &&
          current?.orchestratorSessionId === spawn.sessionId
        ) {
          this.#deps.setOrchestratorSession(scope, missionId, null);
        }
        if (paneRow) this.#deps.removeMissionPane(scope, paneRow.id);
      } else {
        this.#markTerminationPending(scope, missionId, spawn.sessionId, detail);
      }
      return failure;
    }
  }

  #markTerminationPending(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string,
    detail: string,
  ): void {
    const current = this.#deps.getMission(scope, missionId);
    if (
      !current ||
      current.orchestratorSessionId !== sessionId ||
      current.status === "done" ||
      current.status === "failed"
    ) {
      return;
    }
    const note =
      `${BOOTSTRAP_TERMINATION_PENDING_MARKER}\n` +
      `## Encerramento físico pendente\n${detail} O Nexus preservou o vínculo ` +
      `do pane até obter prova de saída. CTA: ${BOOTSTRAP_CTA}.`;
    const description = current.description.includes(
      BOOTSTRAP_TERMINATION_PENDING_MARKER,
    )
      ? current.description
      : [current.description.trim(), note]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 65_536);
    this.#deps.updateMission(scope, missionId, {
      ...missionBlockPatch("technical"),
      description,
    });
  }

  #failure(
    scope: ProjectExecutionScope,
    missionId: string,
    reason: Extract<
      MissionOrchestratorBootstrapResult,
      { ok: false }
    >["reason"],
    detail: string,
    expectedCurrentSnapshot?: string,
  ): MissionOrchestratorBootstrapResult {
    const current = this.#deps.getMission(scope, missionId);
    const key = bootstrapFlightKey(scope, missionId);
    const authorizedSnapshot = this.#authorizedSnapshots.get(key);
    const authorizedApprovalSnapshot =
      this.#authorizedApprovalSnapshots.get(key);
    const exactSnapshot = expectedCurrentSnapshot ?? authorizedSnapshot;
    if (
      reason !== "not_authorized" &&
      exactSnapshot !== undefined &&
      authorizedApprovalSnapshot !== undefined &&
      current &&
      bootstrapMissionSnapshot(current) === exactSnapshot &&
      bootstrapMissionApprovalSnapshot(current) ===
        authorizedApprovalSnapshot &&
      current.status !== "done" &&
      current.status !== "failed"
    ) {
      const note =
        `${BOOTSTRAP_BLOCK_MARKER}\n## Orquestrador não iniciado\n${detail} ` +
        `CTA: ${BOOTSTRAP_CTA}.`;
      const description = current.description.includes(BOOTSTRAP_BLOCK_MARKER)
        ? current.description
        : [current.description.trim(), note]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 65_536);
      this.#deps.updateMission(scope, missionId, {
        ...missionBlockPatch("technical"),
        description,
      });
    }
    return {
      ok: false,
      missionId,
      reason,
      error: detail,
      cta: BOOTSTRAP_CTA,
    };
  }
}

/**
 * Restart/event recovery for the durable approval → initial-orchestrator edge.
 *
 * Calls are coalesced into one promise. The bootstrap service remains the
 * authority for per-mission singleflight, live-session reuse and fail-closed
 * blocking, so recovery cannot create a second PTY. The coordinator cadence
 * provides the bounded follow-up pass for a scope discovered mid-flight.
 */
export class MissionOrchestratorBootstrapRecovery {
  readonly #deps: MissionOrchestratorBootstrapRecoveryDeps;
  #flight: Promise<void> | null = null;

  constructor(deps: MissionOrchestratorBootstrapRecoveryDeps) {
    this.#deps = deps;
  }

  reconcile(): Promise<void> {
    if (this.#flight) return this.#flight;
    const flight = this.#pass()
      .catch((error) => {
        this.#warn(
          "[mission-orchestrator-bootstrap] recovery pass failed:",
          error,
        );
      })
      .finally(() => {
        if (this.#flight === flight) this.#flight = null;
      });
    this.#flight = flight;
    return flight;
  }

  waitForIdle(): Promise<void> {
    return this.#flight ?? Promise.resolve();
  }

  async #pass(): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const scope of this.#deps.listScopes()) {
      let missions: readonly Mission[];
      try {
        missions = this.#deps.listBootstrapCandidates(scope);
      } catch (error) {
        this.#warn(
          `[mission-orchestrator-bootstrap] could not list scope ${scope.projectId}:`,
          error,
        );
        continue;
      }
      for (const mission of missions) {
        if (
          mission.status !== "running" ||
          !hasCurrentDispatchAuthority(mission)
        ) {
          continue;
        }
        pending.push(
          this.#deps.bootstrap(scope, mission.id).then(
            () => undefined,
            (error) => {
              this.#warn(
                `[mission-orchestrator-bootstrap] recovery failed for ${mission.id}:`,
                error,
              );
            },
          ),
        );
      }
    }
    await Promise.all(pending);
  }

  #warn(message: string, error: unknown): void {
    (this.#deps.warn ?? console.warn)(message, error);
  }
}

const productionService = new MissionOrchestratorBootstrapService();
const productionScopes = new Map<string, ProjectExecutionScope>();
const productionRecovery = new MissionOrchestratorBootstrapRecovery({
  listScopes: () => [...productionScopes.values()],
  listBootstrapCandidates: (scope) => {
    const stores = getProjectDomainStores(scope);
    return stores.missions.list("running").filter((mission) => {
      // A complete durable binding already has its own lifecycle/rebind
      // supervision. Recovery owns the missing or torn approval→bootstrap
      // edge only; a half-binding is sent through the service so it blocks
      // with a CTA instead of spawning blindly.
      return needsMissionOrchestratorBootstrapRecovery(
        mission,
        stores.missionPanes.list(mission.id),
        stores.missions.hasCurrentKickoffAcceptance(mission.id),
      );
    });
  },
  bootstrap: (scope, missionId) =>
    productionService.bootstrap(scope, missionId),
});
let disposeProductionScopeListener: (() => void) | null = null;

function productionScopeKey(scope: Readonly<ProjectExecutionScope>): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
  ].join("\0");
}

/** Main-process boundary used by approval and recovery, sharing one singleflight. */
export function bootstrapMissionOrchestratorForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<MissionOrchestratorBootstrapResult> {
  return productionService.bootstrap(scope, missionId);
}

export interface PlanPromotionRestartDeps {
  getMission(scope: ProjectExecutionScope, missionId: string): Mission | null;
  updateMission(
    scope: ProjectExecutionScope,
    missionId: string,
    patch: MissionPatch,
  ): Mission | null;
  setOrchestratorSession(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string | null,
  ): Mission | null;
  listMissionPanes(
    scope: ProjectExecutionScope,
    missionId: string,
  ): MissionPaneSpec[];
  removeMissionPane(scope: ProjectExecutionScope, paneRowId: string): boolean;
  getSessionState(sessionId: string): ReturnType<typeof getSessionState>;
  getAgentSessionInfo(sessionId: string): OwnedAgentSessionInfo | null;
  revokeSessionAuthority(sessionId: string): void;
  closePane(input: MissionPaneCloseRequest): boolean | Promise<boolean>;
  ensureMissionPlan(
    scope: ProjectExecutionScope,
    missionId: string,
  ): GuidedMissionPlanResult;
  bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult>;
}

export type PlanPromotionTeardownResult =
  | Readonly<{ ok: true; missionId: string }>
  | Readonly<{
      ok: false;
      missionId: string;
      error: string;
      cta: string;
    }>;

const productionPlanPromotionRestartDeps: PlanPromotionRestartDeps = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  updateMission: (scope, missionId, patch) =>
    getProjectDomainStores(scope).missions.update(missionId, patch),
  setOrchestratorSession: (scope, missionId, sessionId) =>
    getProjectDomainStores(scope).missions.setOrchestratorSession(
      missionId,
      sessionId,
    ),
  listMissionPanes: (scope, missionId) =>
    getProjectDomainStores(scope).missionPanes.list(missionId),
  removeMissionPane: (scope, paneRowId) =>
    getProjectDomainStores(scope).missionPanes.remove(paneRowId),
  getSessionState,
  getAgentSessionInfo,
  revokeSessionAuthority: releaseSession,
  closePane: requestMissionPaneClose,
  ensureMissionPlan: ensureGuidedMissionPlanForScope,
  bootstrap: bootstrapMissionOrchestratorForScope,
};

function planPromotionTeardownFailure(
  scope: ProjectExecutionScope,
  missionId: string,
  detail: string,
  deps: PlanPromotionRestartDeps,
): PlanPromotionTeardownResult {
  const current = deps.getMission(scope, missionId);
  if (current && current.status !== "done" && current.status !== "failed") {
    const note =
      `${PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER}\n` +
      `## Sessão de plano preservada\n${detail} Nenhuma autoridade de código ` +
      `foi criada. Feche o processo órfão ou tente “Executar plano” novamente.`;
    deps.updateMission(scope, missionId, {
      ...missionBlockPatch("technical"),
      description: current.description.includes(
        PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER,
      )
        ? current.description
        : [current.description.trim(), note]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 65_536),
    });
  }
  return Object.freeze({
    ok: false,
    missionId,
    error: detail,
    cta: "Executar plano novamente",
  });
}

/**
 * Close plan-v1 before writing any standard-lane bytes.
 *
 * This order makes a crash fail safe: until physical exit succeeds the
 * durable mission remains plan-v1; after it succeeds, a crash can at worst
 * leave a plan mission with no pane, which ordinary bootstrap recovery can
 * recreate. There is never a durable code-v2 contract pointing at a v1 PTY.
 */
export async function stopMissionOrchestratorBeforePlanPromotionForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  expectedIntentVersion: number,
  deps: PlanPromotionRestartDeps = productionPlanPromotionRestartDeps,
): Promise<PlanPromotionTeardownResult> {
  const plan = deps.getMission(scope, missionId);
  if (
    !plan?.intentContract ||
    plan.intentContract.lane !== "plan" ||
    plan.intentVersion !== expectedIntentVersion ||
    plan.intentContract.intentVersion !== expectedIntentVersion ||
    plan.status === "done" ||
    plan.status === "failed"
  ) {
    return Object.freeze({
      ok: false,
      missionId,
      error: "O plano mudou antes do encerramento da sessão.",
      cta: "Revisar plano",
    });
  }

  const priorSessionId = plan.orchestratorSessionId;
  if (priorSessionId) deps.revokeSessionAuthority(priorSessionId);

  const priorPanes = deps.listMissionPanes(scope, missionId);
  const orchestratorPanes = priorPanes.filter(
    (pane) => pane.role === "orchestrator",
  );
  if (
    orchestratorPanes.length > 1 ||
    priorPanes.some((pane) => pane.role !== "orchestrator")
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "O runtime de plano contém panes incompatíveis com a promoção segura.",
      deps,
    );
  }

  const priorAgent = priorSessionId
    ? deps.getAgentSessionInfo(priorSessionId)
    : null;
  const paneIds = new Set(
    priorPanes
      .map((pane) => pane.paneId)
      .filter(
        (paneId): paneId is string =>
          typeof paneId === "string" && paneId.length > 0,
      ),
  );
  if (priorAgent?.paneId) paneIds.add(priorAgent.paneId);
  if (
    priorSessionId &&
    deps.getSessionState(priorSessionId) !== null &&
    paneIds.size === 0
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "A sessão de plano está viva, mas seu pane físico não foi identificado.",
      deps,
    );
  }
  for (const paneId of paneIds) {
    if (
      !(await deps.closePane({
        paneId,
        missionId,
        scope,
      }))
    ) {
      return planPromotionTeardownFailure(
        scope,
        missionId,
        "O Nexus não obteve prova de encerramento físico do pane de plano.",
        deps,
      );
    }
  }
  if (
    priorSessionId &&
    deps.getSessionState(priorSessionId) !== null
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "A sessão de plano continuou viva após a solicitação de encerramento.",
      deps,
    );
  }

  const current = deps.getMission(scope, missionId);
  if (
    !current?.intentContract ||
    current.intentContract.lane !== "plan" ||
    current.intentVersion !== expectedIntentVersion ||
    current.intentContract.intentVersion !== expectedIntentVersion ||
    current.orchestratorSessionId !== priorSessionId ||
    current.status === "done" ||
    current.status === "failed"
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "O plano mudou durante o encerramento físico da sessão.",
      deps,
    );
  }
  const remainingPanes = deps.listMissionPanes(scope, missionId);
  const priorPaneRows = new Set(priorPanes.map((pane) => pane.id));
  if (remainingPanes.some((pane) => !priorPaneRows.has(pane.id))) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "Um novo pane apareceu durante o encerramento da sessão de plano.",
      deps,
    );
  }

  if (priorSessionId) {
    const cleared = deps.setOrchestratorSession(scope, missionId, null);
    if (!cleared) {
      return planPromotionTeardownFailure(
        scope,
        missionId,
        "O vínculo durável da sessão de plano não pôde ser removido.",
        deps,
      );
    }
  }
  for (const pane of remainingPanes) {
    if (
      !deps.removeMissionPane(scope, pane.id) &&
      deps
        .listMissionPanes(scope, missionId)
        .some((candidate) => candidate.id === pane.id)
    ) {
      return planPromotionTeardownFailure(
        scope,
        missionId,
        "O vínculo durável do pane de plano não pôde ser removido.",
        deps,
      );
    }
  }
  const detached = deps.getMission(scope, missionId);
  if (
    !detached?.intentContract ||
    detached.intentContract.lane !== "plan" ||
    detached.intentVersion !== expectedIntentVersion ||
    detached.intentContract.intentVersion !== expectedIntentVersion ||
    detached.orchestratorSessionId !== undefined ||
    deps.listMissionPanes(scope, missionId).length > 0
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "O vínculo de plano mudou antes da prova durável de encerramento.",
      deps,
    );
  }
  if (detached.description.includes(PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER)) {
    const cleaned = deps.updateMission(scope, missionId, {
      description: detached.description
        .split(PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER)[0]!
        .trim(),
    });
    if (!cleaned) {
      return planPromotionTeardownFailure(
        scope,
        missionId,
        "O aviso da tentativa anterior não pôde ser limpo com segurança.",
        deps,
      );
    }
  }
  return Object.freeze({ ok: true, missionId });
}

function planPromotionRestartFailure(
  scope: ProjectExecutionScope,
  missionId: string,
  detail: string,
  deps: PlanPromotionRestartDeps,
): MissionOrchestratorBootstrapResult {
  const current = deps.getMission(scope, missionId);
  if (current && current.status !== "done" && current.status !== "failed") {
    const blockedContract = current.intentContract
      ? {
          ...current.intentContract,
          approvedAt: current.intentContract.approvedAt ?? Date.now(),
          // A failed runtime transition has no executable v2 authority.
          // Keeping this timestamp would let the generic pane-rearm path
          // bypass the dedicated physical teardown retry.
          dispatchedAt: undefined,
        }
      : undefined;
    const note =
      `${PLAN_PROMOTION_BLOCK_MARKER}\n` +
      `## Promoção não reiniciada\n${detail} A sessão de plano não recebeu ` +
      `autoridade de código. CTA: ${BOOTSTRAP_CTA}.`;
    const description = current.description.includes(
      PLAN_PROMOTION_BLOCK_MARKER,
    )
      ? current.description
      : [current.description.trim(), note]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 65_536);
    deps.updateMission(scope, missionId, {
      ...missionBlockPatch("technical"),
      ...(blockedContract ? { intentContract: blockedContract } : {}),
      description,
    });
  }
  return {
    ok: false,
    missionId,
    reason: "materialization_failed",
    error: detail,
    cta: BOOTSTRAP_CTA,
  };
}

/**
 * Exact plan-v1 → code-v2 runtime transition.
 *
 * The caller has already revoked and physically closed plan-v1 before writing
 * the durable standard-v2 contract. This boundary refuses any reappearing
 * session/pane, dispatches v2, seals its guided plan and lets the ordinary
 * bootstrap create a fresh pane + kickoff. Reusing or renderer-injecting into
 * the v1 PTY is deliberately impossible.
 */
export async function restartMissionOrchestratorAfterPlanPromotionForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  expectedIntentVersion: number,
  deps: PlanPromotionRestartDeps = productionPlanPromotionRestartDeps,
): Promise<MissionOrchestratorBootstrapResult> {
  const promoted = deps.getMission(scope, missionId);
  if (
    !promoted?.intentContract ||
    promoted.intentContract.lane !== "standard" ||
    promoted.intentVersion !== expectedIntentVersion ||
    promoted.intentContract.intentVersion !== expectedIntentVersion ||
    promoted.intentState !== "ready_to_start" ||
    promoted.status !== "pending"
  ) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: "A revisão promovida mudou antes de reiniciar o orquestrador.",
      cta: BOOTSTRAP_CTA,
    };
  }

  if (
    promoted.orchestratorSessionId !== undefined ||
    deps.listMissionPanes(scope, missionId).length > 0
  ) {
    return planPromotionRestartFailure(
      scope,
      missionId,
      "Uma sessão ou pane apareceu depois do encerramento seguro do plano.",
      deps,
    );
  }

  const current = deps.getMission(scope, missionId);
  if (
    !current?.intentContract ||
    current.intentContract.lane !== "standard" ||
    current.intentVersion !== expectedIntentVersion ||
    current.intentContract.intentVersion !== expectedIntentVersion ||
    current.intentState !== "ready_to_start" ||
    current.status !== "pending" ||
    current.orchestratorSessionId !== undefined ||
    deps.listMissionPanes(scope, missionId).length > 0
  ) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: "A missão mudou antes de despachar a revisão promovida.",
      cta: BOOTSTRAP_CTA,
    };
  }

  const armedContract = {
    ...current.intentContract,
    approvedAt: current.intentContract.approvedAt ?? Date.now(),
    dispatchedAt: Date.now(),
  };
  const armed = deps.updateMission(scope, missionId, {
    status: "running",
    intentState: "dispatched",
    intentContract: armedContract,
  });
  if (
    !armed ||
    armed.intentVersion !== expectedIntentVersion ||
    !hasCurrentDispatchAuthority(armed)
  ) {
    return planPromotionRestartFailure(
      scope,
      missionId,
      "A autoridade da revisão promovida não pôde ser despachada.",
      deps,
    );
  }

  try {
    const plan = deps.ensureMissionPlan(scope, missionId);
    if (
      !plan.applicable ||
      (plan.reason !== "sealed" && plan.reason !== "already-sealed")
    ) {
      throw new Error(
        `guided_plan_receipt_missing: a promoção não produziu o grafo Guided v2 (${plan.reason})`,
      );
    }
  } catch (error) {
    return planPromotionRestartFailure(
      scope,
      missionId,
      `O plano guiado da revisão promovida não pôde ser selado. ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 4_096),
      deps,
    );
  }
  return deps.bootstrap(scope, missionId);
}

/**
 * Whether — and how — a bootstrap-blocked mission may be re-armed for another
 * bootstrap attempt. Pure so the exact recovery precondition is testable: only
 * a mission the BOOTSTRAP failure itself blocked (marker in description,
 * blocked/blocked_technical, approved dispatch authority intact) qualifies.
 * Field wedge this exits: bootstrap failure → blocked_technical with zero
 * panes → wizard retry hits "invalid transition", rail reopen finds no pane
 * composition, removal preserves the mission — no recovery path at all.
 */
export function blockedBootstrapResumePatch(mission: Mission):
  | {
      ok: true;
      patch: {
        status: "running";
        intentState: "executing";
        description: string;
      };
    }
  | {
      ok: false;
      error: string;
    } {
  // Qualquer blocked_technical com contrato aprovado vigente é resumível
  // pelo bootstrap: os re-bloqueios do próprio ciclo (kickoff sem recibo,
  // provider_exited) NÃO anexam o marker, e exigi-lo aqui devolvia a missão
  // ao restore de panes — que recria a identidade morta que o bootstrap
  // recusa (beco circular). O bootstrap revalida squad/contrato/runtime de
  // qualquer forma. blocked_user segue no caminho de re-arme com panes.
  if (
    mission.status !== "blocked" ||
    (mission.intentState !== "blocked_technical" &&
      mission.intentState !== "blocked_user")
  ) {
    return {
      ok: false,
      error: "Só uma missão bloqueada pode ser retomada por aqui.",
    };
  }
  // The approved contract must still be current; everything else (squad hash,
  // runtime, seal) is re-validated by the bootstrap itself after re-arm.
  if (!hasCurrentApprovedDispatchContract(mission)) {
    return {
      ok: false,
      error:
        "A aprovação da missão não está mais vigente. Revise a intenção e aprove novamente.",
    };
  }
  const description = mission.description
    .split(BOOTSTRAP_BLOCK_MARKER)[0]!
    .split(GUIDED_PLAN_BLOCK_MARKER)[0]!
    .split(PLAN_PROMOTION_BLOCK_MARKER)[0]!
    .split(PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER)[0]!
    .trim();
  // begin_execution is the state machine's sanctioned exit from
  // blocked_technical; canDispatchWorkers excludes blocked states, so the
  // bootstrap would refuse a re-armed mission that kept the blocked intent.
  return {
    ok: true,
    patch: { status: "running", intentState: "executing", description },
  };
}

export function blockedPlanPromotionResumePatch(mission: Mission):
  | {
      ok: true;
      intentVersion: number;
      patch: MissionPatch;
    }
  | {
      ok: false;
      error: string;
    } {
  const contract = mission.intentContract;
  const intentVersion = mission.intentVersion;
  if (
    !mission.description.includes(PLAN_PROMOTION_BLOCK_MARKER) ||
    mission.status !== 'blocked' ||
    mission.intentState !== 'blocked_technical' ||
    contract?.lane !== 'standard' ||
    intentVersion === undefined ||
    contract.intentVersion !== intentVersion
  ) {
    return {
      ok: false,
      error:
        'A revisão promovida não conserva o contrato necessário para tentar o reinício.',
    };
  }
  return {
    ok: true,
    intentVersion,
    patch: {
      status: 'pending',
      intentState: 'ready_to_start',
      description: mission.description
        .split(PLAN_PROMOTION_BLOCK_MARKER)[0]!
        .trim(),
      intentContract: {
        ...contract,
        dispatchedAt: undefined,
      },
    },
  };
}

/**
 * Re-arm (only) a blocked mission that still has persisted pane composition:
 * pane respawn resolves the current authority seal from the LIVE mission, and
 * createMissionPaneAuthoritySeal is null while status != running — so panes
 * must never respawn before the mission is re-armed. Uses the state machine's
 * sanctioned exits (user_resume / begin_execution → executing). Pure for
 * testability; the IPC boundary applies the patch and the renderer then
 * restores the composition.
 */
export function blockedMissionRearmPatch(mission: Mission):
  | {
      ok: true;
      patch: {
        status: "running";
        intentState: "executing";
        description: string;
      };
    }
  | {
      ok: false;
      error: string;
    } {
  if (
    mission.description.includes(PLAN_PROMOTION_BLOCK_MARKER) ||
    mission.description.includes(PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER)
  ) {
    return {
      ok: false,
      error:
        "A promoção exige encerrar fisicamente a sessão de plano; use Retomar missão.",
    };
  }
  if (
    mission.status !== "blocked" ||
    (mission.intentState !== "blocked_technical" &&
      mission.intentState !== "blocked_user")
  ) {
    return {
      ok: false,
      error: "Só uma missão bloqueada pode ser re-armada para retomada.",
    };
  }
  if (!hasCurrentApprovedDispatchContract(mission)) {
    return {
      ok: false,
      error:
        "A aprovação da missão não está mais vigente. Revise a intenção e aprove novamente.",
    };
  }
  const description = mission.description
    .split(BOOTSTRAP_BLOCK_MARKER)[0]!
    .trim();
  return {
    ok: true,
    patch: { status: "running", intentState: "executing", description },
  };
}

/** Main boundary: re-arm a blocked mission before the renderer restores panes. */
export function rearmBlockedMissionForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): { ok: true } | { ok: false; error: string } {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) {
    return { ok: false, error: "Missão não encontrada neste workspace." };
  }
  const rearm = blockedMissionRearmPatch(mission);
  if (!rearm.ok) return rearm;
  const updated = stores.missions.update(missionId, rearm.patch);
  if (!updated) {
    return {
      ok: false,
      error: "A missão mudou durante a retomada. Tente novamente.",
    };
  }
  return { ok: true };
}

/** Renderer boundary for the pane-preserving re-arm. */
export function rearmBlockedMissionFromRenderer(
  owner: WebContents,
  raw: unknown,
): { ok: true } | { ok: false; error: string } {
  const input = missionOrchestratorBootstrapRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  return rearmBlockedMissionForScope(scope, input.missionId);
}

const DEAD_GRAPH_DISPATCH_STATES = new Set<TaskDispatchState>([
  "superseded",
  "blocked",
  "failed",
]);

interface DeadGraphPaneTarget {
  readonly paneId: string;
  readonly role: "orchestrator" | "worker";
  readonly sessionId?: string;
  readonly workerIncarnationId?: string;
  readonly observedInRuntime: boolean;
}

export interface DeadGraphReapprovalDeps {
  getMission(scope: ProjectExecutionScope, missionId: string): Mission | null;
  listMissionPanes(
    scope: ProjectExecutionScope,
    missionId: string,
  ): MissionPaneSpec[];
  removeMissionPane(scope: ProjectExecutionScope, paneRowId: string): boolean;
  listTaskDispatches(
    scope: ProjectExecutionScope,
    missionId: string,
  ): TaskDispatchRecord[];
  listRuntimePanes(): readonly PaneSnapshot[];
  getSessionState: typeof getSessionState;
  revokeSessionAuthority(sessionId: string): void;
  closePane(input: MissionPaneCloseRequest): boolean | Promise<boolean>;
  publishReapprovalRevision(
    scope: ProjectExecutionScope,
    missionId: string,
    expected: Mission,
  ): Mission;
}

const productionDeadGraphReapprovalDeps: DeadGraphReapprovalDeps = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  listMissionPanes: (scope, missionId) =>
    getProjectDomainStores(scope).missionPanes.list(missionId),
  removeMissionPane: (scope, paneRowId) =>
    getProjectDomainStores(scope).missionPanes.remove(paneRowId),
  listTaskDispatches: (scope, missionId) =>
    getProjectDomainStores(scope).taskDispatches.list(missionId),
  listRuntimePanes: listPaneSnapshots,
  getSessionState,
  revokeSessionAuthority: releaseSession,
  closePane: requestMissionPaneClose,
  publishReapprovalRevision: (scope, missionId, expected) =>
    getProjectDomainStores(scope).missions.publishDeadGraphReapprovalRevision(
      missionId,
      expected,
    ),
};

function deadGraphResumeFailure(
  missionId: string,
  detail: string,
): MissionOrchestratorBootstrapResult {
  return Object.freeze({
    ok: false,
    missionId,
    reason: "not_authorized",
    error: detail.slice(0, 4_096),
    cta: BOOTSTRAP_CTA,
  });
}

function sameDeadGraphMissionFence(
  expected: Mission,
  current: Mission | null,
): boolean {
  return Boolean(
    current &&
      current.updatedAt === expected.updatedAt &&
      current.orchestratorSessionId === expected.orchestratorSessionId &&
      bootstrapMissionSnapshot(current) === bootstrapMissionSnapshot(expected),
  );
}

/**
 * Convert a blocked, already-invalidated task graph into a fresh revision that
 * requires native approval. Returns null only for bootstrap-only blocks (no
 * terminal dispatch in the current revision), which retain the ordinary
 * resume/rebootstrap path.
 */
export async function prepareDeadGraphReapprovalForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  deps: DeadGraphReapprovalDeps = productionDeadGraphReapprovalDeps,
): Promise<MissionOrchestratorBootstrapResult | null> {
  const mission = deps.getMission(scope, missionId);
  if (!mission) {
    return deadGraphResumeFailure(
      missionId,
      "Missão não encontrada neste workspace.",
    );
  }
  const currentVersion = mission.intentVersion ?? 0;
  const invalidated = deps
    .listTaskDispatches(scope, missionId)
    .filter(
      (dispatch) =>
        dispatch.intentVersion === currentVersion &&
        DEAD_GRAPH_DISPATCH_STATES.has(dispatch.state),
    );
  if (invalidated.length === 0) return null;

  const resume = blockedBootstrapResumePatch(mission);
  if (!resume.ok) {
    return deadGraphResumeFailure(missionId, resume.error);
  }

  const persistedPanes = deps.listMissionPanes(scope, missionId);
  const runtimePanes = deps
    .listRuntimePanes()
    .filter((pane) => pane.missionId === missionId);
  if (
    runtimePanes.some(
      (pane) => !pane.scope || !sameScope(pane.scope, scope),
    )
  ) {
    return deadGraphResumeFailure(
      missionId,
      "O runtime antigo não conserva a identidade exata deste workspace; a missão permaneceu bloqueada.",
    );
  }

  const targets = new Map<string, DeadGraphPaneTarget>();
  const addTarget = (target: DeadGraphPaneTarget): boolean => {
    const existing = targets.get(target.paneId);
    if (!existing) {
      targets.set(target.paneId, target);
      return true;
    }
    if (
      existing.role !== target.role ||
      (existing.sessionId !== undefined &&
        target.sessionId !== undefined &&
        existing.sessionId !== target.sessionId) ||
      (existing.workerIncarnationId !== undefined &&
        target.workerIncarnationId !== undefined &&
        existing.workerIncarnationId !== target.workerIncarnationId)
    ) {
      return false;
    }
    targets.set(target.paneId, {
      paneId: target.paneId,
      role: target.role,
      sessionId: existing.sessionId ?? target.sessionId,
      workerIncarnationId:
        existing.workerIncarnationId ?? target.workerIncarnationId,
      observedInRuntime:
        existing.observedInRuntime || target.observedInRuntime,
    });
    return true;
  };

  for (const pane of persistedPanes) {
    if (!pane.paneId) continue;
    const matchingDispatches =
      pane.role === "worker"
        ? invalidated.filter(
            (dispatch) =>
              dispatch.paneId === pane.paneId ||
              (pane.workerIncarnationId !== undefined &&
                dispatch.workerIncarnationId === pane.workerIncarnationId),
          )
        : [];
    if (matchingDispatches.length > 1) {
      return deadGraphResumeFailure(
        missionId,
        "Mais de um dispatch reivindica o mesmo pane antigo; a missão permaneceu bloqueada.",
      );
    }
    const dispatch = matchingDispatches[0];
    const observed = runtimePanes.find(
      (candidate) => candidate.paneId === pane.paneId,
    );
    const sessionId =
      pane.role === "orchestrator"
        ? mission.orchestratorSessionId
        : dispatch?.sessionId;
    if (
      observed &&
      sessionId !== undefined &&
      observed.sessionId !== sessionId
    ) {
      return deadGraphResumeFailure(
        missionId,
        "A sessão física do pane antigo divergiu do vínculo durável; a missão permaneceu bloqueada.",
      );
    }
    if (
      !addTarget({
        paneId: pane.paneId,
        role: pane.role,
        sessionId: sessionId ?? observed?.sessionId ?? undefined,
        workerIncarnationId:
          pane.workerIncarnationId ?? dispatch?.workerIncarnationId,
        observedInRuntime: observed !== undefined,
      })
    ) {
      return deadGraphResumeFailure(
        missionId,
        "As identidades do pane antigo são ambíguas; a missão permaneceu bloqueada.",
      );
    }
  }

  for (const dispatch of invalidated) {
    const bySession = dispatch.sessionId
      ? runtimePanes.filter(
          (candidate) => candidate.sessionId === dispatch.sessionId,
        )
      : [];
    const byPane = dispatch.paneId
      ? runtimePanes.filter(
          (candidate) => candidate.paneId === dispatch.paneId,
        )
      : [];
    const observed = [...new Set([...bySession, ...byPane])];
    if (observed.length > 1) {
      return deadGraphResumeFailure(
        missionId,
        "O worker antigo possui mais de uma identidade física; a missão permaneceu bloqueada.",
      );
    }
    const runtime = observed[0];
    if (
      runtime &&
      ((dispatch.paneId !== undefined &&
        runtime.paneId !== dispatch.paneId) ||
        (dispatch.sessionId !== undefined &&
          runtime.sessionId !== dispatch.sessionId))
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O worker físico divergiu do dispatch terminal; a missão permaneceu bloqueada.",
      );
    }
    const paneId = dispatch.paneId ?? runtime?.paneId;
    const sessionId = dispatch.sessionId ?? runtime?.sessionId ?? undefined;
    if (!paneId) {
      if (sessionId && deps.getSessionState(sessionId) !== null) {
        return deadGraphResumeFailure(
          missionId,
          "Há uma sessão antiga viva sem pane identificável; a missão permaneceu bloqueada.",
        );
      }
      continue;
    }
    if (
      !addTarget({
        paneId,
        role: "worker",
        sessionId,
        workerIncarnationId: dispatch.workerIncarnationId,
        observedInRuntime: runtime !== undefined,
      })
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O dispatch terminal conflita com a identidade do pane antigo; a missão permaneceu bloqueada.",
      );
    }
  }

  if (mission.orchestratorSessionId) {
    const observed = runtimePanes.filter(
      (pane) => pane.sessionId === mission.orchestratorSessionId,
    );
    if (observed.length > 1) {
      return deadGraphResumeFailure(
        missionId,
        "A sessão do orquestrador antigo está vinculada a múltiplos panes.",
      );
    }
    if (
      observed[0] &&
      !addTarget({
        paneId: observed[0].paneId,
        role: "orchestrator",
        sessionId: mission.orchestratorSessionId,
        observedInRuntime: true,
      })
    ) {
      return deadGraphResumeFailure(
        missionId,
        "A identidade do orquestrador antigo é ambígua; a missão permaneceu bloqueada.",
      );
    }
  }

  for (const runtime of runtimePanes) {
    if (
      (runtime.role !== "orchestrator" && runtime.role !== "worker") ||
      !addTarget({
        paneId: runtime.paneId,
        role: runtime.role,
        sessionId: runtime.sessionId ?? undefined,
        workerIncarnationId: runtime.workerIncarnationId,
        observedInRuntime: true,
      })
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O inventário físico antigo não possui autoridade exata para encerramento.",
      );
    }
  }

  const knownSessions = new Set(
    [...targets.values()]
      .map((target) => target.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  try {
    for (const sessionId of knownSessions) {
      deps.revokeSessionAuthority(sessionId);
    }
  } catch {
    return deadGraphResumeFailure(
      missionId,
      "A autoridade de uma sessão antiga não pôde ser revogada; a missão permaneceu bloqueada.",
    );
  }

  for (const target of targets.values()) {
    if (!target.observedInRuntime) {
      if (
        target.sessionId &&
        deps.getSessionState(target.sessionId) !== null
      ) {
        return deadGraphResumeFailure(
          missionId,
          "A sessão antiga continua viva sem um pane físico verificável; a missão permaneceu bloqueada.",
        );
      }
      continue;
    }
    let closed = false;
    try {
      closed = await deps.closePane({
        paneId: target.paneId,
        missionId,
        scope,
        sessionId: target.sessionId,
        role: target.role,
        workerIncarnationId: target.workerIncarnationId,
      });
    } catch {
      closed = false;
    }
    if (
      !closed ||
      (target.sessionId &&
        deps.getSessionState(target.sessionId) !== null)
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O Nexus não obteve prova de encerramento físico de todos os panes e sessões antigos; a missão permaneceu bloqueada.",
      );
    }
  }

  for (const dispatch of invalidated) {
    if (
      dispatch.sessionId &&
      deps.getSessionState(dispatch.sessionId) !== null
    ) {
      return deadGraphResumeFailure(
        missionId,
        "Um worker antigo permaneceu vivo após o teardown; a missão permaneceu bloqueada.",
      );
    }
  }
  const runtimeAfterClose = deps
    .listRuntimePanes()
    .filter((pane) => pane.missionId === missionId);
  if (
    runtimeAfterClose.some((pane) => {
      const target = targets.get(pane.paneId);
      return (
        !target ||
        !pane.scope ||
        !sameScope(pane.scope, scope) ||
        pane.role !== target.role ||
        (target.sessionId !== undefined &&
          pane.sessionId !== target.sessionId) ||
        (pane.sessionId !== null &&
          deps.getSessionState(pane.sessionId) !== null)
      );
    })
  ) {
    return deadGraphResumeFailure(
      missionId,
      "O inventário físico mudou durante o teardown; a missão permaneceu bloqueada.",
    );
  }

  if (!sameDeadGraphMissionFence(mission, deps.getMission(scope, missionId))) {
    return deadGraphResumeFailure(
      missionId,
      "A missão mudou durante o teardown físico; a revisão nova não foi publicada.",
    );
  }
  const originalPaneRows = new Set(persistedPanes.map((pane) => pane.id));
  const panesBeforeCommit = deps.listMissionPanes(scope, missionId);
  if (panesBeforeCommit.some((pane) => !originalPaneRows.has(pane.id))) {
    return deadGraphResumeFailure(
      missionId,
      "Um novo pane apareceu durante o teardown; a revisão nova não foi publicada.",
    );
  }
  for (const pane of panesBeforeCommit) {
    let removed = false;
    try {
      removed = deps.removeMissionPane(scope, pane.id);
    } catch {
      removed = false;
    }
    if (
      !removed &&
      deps
        .listMissionPanes(scope, missionId)
        .some((candidate) => candidate.id === pane.id)
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O vínculo durável de um pane antigo não pôde ser removido; a missão permaneceu bloqueada.",
      );
    }
  }
  if (deps.listMissionPanes(scope, missionId).length > 0) {
    return deadGraphResumeFailure(
      missionId,
      "O teardown durável dos panes antigos ficou incompleto; a missão permaneceu bloqueada.",
    );
  }

  let reapproval: Mission;
  try {
    reapproval = deps.publishReapprovalRevision(scope, missionId, mission);
  } catch (error) {
    return deadGraphResumeFailure(
      missionId,
      failureDetail(
        "A missão mudou antes do CAS da nova revisão; ela permaneceu bloqueada.",
        error,
      ),
    );
  }
  return Object.freeze({
    ok: false,
    missionId,
    reason: "review_required",
    intentVersion: reapproval.intentVersion,
    error:
      "A execução anterior foi encerrada. Revise a nova versão e aprove novamente antes de iniciar.",
    cta: "Revisar e aprovar",
  });
}

/**
 * Re-arm a bootstrap-blocked mission and retry the orchestrator bootstrap.
 * The bootstrap re-validates every authority (squad hash, contract, runtime)
 * and re-blocks with an actionable marker if the retry fails again.
 */
export async function resumeBlockedMissionBootstrapForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<MissionOrchestratorBootstrapResult> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: "Missão não encontrada neste workspace.",
      cta: BOOTSTRAP_CTA,
    };
  }
  const deadGraphReapproval = await prepareDeadGraphReapprovalForScope(
    scope,
    missionId,
  );
  if (deadGraphReapproval) return deadGraphReapproval;
  if (mission.description.includes(PLAN_PROMOTION_BLOCK_MARKER)) {
    const promotionResume = blockedPlanPromotionResumePatch(mission);
    if (!promotionResume.ok) {
      return {
        ok: false,
        missionId,
        reason: 'not_authorized',
        error: promotionResume.error,
        cta: BOOTSTRAP_CTA,
      };
    }
    const reset = stores.missions.update(missionId, promotionResume.patch);
    if (!reset) {
      return {
        ok: false,
        missionId,
        reason: 'not_authorized',
        error:
          'A missão mudou durante a retomada da promoção. Tente novamente.',
        cta: BOOTSTRAP_CTA,
      };
    }
    return restartMissionOrchestratorAfterPlanPromotionForScope(
      scope,
      missionId,
      promotionResume.intentVersion,
    );
  }
  const resume = blockedBootstrapResumePatch(mission);
  if (!resume.ok) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: resume.error,
      cta: BOOTSTRAP_CTA,
    };
  }
  // Bootstrap re-entry refuses while a stale orchestrator identity persists
  // (dead session + pane row): it #failures with the SAME "Retomar missão"
  // CTA this resume implements — a circular dead end. A PROVEN-dead session
  // (no PTY state) holds no execution; clear the durable identity so the
  // bootstrap takes its fresh spawn+kickoff path. A live session is left
  // untouched — its duplicate-kickoff guard stands.
  const staleSessionId = mission.orchestratorSessionId;
  if (!staleSessionId || getSessionState(staleSessionId) === null) {
    if (staleSessionId) {
      stores.missions.setOrchestratorSession(missionId, null);
    }
    for (const row of stores.missionPanes.list(missionId)) {
      if (row.role === "orchestrator") stores.missionPanes.remove(row.id);
    }
  }
  const updated = stores.missions.update(missionId, resume.patch);
  if (!updated) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: "A missão mudou durante a retomada. Tente novamente.",
      cta: BOOTSTRAP_CTA,
    };
  }
  return bootstrapMissionOrchestratorForScope(scope, missionId);
}

/** Starts durable-scope discovery before the coordinator's first pass. */
export function prepareMissionOrchestratorBootstrapRecovery(): void {
  if (disposeProductionScopeListener) return;
  disposeProductionScopeListener = requireProjectDomainStoreRegistry().onScope(
    (scope) => {
      productionScopes.set(productionScopeKey(scope), scope);
      // onScope runs after the durable suite is registered. Starting the
      // singleflight here closes restart recovery even before the renderer
      // reopens, while the coordinator supplies the periodic safety net.
      void productionRecovery.reconcile();
    },
  );
}

export function reconcileMissionOrchestratorBootstrap(): Promise<void> {
  return productionRecovery.reconcile();
}

export async function shutdownMissionOrchestratorBootstrapRecovery(): Promise<void> {
  disposeProductionScopeListener?.();
  disposeProductionScopeListener = null;
  productionScopes.clear();
  await productionRecovery.waitForIdle();
}

/** Renderer boundary: the only accepted input is the opaque mission id. */
export function bootstrapMissionOrchestratorFromRenderer(
  owner: WebContents,
  raw: unknown,
): Promise<MissionOrchestratorBootstrapResult> {
  const input = missionOrchestratorBootstrapRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  return bootstrapMissionOrchestratorForScope(scope, input.missionId);
}

/** Renderer boundary for retrying a bootstrap-blocked mission. */
export function resumeBlockedMissionBootstrapFromRenderer(
  owner: WebContents,
  raw: unknown,
): Promise<MissionOrchestratorBootstrapResult> {
  const input = missionOrchestratorBootstrapRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  return resumeBlockedMissionBootstrapForScope(scope, input.missionId);
}
