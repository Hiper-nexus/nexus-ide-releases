/**
 * Aritmética de folga de quota compartilhada (main + renderer).
 * Uma única definição de "quão apertada está uma janela": o scorer do
 * smart-pick, o sink do Redline e a timeline do Fleet Pulse leem daqui —
 * as implementações nunca divergem.
 */

import type { QuotaWindow } from './quota-types';

/** Janela a ≤60min do reset recebe crédito linear de liberação. */
export const RESET_PROXIMITY_WINDOW_MS = 60 * 60_000;

/**
 * Uso efetivo de uma janela já descontando o crédito de reset:
 * `usedRatio × (minutosRestantes ÷ 60)` quando resetsAt ≤ 60min.
 * No instante do reset a janela conta como vazia; a 60min, como está.
 * Janela desconhecida segue null — nunca inventa uso.
 */
export function effectiveUsedRatio(win: QuotaWindow, now: number): number | null {
  if (win.usedRatio === null || win.usedRatio === undefined) return null;
  const used = Math.min(1, Math.max(0, win.usedRatio));
  if (win.resetsAt === undefined) return used;
  const msToReset = win.resetsAt - now;
  if (msToReset >= RESET_PROXIMITY_WINDOW_MS) return used;
  if (msToReset <= 0) return 0;
  return used * (msToReset / RESET_PROXIMITY_WINDOW_MS);
}
