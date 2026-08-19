/**
 * Cadeia de sucessão de assento (herança do overclick, 19/08: rotas em
 * cadeia primária→escalação→piso).
 *
 * Um assento do squad não é um CLI — é uma CADEIA: o primário escolhido no
 * roster, depois a escalação (a ordem de preferência com auth present) e o
 * último preferido como piso. O primeiro elo com credencial present senta;
 * sem elo present, o chamador mantém o primário para a falha ficar VISÍVEL
 * no pane (nunca troca silenciosa para algo também quebrado).
 *
 * Módulo puro e compartilhado: o remint do revisor pós-recusa usa hoje; o
 * reroute de spawn-fail pode adotar a mesma cadeia sem duplicar a regra.
 */

import { PREFERRED_AUTO_SEAT_CLIS } from './auto-seat-auth';

export interface SeatChainInput {
  /** CLI escolhido no roster — sempre o primeiro elo. */
  readonly primaryCli: string;
  /** Escalação na ordem de preferência; default: PREFERRED_AUTO_SEAT_CLIS. */
  readonly preferred?: readonly string[];
}

/** Cadeia completa, deduplicada, primário primeiro. */
export function seatSuccessionChain(input: SeatChainInput): readonly string[] {
  const preferred = input.preferred ?? PREFERRED_AUTO_SEAT_CLIS;
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const cli of [input.primaryCli, ...preferred]) {
    const clean = cli.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    chain.push(clean);
  }
  return Object.freeze(chain);
}

/**
 * Primeiro elo da cadeia que o predicado aceita (auth present), ou null
 * quando NENHUM elo senta — o chamador decide manter o primário visível.
 */
export function firstSeatableCli(
  input: SeatChainInput & { readonly canSeat: (cli: string) => boolean },
): string | null {
  for (const cli of seatSuccessionChain(input)) {
    if (input.canSeat(cli)) return cli;
  }
  return null;
}
