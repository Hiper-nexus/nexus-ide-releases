import { randomBytes } from "node:crypto";
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
  internalPrevcReviewerAllowsTool,
  isExactInternalPrevcReviewerProfile,
  type InternalPrevcReviewerAuthority,
} from "./prevc-reviewer-profile";

/**
 * Skill-gate — the server-side half of the dual enforcement described in
 * docs/ARCHITECTURE.md §E.4. Every MCP client (a CLI agent inside a PTY) holds
 * a bearer token minted at spawn time and bound to that agent's allowlists.
 * The embedded MCP server refuses out-of-allowlist calls HERE, regardless of
 * whether the client-side PreToolUse hook was bypassed.
 *
 * Allowlist semantics: `null` = unrestricted, and
 * handoff_submit / handoff_list / handoff_ack / ToolSearch plus in-mission
 * pane observation (pane_read / pane_read_many / pane_list / pane_whoami)
 * are always allowed. Object-level pane-authz still confines reads to the
 * caller's mission and blocks the user's shell/browser.
 */

export type GateRole = "orchestrator" | "worker" | "user";

export interface AgentGateContext {
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
  /** Immutable project/checkout authority captured before the PTY starts. */
  scope: Readonly<ProjectExecutionScope>;
  /** Filesystem checkout granted to this agent (task worktree when present). */
  executionScope?: Readonly<ProjectExecutionScope>;
  allowedTools: string[] | null;
  allowedSkills: string[] | null;
  /** Stop-gate attempts (worker may leave after MAX_STOP_ATTEMPTS). */
  stopAttempts: number;
  handoffSubmitted: boolean;
}

export const MAX_STOP_ATTEMPTS = 10;

/** Tools that must work regardless of any allowlist. */
const ALWAYS_ALLOWED = new Set([
  "handoff_submit",
  "handoff_list",
  "handoff_ack",
  "worker_heartbeat",
  "toolsearch",
  // Overclock parity: any pane in the mission may inspect any other pane's
  // PTY buffer (worker↔worker, worker→orchestrator, orchestrator→worker).
  // Write/spawn/close stay on the squad allowlist. pane-authz is the real
  // boundary (same mission, never the user's shell/browser).
  "pane_read",
  "pane_read_many",
  "pane_list",
  "pane_whoami",
  // Conversa entre panes (ordem do operador, 20/08): qualquer pane pergunta
  // a outro e recebe a resposta. pane-authz continua a fronteira real —
  // worker não escreve no orquestrador, nunca no shell/browser do usuário.
  "pane_ask",
  // Observation: any pane can read GitHub merge-queue state for the branch PR.
  "pr_inspect",
]);

/**
 * High-impact tools that reach OUTSIDE the sandbox — SSH to arbitrary hosts,
 * mutating the shared ~/.claude/agents specs, or opening the network bridge.
 * A default (null) allowlist means "unrestricted" for ordinary tools, but a
 * prompt-injected agent must NOT inherit these implicitly. They are granted
 * only when a squad/mission names them EXPLICITLY in the agent's allowlist.
 */
const REQUIRES_EXPLICIT_ALLOW = new Set([
  "remote_spawn",
  "remote_cli_detect",
  "remote_tmux_list",
  "remote_bridge_status",
  "agent_spec_write",
  "catalog_install",
  "cron",
  "cron_schedule",
  "cron_list",
  "cron_cancel",
]);

const ORCHESTRATOR_DENIED_TOOLS = new Set([
  "file_write", "editor_insert", "editor_replace_selection",
  "editor_apply_patch",
  "terminal_kill", "git_add", "git_commit", "git_push",
  "git_pull", "git_branch_create", "git_branch_switch",
  "image_generate", "video_generate", "audio_generate",
]);

const ORCHESTRATOR_DENIED_NATIVE_TOOLS = new Set([
  "task", "bash", "edit", "write", "notebookedit",
]);

const NAMESPACE_PREFIXES = ["nexus_"];

/** Normalize a tool name to its namespace-free canonical form. */
export function canonicalToolName(name: string): string {
  const lower = name.toLowerCase();
  for (const prefix of NAMESPACE_PREFIXES) {
    if (lower.startsWith(prefix)) return lower.slice(prefix.length);
  }
  return lower;
}

/** Pure allowlist check — exported separately for unit tests. */
export function isToolAllowed(
  allowedTools: string[] | null,
  toolName: string,
): boolean {
  const canonical = canonicalToolName(toolName);
  if (ALWAYS_ALLOWED.has(canonical)) return true;
  if (REQUIRES_EXPLICIT_ALLOW.has(canonical)) {
    // Never implicitly available — requires an explicit grant, even when the
    // rest of the toolset is unrestricted.
    return (
      allowedTools !== null &&
      allowedTools.some((allowed) => {
        const allowedCanonical = canonicalToolName(allowed);
        if (allowedCanonical === canonical) return true;
        if (
          allowedCanonical === 'cron' &&
          (canonical === 'cron_schedule' ||
            canonical === 'cron_list' ||
            canonical === 'cron_cancel')
        ) {
          return true;
        }
        return false;
      })
    );
  }
  if (allowedTools === null) return true;
  return allowedTools.some((allowed) => {
    const allowedCanonical = canonicalToolName(allowed);
    if (allowedCanonical === canonical) return true;
    // Squad allowlists speak native CLI tool names (Bash/Read/Edit). Map the
    // corresponding nexus_* instrumented forms so a squad that grants Bash
    // also grants nexus_terminal_run, and one that grants Edit also grants
    // nexus file/editor writes. Read is already covered by the read-only
    // boundary, but we keep the mapping symmetric.
    if (canonical === 'terminal_run' && allowedCanonical === 'bash') return true;
    if (canonical === 'bg_run' && allowedCanonical === 'bash') return true;
    if (canonical === 'file_read' && allowedCanonical === 'read') return true;
    if (canonical === 'file_search' && allowedCanonical === 'read') return true;
    if (canonical === 'file_write' && allowedCanonical === 'edit') return true;
    if (canonical === 'editor_insert' && allowedCanonical === 'edit') return true;
    if (canonical === 'editor_replace_selection' && allowedCanonical === 'edit') {
      return true;
    }
    if (canonical === 'editor_apply_patch' && allowedCanonical === 'edit') {
      return true;
    }
    return false;
  });
}

/** Role boundary applied after the squad allowlist. A coordinator may inspect,
 * plan, delegate, validate and merge, but cannot become the implementation pane. */
export function isToolAllowedForRole(
  role: GateRole,
  allowedTools: string[] | null,
  toolName: string,
  petStudioMediaAuthority = false,
): boolean {
  const canonical = canonicalToolName(toolName);
  if (
    role === "orchestrator" &&
    ORCHESTRATOR_DENIED_TOOLS.has(canonical) &&
    !(petStudioMediaAuthority && canonical === "image_generate")
  ) {
    return false;
  }
  // Mission orchestrators must always be able to delegate to workers, even
  // when the squad roster expresses that as an empty allowlist. pane_spawn
  // itself enforces role/mission/authority downstream.
  if (role === "orchestrator" && canonical === "pane_spawn") return true;
  return isToolAllowed(allowedTools, toolName);
}

/**
 * Claude hooks also observe native Read/Edit/Bash calls. Nexus MCP allowlists
 * must not be mistaken for a native-tool allowlist: native tools remain under
 * the CLI's explicit safe permission/sandbox mode, while Nexus MCP calls keep
 * the per-agent gate enforced here and again in the HTTP MCP server.
 */
export function isHookToolAllowed(
  allowedTools: string[] | null,
  hookToolName: string,
  role: GateRole = "worker",
): boolean {
  const lower = hookToolName.trim().toLowerCase();
  const mcpPrefix = "mcp__nexus__";
  if (lower.startsWith(mcpPrefix)) {
    return isToolAllowedForRole(role, allowedTools, lower.slice(mcpPrefix.length));
  }
  if (lower.startsWith("mcp__agent-plugin-")) {
    if (allowedTools === null) return true;
    return allowedTools.some(
      (allowed) => allowed.trim().toLowerCase() === lower,
    );
  }
  if (lower.startsWith("nexus_")) return isToolAllowedForRole(role, allowedTools, lower);
  if (role === "orchestrator" && ORCHESTRATOR_DENIED_NATIVE_TOOLS.has(lower)) {
    return false;
  }
  return true;
}

export function isSkillAllowed(
  allowedSkills: string[] | null,
  skillName: string,
): boolean {
  if (allowedSkills === null) return true;
  const target = skillName.toLowerCase();
  return allowedSkills.some((allowed) => allowed.toLowerCase() === target);
}

// ---------------------------------------------------------------------------
// Token registry (module state, main process only).
// ---------------------------------------------------------------------------

const contexts = new Map<string, AgentGateContext>();
const contextBySession = new Map<string, AgentGateContext>();
const abortByToken = new Map<string, AbortController>();

export interface MintTokenInput {
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
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
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
    scope: Object.freeze({ ...input.scope }),
    executionScope: Object.freeze({ ...executionScope }),
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
    stopAttempts: 0,
    handoffSubmitted: false,
  };
  if (input.contextRevision) bindContextRevision(ctx, input.contextRevision);
  contexts.set(ctx.token, ctx);
  abortByToken.set(ctx.token, new AbortController());
  return ctx;
}

/**
 * Exact MCP vocabulary for a main-owned internal reviewer. This check runs in
 * addition to the ordinary allowlist so the global handoff escape hatches
 * cannot widen a reviewer token after its PREVC stage has ended.
 */
export function isInternalPrevcReviewerToolAllowed(
  ctx: Pick<
    AgentGateContext,
    "internalPrevcReviewerAuthority" | "allowedTools"
  >,
  toolName: string,
): boolean {
  if (!ctx.internalPrevcReviewerAuthority) return true;
  return internalPrevcReviewerAllowsTool(
    ctx.internalPrevcReviewerAuthority,
    ctx.allowedTools,
    toolName,
  );
}

/** Claude-family hook spelling of the same exact reviewer vocabulary. */
export function isInternalPrevcReviewerHookToolAllowed(
  ctx: Pick<
    AgentGateContext,
    "internalPrevcReviewerAuthority" | "allowedTools"
  >,
  hookToolName: string,
): boolean {
  if (!ctx.internalPrevcReviewerAuthority) return true;
  const normalized = hookToolName.trim().toLowerCase();
  // Native discovery is not an MCP effect and is required to find the seven
  // namespaced tools. No other native tool receives this exception.
  if (normalized === "toolsearch") return true;
  const nexusTool = normalized.startsWith("mcp__nexus__")
    ? normalized.slice("mcp__nexus__".length)
    : normalized;
  return isInternalPrevcReviewerToolAllowed(ctx, nexusTool);
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
    const previous = contextBySession.get(previousSessionId);
    if (
      previous &&
      previous.missionId === missionId &&
      previous.role === "orchestrator"
    ) {
      previous.role = "worker";
      previous.allowedTools = [];
      previous.allowedSkills = null;
      previous.handoffSubmitted = false;
      delete previous.workerIncarnationId;
    }
  }
  return true;
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
