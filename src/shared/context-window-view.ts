/**
 * Apresentação da janela de contexto (herdada do t3code `contextWindow.ts`).
 *
 * O t3code mede o preenchimento REAL pela última usage report do provider
 * (`usedTokens`/`maxTokens` no turno) e só cai em compactação como fallback.
 * Aqui a derivação é pura: quem tiver o par (used, max) monta o snapshot;
 * o medidor ao vivo é plugado depois, sem reescrever esta regra.
 *
 * Regras herdadas:
 * - métrica ausente é `null`, nunca 0 (mesma honestidade do tok/s);
 * - `usedPercentage` é clampada em 0..100;
 * - formatação usa `formatCompactTokens` (fronteira 999.5k → 1m).
 */

import { formatCompactTokens } from './compact-tokens';

export interface ContextWindowSnapshot {
  /** Tokens já ocupados na janela, ou null quando o provider não reportou. */
  readonly usedTokens: number | null;
  /** Capacidade da janela (contextWindow do modelo), ou null. */
  readonly maxTokens: number | null;
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  /** Carimbo ISO da leitura que gerou o snapshot. */
  readonly updatedAt: string | null;
}

export const EMPTY_CONTEXT_WINDOW: ContextWindowSnapshot = {
  usedTokens: null,
  maxTokens: null,
  remainingTokens: null,
  usedPercentage: null,
  remainingPercentage: null,
  updatedAt: null,
};

/**
 * Monta o snapshot a partir de uma leitura de uso. Aceita `used`/`max`
 * parciais: sem max não há porcentagem; sem used não há restante.
 */
export function deriveContextWindowSnapshot(input: {
  readonly usedTokens?: number | null;
  readonly maxTokens?: number | null;
  readonly updatedAt?: string | null;
}): ContextWindowSnapshot {
  const usedRaw = input.usedTokens;
  const maxRaw = input.maxTokens;
  const usedTokens =
    typeof usedRaw === 'number' && Number.isFinite(usedRaw) && usedRaw >= 0
      ? usedRaw
      : null;
  const maxTokens =
    typeof maxRaw === 'number' && Number.isFinite(maxRaw) && maxRaw > 0
      ? maxRaw
      : null;
  if (usedTokens === null && maxTokens === null) return EMPTY_CONTEXT_WINDOW;

  const usedPercentage =
    usedTokens !== null && maxTokens !== null
      ? Math.min(100, Math.max(0, (usedTokens / maxTokens) * 100))
      : null;
  const remainingTokens =
    usedTokens !== null && maxTokens !== null
      ? Math.max(0, Math.round(maxTokens - usedTokens))
      : null;
  return {
    usedTokens,
    maxTokens,
    remainingTokens,
    usedPercentage,
    remainingPercentage:
      usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null,
    updatedAt: input.updatedAt ?? null,
  };
}

/** Rótulo compacto: "12.4k/200k" · "—" quando não há leitura. */
export function formatContextWindowLabel(
  snapshot: ContextWindowSnapshot,
  empty = '—',
): string {
  if (snapshot.usedTokens === null && snapshot.maxTokens === null) return empty;
  const used =
    snapshot.usedTokens === null
      ? empty
      : formatCompactTokens(snapshot.usedTokens, '0');
  if (snapshot.maxTokens === null) return used;
  return `${used}/${formatCompactTokens(snapshot.maxTokens)}`;
}

/** Faixa 0..1 para o medidor visual; null quando não há leitura honesta. */
export function contextWindowFillRatio(
  snapshot: ContextWindowSnapshot,
): number | null {
  if (snapshot.usedPercentage === null) return null;
  return Math.min(1, Math.max(0, snapshot.usedPercentage / 100));
}

/**
 * Aviso operacional: ≥85% da janela é o limiar em que o t3code (e o
 * costume de CLIs) começam a compactar/empurrar histórico.
 */
export function contextWindowUrgency(
  snapshot: ContextWindowSnapshot,
): 'none' | 'warn' | 'critical' {
  const pct = snapshot.usedPercentage;
  if (pct === null) return 'none';
  if (pct >= 95) return 'critical';
  if (pct >= 85) return 'warn';
  return 'none';
}
