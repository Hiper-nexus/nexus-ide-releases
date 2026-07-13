import { randomBytes } from "node:crypto";
import type { ProjectExecutionScope } from "../../shared/types";

/**
 * Skill-gate — the server-side half of the dual enforcement described in
 * docs/ARCHITECTURE.md §E.4. Every MCP client (a CLI agent inside a PTY) holds
 * a bearer token minted at spawn time and bound to that agent's allowlists.
 * The embedded MCP server refuses out-of-allowlist calls HERE, regardless of
 * whether the client-side PreToolUse hook was bypassed.
 *
 * Allowlist semantics: `null` = unrestricted, and
 * handoff_submit / handoff_list / ToolSearch are always allowed.
 */

export type GateRole = "orchestrator" | "worker" | "user";

export interface AgentGateContext {
  token: string;
  label: string;
  role: GateRole;
  /** PTY session bound after spawn (used by Stop-gate + handoff attribution). */
  sessionId?: string;
  missionId?: string;
  /** Frozen business-context revision bound to every mission effect. */
  contextRevision?: string;
  agentName?: string;
  /** Concrete CLI/provider identity, captured by main at spawn. */
  providerId?: string;
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

export const MAX_STOP_ATTEMPTS = 3;

/** Tools that must work regardless of any allowlist. */
const ALWAYS_ALLOWED = new Set([
  "handoff_submit",
  "handoff_list",
  "toolsearch",
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
]);

const ORCHESTRATOR_DENIED_TOOLS = new Set([
  "file_write", "editor_insert", "editor_replace_selection",
  "terminal_run", "terminal_kill", "git_add", "git_commit", "git_push",
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
      allowedTools.some((allowed) => canonicalToolName(allowed) === canonical)
    );
  }
  if (allowedTools === null) return true;
  return allowedTools.some(
    (allowed) => canonicalToolName(allowed) === canonical,
  );
}

/** Role boundary applied after the squad allowlist. A coordinator may inspect,
 * plan, delegate, validate and merge, but cannot become the implementation pane. */
export function isToolAllowedForRole(
  role: GateRole,
  allowedTools: string[] | null,
  toolName: string,
): boolean {
  if (
    role === "orchestrator" &&
    ORCHESTRATOR_DENIED_TOOLS.has(canonicalToolName(toolName))
  ) return false;
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

export interface MintTokenInput {
  label: string;
  role: GateRole;
  missionId?: string;
  contextRevision?: string;
  agentName?: string;
  providerId?: string;
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
    agentName: input.agentName,
    providerId: input.providerId,
    readOnly: input.readOnly === true,
    scope: Object.freeze({ ...input.scope }),
    executionScope: Object.freeze({ ...executionScope }),
    allowedTools: input.allowedTools ?? null,
    allowedSkills: input.allowedSkills ?? null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
  if (input.contextRevision) bindContextRevision(ctx, input.contextRevision);
  contexts.set(ctx.token, ctx);
  return ctx;
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

export interface RestoredSessionAuthority {
  missionId: string;
  contextRevision?: string;
  role: "orchestrator" | "worker";
  agentName?: string;
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

  if (ctx.role === "user") {
    ctx.role = authority.role;
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
  ctx.missionId = authority.missionId;
  if (authority.contextRevision) {
    bindContextRevision(ctx, authority.contextRevision);
  }
  if (authority.agentName) ctx.agentName = authority.agentName;
  return true;
}

/** Compensation for a failed cross-store mission creation commit. */
export function rollbackSessionAuthorityMission(
  sessionId: string,
  missionId: string,
): boolean {
  const ctx = contextBySession.get(sessionId);
  if (!ctx || ctx.missionId !== missionId) return false;
  delete ctx.missionId;
  delete ctx.contextRevision;
  return true;
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

export function releaseSession(sessionId: string): void {
  const ctx = contextBySession.get(sessionId);
  if (!ctx) return;
  contextBySession.delete(sessionId);
  contexts.delete(ctx.token);
}

/**
 * Drop a token that never bound to a session (its PTY failed to spawn) so it
 * cannot authorize MCP calls forever.
 */
export function releaseSessionByToken(token: string): void {
  contexts.delete(token);
}

export function markHandoffSubmitted(ctx: AgentGateContext): void {
  ctx.handoffSubmitted = true;
}

/**
 * Stop-gate decision: a worker may only stop after submitting a handoff, or
 * after MAX_STOP_ATTEMPTS blocked attempts (never trap an
 * agent forever). Non-workers are never blocked.
 */
export function evaluateStop(
  ctx: AgentGateContext,
  hasTrustedHandoff = ctx.handoffSubmitted,
): {
  allow: boolean;
  reason?: string;
} {
  if (ctx.role !== "worker") return { allow: true };
  ctx.handoffSubmitted = hasTrustedHandoff;
  if (hasTrustedHandoff) return { allow: true };
  ctx.stopAttempts += 1;
  if (ctx.stopAttempts >= MAX_STOP_ATTEMPTS) return { allow: true };
  return {
    allow: false,
    reason:
      "You must submit your handoff before finishing: call the " +
      "nexus_handoff_submit tool with {status, summary, evidenceIds}. " +
      "Only current Nexus-issued evidence satisfies the stop receipt. " +
      `(attempt ${ctx.stopAttempts}/${MAX_STOP_ATTEMPTS})`,
  };
}

/** Test-only: reset module state. */
export function resetGateForTests(): void {
  contexts.clear();
  contextBySession.clear();
}
