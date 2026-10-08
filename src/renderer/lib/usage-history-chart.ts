import type { UsageDailyBucket } from '../../shared/usage-types';

/**
 * Série do gráfico de histórico de uso (WEB-12): pura, sem DOM. O main guarda
 * só os dias com consumo; aqui a janela vira uma régua contínua de dias, com
 * zero explícito onde não houve uso e nada antes de o rollup começar.
 */

export type UsageHistoryMetric = 'tokens' | 'usd';

export interface UsageHistoryPoint {
  readonly day: string;
  /** "08/10" — eixo e tabela. */
  readonly shortLabel: string;
  /** "qua., 8 de out." — leitura e nome acessível. */
  readonly longLabel: string;
  readonly tokens: number;
  readonly usdEquivalent: number;
  readonly turns: number;
  /** Dia antes de o rollup começar: sem dado, não zero. */
  readonly beforeTracking: boolean;
}

export interface UsageHistorySeries {
  readonly points: readonly UsageHistoryPoint[];
  readonly totals: { readonly tokens: number; readonly usdEquivalent: number; readonly turns: number };
  /** Dias com consumo dentro da janela. */
  readonly activeDays: number;
}

export const USAGE_HISTORY_SPAN_DAYS = 30;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Mesma chave do main (`usageDayKey`): o dia LOCAL do operador. */
export function localDayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

export function buildUsageHistorySeries(
  days: readonly UsageDailyBucket[],
  options: { readonly now: number; readonly since?: number; readonly span?: number },
): UsageHistorySeries {
  const span = Math.max(1, Math.floor(options.span ?? USAGE_HISTORY_SPAN_DAYS));
  const byDay = new Map(days.map((bucket) => [bucket.day, bucket]));
  const sinceKey = options.since !== undefined ? localDayKey(options.since) : null;
  const today = new Date(options.now);
  const points: UsageHistoryPoint[] = [];
  const totals = { tokens: 0, usdEquivalent: 0, turns: 0 };
  let activeDays = 0;
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    // Construir pela data local (não por ms) atravessa horário de verão.
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const day = localDayKey(date.getTime());
    const bucket = byDay.get(day);
    const tokens = bucket?.tokens ?? 0;
    const usdEquivalent = bucket?.usdEquivalent ?? 0;
    const turns = bucket?.turns ?? 0;
    totals.tokens += tokens;
    totals.usdEquivalent += usdEquivalent;
    totals.turns += turns;
    if (tokens > 0 || usdEquivalent > 0 || turns > 0) activeDays += 1;
    points.push({
      day,
      shortLabel: `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`,
      longLabel: dayFromKey(day).toLocaleDateString('pt-BR', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }),
      tokens,
      usdEquivalent,
      turns,
      beforeTracking: !bucket && sinceKey !== null && day < sinceKey,
    });
  }
  return { points, totals, activeDays };
}

export function metricValue(point: UsageHistoryPoint, metric: UsageHistoryMetric): number {
  return metric === 'tokens' ? point.tokens : point.usdEquivalent;
}

/** Topo "redondo" da escala: 1, 2 ou 5 × 10ⁿ acima do maior valor. */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}
