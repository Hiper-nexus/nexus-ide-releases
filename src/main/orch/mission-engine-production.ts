import path from "node:path";
import { missionExecutionScope, prepareMissionExecutionScope } from './mission-execution-scope';
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import type { WorktreeRecord } from "../runtime/worktree-contract";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WebContents } from "electron";
import { z } from "zod";
import {
  missionEngineCommandSchema,
  type MissionEngineCommand,
  type MissionResult,
} from "../../shared/mission-engine-contract";
import { parseClarifyAnswerArtifact } from "../../shared/clarify";
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  type MissionOrchestratorRuntimeSnapshot,
} from "../../shared/mission-intent";
import {
  MISSION_RUNTIME_CLOSED_MARKER,
  withAwaitingAdjustmentMarker,
  wasMissionRuntimeClosedByOperator,
} from "../../shared/mission-recovery-policy";
import { stripMissionVerdictParagraph } from "../../shared/mission-block-cause";
import {
  persistLeftoverIsolation,
  shouldPersistLeftoverIsolation,
  wasMissionLeftoverParked,
  isFreshIniciarKickoff,
  NEXUS_LEFTOVER_PARKED_MARKER,
} from "../../shared/mission-leftover-isolation";
import {
  leftoverRunningOrPendingIsDead,
  wasUpdatedBeforeThisProcess,
} from "../../shared/session-restore-liveness";
import type {
  Handoff,
  Mission,
  MissionIntentState,
  MissionOrchestratorBootstrapResult,
  MissionPaneSpec,
  MissionStatus,
  PaneSnapshot,
  SquadAgent,
} from "../../shared/orch-types";
import { listAdapters } from "../adapters/adapter-registry";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from "../../shared/pet-studio";
import { assertIndependentReviewForDone, missionRequiresIndependentReview } from "./mission-independent-review-gate";
import { assertDeliveryArtifactsForDone } from "./mission-delivery-artifact-gate";
import { getAutomaticCompletionProof } from "./automatic-completion-proof";
import { resolveFrozenMissionReviewProof } from "./mission-review-proof";
import { assertTeamQuestionCompletion, teamQuestionResponseSummary, type TeamQuestionObserverBinding, type TeamQuestionPaneRuntime } from "./mission-team-question-completion";
import { noteOperatorDirection } from "./operator-cli-mentions";
import { loadObserverPaneSessions } from "./mission-team-question-observer";
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import {
  revalidateSealedAttachmentSnapshots,
  workspaceRootAuthorityFromScope,
} from "../persistence/dropped-files";
import {
  getAgentSessionInfo,
  getSessionState,
  listAgentSessions,
  listAgentSessionsForPane,
  type OwnedAgentSessionInfo,
} from "../pty/pty-manager";
import {
  getAcpDriverSemanticStatus,
  getAcpDriverSession,
  listAcpDriverAgentSessions,
} from "../acp/acp-harness-driver";
import {
  getAgentSemanticStatus,
  getAgentSemanticStatusBySession,
} from "./agent-status";
import {
  assertSafePtyPrompt,
  deliverAgentPrompt,
} from "./tool-util";
import { emitMissionEvent } from "./mission-event-emit";
import {
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  readSessionOutput,
  wasOrchestratorOperatorDismissed,
  type PaneRuntimeAuthority,
} from "./pane-registry";
import {
  enqueueKickoffDirect,
  isKickoffInProgressError,
  rememberedKickoffBrief,
  takeKickoffDirects,
  tryRecordIdleKickoffAcceptance,
} from "./mission-kickoff-direct-queue";
import { maestroKickoffBlockReason } from "./maestro-boot-gate";
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import { withMissionLifecycleLock } from "./mission-lifecycle-lock";
import {
  fastLaneBootstrap,
  fastLaneOrchestratorPaneSummary,
  resumeFastLaneMission,
} from "./mission-fast-lane";
import { getSquad } from "./squad-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { isFreeAgentChoiceContract } from "./free-agent-choice";
import {
  MainMissionEngine,
  type MissionStartInput,
  type MissionVerifiedCompletionInput,
} from "./mission-engine";
import { createMissionEnginePreparationPorts } from "./mission-engine-preparation";
import type { ScopedMissionStore } from "./mission-store";
import {
  configureMissionEngineForScope,
  MissionEngineRegistry,
} from "./mission-engine-registry";
import {
  taskDispatchBlockDetailFromDescription,
  taskDispatchTechnicalResumeDescription,
} from "./task-dispatch-persistence";
import {
  missionViewHasFiles,
  missionViewHasLiveWorkingRuntime,
  missionViewHasResidualWork,
  resolveMissionAgentLiveState,
  type MissionAgentTaskFallback,
  type ProjectMissionSnapshotView,
} from "./mission-snapshot";
import { resolveOpenMissionQuestion } from "./mission-open-question";
import { isOperatorTabMission } from "./operator-tab-mission-resume";
import { sameMissionPaneAuthoritySeal } from "./mission-pane-authority";
import { MissionLeadershipError, type MissionLeader } from "./mission-leadership";
import { getMissionLeadership } from "./mission-leadership-runtime";

/**
 * Produção do motor de missão da Via Rápida (2026-08-10).
 *
 * Substitui o antigo mission-orchestrator-bootstrap.ts: aqui vivem SOMENTE as
 * partes que a Via Rápida usa — o registro do MainMissionEngine por escopo,
 * o selo do review de início, a entrega direta do operador, a projeção de
 * snapshot e os boundaries do renderer/cron. O pipeline cerimonial (plano
 * selado, scheduler, kickoff ping-pong, merge queue, recovery periódica) foi
 * removido fisicamente.
 */

const BOOTSTRAP_CTA = "Retomar missão";

export const missionOrchestratorBootstrapRequestSchema = z
  .object({
    missionId: z.string().min(1).max(128),
  })
  .strict();

/** Main-owned session inventory shared by PTY and ACP mission transports. */
function runtimeAgentSessionInfo(
  sessionId: string,
): OwnedAgentSessionInfo | null {
  return (
    getAgentSessionInfo(sessionId) ?? getAcpDriverSession(sessionId)?.agent ?? null
  );
}

function runtimeSessionState(
  sessionId: string,
): ReturnType<typeof getSessionState> {
  return (
    getSessionState(sessionId) ?? (getAcpDriverSession(sessionId) ? "idle" : null)
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
    left.rootRealPath === right.rootRealPath &&
    left.workspaceRootDevice === right.workspaceRootDevice &&
    left.workspaceRootInode === right.workspaceRootInode
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
  // Canonical path only: symlink / trailing-slash / realpath spelling must not
  // tear down a healthy Maestro PTY (field: agent.cwd×pane false-negative).
  check(
    "agent.cwd×pane",
    agent.cwd === undefined ? undefined : path.resolve(agent.cwd),
    pane.cwd === undefined ? undefined : path.resolve(pane.cwd),
  );
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
  const executionScope = mission.intentContract?.workspaceBinding
    ? missionExecutionScope(scope, mission) : pane.executionScope ?? scope;
  if (!sameScope(agent.scope, executionScope)) mismatches.push("agent.scope");
  if (pane.executionScope && !sameScope(pane.executionScope, executionScope)) mismatches.push("pane.executionScope");
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

export function sealMissionStartReview(
  missions: Pick<ScopedMissionStore, "get" | "transitionLifecycle">,
  input: MissionStartInput,
): Mission {
  const current = missions.get(input.missionId);
  const reviewSha256 = current?.intentContract?.approvalReviewSha256;
  const approved = current
    ? hasCurrentApprovedDispatchContract(current)
    : false;
  const lifecycleOk = Boolean(
    current &&
      ((current.status === "pending" &&
        current.intentState === "ready_to_start") ||
        (current.status === "running" &&
          (current.intentState === "dispatched" ||
            current.intentState === "executing"))),
  );
  const hashOk = reviewSha256 === input.reviewSha256;
  if (!current || !approved || !hashOk || !lifecycleOk) {
    const reasons: string[] = [];
    if (!current) reasons.push("mission-missing");
    else {
      if (!approved) {
        reasons.push(
          `approval-missing(intentVersion=${current.intentVersion ?? "null"},contractIntentVersion=${current.intentContract?.intentVersion ?? "null"},approvedAt=${current.intentContract?.approvedAt ?? "null"},goalEmpty=${!(current.intentContract?.goal?.trim())})`,
        );
      }
      if (!hashOk) {
        reasons.push(
          `hash-mismatch(persisted=${reviewSha256 ?? "null"},input=${input.reviewSha256})`,
        );
      }
      if (!lifecycleOk) {
        reasons.push(
          `lifecycle(${current.status}/${current.intentState ?? "null"})`,
        );
      }
    }
    console.error("[mission-start-seal] review fence rejected", {
      missionId: input.missionId,
      reasons,
      status: current?.status ?? null,
      intentState: current?.intentState ?? null,
      intentVersion: current?.intentVersion ?? null,
      contractIntentVersion: current?.intentContract?.intentVersion ?? null,
      approvedAt: current?.intentContract?.approvedAt ?? null,
      persistedReviewSha256: reviewSha256 ?? null,
      inputReviewSha256: input.reviewSha256,
      dispatchedAt: current?.intentContract?.dispatchedAt ?? null,
    });
    throw new Error(
      `mission start review fence changed before seal (${reasons.join("; ")})`,
    );
  }
  const dispatchedAt =
    typeof current.intentContract?.dispatchedAt === "number" &&
    current.intentContract.dispatchedAt > 0
      ? current.intentContract.dispatchedAt
      : Date.now();
  const sealed = missions.transitionLifecycle(
    current.id,
    {
      updatedAt: current.updatedAt,
      intentVersion: current.intentVersion ?? 0,
    },
    {
      status: current.status,
      intentState: current.intentState!,
      intentContract: {
        ...current.intentContract!,
        dispatchedAt,
      },
    },
  );
  if (
    !sealed ||
    sealed.intentContract?.approvalReviewSha256 !== input.reviewSha256 ||
    sealed.intentContract.dispatchedAt !== dispatchedAt
  ) {
    throw new Error("mission start seal CAS changed before bootstrap");
  }
  return sealed;
}

type MissionDirectCommand = Extract<
  MissionEngineCommand,
  { readonly kind: "direct" }
>;

export interface MissionDirectDeliveryDeps {
  readonly getRuntimeAgentSessionInfo: (
    sessionId: string,
  ) => OwnedAgentSessionInfo | null;
  readonly getAcpDriverSession: typeof getAcpDriverSession;
  readonly getAcpDriverSemanticStatus: typeof getAcpDriverSemanticStatus;
  readonly getPaneRuntimeAuthorityBySession:
    typeof getPaneRuntimeAuthorityBySession;
  readonly getSquad: typeof getSquad;
  /** Workers vivos (PTY + ACP) de uma missão — o alvo do caminho operador-como-orquestrador. */
  readonly listMissionWorkerSessions: (
    missionId: string,
  ) => readonly OwnedAgentSessionInfo[];
  readonly deliverAgentPrompt: typeof deliverAgentPrompt;
  readonly emitMissionEvent: typeof emitMissionEvent;
  /**
   * Overclock/B2: comando do operador religa o Maestro em vez de falhar
   * fechado quando a sessão ou o recibo de kickoff morreram no exit 0.
   */
  readonly resumeOrchestrator?: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => Promise<void>;
  readonly getSessionState?: (sessionId: string) => string | null;
  readonly readSessionOutput?: (sessionId: string, maxLines?: number) => string;
  /** F-682: orientação aceita vira prova de pedido do operador (menção de CLI). */
  readonly noteOperatorDirection?: (sessionId: string, text: string) => void;
}

export interface MissionDirectDeliveryOptions {
  /** Flush da fila já emitiu a orientação na conversa. */
  readonly conversationAlreadyAccepted?: boolean;
}

const productionMissionDirectDeliveryDeps: MissionDirectDeliveryDeps = {
  getRuntimeAgentSessionInfo: runtimeAgentSessionInfo,
  getAcpDriverSession,
  getAcpDriverSemanticStatus,
  getPaneRuntimeAuthorityBySession,
  getSquad,
  listMissionWorkerSessions: (missionId) =>
    [
      ...listAgentSessions().filter(
        (session) =>
          session.missionId === missionId && session.role === "worker",
      ),
      ...listAcpDriverAgentSessions().filter(
        (session) =>
          session.missionId === missionId && session.role === "worker",
      ),
    ],
  deliverAgentPrompt,
  emitMissionEvent,
  resumeOrchestrator: resumeFastLaneMission,
  getSessionState,
  readSessionOutput,
  noteOperatorDirection,
};

interface MissionDirectAuthority {
  readonly mission: Mission;
  readonly sessionId: string;
  readonly adapterId: string;
  /** Direção entregue direto ao worker (squad sem orquestrador na Via Rápida). */
  readonly operatorDirectToWorker: boolean;
  /** Missão da aba: alvos são 'orchestrator'/null ou 'pane:<paneId>' de worker. */
  readonly operatorTabMission: boolean;
  readonly authorityFingerprint: string;
}

/**
 * Squad selada: devolve o hash de revisão de squad autorizado. Quando um alvo
 * é nomeado, re-valida contra a squad viva e exige pertencimento (gate 8).
 */
function sealedSquadTargetHash(
  mission: Mission,
  command: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps,
): string | null {
  const sealedHash = mission.intentContract?.squadRevisionHash ?? null;
  if (command.targetAgentId === null) {
    return sealedHash;
  }
  const currentSquad = mission.squadId ? deps.getSquad(mission.squadId) : null;
  if (!currentSquad || !sealedHash) {
    throw new Error("mission direct target requires sealed squad authority");
  }
  const currentSquadSnapshot = snapshotSquadAuthority(currentSquad);
  if (currentSquadSnapshot.hash !== sealedHash) {
    throw new Error("mission direct target squad authority is stale");
  }
  if (
    !currentSquadSnapshot.agents.some(
      (candidate) => candidate.id === command.targetAgentId,
    )
  ) {
    throw new Error("mission direct target agent is not in the sealed squad");
  }
  return currentSquadSnapshot.hash;
}

/**
 * Caminho operador-como-orquestrador: resolve o worker vivo alvo da direção.
 * Sem alvo nomeado exige exatamente um worker (direção à missão); com alvo
 * nomeado, casa o agente selado da squad com o worker vivo por agentName.
 */
/**
 * A direção à missão (targetAgentId null) só pode chegar num worker que a
 * squad SELADA autorizou — o mesmo gate 8 do alvo nomeado. Modo livre dispensa
 * o vínculo (worker decoupled da squad por opt-in selado); squad com selo e
 * hash divergente (drift pós-seal) falha fechado, como o caminho nomeado.
 */
function assertSealedSquadAuthorizesWorker(
  mission: Mission,
  worker: OwnedAgentSessionInfo,
  deps: MissionDirectDeliveryDeps,
): void {
  if (isFreeAgentChoiceContract(mission.intentContract)) return;
  const sealedHash = mission.intentContract?.squadRevisionHash ?? null;
  const currentSquad = mission.squadId ? deps.getSquad(mission.squadId) : null;
  if (!currentSquad || !sealedHash) {
    throw new Error("mission direct worker requires sealed squad authority");
  }
  const currentSquadSnapshot = snapshotSquadAuthority(currentSquad);
  if (currentSquadSnapshot.hash !== sealedHash) {
    throw new Error("mission direct squad authority is stale");
  }
  if (
    !currentSquadSnapshot.agents.some(
      (candidate) => candidate.agentName === worker.agentName,
    )
  ) {
    throw new Error("mission direct worker is not in the sealed squad");
  }
}

/**
 * Pane worker casa com a sessão viva do worker: mesmo paneId E identidade
 * consistente. Os campos de identidade são opcionais na spec (linhas legadas),
 * então só são exigidos quando presentes — um pane que declara identidade
 * divergente é rejeitado (finding 2 do security review: binding de pane não
 * podia ser só paneId).
 */
function workerPaneMatchesSession(
  pane: MissionPaneSpec,
  worker: OwnedAgentSessionInfo,
): boolean {
  if (pane.role !== "worker" || pane.paneId !== worker.paneId) return false;
  if (pane.agentName !== undefined && pane.agentName !== worker.agentName) {
    return false;
  }
  if (
    pane.workerIncarnationId !== undefined &&
    pane.workerIncarnationId !== worker.workerIncarnationId
  ) {
    return false;
  }
  return true;
}

/**
 * A squad SELADA contém um agente de categoria orquestrador? (finding 3 do
 * security review.) O discriminador "operador É o orquestrador" não pode ser
 * só `orchestratorSessionId == null`: se a missão foi selada COM orquestrador
 * e a sessão dele morreu/foi limpa, NÃO devemos descer silenciosamente para o
 * caminho worker — a direção precisa falhar fechada exigindo orquestrador vivo.
 * Squad divergente após o selo não decide (o hash é a autoridade).
 */
function sealedSquadHasOrchestrator(
  mission: Mission,
  deps: MissionDirectDeliveryDeps,
): boolean {
  const sealedHash = mission.intentContract?.squadRevisionHash ?? null;
  const currentSquad = mission.squadId ? deps.getSquad(mission.squadId) : null;
  if (!currentSquad || !sealedHash) return false;
  const snapshot = snapshotSquadAuthority(currentSquad);
  if (snapshot.hash !== sealedHash) return false;
  return snapshot.agents.some((agent) => agent.category === "orchestrator");
}

function resolveDirectWorkerSession(
  mission: Mission,
  command: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps,
): OwnedAgentSessionInfo {
  const liveWorkers = deps.listMissionWorkerSessions(mission.id);
  if (command.targetAgentId === null) {
    if (liveWorkers.length !== 1) {
      throw new Error(
        liveWorkers.length === 0
          ? "mission direct requires a live worker in the fast-lane squad"
          : "mission direct for a single worker is ambiguous: name the target agent",
      );
    }
    const worker = liveWorkers[0];
    assertSealedSquadAuthorizesWorker(mission, worker, deps);
    return worker;
  }
  const currentSquad = mission.squadId ? deps.getSquad(mission.squadId) : null;
  const targetAgent = currentSquad?.agents.find(
    (candidate) => candidate.id === command.targetAgentId,
  );
  const match = liveWorkers.find(
    (worker) => worker.agentName === targetAgent?.agentName,
  );
  if (!match) {
    throw new Error("mission direct target worker is not live");
  }
  return match;
}

/**
 * Cura in-place o split-brain de linha persistida (status running + intent
 * blocked_*): writes status-only legados deixaram o cadáver de intent que
 * mata a autoridade de dispatch. A reativação passa pelo mission-store.update
 * — o guard de lá normaliza o intent para 'executing' (semântica do Retomar).
 * Best-effort: sem update disponível (harness/migração), devolve a linha como
 * está e o guard de autoridade decide o resto.
 */
function healSplitBrainMissionRow(
  stores: ProjectDomainStoreSuite,
  mission: NonNullable<ReturnType<ProjectDomainStoreSuite["missions"]["get"]>>,
): NonNullable<ReturnType<ProjectDomainStoreSuite["missions"]["get"]>> {
  const isSplit =
    mission.status === "running" &&
    (mission.intentState === "blocked_technical" ||
      mission.intentState === "blocked_user");
  if (!isSplit) return mission;
  const update = (
    stores.missions as unknown as {
      update?: (
        id: string,
        patch: { readonly status: "running" },
      ) => typeof mission | null;
    }
  ).update;
  if (typeof update !== "function") return mission;
  try {
    return update.call(stores.missions, mission.id, { status: "running" }) ?? mission;
  } catch {
    return mission;
  }
}

/**
 * Missão da aba (sem squad): não há squad selada para validar o alvo — os
 * alvos possíveis são o próprio Maestro ('orchestrator'/null) ou um helper
 * gravado como pane worker ('pane:<paneId>'). O Composer monta o seletor a
 * partir dos agentes sintetizados por estes mesmos specs, então a validação
 * é contra missionPanes, não contra um roster. O hash retornado segue o do
 * contrato (entra no fingerprint), nunca um selo de squad que não existe.
 */
function operatorTabDirectTargetHash(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
  command: MissionDirectCommand,
): string | null {
  const target = command.targetAgentId;
  if (target !== null && target !== "orchestrator") {
    const paneId = target.startsWith("pane:") ? target.slice(5) : null;
    const spec = paneId
      ? stores.missionPanes
          .list(mission.id)
          .find((candidate) => candidate.paneId === paneId)
      : null;
    if (!spec || spec.role !== "worker") {
      throw new Error("mission direct target is not an agent of this mission");
    }
  }
  return mission.intentContract?.squadRevisionHash ?? null;
}

function missionDirectAuthority(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  command: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps,
): MissionDirectAuthority {
  const stored = stores.missions.get(command.missionId);
  if (!stored || stored.id !== command.missionId) {
    throw new Error("mission direct requires a current mission");
  }
  const mission = healSplitBrainMissionRow(stores, stored);
  const operatorTab = isOperatorTabMission(mission);
  if (!hasCurrentDispatchAuthority(mission)) {
    throw new Error("mission direct requires live current dispatch authority");
  }

  // Só desce para o caminho worker quando a squad selada NÃO tem orquestrador
  // (modo livre) — se o selo previa orquestrador mas a sessão morreu, falha
  // fechada exigindo orquestrador vivo (finding 3 do security review).
  const operatorIsOrchestrator =
    mission.orchestratorSessionId == null && !sealedSquadHasOrchestrator(mission, deps);
  let sessionId: string;
  let pane: MissionPaneSpec;
  if (operatorIsOrchestrator) {
    // Via Rápida com squad sem orquestrador: o operador É o orquestrador.
    // Gates 1/2 acima já valem; a conclusão é observacional e a direção vai
    // contra um worker vivo — pular kickoff acceptance e o selo de runtime do
    // orquestrador, mantendo squad selada (8) e idempotência (9).
    const worker = resolveDirectWorkerSession(mission, command, deps);
    const workerPane =
      stores.missionPanes
        .list(mission.id)
        .find((candidate) => workerPaneMatchesSession(candidate, worker)) ?? null;
    if (!workerPane) {
      throw new Error("mission direct worker pane authority is incomplete");
    }
    sessionId = worker.sessionId;
    pane = workerPane;
  } else {
    // Missão da aba (sem squad, liderada pelo pane promovido do operador):
    // nunca houve briefing de kickoff, logo o recibo nunca existirá — exigi-lo
    // era o erro cru do print. TODOS os demais gates seguem iguais: sessão
    // viva, pane orquestrador gravado para a sessão, selo de runtime quando
    // o contrato o traz, hash de squad e fingerprint/idempotência.
    if (
      !operatorTab &&
      !stores.missions.hasCurrentKickoffAcceptance(mission.id)
    ) {
      throw new Error("mission direct requires the current kickoff receipt");
    }
    const orchestratorSessionId = mission.orchestratorSessionId;
    if (!orchestratorSessionId) {
      throw new Error("mission direct requires a live orchestrator session");
    }
    const agent = deps.getRuntimeAgentSessionInfo(orchestratorSessionId);
    if (!agent) {
      throw new Error("mission direct orchestrator session is not live");
    }
    const orchestratorPane =
      stores.missionPanes
        .list(mission.id)
        .find(
          (candidate) =>
            candidate.role === "orchestrator" &&
            candidate.paneId === agent.paneId,
        ) ?? null;
    if (!orchestratorPane) {
      throw new Error("mission direct orchestrator authority is incomplete");
    }
    const approvedRuntime = mission.intentContract?.orchestratorRuntime;
    if (approvedRuntime) {
      const mismatches = runtimeAuthorityMismatches(
        scope,
        mission,
        orchestratorPane,
        agent,
        deps.getPaneRuntimeAuthorityBySession(orchestratorSessionId),
        approvedRuntime,
      );
      if (mismatches.length > 0) {
        throw new Error(
          `mission direct orchestrator authority mismatch: ${mismatches[0]}`,
        );
      }
    }
    sessionId = orchestratorSessionId;
    pane = orchestratorPane;
  }

  const squadRevisionHash = operatorTab
    ? operatorTabDirectTargetHash(stores, mission, command)
    : sealedSquadTargetHash(mission, command, deps);

  const authorityFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        scope: {
          installationId: scope.installationId,
          projectId: scope.projectId,
          checkoutId: scope.checkoutId,
          rootRealPath: scope.rootRealPath,
        },
        missionId: mission.id,
        intentVersion: mission.intentVersion ?? 0,
        sessionId,
        paneId: pane.paneId,
        adapterId: pane.adapterId,
        squadRevisionHash,
        targetAgentId: command.targetAgentId,
        text: command.text,
      }),
    )
    .digest("hex");
  return {
    mission,
    sessionId,
    adapterId: pane.adapterId,
    operatorDirectToWorker: operatorIsOrchestrator,
    operatorTabMission: operatorTab,
    authorityFingerprint,
  };
}

function isRecoverableMissionDirectFailure(
  mission: Mission,
  error: unknown,
): boolean {
  if (mission.status === "pending") return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("live orchestrator session") ||
    message.includes("orchestrator session is not live") ||
    message.includes("current kickoff receipt") ||
    message.includes("orchestrator authority is incomplete") ||
    (mission.status === "blocked" &&
      message.includes("live current dispatch authority"))
  );
}

async function resolveMissionDirectAuthority(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  command: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps,
): Promise<MissionDirectAuthority> {
  try {
    return missionDirectAuthority(scope, stores, command, deps);
  } catch (error) {
    const mission = stores.missions.get(command.missionId);
    if (
      !mission ||
      !deps.resumeOrchestrator ||
      !isRecoverableMissionDirectFailure(mission, error)
    ) {
      throw error;
    }
    await deps.resumeOrchestrator(scope, command.missionId);
    return missionDirectAuthority(scope, stores, command, deps);
  }
}

function missionDirectPrompt(
  command: MissionDirectCommand,
  operatorDirectToWorker: boolean,
  operatorTabMission: boolean,
): string {
  const payload = {
    kind: "operator_direction" as const,
    targetAgentId: command.targetAgentId,
    text: command.text,
  };
  let targetRule: string;
  if (operatorDirectToWorker) {
    targetRule =
      command.targetAgentId === null
        ? "The operator directs this mission directly: apply the direction to the current work."
        : "The operator selected this agent directly: apply the direction to the current work.";
  } else if (operatorTabMission) {
    // Missão da aba: o Maestro é a conversa do operador e os helpers são
    // panes — o repasse é por nexus_pane_write, não por id de squad.
    targetRule =
      command.targetAgentId === null ||
      command.targetAgentId === "orchestrator"
        ? "Apply this direction to your current mission."
        : `Route this direction to the mission helper in pane ${JSON.stringify(command.targetAgentId.slice("pane:".length))} with nexus_pane_write and retain orchestration authority.`;
  } else {
    targetRule =
      command.targetAgentId === null
        ? "Apply this direction to your current mission."
        : `Route this direction to exactly squad agent ${JSON.stringify(command.targetAgentId)} and retain orchestration authority.`;
  }
  return assertSafePtyPrompt(
    [
      "Nexus operator direction accepted by the main process.",
      targetRule,
      "Exact direction envelope:",
      JSON.stringify(payload),
    ].join("\n"),
  );
}

/**
 * Main-owned canonical direct path. Renderer input selects neither a session
 * nor a transport: both are rederived from the current sealed mission. The
 * method resolves only after PTY acceptance proof (or the ACP turn boundary),
 * revalidates that exact authority, then emits the bounded conversation event.
 */
function tryAcceptIdleKickoffForDirect(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
  deps: MissionDirectDeliveryDeps,
): boolean {
  if (stores.missions.hasCurrentKickoffAcceptance(mission.id)) return true;
  const sessionId = mission.orchestratorSessionId;
  const brief = rememberedKickoffBrief(mission.id);
  if (!sessionId || !brief) return false;
  if (brief.orchestratorSessionId !== sessionId) return false;
  const record = (
    stores.missions as {
      recordKickoffAcceptance?: (raw: {
        readonly missionId: string;
        readonly intentVersion: number;
        readonly orchestratorSessionId: string;
        readonly promptHash: string;
      }) => unknown;
    }
  ).recordKickoffAcceptance;
  if (typeof record !== "function") return false;
  return tryRecordIdleKickoffAcceptance({
    missionId: mission.id,
    sessionId,
    intentVersion: brief.intentVersion,
    promptHash: brief.promptHash,
    sessionIdle: deps.getSessionState?.(sessionId) === "idle",
    sessionOutput: deps.readSessionOutput?.(sessionId, 80) ?? "",
    hasCurrentKickoffAcceptance: false,
    recordKickoffAcceptance: record,
  });
}

function emitOperatorDirectionAccepted(
  scope: ProjectExecutionScope,
  command: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps,
  fingerprint: string,
): void {
  deps.emitMissionEvent(scope, {
    missionId: command.missionId,
    runId: "operator-direction",
    type: "custom",
    origin: "main",
    idempotencyKey: `operator_direction:${fingerprint}`,
    payload: {
      kind: "operator_direction" as const,
      targetAgentId: command.targetAgentId,
      text: command.text,
    },
  });
}

/**
 * Main-owned canonical direct path. Renderer input selects neither a session
 * nor a transport: both are rederived from the current sealed mission. The
 * method resolves only after PTY acceptance proof (or the ACP turn boundary),
 * revalidates that exact authority, then emits the bounded conversation event.
 *
 * Durante o kickoff (recibo ainda ausente) a linha do operador entra na fila
 * ou o recibo é aceito se o pane já está idle com o briefing injetado — nunca
 * um erro técnico em inglês.
 */
export async function deliverMissionDirectInstruction(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  rawCommand: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps = productionMissionDirectDeliveryDeps,
  options: MissionDirectDeliveryOptions = {},
): Promise<void> {
  assertSafePtyPrompt(rawCommand.text);
  const parsed = missionEngineCommandSchema.parse(rawCommand);
  if (parsed.kind !== "direct") {
    throw new Error("mission direct received a non-direct command");
  }
  const command = parsed;
  assertSafePtyPrompt(command.text);
  const storedForKickoff = stores.missions.get(command.missionId);
  if (storedForKickoff) {
    tryAcceptIdleKickoffForDirect(stores, storedForKickoff, deps);
  }
  let initial: MissionDirectAuthority;
  try {
    initial = await resolveMissionDirectAuthority(
      scope,
      stores,
      command,
      deps,
    );
  } catch (error) {
    const mission = stores.missions.get(command.missionId);
    const hasReceipt = mission
      ? stores.missions.hasCurrentKickoffAcceptance(mission.id)
      : false;
    if (
      mission &&
      isKickoffInProgressError(error, hasReceipt) &&
      sealedSquadHasOrchestrator(mission, deps)
    ) {
      const sessionId = mission.orchestratorSessionId;
      const bootBlock = sessionId
        ? maestroKickoffBlockReason(
            deps.readSessionOutput?.(sessionId, 80) ?? "",
          )
        : null;
      if (bootBlock) {
        throw new Error(
          "A coordenação ainda está no login. Conclua a autenticação e envie de novo.",
        );
      }
      const queuedFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            missionId: command.missionId,
            targetAgentId: command.targetAgentId,
            text: command.text,
            phase: "kickoff-queue",
          }),
        )
        .digest("hex");
      enqueueKickoffDirect({
        missionId: command.missionId,
        targetAgentId: command.targetAgentId,
        text: command.text,
      });
      if (!options.conversationAlreadyAccepted) {
        emitOperatorDirectionAccepted(
          scope,
          command,
          deps,
          queuedFingerprint,
        );
      }
      return;
    }
    throw error;
  }
  const prompt = missionDirectPrompt(
    command,
    initial.operatorDirectToWorker,
    initial.operatorTabMission,
  );
  const acpSession = deps.getAcpDriverSession(initial.sessionId);
  if (acpSession) {
    const status = deps.getAcpDriverSemanticStatus(initial.sessionId);
    if (status !== "idle" && status !== "completed") {
      throw new Error("mission direct ACP target is not ready");
    }
    // `promptLiveSession` emits turn_started and flips semantic status to
    // working synchronously, before its promise follows the provider's full
    // turn. That transition is the ACP acceptance receipt.
    const turn = acpSession.prompt(prompt);
    if (deps.getAcpDriverSemanticStatus(initial.sessionId) !== "working") {
      void turn.catch(() => undefined);
      throw new Error("mission direct ACP turn was not accepted");
    }
    void turn.catch((error) => {
      console.warn("[mission-direct] ACP turn ended after acceptance:", error);
    });
  } else {
    const accepted = await deps.deliverAgentPrompt(
      initial.sessionId,
      prompt,
      undefined,
      { adapterId: initial.adapterId },
    );
    if (!accepted) {
      throw new Error("mission direct delivery was not accepted");
    }
  }

  const current = missionDirectAuthority(scope, stores, command, deps);
  if (
    current.sessionId !== initial.sessionId ||
    current.authorityFingerprint !== initial.authorityFingerprint
  ) {
    throw new Error("mission direct authority changed during delivery");
  }
  deps.noteOperatorDirection?.(initial.sessionId, command.text);
  if (!options.conversationAlreadyAccepted) {
    emitOperatorDirectionAccepted(
      scope,
      command,
      deps,
      initial.authorityFingerprint,
    );
  }
}

export async function flushQueuedKickoffDirectsForMission(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  missionId: string,
): Promise<void> {
  const queued = takeKickoffDirects(missionId);
  for (const item of queued) {
    try {
      await deliverMissionDirectInstruction(
        scope,
        stores,
        {
          kind: "direct",
          missionId: item.missionId,
          targetAgentId: item.targetAgentId,
          text: item.text,
        },
        productionMissionDirectDeliveryDeps,
        { conversationAlreadyAccepted: true },
      );
    } catch (error) {
      console.warn(
        "[mission-direct] orientação enfileirada no kickoff não entregue:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export function projectMissionEngineSnapshotView(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  missionId: string,
): ProjectMissionSnapshotView {
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error("mission not found");
  const livePaneSnapshots = listPaneSnapshots();
  // F-777: o helper aberto por nexus_pane_spawn com ACK pendente nasce sem
  // linha em missionPanes — o quadro desenhava só o orquestrador numa missão
  // com dez helpers vivos. O pane vivo da missão conta como membro.
  const missionPanes = withUnrecordedLiveHelperPanes(
    stores.missionPanes.list(missionId),
    livePaneSnapshots,
    missionId,
  );
  const worktrees = missionWorktreeViews(scope, mission.id);
  // Pane e sessão do orquestrador vêm do MESMO par (sessionId,paneId)
  // provado por resolveMissionLeader — nunca de duas derivações
  // independentes (C: primeiro pane com role='orchestrator'; A: campo
  // cru da missão), que podem apontar para encarnações diferentes.
  let leader: MissionLeader | null;
  try {
    leader = getMissionLeadership().resolveMissionLeader(scope, missionId);
  } catch (error) {
    if (!(error instanceof MissionLeadershipError)) throw error;
    if (error.code === "unavailable") {
      // Engine sem registry (fixtures, boot parcial): projeção de leitura
      // degrada à derivação durável de antes da onda 1 — campo da missão +
      // pane de papel orquestrador — sem prova física (proven=false).
      const durableSessionId = mission.orchestratorSessionId?.trim() || null;
      const durablePane =
        missionPanes.find((pane) => pane.role === "orchestrator") ?? null;
      leader = durableSessionId
        ? {
            sessionId: durableSessionId,
            paneId: durablePane?.paneId ?? null,
            source: "durable",
            proven: false,
          }
        : null;
    } else {
      console.warn(
        "[mission-engine] resolveMissionLeader falhou no snapshot (fail-closed, sem líder):",
        error.code,
      );
      leader = null;
    }
  }
  const orchestratorPane = leader?.paneId
    ? missionPanes.find((pane) => pane.paneId === leader.paneId) ?? null
    : null;
  const sessionId = leader?.sessionId ?? null;
  const sessionState = sessionId ? runtimeSessionState(sessionId) : null;
  // Via Rápida: coordenação viva = sessão viva. O selo cerimonial de
  // autoridade (runtimeAuthorityMismatches) pertencia ao motor antigo; o
  // caminho direto do operador ainda o valida integralmente.
  const orchestratorLive = Boolean(
    sessionId &&
      orchestratorPane &&
      (sessionState === "spawning" ||
        sessionState === "busy" ||
        sessionState === "idle"),
  );
  // Líder à deriva (campo 23/09): a sessão durável morreu (failover Claude →
  // GLM, restart) e o pane gravado como orquestrador voltou com a autoridade
  // persistida DESTA missão, mas ninguém religou a liderança. O quadro mostrava
  // o Maestro "Na fila" com o terminal trabalhando. Só leitura: o card aponta o
  // pane vivo e o estado vira "líder à deriva" — `orchestratorLive` continua
  // exigindo o líder provado, e nada aqui escreve autoridade.
  const leaderDrift = leader?.proven
    ? null
    : driftedOrchestratorSession(scope, missionId, missionPanes);
  const squad = mission.squadId ? getSquad(mission.squadId) : null;
  // Missão da aba (sem squad): não há roster persistido — a equipe do quadro
  // nasce dos panes que a missão gravou (Maestro provado/à deriva + cada
  // worker pelo próprio paneId). Sem isso roster=[] e o grafo dizia
  // "Não foi possível carregar a equipe" numa missão cheia de agentes.
  const roster: SquadAgent[] = squad
    ? squad.agents.map((agent) => ({
        ...agent,
        allowedTools: agent.allowedTools
          ? [...agent.allowedTools]
          : agent.allowedTools,
        allowedSkills: agent.allowedSkills
          ? [...agent.allowedSkills]
          : agent.allowedSkills,
      }))
    : squadlessMissionPaneRoster(missionPanes, orchestratorPane, leaderDrift);
  const rosterById = new Map(roster.map((agent) => [agent.id, agent] as const));
  const rosterByName = new Map(
    roster.map((agent) => [agent.agentName, agent] as const),
  );
  const taskAgentById = new Map(
    stores.tasks
      .listPlannedTasks(mission.id, mission.intentVersion ?? 0)
      .map((planned) => [planned.taskId, planned.agentRef] as const),
  );
  const tasks = stores.tasks.list(mission.id).map((task) => {
    const agentId = taskAgentById.get(task.id);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      ...(agentId ? { agentId } : {}),
      dependsOn: [] as string[],
      evidence: [] as Array<{ id: string; path?: string }>,
    };
  });
  const taskFallbackByAgent = new Map<string, MissionAgentTaskFallback>();
  for (const agent of roster) {
    const agentTasks = tasks.filter((task) => task.agentId === agent.id);
    if (agentTasks.some((task) => task.status === "running")) {
      taskFallbackByAgent.set(agent.id, "working");
    } else if (agentTasks.some((task) => task.status === "failed")) {
      taskFallbackByAgent.set(agent.id, "failed");
    } else if (
      agentTasks.length > 0 &&
      agentTasks.every((task) => task.status === "done")
    ) {
      taskFallbackByAgent.set(agent.id, "done");
    } else {
      taskFallbackByAgent.set(agent.id, "queued");
    }
  }
  const sessionByPaneId = new Map<string, string>();
  for (const snapshot of livePaneSnapshots) {
    if (snapshot.sessionId) {
      sessionByPaneId.set(snapshot.paneId, snapshot.sessionId);
    }
  }
  if (
    orchestratorPane?.paneId &&
    sessionId &&
    !sessionByPaneId.has(orchestratorPane.paneId)
  ) {
    sessionByPaneId.set(orchestratorPane.paneId, sessionId);
  }
  if (leaderDrift) sessionByPaneId.set(leaderDrift.paneId, leaderDrift.sessionId);
  const dispatches = stores.taskDispatches.list(missionId);
  for (const dispatch of dispatches) {
    if (dispatch.paneId && dispatch.sessionId && !sessionByPaneId.has(dispatch.paneId)) {
      sessionByPaneId.set(dispatch.paneId, dispatch.sessionId);
    }
  }
  const currentUnitByAgent = new Map<string, string>();
  for (const task of tasks) {
    if (task.status === "running" && task.agentId) {
      currentUnitByAgent.set(task.agentId, task.id);
    }
  }
  for (const dispatch of dispatches) {
    if (
      !dispatch.agentRef ||
      currentUnitByAgent.has(dispatch.agentRef) ||
      !["running", "spawning", "routed"].includes(dispatch.state)
    ) {
      continue;
    }
    currentUnitByAgent.set(dispatch.agentRef, dispatch.taskId);
  }

  const missionHandoffs = stores.handoffs.list({
    missionId: mission.id,
    includeDelivered: true,
  });
  const deliveries = missionHandoffDeliveries(missionHandoffs, [
    sessionId,
    leaderDrift?.sessionId ?? null,
  ]);
  const deliveryByAgentId = new Map<string, MissionHandoffDelivery>();
  const panes: ProjectMissionSnapshotView["panes"] = [];
  const claimedAgentIds = new Set<string>();
  // Mais NOVO primeiro: após uma retomada existem linhas antigas de panes
  // mortos para o mesmo agente, e o primeiro claim vence — iterar do mais
  // velho fazia o cartão do grafo mostrar "stopped" com o processo novo vivo.
  for (const pane of [...missionPanes].reverse()) {
    if (!pane.paneId) continue;
    let agentId: string | undefined;
    if (!squad) {
      // Missão da aba: helpers dividem agentName com frequência — a
      // identidade é o paneId, nunca o nome. O orquestrador continua sendo
      // só o pane do líder provado ou o do líder à deriva.
      if (
        pane.role === "orchestrator" &&
        (pane.paneId === orchestratorPane?.paneId ||
          pane.paneId === leaderDrift?.paneId)
      ) {
        agentId = "orchestrator";
      } else {
        const synthesizedId = `pane:${pane.paneId}`;
        if (rosterById.has(synthesizedId)) agentId = synthesizedId;
      }
    } else if (pane.agentName && rosterByName.has(pane.agentName)) {
      agentId = rosterByName.get(pane.agentName)!.id;
    } else if (
      pane.role === "orchestrator" &&
      (pane.paneId === orchestratorPane?.paneId ||
        pane.paneId === leaderDrift?.paneId)
    ) {
      // Mesmo par resolvido acima — um pane órfão com role='orchestrator'
      // que não é o líder provado não herda o card do orquestrador. A deriva
      // só existe sem líder provado e com sessão viva selada por esta missão.
      agentId = roster.find((agent) => agent.category === "orchestrator")?.id;
    } else {
      const dispatch = dispatches.find(
        (candidate) =>
          candidate.paneId === pane.paneId ||
          (pane.workerIncarnationId !== undefined &&
            candidate.workerIncarnationId === pane.workerIncarnationId),
      );
      if (dispatch?.agentRef && rosterById.has(dispatch.agentRef)) {
        agentId = dispatch.agentRef;
      } else if (pane.role === "worker" && roster.length < 64) {
        // F-777: helper sem assento no squad (nexus_pane_spawn da missão) —
        // card próprio pelo paneId, nunca descartado do grafo.
        agentId = `pane:${pane.paneId}`;
        if (!rosterById.has(agentId)) {
          const helper = missionHelperAgent(pane, agentId);
          roster.push(helper);
          rosterById.set(agentId, helper);
        }
      }
    }
    if (!agentId || claimedAgentIds.has(agentId)) continue;
    claimedAgentIds.add(agentId);

    const paneSessionId = sessionByPaneId.get(pane.paneId) ?? null;
    const delivery = deliveries.claim(paneSessionId, pane.workerIncarnationId);
    if (delivery) deliveryByAgentId.set(agentId, delivery);
    const liveSessionState = paneSessionId
      ? runtimeSessionState(paneSessionId)
      : null;
    const semantic =
      getAgentSemanticStatus(pane.paneId)?.status ??
      (paneSessionId
        ? getAgentSemanticStatusBySession(paneSessionId)?.status
        : null) ??
      (paneSessionId ? getAcpDriverSemanticStatus(paneSessionId) : null);
    const state = resolveMissionAgentLiveState({
      semantic: ["busy", "spawning", "idle"].includes(liveSessionState ?? "") ? semantic : null,
      sessionState:
        liveSessionState === "spawning" ||
        liveSessionState === "busy" ||
        liveSessionState === "idle"
          ? liveSessionState
          : null,
      // F-777: helper que entregou e ficou ocioso é Concluído, não Na fila.
      taskState:
        delivery?.state === "done" || delivery?.state === "failed"
          ? delivery.state
          : (taskFallbackByAgent.get(agentId) ?? "queued"),
    });
    const currentUnitId = currentUnitByAgent.get(agentId);
    panes.push({
      paneId: pane.paneId,
      agentId,
      state,
      terminalLive: liveSessionState === "busy" || liveSessionState === "spawning" || liveSessionState === "idle",
      ...(currentUnitId ? { currentUnitId } : {}),
      // F-231: o quadro rotula "aberto por você" e o close do Maestro é recusado.
      ...(pane.operatorOpened === true ? { operatorOpened: true } : {}),
    });
  }

  // F-777: helper que entregou e já fechou o pane continua no grafo, com o
  // estado da entrega. A sessão é atribuída antes ao agente planejado que a
  // despachou; só a que sobra vira card próprio.
  for (const delivery of deliveries.unclaimed()) {
    const dispatch = dispatches.find(
      (candidate) =>
        candidate.agentRef !== undefined &&
        rosterById.has(candidate.agentRef) &&
        (candidate.sessionId === delivery.sessionId ||
          (delivery.workerIncarnationId !== undefined &&
            candidate.workerIncarnationId === delivery.workerIncarnationId)),
    );
    let agentId = dispatch?.agentRef;
    if (!agentId) {
      if (roster.length >= 64) continue;
      agentId = `session:${delivery.sessionId}`;
      const helper = closedHelperAgent(agentId, delivery.fromAgent);
      roster.push(helper);
      rosterById.set(agentId, helper);
    }
    claimedAgentIds.add(agentId);
    if (!deliveryByAgentId.has(agentId)) deliveryByAgentId.set(agentId, delivery);
  }

  const openQuestion = resolveOpenMissionQuestion(
    mission,
    missionHandoffs,
    sessionId,
  );

  // Missão sem plano (aberta pelo pane do operador via nexus_mission_create)
  // herda o squad padrão só para achar agentes por nome — não é equipe
  // planejada. Desenhar os oito papéis "Na fila" prometia panes que ninguém
  // vai abrir. O quadro mostra o orquestrador e quem de fato tem pane.
  const unplanned =
    !mission.intentContract && taskAgentById.size === 0 && dispatches.length === 0;
  const boardRoster = unplanned
    ? roster.filter(
        (agent) =>
          agent.category === "orchestrator" || claimedAgentIds.has(agent.id),
      )
    : roster;

  return {
    mission: {
      id: mission.id,
      title: mission.title,
      objective:
        mission.intentContract?.goal.trim() ||
        mission.description.trim() ||
        mission.title,
      workspaceLabel: `${scope.projectId}/${scope.checkoutId}`,
      status: mission.status,
      // F-244: descrição/intentState alimentam a causa nomeada no Quadro.
      ...(mission.description ? { description: mission.description } : {}),
      ...(mission.intentState ? { intentState: mission.intentState } : {}),
      version: mission.intentVersion ?? 0,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      ...(mission.result ? { result: mission.result } : {}),
    },
    hasDispatchAuthority: hasCurrentDispatchAuthority(mission),
    hasCurrentKickoffReceipt:
      stores.missions.hasCurrentKickoffAcceptance(mission.id),
    orchestratorLive,
    ...(orchestratorLive && sessionState === "idle"
      ? { orchestratorIdle: true }
      : {}),
    ...(leaderDrift ? { orchestratorDrift: true } : {}),
    runtimeClosedByOperator: wasMissionRuntimeClosedByOperator(mission),
    leftoverParked: wasMissionLeftoverParked(mission),
    tasks,
    handoffs: [],
    panes,
    ...(deliveryByAgentId.size > 0
      ? {
          deliveries: [...deliveryByAgentId].map(([agentId, delivery]) => ({
            agentId,
            state: delivery.state,
          })),
        }
      : {}),
    roster: boardRoster,
    ...(openQuestion ? { openQuestion } : {}),
    ...(worktrees.length > 0 ? { worktrees } : {}),
  };
}

/**
 * A ÚNICA sessão viva que o Main selou como orquestradora desta missão num
 * pane gravado como orquestrador. Mais de uma é ambiguidade — não se escolhe
 * por ordem de array; nenhuma, não há deriva.
 */
function driftedOrchestratorSession(
  scope: ProjectExecutionScope,
  missionId: string,
  missionPanes: readonly { readonly paneId?: string; readonly role?: string }[],
): { paneId: string; sessionId: string } | null {
  const found: Array<{ paneId: string; sessionId: string }> = [];
  for (const spec of missionPanes) {
    if (spec.role !== "orchestrator" || !spec.paneId) continue;
    for (const info of listAgentSessionsForPane(spec.paneId)) {
      const state = runtimeSessionState(info.sessionId);
      if (
        info.missionId === missionId &&
        info.role === "orchestrator" &&
        info.scope.installationId === scope.installationId &&
        info.scope.projectId === scope.projectId &&
        info.scope.checkoutId === scope.checkoutId &&
        (state === "spawning" || state === "busy" || state === "idle")
      ) {
        found.push({ paneId: spec.paneId, sessionId: info.sessionId });
      }
    }
  }
  return found.length === 1 ? found[0]! : null;
}

/**
 * Roster sintético da missão da aba (sem squad): um agente "orchestrator"
 * com os dados do pane do líder provado (ou do líder à deriva, senão o spec
 * de orquestrador mais novo) e um executor por spec de worker, dedupado por
 * paneId — helpers dividem agentName, então a identidade do card é o pane.
 * Mais novo primeiro, máximo 64 (teto do schema do snapshot).
 */
function squadlessMissionPaneRoster(
  missionPanes: readonly MissionPaneSpec[],
  orchestratorPane: MissionPaneSpec | null,
  leaderDrift: { paneId: string } | null,
): SquadAgent[] {
  const driftSpec = leaderDrift
    ? (missionPanes.find((pane) => pane.paneId === leaderDrift.paneId) ?? null)
    : null;
  const orchestratorSpec =
    orchestratorPane ??
    driftSpec ??
    [...missionPanes].reverse().find((pane) => pane.role === "orchestrator") ??
    null;
  const agents: SquadAgent[] = [];
  if (orchestratorSpec) {
    agents.push({
      id: "orchestrator",
      agentName: orchestratorSpec.agentName?.trim() || "Orquestrador",
      category: "orchestrator",
      cli: orchestratorSpec.adapterId,
      ...(orchestratorSpec.model ? { model: orchestratorSpec.model } : {}),
    });
  }
  const seenPaneIds = new Set<string>();
  for (const spec of [...missionPanes].reverse()) {
    if (!spec.paneId || seenPaneIds.has(spec.paneId)) continue;
    seenPaneIds.add(spec.paneId);
    if (spec.role !== "worker" || spec.paneId === orchestratorSpec?.paneId) {
      continue;
    }
    agents.push(missionHelperAgent(spec, `pane:${spec.paneId}`));
    if (agents.length >= 64) break;
  }
  return agents;
}

/** Rótulo de pane/CLI cabe no `agentName` do roster (128, sem controle). */
function helperLabel(value: string | undefined, max = 128): string {
  return (value ?? "")
    .replace(/[\0-\x1f\x7f‪-‮⁦-⁩]/gu, "")
    .trim()
    .slice(0, max)
    .trim();
}

/** F-777: papel do helper pelo que ele faz — revisão, análise read-only ou escrita. */
function missionHelperCategory(spec: {
  readonly agentName?: string;
  readonly title?: string;
  readonly readOnly?: boolean;
}): SquadAgent["category"] {
  const label = `${spec.agentName ?? ""} ${spec.title ?? ""}`;
  if (/\b(revis|review)|\bqa\b/iu.test(label)) return "reviewer";
  return spec.readOnly === true ? "scout" : "executor";
}

function missionHelperAgent(
  spec: Pick<MissionPaneSpec, "adapterId" | "model" | "title" | "agentName" | "readOnly">,
  id: string,
): SquadAgent {
  const tool = spec.model ? `${spec.adapterId} · ${spec.model}` : spec.adapterId;
  return {
    id,
    agentName: helperLabel(spec.agentName) || helperLabel(spec.title) || helperLabel(tool),
    category: missionHelperCategory(spec),
    cli: spec.adapterId,
    ...(spec.model ? { model: spec.model } : {}),
  };
}

/** Helper que entregou e fechou o pane: só o handoff sobrou para nomeá-lo. */
function closedHelperAgent(id: string, fromAgent: string | undefined): SquadAgent {
  const label = helperLabel(fromAgent);
  let adapterId: string | undefined;
  try {
    adapterId = label
      ? listAdapters().find((adapter) => adapter.label === label || adapter.id === label)?.id
      : undefined;
  } catch {
    adapterId = undefined;
  }
  return {
    id,
    agentName: label || "Helper",
    category: missionHelperCategory({ agentName: label }),
    cli: adapterId ?? (helperLabel(label, 64) || "agente"),
  };
}

/**
 * F-777: pane vivo da missão que não tem linha em missionPanes (spawn com ACK
 * pendente não chega a `missionPanes.record`) entra como membro sintético —
 * só leitura, nunca persistido nem usado como autoridade.
 */
function withUnrecordedLiveHelperPanes(
  recorded: readonly MissionPaneSpec[],
  snapshots: readonly PaneSnapshot[],
  missionId: string,
): MissionPaneSpec[] {
  const recordedPaneIds = new Set(recorded.map((pane) => pane.paneId));
  const unrecorded = snapshots
    .filter(
      (snapshot) =>
        snapshot.missionId === missionId &&
        snapshot.kind === "cli-agent" &&
        snapshot.role === "worker" &&
        Boolean(snapshot.adapterId) &&
        !recordedPaneIds.has(snapshot.paneId),
    )
    .map(
      (snapshot): MissionPaneSpec => ({
        id: `live:${snapshot.paneId}`,
        missionId,
        adapterId: snapshot.adapterId!,
        ...(snapshot.model ? { model: snapshot.model } : {}),
        title: snapshot.title,
        ...(snapshot.agentName ? { agentName: snapshot.agentName } : {}),
        ...(snapshot.workerIncarnationId
          ? { workerIncarnationId: snapshot.workerIncarnationId }
          : {}),
        role: "worker",
        createdAt: Date.now(),
        ...(snapshot.readOnly === true ? { readOnly: true } : {}),
        ...(snapshot.operatorOpened === true ? { operatorOpened: true } : {}),
        paneId: snapshot.paneId,
      }),
    );
  return unrecorded.length > 0 ? [...recorded, ...unrecorded] : [...recorded];
}

interface MissionHandoffDelivery {
  readonly sessionId: string;
  readonly workerIncarnationId?: string;
  readonly fromAgent?: string;
  readonly state: "done" | "failed" | "blocked";
}

const HANDOFF_DELIVERY_STATE: Partial<
  Record<Handoff["status"], MissionHandoffDelivery["state"]>
> = {
  success: "done",
  partial: "done",
  failed: "failed",
  blocked: "blocked",
};

/**
 * Última entrega de cada sessão worker da missão (os sintéticos progress /
 * stalled não são entrega). `claim` liga a entrega ao pane que a fez; o que
 * sobra em `unclaimed` é helper cujo pane já fechou.
 */
function missionHandoffDeliveries(
  handoffs: readonly Handoff[],
  excludedSessionIds: readonly (string | null)[],
): {
  claim(
    sessionId: string | null,
    workerIncarnationId: string | undefined,
  ): MissionHandoffDelivery | null;
  unclaimed(): MissionHandoffDelivery[];
} {
  const excluded = new Set(excludedSessionIds.filter(Boolean));
  const bySession = new Map<string, MissionHandoffDelivery>();
  for (const handoff of [...handoffs].sort((a, b) => a.createdAt - b.createdAt)) {
    const state = HANDOFF_DELIVERY_STATE[handoff.status];
    const sessionId = handoff.sessionId?.trim();
    if (!state || !sessionId || excluded.has(sessionId)) continue;
    bySession.set(sessionId, {
      sessionId,
      ...(handoff.workerIncarnationId
        ? { workerIncarnationId: handoff.workerIncarnationId }
        : {}),
      ...(handoff.fromAgent ? { fromAgent: handoff.fromAgent } : {}),
      state,
    });
  }
  const claimed = new Set<string>();
  return {
    claim(sessionId, workerIncarnationId) {
      for (const delivery of bySession.values()) {
        if (claimed.has(delivery.sessionId)) continue;
        if (
          delivery.sessionId === sessionId ||
          (workerIncarnationId !== undefined &&
            delivery.workerIncarnationId === workerIncarnationId)
        ) {
          claimed.add(delivery.sessionId);
          return delivery;
        }
      }
      return null;
    },
    unclaimed: () =>
      [...bySession.values()].filter((delivery) => !claimed.has(delivery.sessionId)),
  };
}

/**
 * Worktrees da missão para o rail (branch como nó da árvore). O registry é
 * runtime, não verdade da missão: se ele não estiver disponível, a view segue
 * sem o campo — o rail mostra a missão sob o projeto, como antes.
 */
function missionWorktreeViews(
  scope: ProjectExecutionScope,
  missionId: string,
): Array<{ branchRef: string; worktreePath?: string; status: WorktreeRecord["status"] }> {
  try {
    return requireWorktreeRuntimeRegistry()
      .listMission(scope, missionId)
      .map((record) => ({
        branchRef: record.branchRef,
        ...(record.worktreePath ? { worktreePath: record.worktreePath } : {}),
        status: record.status,
      }));
  } catch {
    return [];
  }
}

function persistLeftoverIsolationFromSnapshotView(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
  view: ProjectMissionSnapshotView,
): void {
  const stale = wasUpdatedBeforeThisProcess(view.mission.updatedAt);
  const hasLive = missionViewHasLiveWorkingRuntime(view);
  const hasFiles = missionViewHasFiles(view);
  const freshKickoff = isFreshIniciarKickoff({
    status: view.mission.status,
    createdAt: view.mission.createdAt ?? mission.createdAt,
    updatedAt: view.mission.updatedAt,
    sealedCount: view.tasks.length,
    paneCount: view.panes.length,
    hasLiveMaestro: hasLive,
    hasKickoffReceipt: view.hasCurrentKickoffReceipt,
  });
  const freshPending =
    view.mission.status === "pending" &&
    !stale &&
    view.panes.length === 0;
  const leftoverPainted = leftoverRunningOrPendingIsDead({
    status: view.mission.status,
    hasLivePty: hasLive,
    hasFiles,
    isFreshKickoff: freshKickoff,
    isFreshPending: freshPending,
  });
  if (mission.status !== "running" && mission.status !== "pending") {
    return;
  }
  if (
    !leftoverPainted &&
    !(stale && !hasLive)
  ) {
    return;
  }
  if (
    !shouldPersistLeftoverIsolation({
      status: mission.status,
      alreadyClosedByOperator: wasMissionRuntimeClosedByOperator(mission),
      alreadyLeftoverParked: wasMissionLeftoverParked(mission),
      hasThisProcessLiveMaestro: hasLive,
      isFreshKickoff: freshKickoff,
      isFreshPending: freshPending,
    })
  ) {
    return;
  }
  persistLeftoverIsolation(stores.missions, mission.id, "leftover");
}

interface MissionEngineLifecyclePatch {
  readonly status: MissionStatus;
  readonly intentState: MissionIntentState;
  readonly description?: string;
  readonly learnings?: string;
  readonly result?: MissionResult;
}

function transitionMissionEngineLifecycle(
  stores: ProjectDomainStoreSuite,
  input: {
    readonly missionId: string;
    readonly expectedStatus: MissionStatus;
    // Reabertura cerca contra o estado EXATO atual — linhas legadas podem
    // ter intentState ausente, e o CAS precisa compará-lo como undefined.
    readonly expectedIntentState: MissionIntentState | undefined;
    readonly expectedUpdatedAt: number;
    readonly expectedIntentVersion: number;
  },
  patch: MissionEngineLifecyclePatch,
): void {
  const current = stores.missions.get(input.missionId);
  if (
    !current ||
    current.status !== input.expectedStatus ||
    current.intentState !== input.expectedIntentState ||
    current.updatedAt !== input.expectedUpdatedAt ||
    (current.intentVersion ?? 0) !== input.expectedIntentVersion
  ) {
    throw new Error("mission engine lifecycle fence changed");
  }
  const updated = stores.missions.transitionLifecycle(
    input.missionId,
    {
      updatedAt: input.expectedUpdatedAt,
      intentVersion: input.expectedIntentVersion,
    },
    patch,
  );
  if (!updated) {
    throw new Error("mission engine lifecycle CAS changed");
  }
}

/** Final automatic completion boundary, shared by agents and civilian shortcuts. */
export function completeVerifiedMission(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  input: MissionVerifiedCompletionInput,
  deps: {
    readonly getSquad?: typeof getSquad;
    readonly listPanes?: () => readonly TeamQuestionPaneRuntime[];
    readonly listObserverPaneSessions?: (missionId: string) => readonly TeamQuestionObserverBinding[];
  } = {},
): void {
  const current = stores.missions.get(input.missionId);
  let result = input.result;
  if (current && input.operatorOverride !== true) {
    const handoffs = stores.handoffs?.list?.({ missionId: current.id, includeDelivered: true }) ?? [];
    const squad = current.squadId ? (deps.getSquad ?? getSquad)(current.squadId) : null;
    const teamQuestion = assertTeamQuestionCompletion({
      mission: current, squad, handoffs,
      panes: stores.missionPanes?.list?.(current.id) ?? [],
      runtimePanes: (deps.listPanes ?? listPaneSnapshots)(),
      observerPaneSessions: deps.listObserverPaneSessions?.(current.id) ??
        loadObserverPaneSessions(scope, current.id),
    });
    if (teamQuestion.fallbackAgents.length > 0) {
      console.info(
        `[mission-engine] team-question consolidated via observer fallback for ${teamQuestion.fallbackAgents.join(', ')} (mission ${current.id}): panes were never sealed.`,
      );
    }
    const textOnly = teamQuestion.applicable || current.intentContract?.routingAdvice?.kind === 'direct-answer';
    const automaticProof = getAutomaticCompletionProof(scope, current);
    const frozenReviewProof = !textOnly && !automaticProof &&
      ((current.intentContract?.lane ?? 'standard') === 'standard' || missionRequiresIndependentReview(current, squad))
      ? resolveFrozenMissionReviewProof(scope, current) : null;
    const codeCompletionRequired = !textOnly && (current.intentContract?.lane ?? 'standard') === 'standard' &&
      current.squadId !== PET_STUDIO_SQUAD_ID && !frozenReviewProof;
    assertIndependentReviewForDone({
      mission: current, scope, squad, handoffs, automaticProof, frozenReviewProof, textOnly, codeCompletionRequired,
      deliveryAttemptsOf: (handoffId) => stores.handoffs?.listDeliveryAttempts?.(handoffId) ?? [],
      dispatches: stores.taskDispatches?.list?.(current.id) ?? [],
    });
    assertDeliveryArtifactsForDone({
      lane: current.intentContract?.lane,
      goal: current.intentContract?.goal.trim() || current.description?.trim() || current.title?.trim() || '',
      rootRealPath: missionExecutionScope(scope, current).rootRealPath,
      handoffs,
      artifactRefs: input.result.artifactRefs,
      resultSummary: input.result.summary,
      deletedArtifactRefs: automaticProof?.deletedArtifactPaths,
      textOnly,
    });
    if (teamQuestion.applicable) {
      result = { ...result, summary: teamQuestionResponseSummary(teamQuestion), artifactRefs: [], evidenceIds: [] };
    }
  }
  transitionMissionEngineLifecycle(stores, input, {
    status: 'done', intentState: 'done', learnings: input.learnings, result,
  });
}

const productionMissionEngines = new MissionEngineRegistry((scope, stores) =>
  new MainMissionEngine(scope, {
    ...createMissionEnginePreparationPorts({
      scope,
      missions: stores.missions,
    }),
    readReviewFence: async (missionId) => {
      const mission = stores.missions.get(missionId);
      if (mission?.squadId === PET_STUDIO_SQUAD_ID) {
        const saved = getSquad(PET_STUDIO_SQUAD_ID);
        if (!saved || !isDeepStrictEqual(saved, PET_STUDIO_SQUAD)) {
          throw new Error("saved Pet Studio squad authority changed");
        }
      }
      const reviewSha256 =
        mission?.intentContract?.approvalReviewSha256;
      if (!reviewSha256) return null;
      return {
        missionId,
        reviewSha256,
        ...(mission.squadId === PET_STUDIO_SQUAD_ID
          ? {
              profile: { kind: "pet-studio" as const },
              attachments:
                mission.intentContract?.attachmentSnapshots?.map(
                  (snapshot) => ({ ...snapshot }),
                ) ?? [],
            }
          : {}),
      };
    },
    revalidatePetStudioAttachments: (snapshots) =>
      revalidateSealedAttachmentSnapshots(snapshots, {
        workspaceRootAuthority: workspaceRootAuthorityFromScope(scope),
        checkoutId: scope.checkoutId,
      }),
    seal: async (input, assertCurrentScope) => {
      const mission = stores.missions.get(input.missionId);
      if (!mission || mission.intentContract?.approvalReviewSha256 !== input.reviewSha256) throw new Error('mission review changed');
      await prepareMissionExecutionScope(scope, mission);
      assertCurrentScope?.();
      if (stores.missions.get(input.missionId)?.updatedAt !== mission.updatedAt) throw new Error('mission changed while preparing its workspace');
      sealMissionStartReview(stores.missions, input);
    },
    bootstrap: async (missionId) => {
      // Via Rápida: terminais interativos direto no workspace — caminho único.
      // Do not block mission.start on first pane / Maestro boot idle.
      await fastLaneBootstrap(scope, missionId, { waitForFirstPane: false });
    },
    retryKickoff: async (command) => {
      // O STOP do operador é lei (print de campo 19/08: "encerrei todas as
      // missões e ele iniciando de novo sozinho"). retry-kickoff é gatilho
      // MECÂNICO (tecla em pane morto, auto-cura de grant, watchdogs) — ele
      // NUNCA pode quebrar o selo de encerramento. Só o comando `resume`
      // (botão Retomar, decisão explícita) reabre missão selada.
      const mission = stores.missions.get(command.missionId);
      if (
        mission &&
        (wasMissionRuntimeClosedByOperator(mission) ||
          wasMissionLeftoverParked(mission))
      ) {
        throw new Error(
          "mission_closed_by_operator: missão encerrada pelo operador — " +
            "só Retomar no rail religa",
        );
      }
      // F-245: o remount automático ignora pane dispensado em SILÊNCIO — o
      // botão do Quadro resolvia sem erro e sem efeito. O clique do operador
      // merece erro visível apontando o Retomar.
      if (wasOrchestratorOperatorDismissed(command.missionId)) {
        throw new Error(
          "orchestrator_operator_dismissed: o pane do coordenador foi " +
            "fechado — use Retomar para reabrir a missão",
        );
      }
      await resumeFastLaneMission(scope, command.missionId, {
        remountKind: "automatic",
      });
    },
    resume: async (command) => {
      const mission = stores.missions.get(command.missionId);
      if (!mission) throw new Error("mission not found");
      if (
        mission.status === "running" &&
        mission.intentState === "executing"
      ) {
        // A durable running row does not prove a live coordinator. The
        // physical recovery path watches an existing leader or respawns one.
        await resumeFastLaneMission(scope, command.missionId, { remountKind: "operator" });
        return;
      }
      // Os DOIS estados em que o card anuncia Retomar (mission-snapshot
      // allowedActions): missão encerrada pelo operador (blocked com selo
      // runtime-closed) e missão concluída com trabalho residual (done sem
      // result). Recusar aqui com erro interno era o bug da screenshot
      // "Mission engine resume requires a technical block" — reabrir limpa
      // o selo de encerramento (a presença dele numa missão blocked É a
      // prova de "Encerrada pelo operador"), volta a running/executing e
      // religa a coordenação pela Via Rápida (respawn + re-entrega).
      const runtimeClosedByOperator = wasMissionRuntimeClosedByOperator(mission);
      const leftoverParked = wasMissionLeftoverParked(mission);
      const residualWork =
        mission.status === "done" &&
        !mission.result &&
        missionViewHasResidualWork(
          projectMissionEngineSnapshotView(scope, stores, mission.id),
        );
      // Concluída COM resultado: a entrega existe, mas ainda não foi aprovada
      // pelo humano. `resume` é a decisão explícita do operador ("pedir um
      // ajuste") e é o ÚNICO comando autorizado a reabrir missão selada — o
      // retry-kickoff mecânico continua recusando. Reabrir religa a
      // coordenação pela Via Rápida (respawn + re-entrega), que é o que faz o
      // pane do coordenador voltar a aceitar digitação.
      const completedAwaitingReview =
        mission.status === "done" && Boolean(mission.result);
      // Falha não pode ter apagar como única saída: `resume` é o "tentar de
      // novo" que o snapshot passou a anunciar em `failed`.
      const failedRetry = mission.status === "failed";
      if (
        runtimeClosedByOperator ||
        leftoverParked ||
        residualWork ||
        completedAwaitingReview ||
        failedRetry
      ) {
        const reopened =
          leftoverParked
            ? stripMissionVerdictParagraph(
                mission.description ?? "",
                NEXUS_LEFTOVER_PARKED_MARKER,
              ) || "Missão reaberta pelo operador."
            : runtimeClosedByOperator
              ? stripMissionVerdictParagraph(
                  mission.description ?? "",
                  MISSION_RUNTIME_CLOSED_MARKER,
                ) || "Missão reaberta pelo operador."
              : (mission.description ?? "");
        const description = completedAwaitingReview
          ? withAwaitingAdjustmentMarker(reopened)
          : reopened;
        transitionMissionEngineLifecycle(
          stores,
          {
            missionId: mission.id,
            expectedStatus: mission.status,
            expectedIntentState: mission.intentState,
            expectedUpdatedAt: mission.updatedAt,
            expectedIntentVersion: mission.intentVersion ?? 0,
          },
          {
            status: "running",
            intentState: "executing",
            description,
          },
        );
        if (completedAwaitingReview) {
          await resumeFastLaneMission(scope, command.missionId, {
            remountKind: "operator",
            note:
              "O operador reabriu para PEDIR UM AJUSTE. Não conclua a missão. Espere a orientação dele no chat.",
          });
        } else {
          await resumeFastLaneMission(scope, command.missionId);
        }
        return;
      }
      // F-738: bloqueio declarado pelo próprio Maestro (`nexus_mission_set_status
      // blocked`) é `blocked_user` SEM pergunta registrada — a pergunta dele
      // ficou no chat, e o reconciliador encerra o processo de missão parada.
      // O card anuncia "Retomar o coordenador" (projeção blocked_technical) e
      // o motor recusava com "requires a technical block": a missão ficava sem
      // saída. Retomar religa o Maestro na mesma conversa (F-721) para o
      // operador responder ali. Com pergunta registrada a saída continua
      // sendo answer-question.
      if (
        mission.status === "blocked" &&
        mission.intentState === "blocked_user" &&
        !projectMissionEngineSnapshotView(scope, stores, mission.id).openQuestion
      ) {
        await resumeFastLaneMission(scope, command.missionId, {
          remountKind: "operator",
          note:
            "O operador retomou a missão que você tinha bloqueado esperando " +
            "por ele. Releia no histórico a sua última pergunta ao operador e " +
            "o motivo do bloqueio; se a resposta ainda faltar, peça-a no chat " +
            "antes de despachar, e siga a partir dela.",
        });
        return;
      }
      if (
        mission.status !== "blocked" ||
        mission.intentState !== "blocked_technical"
      ) {
        throw new Error("mission engine resume requires a technical block");
      }
      const detail = taskDispatchBlockDetailFromDescription(
        mission.description,
      );
      // F-245: sem marcador de dispatch (chef-idle etc.) o bloqueio técnico
      // não tinha saída — `resume` lançava e o remount automático pulava o
      // pane dispensado. O clique do operador é `operator`: reabre a missão
      // (resumeTechnical + fastLaneBootstrap) com nota de continuidade.
      if (!detail) {
        await resumeFastLaneMission(scope, command.missionId, {
          remountKind: "operator",
          note:
            "O operador retomou a missão depois de uma pausa (bloqueio " +
            "técnico). Releia nexus_handoff_list({full:true}) e " +
            "nexus_pane_list antes de despachar; worker que estava travado " +
            "não voltou — re-despache a tarefa dele.",
        });
        return;
      }
      transitionMissionEngineLifecycle(
        stores,
        {
          missionId: mission.id,
          expectedStatus: mission.status,
          expectedIntentState: mission.intentState,
          expectedUpdatedAt: mission.updatedAt,
          expectedIntentVersion: mission.intentVersion ?? 0,
        },
        {
          status: "running",
          intentState: "executing",
          description: taskDispatchTechnicalResumeDescription(
            mission.description,
            detail,
          ),
        },
      );
    },
    stop: async (command) => {
      // Native confirmation + lifecycle lock + physical teardown belong to
      // the renderer IPC authority boundary. This port is deliberately
      // post-authority only: it can validate an idempotent completed close,
      // but can never terminate a live process without that boundary.
      const mission = stores.missions.get(command.missionId);
      if (!mission) throw new Error("mission not found");
      if (
        (mission.status !== "blocked" && mission.status !== "failed") ||
        mission.orchestratorSessionId !== undefined
      ) {
        throw new Error(
          "mission engine stop requires completed operator runtime teardown",
        );
      }
    },
    direct: async (command) => {
      await deliverMissionDirectInstruction(scope, stores, command);
    },
    answerQuestion: async (command) => {
      const question = stores.handoffs.get(command.questionId);
      if (
        !question ||
        question.missionId !== command.missionId ||
        question.deliveryState !== "consumed"
      ) {
        throw new Error(
          "mission engine answer requires the consumed current question",
        );
      }
      const answers = stores.handoffs
        .list({ missionId: command.missionId, includeDelivered: true })
        .filter((handoff) => {
          if (handoff.authorityOrigin !== "operator-confirmed") return false;
          return handoff.artifacts.some((artifact) => {
            const parsed = parseClarifyAnswerArtifact(artifact);
            return parsed?.questionId === command.questionId;
          });
        });
      if (answers.length !== 1) {
        throw new Error(
          "mission engine answer requires one operator-confirmed response",
        );
      }
      const answer = answers[0]!.artifacts
        .map((artifact) => parseClarifyAnswerArtifact(artifact))
        .find((artifact) => artifact?.questionId === command.questionId);
      const matchesCommand =
        answer?.answer.kind === "chip"
          ? answer.answer.chipId === command.optionId
          : answer?.answer.kind === "freeform" &&
            answer.answer.value === command.text;
      if (!matchesCommand) {
        throw new Error("mission engine answer diverges from durable response");
      }
      const mission = stores.missions.get(command.missionId);
      if (!mission) throw new Error("mission not found");
      if (
        mission.status === "running" &&
        mission.intentState === "executing"
      ) {
        return;
      }
      if (
        mission.status !== "blocked" ||
        mission.intentState !== "blocked_user"
      ) {
        throw new Error("mission engine answer requires a user block");
      }
      transitionMissionEngineLifecycle(
        stores,
        {
          missionId: mission.id,
          expectedStatus: mission.status,
          expectedIntentState: mission.intentState,
          expectedUpdatedAt: mission.updatedAt,
          expectedIntentVersion: mission.intentVersion ?? 0,
        },
        { status: "running", intentState: "executing" },
      );
    },
    blockUser: (input) =>
      transitionMissionEngineLifecycle(stores, input, {
        status: "blocked",
        intentState: "blocked_user",
        description: input.description,
      }),
    blockTechnical: (input) =>
      transitionMissionEngineLifecycle(stores, input, {
        status: "blocked",
        intentState: "blocked_technical",
        description: input.description,
      }),
    resumeTechnical: (input) =>
      transitionMissionEngineLifecycle(stores, input, {
        status: "running",
        intentState: "executing",
        description: input.description,
      }),
    completeVerified: (input) => completeVerifiedMission(scope, stores, input),
    readSnapshotView: async (missionId) =>
      projectMissionEngineSnapshotView(scope, stores, missionId),
    listSnapshotViews: async () =>
      stores.missions.list().map((mission) => {
        const view = projectMissionEngineSnapshotView(scope, stores, mission.id);
        persistLeftoverIsolationFromSnapshotView(stores, mission, view);
        return projectMissionEngineSnapshotView(scope, stores, mission.id);
      }),
  }),
);
configureMissionEngineForScope((scope) =>
  productionMissionEngines.forScope(scope, getProjectDomainStores(scope)),
);

function fastLaneBootstrapSuccess(
  scope: ProjectExecutionScope,
  missionId: string,
  reused: boolean,
): MissionOrchestratorBootstrapResult {
  const pane = fastLaneOrchestratorPaneSummary(scope, missionId);
  if (pane) {
    return {
      ok: true,
      missionId,
      pane,
      kickoff: { accepted: true },
      ...(reused ? { reused: true } : {}),
    };
  }
  return {
    ok: false,
    missionId,
    reason: "spawn_failed",
    error: "a Via Rápida não conseguiu abrir a coordenação",
    cta: BOOTSTRAP_CTA,
  };
}

/** Main-process boundary used by approval and cron, sharing one engine start. */
export function bootstrapMissionOrchestratorForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  expectedReviewSha256?: string,
): Promise<MissionOrchestratorBootstrapResult> {
  return withMissionLifecycleLock(scope, missionId, async () => {
    const stores = getProjectDomainStores(scope);
    const initial = stores.missions.get(missionId);
    if (!initial) {
      return {
        ok: false,
        missionId,
        reason: "not_authorized",
        error: "MissionEngine.start exige uma missão existente.",
        cta: BOOTSTRAP_CTA,
      };
    }
    const reviewSha256 =
      expectedReviewSha256 ??
      initial.intentContract?.approvalReviewSha256;
    if (!reviewSha256) {
      return {
        ok: false,
        missionId,
        reason: "review_required",
        error: "MissionEngine.start exige o review selado da missão.",
        cta: BOOTSTRAP_CTA,
      };
    }
    try {
      await productionMissionEngines
        .forScope(scope, stores)
        .start(scope, { missionId, reviewSha256 });
    } catch (error) {
      return {
        ok: false,
        missionId,
        reason: "materialization_failed",
        error:
          error instanceof Error
            ? error.message
            : "MissionEngine.start falhou.",
        cta: BOOTSTRAP_CTA,
      };
    }
    return fastLaneBootstrapSuccess(scope, missionId, false);
  });
}

/** Renderer boundary for retrying a bootstrap-blocked mission. */
export async function resumeBlockedMissionBootstrapFromRenderer(
  owner: WebContents,
  raw: unknown,
): Promise<MissionOrchestratorBootstrapResult> {
  const input = missionOrchestratorBootstrapRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  try {
    await resumeFastLaneMission(scope, input.missionId);
    const pane = fastLaneOrchestratorPaneSummary(scope, input.missionId);
    if (pane) {
      return {
        ok: true,
        missionId: input.missionId,
        pane,
        kickoff: { accepted: true },
        reused: true,
      };
    }
    return {
      ok: false,
      missionId: input.missionId,
      reason: "spawn_failed",
      error: "a retomada não conseguiu religar a coordenação",
      cta: BOOTSTRAP_CTA,
    };
  } catch (error) {
    return {
      ok: false,
      missionId: input.missionId,
      reason: "materialization_failed",
      error:
        error instanceof Error ? error.message : "retomada da Via Rápida falhou",
      cta: BOOTSTRAP_CTA,
    };
  }
}
