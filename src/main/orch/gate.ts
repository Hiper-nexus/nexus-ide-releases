import { randomBytes, randomUUID } from "node:crypto";
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from "../../shared/pet-studio";
import type { ProjectExecutionScope } from "../../shared/types";
// F-562/onda 3: o gate consulta o líder resolvido, mas NÃO importa
// mission-leader-gate estaticamente — esse edge fechava o ciclo ESM
// gate → leader-gate → leadership-runtime → fast-lane → squad-store →
// guided-squad-skills → catalog → plugin-skill → gate, deixando
// BUILTIN_SQUADS/NEXUS_GUIDED_SKILLS em TDZ na suíte. O leader-gate se
// registra aqui ao ser carregado (todo consumidor de orquestração o importa
// no boot); sem registro, vale a comparação durável de antes da onda 3.
import {
  getMissionLeaderSessionCheck,
  registerMissionLeaderSessionCheck,
} from "./mission-leader-session-check";

export { registerMissionLeaderSessionCheck };
import {
  isExactInternalPrevcReviewerProfile,
  type InternalPrevcReviewerAuthority,
} from "./prevc-reviewer-profile";

/**
 * Agent gate — docs/ARCHITECTURE.md §E.4. Every MCP client (a CLI agent inside
 * a PTY) holds a bearer token minted at spawn time and bound to its session,
 * mission and checkout. Since F-1157 the gate does not restrict tools or
 * skills (see the doctrine note below); it keeps the session authority:
 * bearer, revocation, leader binding and the stop/handoff bookkeeping.
 * Object-level pane-authz still confines panes to the caller's mission.
 */

export type GateRole = "orchestrator" | "worker" | "user";

export interface AgentGateContext {
  /** Derived by Main from the assigned task, never handoff text. */
  visualTask?: import('../../shared/orch-types').VisualTaskRequirement;
  token: string;
  label: string;
  role: GateRole;
  /** PTY session bound after spawn (used by Stop-gate + handoff attribution). */
  sessionId?: string;
  /** Main-issued nonce for one physical worker generation. */
  workerIncarnationId?: string;
  missionId?: string;
  /** Frozen business-context revision bound to every mission effect. */
  contextRevision?: string;
  agentName?: string;
  /** Concrete CLI/provider identity, captured by main at spawn. */
  providerId?: string;
  /**
   * Main-owned marker that this bearer belongs to a writable mission Codex
   * worker. Main-process MCP handlers use it to avoid bypassing that worker's
   * native confinement, independently of PREVC and allowlist availability.
   */
  governedNativeProvider?: "codex";
  /**
   * Narrow main-owned exception for the canonical single-session Pet Studio.
   * It permits only nexus_image_generate through the orchestrator role gate;
   * native confinement, allowlists, mission intent and confirmation still run.
   */
  petStudioMediaAuthority?: true;
  /**
   * Marca de que ESTA sessão era `user` e foi promovida a orquestradora por
   * `nexus_mission_create`. Só ela pode ser devolvida a `user` quando a missão
   * some — um worker que perde a missão continua worker, porque devolvê-lo a
   * `user` seria escalada de privilégio.
   */
  promotedFromUserSession?: true;
  /**
   * Main-owned proof that this exact read-only worker profile belongs to an
   * active Nexus PREVC reviewer. It is derived at the physical spawn boundary,
   * never from prompt text or a caller-supplied MCP argument.
   */
  internalPrevcReviewerAuthority?: InternalPrevcReviewerAuthority;
  readOnly?: boolean;
  /**
   * F-1157: `readOnly` is a label everywhere except when the operator chose
   * Hardened (governed) mode, where the CLI is natively confined. Then the
   * MCP must not become a write path around that confinement. Main decides
   * it at mint/restore; a lane with this mark never writes by any path.
   */
  readOnlyEnforced?: true;
  /** Immutable project/checkout authority captured before the PTY starts. */
  scope: Readonly<ProjectExecutionScope>;
  /** Filesystem checkout granted to this agent (task worktree when present). */
  executionScope?: Readonly<ProjectExecutionScope>;
  /** Main verified a durable tab record, distinct from an isolated task writer. */
  sharedTabWorktree?: true;
  /**
   * Main-owned: the Nexus spawned this operator helper as an isolated writer
   * (own worktree/branch). It gets the same git guard as an isolated worker.
   */
  isolatedWriter?: true;
  allowedTools: string[] | null;
  allowedSkills: string[] | null;
  /**
   * Main-owned brief (spawn prompt, capped) of an operator-spawned helper;
   * only used by the Jev dispatch guard as the objective — never persisted,
   * never returned to callers.
   */
  operatorBrief?: string;
  /**
   * Main-owned link to the operator pane that spawned this helper (spawn
   * authority, never caller input). Lets a workspace handoff find its parent
   * while the window shows another workspace and the renderer-fed pane
   * registry no longer mirrors these panes.
   */
  operatorParentSessionId?: string;
  /** Stop-gate attempts (worker may leave after MAX_STOP_ATTEMPTS). */
  stopAttempts: number;
  handoffSubmitted: boolean;
}

export const MAX_STOP_ATTEMPTS = 10;

/*
 * F-1157 — doutrina do dono (10/10/2026): orquestrador, helpers, workers e
 * revisores têm acesso a TUDO. As allowlists (`allowedTools`/`allowedSkills`),
 * o `readOnly` e o perfil exato do revisor continuam gravados no token e nos
 * selos de missão (mudar os dados quebraria a ligação de missões já seladas),
 * mas deixaram de negar: nenhuma chamada recebe mais "tool fora da allowlist"
 * nem negação de papel do orquestrador; `readOnly` só confina sob o Hardened
 * (`readOnlyEnforced`, mcp-effect-policy). As funções abaixo ficam como a
 * resposta única e aberta para quem ainda pergunta (hoje: a interseção do
 * `allowed-tools` das skills de Agent Plugin) — `tools/list`, `tools/call`,
 * o hook e o `tool_pick` não as consultam mais.
 * Integridade de protocolo (bearer, ligação de sessão/missão, proveniência de
 * handoff, consentimento humano) não é acesso e segue nos seus módulos.
 */

let hardenedSpawnLookup: () => boolean = () => false;

/**
 * F-1157: Main registers, at boot, whether the operator chose Hardened
 * (governed) mode. Registered instead of imported so this module stays free
 * of the settings store (Electron) and of import cycles. Unregistered or a
 * failing lookup means the default Autopilot: `readOnly` is only a label.
 */
export function registerHardenedSpawnPolicy(lookup: () => boolean): void {
  hardenedSpawnLookup = lookup;
}

function hardenedSpawnPolicy(): boolean {
  try {
    return hardenedSpawnLookup() === true;
  } catch {
    return false;
  }
}

/** Did the operator choose Hardened (governed) mode? Autopilot when unknown. */
export function isHardenedSpawnPolicy(): boolean {
  return hardenedSpawnPolicy();
}

const NAMESPACE_PREFIXES = ["nexus_"];

/** Normalize a tool name to its namespace-free canonical form. */
export function canonicalToolName(name: string): string {
  const lower = name.toLowerCase();
  for (const prefix of NAMESPACE_PREFIXES) {
    if (lower.startsWith(prefix)) return lower.slice(prefix.length);
  }
  return lower;
}

/** F-1157: toda tool do Nexus está ao alcance de todo agente. */
export function isToolAllowed(
  _allowedTools: string[] | null,
  _toolName: string,
): boolean {
  return true;
}

/** F-1157: o orquestrador também implementa, commita e gera mídia. */
export function isToolAllowedForRole(
  _role: GateRole,
  _allowedTools: string[] | null,
  _toolName: string,
  _petStudioMediaAuthority = false,
): boolean {
  return true;
}

/** F-1157: nativas, Nexus e Agent Plugins, para todo papel. */
export function isHookToolAllowed(
  _allowedTools: string[] | null,
  _hookToolName: string,
  _role: GateRole = "worker",
): boolean {
  return true;
}

/** F-1157: sem filtro de skill. */
export function isSkillAllowed(
  _allowedSkills: string[] | null,
  _skillName: string,
): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// Token registry (module state, main process only).
// ---------------------------------------------------------------------------

const contexts = new Map<string, AgentGateContext>();
const contextBySession = new Map<string, AgentGateContext>();
const abortByToken = new Map<string, AbortController>();

export interface MintTokenInput {
  visualTask?: import('../../shared/orch-types').VisualTaskRequirement;
  label: string;
  role: GateRole;
  missionId?: string;
  contextRevision?: string;
  agentName?: string;
  workerIncarnationId?: string;
  providerId?: string;
  governedNativeProvider?: "codex";
  petStudioMediaAuthority?: true;
  /** Main-owned spawn proof consumed only while minting the Pet marker. */
  petStudioAuthoritySource?: "legacy-squad" | "persisted-pane";
  petStudioSquadId?: string;
  internalPrevcReviewerAuthority?: InternalPrevcReviewerAuthority;
  /** Main-owned active-session/draft proof consumed only while minting. */
  internalPrevcReviewerAuthoritySource?: "verified-active-profile";
  readOnly?: boolean;
  scope: ProjectExecutionScope;
  executionScope?: ProjectExecutionScope;
  sharedTabWorktree?: true;
  isolatedWriter?: true;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  /**
   * Main-owned spawn brief of an operator-spawned helper (see
   * AgentGateContext.operatorBrief). Never persisted nor returned to callers.
   */
  operatorBrief?: string;
  /** See AgentGateContext.operatorParentSessionId (operator helpers only). */
  operatorParentSessionId?: string;
}

export function mintToken(input: MintTokenInput): AgentGateContext {
  if (input.contextRevision && !input.missionId) {
    throw new Error('context revision authority requires a mission');
  }
  const executionScope = input.executionScope ?? input.scope;
  const workerIncarnationId = input.workerIncarnationId?.trim();
  if (
    workerIncarnationId !== undefined &&
    (
      input.role !== 'worker' ||
      workerIncarnationId.length === 0 ||
      workerIncarnationId.length > 256 ||
      workerIncarnationId.includes('\0')
    )
  ) {
    throw new Error('invalid worker incarnation authority');
  }
  if (
    input.governedNativeProvider !== undefined &&
    (
      input.providerId !== input.governedNativeProvider ||
      input.role !== 'worker' ||
      !input.missionId?.trim() ||
      input.readOnly === true
    )
  ) {
    throw new Error(
      'governed native provider requires a matching writable mission worker',
    );
  }
  if (input.petStudioMediaAuthority) {
    const maker = PET_STUDIO_SQUAD.agents[0];
    const validSource =
      input.petStudioSquadId === PET_STUDIO_SQUAD_ID &&
      (input.petStudioAuthoritySource === "legacy-squad" ||
        (input.petStudioAuthoritySource === "persisted-pane" &&
          Boolean(input.missionId?.trim())));
    const sameCapabilities = (
      actual: readonly string[] | null | undefined,
      expected: readonly string[] | null | undefined,
    ): boolean =>
      actual !== null &&
      actual !== undefined &&
      expected !== null &&
      expected !== undefined &&
      actual.length === expected.length &&
      expected.every((capability, index) => actual[index] === capability);
    if (
      !maker ||
      !validSource ||
      input.providerId !== "codex" ||
      input.role !== "orchestrator" ||
      input.agentName !== maker.agentName ||
      input.readOnly === true ||
      !sameCapabilities(input.allowedTools, maker.allowedTools) ||
      !sameCapabilities(input.allowedSkills, maker.allowedSkills)
    ) {
      throw new Error(
        "Pet Studio media authority requires the exact writable main-owned Codex maker profile",
      );
    }
  }
  if (
    input.internalPrevcReviewerAuthority !== undefined &&
    (
      input.internalPrevcReviewerAuthoritySource !==
        "verified-active-profile" ||
      !isExactInternalPrevcReviewerProfile({
        authority: input.internalPrevcReviewerAuthority,
        role: input.role,
        missionId: input.missionId,
        agentName: input.agentName,
        providerId: input.providerId,
        readOnly: input.readOnly,
        allowedTools: input.allowedTools,
        allowedSkills: input.allowedSkills,
      })
    )
  ) {
    throw new Error(
      "internal PREVC reviewer authority requires an exact active main-owned profile",
    );
  }
  if (
    input.operatorParentSessionId !== undefined &&
    (input.role !== "user" || input.missionId || input.contextRevision)
  ) {
    throw new Error("operator parent link requires a user token without a mission");
  }
  if (
    executionScope.installationId !== input.scope.installationId ||
    executionScope.projectId !== input.scope.projectId ||
    executionScope.checkoutId !== input.scope.checkoutId
  ) {
    throw new Error('execution scope must belong to the coordination scope');
  }
  const ctx: AgentGateContext = {
    token: randomBytes(24).toString("hex"),
    label: input.label,
    role: input.role,
    missionId: input.missionId,
    workerIncarnationId,
    agentName: input.agentName,
    providerId: input.providerId,
    governedNativeProvider: input.governedNativeProvider,
    petStudioMediaAuthority: input.petStudioMediaAuthority,
    internalPrevcReviewerAuthority:
      input.internalPrevcReviewerAuthority
        ? Object.freeze({ ...input.internalPrevcReviewerAuthority })
        : undefined,
    readOnly: input.readOnly === true,
    ...(input.readOnly === true && hardenedSpawnPolicy()
      ? { readOnlyEnforced: true as const }
      : {}),
    scope: Object.freeze({ ...input.scope }),
    executionScope: Object.freeze({ ...executionScope }),
    ...(input.sharedTabWorktree === true ? { sharedTabWorktree: true as const } : {}),
    ...(input.isolatedWriter === true ? { isolatedWriter: true as const } : {}),
    // Snapshot caller-owned arrays at the mint boundary. Mutating spawn
    // metadata afterwards must never widen an already-issued bearer.
    allowedTools:
      input.allowedTools === null || input.allowedTools === undefined
        ? null
        : [...input.allowedTools],
    allowedSkills:
      input.allowedSkills === null || input.allowedSkills === undefined
        ? null
        : [...input.allowedSkills],
    operatorBrief: input.operatorBrief,
    ...(input.visualTask && Number.isSafeInteger(input.visualTask.since) && input.visualTask.since >= 0
      ? { visualTask: Object.freeze({ since: input.visualTask.since,
        id: typeof input.visualTask.id === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(input.visualTask.id)
          ? input.visualTask.id : randomUUID() }) } : {}),
    operatorParentSessionId: input.operatorParentSessionId,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
  if (input.contextRevision) bindContextRevision(ctx, input.contextRevision);
  contexts.set(ctx.token, ctx);
  abortByToken.set(ctx.token, new AbortController());
  return ctx;
}

/**
 * F-1157: o revisor interno deixou de ter vocabulário exato. A prova de que o
 * token pertence a um revisor PREVC ativo continua no mint (integridade); ela
 * só não restringe mais as tools.
 */
export function isInternalPrevcReviewerToolAllowed(
  _ctx: Pick<
    AgentGateContext,
    "internalPrevcReviewerAuthority" | "allowedTools"
  >,
  _toolName: string,
): boolean {
  return true;
}

/** Claude-family hook spelling of the same open reviewer vocabulary. */
export function isInternalPrevcReviewerHookToolAllowed(
  _ctx: Pick<
    AgentGateContext,
    "internalPrevcReviewerAuthority" | "allowedTools"
  >,
  _hookToolName: string,
): boolean {
  return true;
}

export function executionScopeFor(
  ctx: Pick<AgentGateContext, 'scope' | 'executionScope'>,
): Readonly<ProjectExecutionScope> {
  return ctx.executionScope ?? ctx.scope;
}

export function assertOrchestratorMission(
  ctx: Pick<AgentGateContext, 'role' | 'missionId'>,
  missionId: string,
): void {
  if (ctx.role !== 'orchestrator') {
    throw new Error('only the mission orchestrator is authorized');
  }
  if (!ctx.missionId || ctx.missionId !== missionId) {
    throw new Error('requested mission does not match the orchestrator authority');
  }
}

/**
 * Exact physical authority for mutations that belong to the mission
 * orchestrator. A role-bearing token is not enough once main has durably bound
 * the mission to one PTY session: stale/replayed orchestrator tokens must fail
 * closed instead of acting in parallel with the accepted kickoff session.
 *
 * Legacy rows without an orchestrator binding retain their existing behavior;
 * modern running missions are bound by the main-owned bootstrap.
 */
export function assertCurrentMissionOrchestratorSession(
  ctx: Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId' | 'scope'>,
  mission: {
    readonly id: string;
    readonly orchestratorSessionId?: string | null;
  },
): void {
  assertOrchestratorMission(ctx, mission.id);
  const currentSessionId = mission.orchestratorSessionId?.trim();
  if (!currentSessionId) return;
  const missionLeaderSessionCheck = getMissionLeaderSessionCheck();
  if (!missionLeaderSessionCheck) {
    // Nenhum consumidor de liderança carregado (bootstrap parcial/fixture):
    // vale a ligação durável, como antes da onda 3.
    if (ctx.sessionId !== currentSessionId) {
      throw new Error(
        'orchestrator_session_stale: somente a sessão main-owned atual da missão ' +
          'pode planejar, reservar rota ou delegar workers; use “Retomar missão” ' +
          'para restaurar a autoridade correta',
      );
    }
    return;
  }
  const leader = missionLeaderSessionCheck(ctx.scope, mission.id, { sessionId: ctx.sessionId });
  if (!leader.ok) {
    throw new Error(
      `orchestrator_session_stale (${leader.code}): somente a sessão main-owned atual da missão ` +
        'pode planejar, reservar rota ou delegar workers; use “Retomar missão” ' +
        `para restaurar a autoridade correta — ${leader.hint}`,
    );
  }
}

/**
 * F-1013: recusa de autoridade feita ANTES de qualquer escrita do handler. O
 * dispatcher reporta `effectMayHaveCommitted` falso e repassa a dica. Só vale
 * em pontos que comprovadamente precedem toda mutação: a mesma checagem depois
 * de um efeito (ex.: o push após o done) continua lançando o erro comum.
 */
export class PreEffectRefusalError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'PreEffectRefusalError';
  }
}

export function refuseBeforeEffect(check: () => void, hint?: string): void {
  try {
    check();
  } catch (error) {
    throw new PreEffectRefusalError(
      error instanceof Error ? error.message : String(error),
      hint,
    );
  }
}

export function getContext(token: string): AgentGateContext | null {
  return contexts.get(token) ?? null;
}

export function bindTokenToSession(token: string, sessionId: string): void {
  const ctx = contexts.get(token);
  if (!ctx) return;
  if (ctx.sessionId && ctx.sessionId !== sessionId) {
    throw new Error(`token is already bound to session ${ctx.sessionId}`);
  }
  const existing = contextBySession.get(sessionId);
  if (existing && existing.token !== token) {
    throw new Error(`session ${sessionId} is already bound to another token`);
  }
  ctx.sessionId = sessionId;
  contextBySession.set(sessionId, ctx);
}

export function getContextBySession(
  sessionId: string,
): AgentGateContext | null {
  return contextBySession.get(sessionId) ?? null;
}

/** Exact identity check used at async dispatch boundaries after bearer lookup. */
export function isCurrentGateContext(ctx: AgentGateContext): boolean {
  if (contexts.get(ctx.token) !== ctx) return false;
  return !ctx.sessionId || contextBySession.get(ctx.sessionId) === ctx;
}

/** Cancellation signal paired with the exact live bearer identity. */
export function gateContextAbortSignal(
  ctx: AgentGateContext,
): AbortSignal | undefined {
  return isCurrentGateContext(ctx)
    ? abortByToken.get(ctx.token)?.signal
    : undefined;
}

export interface RestoredSessionAuthority {
  missionId: string;
  workerIncarnationId?: string;
  contextRevision?: string;
  role: "orchestrator" | "worker";
  agentName?: string;
  readOnly?: boolean;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
}

/**
 * Reapply trusted mission metadata when a persisted pane is resumed. Direct
 * panes initially mint as `user`; restoring a worker must attenuate that
 * authority instead of accidentally granting the full Nexus MCP surface.
 */
export function restoreSessionAuthority(
  sessionId: string,
  authority: RestoredSessionAuthority,
): boolean {
  const ctx = contextBySession.get(sessionId);
  if (!ctx) return false;
  if (ctx.missionId && ctx.missionId !== authority.missionId) return false;
  if (ctx.role !== "user" && ctx.role !== authority.role) return false;
  if (authority.workerIncarnationId && authority.role !== 'worker') return false;
  if (
    ctx.workerIncarnationId &&
    ctx.workerIncarnationId !== authority.workerIncarnationId
  ) return false;

  if (ctx.role === "user") {
    ctx.role = authority.role;
    ctx.readOnly = authority.readOnly === true;
    ctx.allowedTools =
      authority.allowedTools === undefined
        ? authority.role === "worker"
          ? []
          : null
        : authority.allowedTools === null
          ? null
          : [...authority.allowedTools];
    ctx.allowedSkills =
      authority.allowedSkills === undefined
        ? null
        : authority.allowedSkills === null
          ? null
          : [...authority.allowedSkills];
  }
  if (authority.readOnly === true) ctx.readOnly = true;
  if (ctx.readOnly && hardenedSpawnPolicy()) ctx.readOnlyEnforced = true;
  ctx.missionId = authority.missionId;
  if (authority.workerIncarnationId) {
    ctx.workerIncarnationId = authority.workerIncarnationId;
  }
  if (authority.contextRevision) {
    bindContextRevision(ctx, authority.contextRevision);
  }
  if (authority.agentName) ctx.agentName = authority.agentName;
  return true;
}

/**
 * O ÚNICO caminho que adota a mão do operador (`user` sem missão) como
 * orquestradora de uma missão: `nexus_mission_create`, "Tornar orquestrador"
 * e a missão sob demanda do primeiro helper passam por aqui. Mantém allowlists
 * (nunca alarga o que o pane tinha) e marca `promotedFromUserSession` para a
 * devolução ao operador quando a missão acabar. `false` = nada mudou.
 */
export function adoptUserSessionAsMissionOrchestrator(
  sessionId: string,
  missionId: string,
  contextRevision?: string,
): boolean {
  const ctx = contextBySession.get(sessionId);
  const target = missionId.trim();
  if (!ctx || !target || ctx.role !== "user" || ctx.missionId) return false;
  return adoptUserContextAsMissionOrchestrator(ctx, target, contextRevision);
}

/** Mesma adoção sobre o contexto já resolvido do chamador MCP. */
export function adoptUserContextAsMissionOrchestrator(
  ctx: AgentGateContext,
  missionId: string,
  contextRevision?: string,
): boolean {
  if (ctx.role !== "user" || ctx.missionId || !missionId.trim()) return false;
  ctx.missionId = missionId.trim();
  ctx.role = "orchestrator";
  ctx.promotedFromUserSession = true;
  ctx.handoffSubmitted = false;
  if (contextRevision) bindContextRevision(ctx, contextRevision);
  return true;
}

export interface PromoteMissionSessionAuthorityInput {
  missionId: string;
  promotedSessionId: string;
  previousSessionId?: string | null;
}

export function promoteMissionSessionAuthority(
  input: PromoteMissionSessionAuthorityInput,
): boolean {
  const missionId = input.missionId.trim();
  const promoted = contextBySession.get(input.promotedSessionId);
  if (
    !missionId ||
    !promoted ||
    promoted.missionId !== missionId ||
    (promoted.role !== "worker" && promoted.role !== "orchestrator")
  ) {
    return false;
  }
  promoted.role = "orchestrator";
  promoted.allowedTools = null;
  promoted.allowedSkills = null;
  promoted.handoffSubmitted = false;
  delete promoted.workerIncarnationId;

  const previousSessionId = input.previousSessionId?.trim();
  if (
    previousSessionId &&
    previousSessionId !== input.promotedSessionId
  ) {
    demoteMissionOrchestratorSession(missionId, previousSessionId);
  }
  return true;
}

/**
 * Troca de liderança: o orquestrador anterior deixa de liderar a missão.
 *
 * Troca de coroa NÃO é adoção: quem foi promovido a partir de `user` (a mão do
 * operador) volta a `user` com o que tinha, nunca vira worker sem tools. Só o
 * líder nascido na missão (missão selada) é rebaixado a worker.
 */
export function demoteMissionOrchestratorSession(
  missionId: string,
  sessionId: string,
): void {
  const previous = contextBySession.get(sessionId);
  if (
    previous &&
    previous.missionId === missionId &&
    previous.role === "orchestrator"
  ) {
    if (returnOperatorHandFromEndedMission(previous)) return;
    previous.role = "worker";
    previous.allowedTools = [];
    previous.allowedSkills = null;
    previous.handoffSubmitted = false;
    delete previous.workerIncarnationId;
  }
}

/** Compensation for a failed cross-store mission creation commit. */
/**
 * Desfaz o vínculo de uma sessão com uma missão que deixou de existir.
 *
 * A promoção `user` → `orchestrator` de `nexus_mission_create` era porta de mão
 * única: quem criava uma missão num pane e a descartava ficava estéril para
 * sempre — `nexus_mission_create` respondia "only a user-owned session may
 * create a mission" e só um pane novo resolvia (campo 09/09). Aqui a promoção
 * é revertida junto com a missão que a justificou.
 *
 * A devolução vale SÓ para quem foi promovido a partir de `user`. Worker órfão
 * perde a missão e continua worker.
 */
export function rollbackSessionAuthorityMission(
  sessionId: string,
  missionId: string,
): boolean {
  const ctx = contextBySession.get(sessionId);
  if (!ctx || ctx.missionId !== missionId) return false;
  delete ctx.missionId;
  delete ctx.contextRevision;
  delete ctx.workerIncarnationId;
  if (ctx.promotedFromUserSession) {
    ctx.role = "user";
    ctx.allowedTools = null;
    ctx.allowedSkills = null;
    ctx.handoffSubmitted = false;
    delete ctx.promotedFromUserSession;
  }
  return true;
}

/**
 * Missão ENCERRADA (done/failed) não aprisiona a mão do operador (campo 25/09).
 *
 * O rollback acima só rodava quando a missão era APAGADA. Missão que falhava ou
 * concluía deixava o pane que a criou `orchestrator` de uma missão morta: todo
 * `pane_spawn`/`terminal_run` voltava `dispatch_required`, `nexus_mission_create`
 * respondia "only a user-owned session may create a mission", e o agente pedia
 * ao operador um despacho que o Quadro de missão falha nem oferece.
 *
 * Devolve SÓ quem foi promovido de `user` e continua orquestrador. A promoção
 * não mexeu no allowlist, então a devolução também não mexe — nunca alarga o
 * que o pane tinha. A troca de liderança usa a mesma devolução
 * (`demoteMissionOrchestratorSession`), então um worker com essa marca só pode
 * vir de autoridade da missão e fica como está.
 */
export function returnOperatorHandFromEndedMission(
  ctx: AgentGateContext,
): boolean {
  if (
    !ctx.promotedFromUserSession ||
    !ctx.missionId ||
    ctx.role !== "orchestrator"
  ) {
    return false;
  }
  delete ctx.missionId;
  delete ctx.contextRevision;
  delete ctx.workerIncarnationId;
  delete ctx.promotedFromUserSession;
  ctx.role = "user";
  ctx.handoffSubmitted = false;
  return true;
}

/**
 * F-231: o pane que o operador abriu dentro da missão volta à mão dele no
 * fim — a máquina da missão nunca o fecha. Mesmo efeito da devolução do
 * líder adotado, mas para o worker `operatorOpened`: allowlist aberta de
 * volta ao que o operador tinha (null = irrestrito, como todo pane dele).
 */
export function returnOperatorOpenedSessionToUser(
  sessionId: string,
  missionId: string,
): boolean {
  const ctx = contextBySession.get(sessionId);
  if (!ctx || ctx.missionId !== missionId) return false;
  delete ctx.missionId;
  delete ctx.contextRevision;
  delete ctx.workerIncarnationId;
  delete ctx.promotedFromUserSession;
  ctx.role = "user";
  ctx.allowedTools = null;
  ctx.allowedSkills = null;
  ctx.handoffSubmitted = false;
  return true;
}

/** Toda sessão presa à missão que sumiu, devolvida de uma vez. */
export function rollbackMissionSessionAuthorities(missionId: string): number {
  const target = missionId.trim();
  if (!target) return 0;
  let released = 0;
  for (const [sessionId, ctx] of contextBySession) {
    if (ctx.missionId !== target) continue;
    if (rollbackSessionAuthorityMission(sessionId, target)) released += 1;
  }
  return released;
}

export function bindContextRevision(
  ctx: Pick<AgentGateContext, 'contextRevision'>,
  contextRevision: string,
): void {
  const normalized = contextRevision.trim();
  if (!normalized || normalized.length > 256 || normalized.includes('\0')) {
    throw new Error('invalid context revision authority');
  }
  if (ctx.contextRevision && ctx.contextRevision !== normalized) {
    throw new Error('agent context revision does not match the frozen mission');
  }
  ctx.contextRevision = normalized;
}

/**
 * Main-owned PREVC freeze/refreeze transition. A provider cannot call this
 * primitive directly: the context tool supplies the exact prior revision
 * from the durable workflow, and only an unbound or exactly matching gate
 * context may advance to the new revision.
 */
export function rotateContextRevisionAuthority(
  ctx: Pick<AgentGateContext, 'contextRevision'>,
  expectedRevision: string | undefined,
  nextRevision: string,
): void {
  const expected = expectedRevision?.trim();
  if (
    ctx.contextRevision !== undefined &&
    ctx.contextRevision !== expected
  ) {
    throw new Error(
      'agent context revision changed before PREVC authority rotation',
    );
  }
  delete ctx.contextRevision;
  bindContextRevision(ctx, nextRevision);
}

export function releaseSession(sessionId: string): void {
  const ctx = contextBySession.get(sessionId);
  if (!ctx) return;
  contextBySession.delete(sessionId);
  contexts.delete(ctx.token);
  abortByToken.get(ctx.token)?.abort('session_authority_revoked');
  abortByToken.delete(ctx.token);
}

/**
 * Drop a token that never bound to a session (its PTY failed to spawn) so it
 * cannot authorize MCP calls forever.
 */
export function releaseSessionByToken(token: string): void {
  const ctx = contexts.get(token);
  if (
    ctx?.sessionId &&
    contextBySession.get(ctx.sessionId) === ctx
  ) {
    contextBySession.delete(ctx.sessionId);
  }
  contexts.delete(token);
  abortByToken.get(token)?.abort('session_authority_revoked');
  abortByToken.delete(token);
}

export function markHandoffSubmitted(ctx: AgentGateContext): void {
  ctx.handoffSubmitted = true;
}

/**
 * Stop-gate decision. C-194.1: nunca BLOQUEIA o stop. A doutrina do worker é
 * condicional (resposta ≤280 chars → NÃO chama tool, só encerre o turno — o
 * fechamento mecânico em turn-end-handoff entrega verbatim), então exigir a
 * tool antes do stop contradiria o próprio contrato que ensinamos. O
 * stopAttempts continua contado puramente como observação de workers que
 * terminam sem handoff confiável; a garantia de entrega é do Main, não do
 * bloqueio de turno.
 */
export function evaluateStop(
  ctx: AgentGateContext,
  hasTrustedHandoff = ctx.handoffSubmitted,
): {
  allow: boolean;
  reason?: string;
} {
  ctx.handoffSubmitted = hasTrustedHandoff;
  if (ctx.role === "worker" && !hasTrustedHandoff) {
    ctx.stopAttempts += 1;
  }
  return { allow: true };
}

/** Test-only: reset module state. */
export function resetGateForTests(): void {
  for (const controller of abortByToken.values()) {
    controller.abort('gate_reset');
  }
  contexts.clear();
  contextBySession.clear();
  abortByToken.clear();
}
