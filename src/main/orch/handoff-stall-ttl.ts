/**
 * TTL de stalled (paridade Overclock 1.3.5: "estados de morte nomeados").
 * Entrega em voo sem veredito e sem movimento vira `stalled` — deixa de ser
 * pendente anônima e ganha dono para cobrança/doctor. Puro, sem sqlite.
 */
import type { Handoff } from '../../shared/orch-types';

/** 30min sem sair do lugar = stalled (OC: soft-waiting >30min). */
export const HANDOFF_STALL_TTL_MS = 30 * 60_000;

const TERMINAL_OR_STALLED = new Set([
  'success',
  'partial',
  'failed',
  'blocked',
  'stalled',
]);

export type StallCandidate = Pick<
  Handoff,
  'id' | 'status' | 'deliveryState' | 'createdAt'
>;

export function findStalledHandoffIds(
  handoffs: readonly StallCandidate[],
  now: number,
  ttlMs: number = HANDOFF_STALL_TTL_MS,
): string[] {
  return handoffs
    .filter(
      (handoff) =>
        (handoff.deliveryState === 'queued' ||
          handoff.deliveryState === 'submitted') &&
        !TERMINAL_OR_STALLED.has(handoff.status) &&
        now - handoff.createdAt >= ttlMs,
    )
    .map((handoff) => handoff.id);
}
