import { randomBytes } from 'node:crypto';

/**
 * Skill-gate — the server-side half of the dual enforcement described in
 * docs/ARCHITECTURE.md §E.4. Every MCP client (a CLI agent inside a PTY) holds
 * a bearer token minted at spawn time and bound to that agent's allowlists.
 * The embedded MCP server refuses out-of-allowlist calls HERE, regardless of
 * whether the client-side PreToolUse hook was bypassed.
 *
 * Overclock semantics preserved: `null` allowlist = unrestricted, and
 * handoff_submit / handoff_list / ToolSearch are always allowed.
 */

export type GateRole = 'orchestrator' | 'worker' | 'user';

export interface AgentGateContext {
  token: string;
  label: string;
  role: GateRole;
  /** PTY session bound after spawn (used by Stop-gate + handoff attribution). */
  sessionId?: string;
  missionId?: string;
  agentName?: string;
  allowedTools: string[] | null;
  allowedSkills: string[] | null;
  /** Stop-gate attempts (worker may leave after MAX_STOP_ATTEMPTS). */
  stopAttempts: number;
  handoffSubmitted: boolean;
}

export const MAX_STOP_ATTEMPTS = 3;

/** Tools that must work regardless of any allowlist (Overclock parity). */
const ALWAYS_ALLOWED = new Set([
  'handoff_submit',
  'handoff_list',
  'toolsearch',
]);

const NAMESPACE_PREFIXES = ['nexus_', 'overclock_'];

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
  if (allowedTools === null) return true;
  return allowedTools.some((allowed) => canonicalToolName(allowed) === canonical);
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
  agentName?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
}

export function mintToken(input: MintTokenInput): AgentGateContext {
  const ctx: AgentGateContext = {
    token: randomBytes(24).toString('hex'),
    label: input.label,
    role: input.role,
    missionId: input.missionId,
    agentName: input.agentName,
    allowedTools: input.allowedTools ?? null,
    allowedSkills: input.allowedSkills ?? null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
  contexts.set(ctx.token, ctx);
  return ctx;
}

export function getContext(token: string): AgentGateContext | null {
  return contexts.get(token) ?? null;
}

export function bindTokenToSession(token: string, sessionId: string): void {
  const ctx = contexts.get(token);
  if (!ctx) return;
  ctx.sessionId = sessionId;
  contextBySession.set(sessionId, ctx);
}

export function getContextBySession(
  sessionId: string,
): AgentGateContext | null {
  return contextBySession.get(sessionId) ?? null;
}

export function releaseSession(sessionId: string): void {
  const ctx = contextBySession.get(sessionId);
  if (!ctx) return;
  contextBySession.delete(sessionId);
  contexts.delete(ctx.token);
}

export function markHandoffSubmitted(ctx: AgentGateContext): void {
  ctx.handoffSubmitted = true;
}

/**
 * Stop-gate decision: a worker may only stop after submitting a handoff, or
 * after MAX_STOP_ATTEMPTS blocked attempts (Overclock parity — never trap an
 * agent forever). Non-workers are never blocked.
 */
export function evaluateStop(ctx: AgentGateContext): {
  allow: boolean;
  reason?: string;
} {
  if (ctx.role !== 'worker') return { allow: true };
  if (ctx.handoffSubmitted) return { allow: true };
  ctx.stopAttempts += 1;
  if (ctx.stopAttempts >= MAX_STOP_ATTEMPTS) return { allow: true };
  return {
    allow: false,
    reason:
      'You must submit your handoff before finishing: call the ' +
      'nexus_handoff_submit tool with {status, summary, artifacts}. ' +
      `(attempt ${ctx.stopAttempts}/${MAX_STOP_ATTEMPTS})`,
  };
}

/** Test-only: reset module state. */
export function resetGateForTests(): void {
  contexts.clear();
  contextBySession.clear();
}
