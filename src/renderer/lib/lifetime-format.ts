/**
 * Formatação compacta dos totais de vida útil (rail, cotas, perfil do
 * operador). Tokens em sufixo k/M com 1 casa; USD sempre com centavos.
 * Regra de compactação compartilhada em `shared/compact-tokens`.
 */

import { formatCompactTokensPrecise } from '../../shared/compact-tokens'

/** 1_234_567 → "1.2M"; 42_100 → "42.1k"; 900 → "900". */
export function fmtTokens(n: number): string {
  return formatCompactTokensPrecise(Math.max(0, Math.floor(n)))
}

/** USD com 2 casas — valores pequenos importam (o ponto é provar economia). */
export function fmtUsd(n: number): string {
  return `$${Math.max(0, n).toFixed(2)}`;
}
