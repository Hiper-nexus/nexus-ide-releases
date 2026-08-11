import path from "node:path";
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
import type {
  Mission,
  MissionIntentState,
  MissionOrchestratorBootstrapResult,
  MissionPaneSpec,
  MissionStatus,
} from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from "../../shared/pet-studio";
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import {
  revalidateSealedAttachmentSnapshots,
  workspaceRootAuthorityFromScope,
} from "../persistence/dropped-files";
import {
  getAgentSessionInfo,
  getSessionState,
  listAgentSessions,
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
  type PaneRuntimeAuthority,
} from "./pane-registry";
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
  type MissionBlockInput,
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
  resolveMissionAgentLiveState,
  type MissionAgentTaskFallback,
  type ProjectMissionSnapshotView,
} from "./mission-snapshot";
import { sameMissionPaneAuthoritySeal } from "./mission-pane-authority";

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
};

interface MissionDirectAuthority {
  readonly mission: Mission;
  readonly sessionId: string;
  readonly adapterId: string;
  /** Direção entregue direto ao worker (squad sem orquestrador na Via Rápida). */
  readonly operatorDirectToWorker: boolean;
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

function missionDirectAuthority(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  command: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps,
): MissionDirectAuthority {
  const mission = stores.missions.get(command.missionId);
  if (!mission || mission.id !== command.missionId) {
    throw new Error("mission direct requires a current mission");
  }
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
    if (!stores.missions.hasCurrentKickoffAcceptance(mission.id)) {
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
    const approvedRuntime = mission.intentContract?.orchestratorRuntime;
    if (!orchestratorPane || !approvedRuntime) {
      throw new Error("mission direct orchestrator authority is incomplete");
    }
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
    sessionId = orchestratorSessionId;
    pane = orchestratorPane;
  }

  const squadRevisionHash = sealedSquadTargetHash(mission, command, deps);

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
    authorityFingerprint,
  };
}

function missionDirectPrompt(
  command: MissionDirectCommand,
  operatorDirectToWorker: boolean,
): string {
  const payload = {
    kind: "operator_direction" as const,
    targetAgentId: command.targetAgentId,
    text: command.text,
  };
  const targetRule = operatorDirectToWorker
    ? command.targetAgentId === null
      ? "The operator directs this mission directly: apply the direction to the current work."
      : "The operator selected this agent directly: apply the direction to the current work."
    : command.targetAgentId === null
      ? "Apply this direction to your current mission."
      : `Route this direction to exactly squad agent ${JSON.stringify(command.targetAgentId)} and retain orchestration authority.`;
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
export async function deliverMissionDirectInstruction(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  rawCommand: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps = productionMissionDirectDeliveryDeps,
): Promise<void> {
  assertSafePtyPrompt(rawCommand.text);
  const parsed = missionEngineCommandSchema.parse(rawCommand);
  if (parsed.kind !== "direct") {
    throw new Error("mission direct received a non-direct command");
  }
  const command = parsed;
  assertSafePtyPrompt(command.text);
  const initial = missionDirectAuthority(scope, stores, command, deps);
  const prompt = missionDirectPrompt(command, initial.operatorDirectToWorker);
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
  const payload = {
    kind: "operator_direction" as const,
    targetAgentId: command.targetAgentId,
    text: command.text,
  };
  deps.emitMissionEvent(scope, {
    missionId: command.missionId,
    runId: "operator-direction",
    type: "custom",
    origin: "main",
    idempotencyKey: `operator_direction:${initial.authorityFingerprint}`,
    payload,
  });
}

function projectMissionEngineSnapshotView(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  missionId: string,
): ProjectMissionSnapshotView {
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error("mission not found");
  const missionPanes = stores.missionPanes.list(missionId);
  const orchestratorPane =
    missionPanes.find((pane) => pane.role === "orchestrator") ?? null;
  const sessionId = mission.orchestratorSessionId;
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
  const squad = mission.squadId ? getSquad(mission.squadId) : null;
  const roster = (squad?.agents ?? []).map((agent) => ({
    ...agent,
    allowedTools: agent.allowedTools ? [...agent.allowedTools] : agent.allowedTools,
    allowedSkills: agent.allowedSkills
      ? [...agent.allowedSkills]
      : agent.allowedSkills,
  }));
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
  const livePaneSnapshots = listPaneSnapshots();
  const sessionByPaneId = new Map<string, string>();
  for (const snapshot of livePaneSnapshots) {
    if (snapshot.sessionId) {
      sessionByPaneId.set(snapshot.paneId, snapshot.sessionId);
    }
  }
  if (
    orchestratorPane?.paneId &&
    mission.orchestratorSessionId &&
    !sessionByPaneId.has(orchestratorPane.paneId)
  ) {
    sessionByPaneId.set(
      orchestratorPane.paneId,
      mission.orchestratorSessionId,
    );
  }
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

  const panes: ProjectMissionSnapshotView["panes"] = [];
  const claimedAgentIds = new Set<string>();
  // Mais NOVO primeiro: após uma retomada existem linhas antigas de panes
  // mortos para o mesmo agente, e o primeiro claim vence — iterar do mais
  // velho fazia o cartão do grafo mostrar "stopped" com o processo novo vivo.
  for (const pane of [...missionPanes].reverse()) {
    if (!pane.paneId) continue;
    let agentId: string | undefined;
    if (pane.agentName && rosterByName.has(pane.agentName)) {
      agentId = rosterByName.get(pane.agentName)!.id;
    } else if (pane.role === "orchestrator") {
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
      }
    }
    if (!agentId || claimedAgentIds.has(agentId)) continue;
    claimedAgentIds.add(agentId);

    const paneSessionId = sessionByPaneId.get(pane.paneId) ?? null;
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
      semantic,
      sessionState:
        liveSessionState === "spawning" ||
        liveSessionState === "busy" ||
        liveSessionState === "idle"
          ? liveSessionState
          : null,
      taskState: taskFallbackByAgent.get(agentId) ?? "queued",
    });
    const currentUnitId = currentUnitByAgent.get(agentId);
    panes.push({
      paneId: pane.paneId,
      agentId,
      state,
      ...(currentUnitId ? { currentUnitId } : {}),
    });
  }

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
      version: mission.intentVersion ?? 0,
      updatedAt: mission.updatedAt,
      ...(mission.result ? { result: mission.result } : {}),
    },
    hasDispatchAuthority: hasCurrentDispatchAuthority(mission),
    hasCurrentKickoffReceipt:
      stores.missions.hasCurrentKickoffAcceptance(mission.id),
    orchestratorLive,
    tasks,
    handoffs: [],
    panes,
    roster,
  };
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
  input: Pick<
    MissionBlockInput,
    | "missionId"
    | "expectedStatus"
    | "expectedIntentState"
    | "expectedUpdatedAt"
    | "expectedIntentVersion"
  >,
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
    seal: async (input) => {
      sealMissionStartReview(stores.missions, input);
    },
    bootstrap: async (missionId) => {
      // Via Rápida: terminais interativos direto no workspace — caminho único.
      await fastLaneBootstrap(scope, missionId);
    },
    retryKickoff: async (command) => {
      await resumeFastLaneMission(scope, command.missionId);
    },
    resume: async (command) => {
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
        mission.intentState !== "blocked_technical"
      ) {
        throw new Error("mission engine resume requires a technical block");
      }
      const detail = taskDispatchBlockDetailFromDescription(
        mission.description,
      );
      if (!detail) {
        throw new Error("mission engine resume requires an exact dispatch block");
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
    completeVerified: (input: MissionVerifiedCompletionInput) =>
      transitionMissionEngineLifecycle(stores, input, {
        status: "done",
        intentState: "done",
        learnings: input.learnings,
        result: input.result,
      }),
    readSnapshotView: async (missionId) =>
      projectMissionEngineSnapshotView(scope, stores, missionId),
    listSnapshotViews: async () =>
      stores.missions
        .list()
        .map((mission) =>
          projectMissionEngineSnapshotView(scope, stores, mission.id),
        ),
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
