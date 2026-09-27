/**
 * Pure continuity pack for multi-account failover.
 * Cross-account resume cannot reuse provider session ids (account-owned),
 * so we rehydrate mission intent as a fresh CLI prompt.
 */

import {
  FAILOVER_HANDOFF_FOOTER,
  FAILOVER_HANDOFF_HEADER,
  sanitizeHandoffExcerptForDetector,
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

/**
 * Packs anteriores vêm impressos no scrollback (o handoff é digitado no CLI
 * e ecoa). Sem a poda, cada ciclo de failover embutia o pack anterior e o
 * prompt crescia a cada sessão nova — um pane recém-aberto, que ainda não
 * recebeu nenhum pedido, herdava milhares de tokens.
 */
const NESTED_PACK_RE = new RegExp(
  `\\${FAILOVER_HANDOFF_HEADER}[\\s\\S]*?${FAILOVER_HANDOFF_FOOTER}`,
  'g',
);

export function stripNestedHandoffPacks(scrollback: string): string {
  return scrollback
    .replace(NESTED_PACK_RE, '[handoff anterior omitido]')
    .replace(/[ \t]{2,}/g, ' ');
}

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
    `Account "${input.fromAccountLabel}" hit a provider limit (${sanitizeHandoffExcerptForDetector(clip(input.reason, 160))}).`,
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
    // Sanitizado contra o limit-detector (F-511): o excerpt cita a tela da
    // morte da sessão anterior — 401/429/quota verbatim. Sem as máscaras, o
    // detector recasa esse texto citado como sinal vivo assim que o header
    // do pack sai da janela rolante (4000 chars) e o failover entra em
    // ping-pong entre contas saudáveis. O motivo na 2ª linha recebe o mesmo
    // tratamento: a TUI pode redesenhá-la sem o header.
    const excerpt = sanitizeHandoffExcerptForDetector(
      clip(stripNestedHandoffPacks(input.scrollbackExcerpt), MAX_EXCERPT),
    );
    lines.push(`Recent terminal excerpt (may be partial):\n"""\n${excerpt}\n"""`);
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
