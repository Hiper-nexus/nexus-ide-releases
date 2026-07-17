/**
 * Pure continuity pack for multi-account failover.
 * Cross-account resume cannot reuse provider session ids (account-owned),
 * so we rehydrate mission intent as a fresh CLI prompt.
 */

import {
  FAILOVER_HANDOFF_FOOTER,
  FAILOVER_HANDOFF_HEADER,
} from '../../shared/failover-handoff';

export interface ContinuityPackInput {
  fromAccountLabel: string;
  toAccountLabel: string;
  reason: string;
  role?: string;
  missionId?: string;
  /** Truncated terminal scrollback (ANSI stripped preferred). */
  scrollbackExcerpt?: string;
  /** Short task/todo hint from orch store. */
  openWorkHint?: string;
}

const MAX_EXCERPT = 2_400;
const MAX_HINT = 600;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Build the handoff prompt injected after a fresh spawn on the replacement
 * account. Never claims native --resume succeeded across accounts.
 */
export function buildContinuityPack(input: ContinuityPackInput): string {
  const role = input.role === 'orchestrator' ? 'orchestrator' : 'agent';
  const lines = [
    FAILOVER_HANDOFF_HEADER,
    `Account "${input.fromAccountLabel}" hit a provider limit (${clip(input.reason, 160)}).`,
    `You are now running on account "${input.toAccountLabel}" in a NEW provider session.`,
    `Terminal scrollback above is historical context only — the previous conversation id is NOT transferable across accounts.`,
    `Continue as the ${role} from the next pending step. Do not re-do completed work. Prefer files/MCP mission state over guessing.`,
  ];
  if (input.missionId) {
    lines.push(`Mission id: ${clip(input.missionId, 80)}.`);
  }
  if (input.openWorkHint) {
    lines.push(`Open work: ${clip(input.openWorkHint, MAX_HINT)}`);
  }
  if (input.scrollbackExcerpt) {
    lines.push(
      `Recent terminal excerpt (may be partial):\n"""\n${clip(input.scrollbackExcerpt, MAX_EXCERPT)}\n"""`,
    );
  }
  lines.push(FAILOVER_HANDOFF_FOOTER);
  return lines.join('\n');
}

/** Same-account recovery (stall) keeps a lighter continue prompt. */
export function buildSameAccountContinuePrompt(role?: string): string {
  const r = role === 'orchestrator' ? 'orchestrator' : 'agent';
  return (
    `Continue the current mission from exactly where you stopped as the ${r}. ` +
    'Preserve existing context and execute the next pending step now.'
  );
}
