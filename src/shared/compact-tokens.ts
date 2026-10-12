/**
 * Formatação compacta de contagens de tokens — fonte única para UI
 * (monitor de velocidade, orçamento de missão, telemetria, rail, cotas).
 *
 * Herdado do bugfix do t3code (#17539): `Math.round(999_500 / 1000)` devolve
 * `1000`, então a cadeia `k` imprimia "1000k" logo abaixo de um milhão.
 * Qualquer valor a partir de 999_500 pertence à unidade `M`.
 */

/** Limiar em que `round(n/1000)` chegaria a 1000k e vira `M`. */
export const COMPACT_TOKENS_K_TO_M = 999_500;

/**
 * Compacta uma contagem de tokens: `900` → `"900"`, `12_400` → `"12.4k"`,
 * `999_499` → `"999k"`, `999_500` → `"1.0m"`, `1_100_000` → `"1.1m"`.
 *
 * `null`/não-finito devolve `empty` (padrão `"—"`) — métrica ausente nunca
 * vira 0 (mesma honestidade do medidor de velocidade).
 */
export function formatCompactTokens(
  value: number | null | undefined,
  empty = '—',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return empty;
  }
  const n = value < 0 ? 0 : value;
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  if (n < COMPACT_TOKENS_K_TO_M) {
    return `${Math.round(n / 1_000)}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

/**
 * Mesma regra, sufixo maiúsculo `M` para superfícies legadas (pet, rail)
 * que já imprimem `1.2M`. Preferir `formatCompactTokens` em código novo.
 */
export function formatCompactTokensUpperM(
  value: number | null | undefined,
  empty = '—',
): string {
  return formatCompactTokens(value, empty).replace(/m$/, 'M');
}

/**
 * Variante com 1 casa decimal em k e M (totais de vida útil, telemetria de
 * missão — "42.1k", "1.2M"). Mesma fronteira 999_500 → 1m.
 */
export function formatCompactTokensPrecise(
  value: number | null | undefined,
  empty = '—',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return empty;
  }
  const n = value < 0 ? 0 : value;
  if (n < 1_000) return String(Math.round(n));
  if (n < COMPACT_TOKENS_K_TO_M) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
