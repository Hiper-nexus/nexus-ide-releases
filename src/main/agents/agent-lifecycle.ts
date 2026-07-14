import { z } from 'zod';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';

/**
 * Agent lifecycle: finished / needs-input events, resume, reap finished only.
 * Hooks install/uninstall remain in agent-hooks/*; this is orchestration status.
 */

export const agentLifecycleStatusSchema = z.enum([
  'running',
  'needs-input',
  'finished',
  'reaped',
  'unknown',
]);

export type AgentLifecycleStatus = z.infer<typeof agentLifecycleStatusSchema>;

export const agentLifecycleEventSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    agentId: z.string().min(1).max(128).optional(),
    status: agentLifecycleStatusSchema,
    accountId: z.string().max(128).optional(),
    transcriptPath: z.string().max(4096).optional(),
    at: z.number().int().nonnegative(),
  })
  .strict();

export type AgentLifecycleEvent = z.infer<typeof agentLifecycleEventSchema>;

export interface AgentRecord {
  sessionId: string;
  status: AgentLifecycleStatus;
  accountId?: string;
  finishedAt?: number;
  transcriptPath?: string;
}

const agents = new Map<string, AgentRecord>();

export function recordAgentEvent(raw: unknown): AgentLifecycleEvent {
  const event = agentLifecycleEventSchema.parse(raw);
  agents.set(event.sessionId, {
    sessionId: event.sessionId,
    status: event.status,
    accountId: event.accountId,
    finishedAt: event.status === 'finished' ? event.at : undefined,
    transcriptPath: redactTranscriptPath(event.transcriptPath),
  });
  return event;
}

export function redactTranscriptPath(path?: string): string | undefined {
  if (!path) return undefined;
  // Never return home-relative secrets; keep basename only for UI.
  const base = path.split(/[/\\]/).pop() ?? 'transcript';
  return `[transcript]/${base}`;
}

/** Reap only finished agents; never kill running. */
export function reapFinishedAgents(now = Date.now(), maxAgeMs = 60_000): string[] {
  const reaped: string[] = [];
  for (const [id, rec] of agents) {
    if (rec.status !== 'finished') continue;
    if (rec.finishedAt !== undefined && now - rec.finishedAt < maxAgeMs) continue;
    agents.set(id, { ...rec, status: 'reaped' });
    reaped.push(id);
  }
  return reaped;
}

export function listAgents(): AgentRecord[] {
  return [...agents.values()];
}

export function assertExplicitAccountSwitch(
  fromAccountId: string | undefined,
  toAccountId: string,
): void {
  if (!toAccountId) throw new Error('account id required');
  if (fromAccountId && fromAccountId === toAccountId) return;
  // Caller must have obtained explicit UI confirmation; we only record the gate.
  if (
    getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.autonomyProfiles) ||
    true
  ) {
    // Always require non-empty explicit target — silent auto-switch forbidden.
    if (!toAccountId.trim()) throw new Error('explicit account switch required');
  }
}

/** Test-only. */
export function resetAgentLifecycleForTests(): void {
  agents.clear();
}
