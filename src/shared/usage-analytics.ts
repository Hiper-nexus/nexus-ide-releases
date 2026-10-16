import {
  USAGE_ANALYTICS_MAX_DAYS,
  USAGE_WINDOW_OPTIONS,
  type UsageAnalytics,
  type UsageDayPoint,
  type UsageDayProviderSlice,
  type UsageDetailedTotals,
  type UsageModelAggregate,
  type UsageProviderAggregate,
  type UsageWindowDays,
  type UsageWindowSummary,
} from './usage-types';

/**
 * Aritmética pura do painel de Uso e custos: o store do Main entrega o rollup
 * (dia local × provedor × modelo) e as sessões distintas por janela; daqui
 * saem a série diária e os resumos de 7/30/90 dias. Sem I/O, sem relógio
 * implícito: "hoje" chega pronto, então a mesma entrada dá o mesmo resumo.
 */

/** Um dia local × provedor × modelo, somado no SQLite do projeto. */
export interface UsageRollupRow {
  readonly day: string;
  readonly provider: string;
  readonly model: string;
  readonly costUsd: number;
  /** Input sem cache, como o store grava (`input_units`). */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly cacheSavingsUsd: number;
  readonly turns: number;
}

/** Sessões distintas de um provedor com atividade em cada janela. */
export interface UsageProviderSessions {
  readonly provider: string;
  readonly sessions: Readonly<Record<UsageWindowDays, number>>;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Dia local (YYYY-MM-DD) de um instante em ms. */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Meia-noite local do dia `day` (YYYY-MM-DD), em ms. */
export function dayStartMs(day: string): number {
  if (!DAY_KEY.test(day)) throw new Error(`invalid day key: ${day}`);
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, 0, 0, 0, 0).getTime();
}

/** Desloca um dia local por `delta` dias de calendário (DST não pula dia). */
export function shiftDayKey(day: string, delta: number): string {
  if (!DAY_KEY.test(day)) throw new Error(`invalid day key: ${day}`);
  const [year, month, date] = day.split('-').map(Number);
  // Meio-dia: nenhuma mudança de horário de verão empurra para outro dia.
  return localDayKey(new Date(year, month - 1, date + delta, 12).getTime());
}

/** Primeiro dia local da janela de `windowDays` terminada em `today`. */
export function usageWindowStartDay(today: string, windowDays: number): string {
  return shiftDayKey(today, -(Math.max(1, Math.floor(windowDays)) - 1));
}

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
}

function rowTotalTokens(row: UsageRollupRow): number {
  return (
    finite(row.inputTokens) +
    finite(row.cachedInputTokens) +
    finite(row.cacheWriteTokens) +
    finite(row.outputTokens)
  );
}

function byCostThenTokens<T extends { costUsd: number; totalTokens: number }>(
  key: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) =>
    b.costUsd - a.costUsd ||
    b.totalTokens - a.totalTokens ||
    key(a).localeCompare(key(b));
}

interface MutableProvider {
  provider: string;
  costUsd: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function summarizeWindow(
  rows: readonly UsageRollupRow[],
  sessions: readonly UsageProviderSessions[],
  today: string,
  windowDays: UsageWindowDays,
): UsageWindowSummary {
  const startDay = usageWindowStartDay(today, windowDays);
  const providers = new Map<string, MutableProvider>();
  const models = new Map<string, { model: string; provider: string; costUsd: number; totalTokens: number }>();
  let costUsd = 0;
  let cachedInputTokens = 0;
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheSavingsUsd = 0;
  let turns = 0;
  for (const row of rows) {
    if (row.day < startDay || row.day > today) continue;
    const cost = finite(row.costUsd);
    const cached = finite(row.cachedInputTokens);
    const uncached = finite(row.inputTokens) + finite(row.cacheWriteTokens);
    const output = finite(row.outputTokens);
    const total = cached + uncached + output;
    costUsd += cost;
    cachedInputTokens += cached;
    uncachedInputTokens += uncached;
    outputTokens += output;
    cacheSavingsUsd += finite(row.cacheSavingsUsd);
    turns += finite(row.turns);
    const provider = providers.get(row.provider) ?? {
      provider: row.provider,
      costUsd: 0,
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    provider.costUsd += cost;
    provider.totalTokens += total;
    provider.inputTokens += uncached;
    provider.cachedInputTokens += cached;
    provider.outputTokens += output;
    providers.set(row.provider, provider);
    const modelKey = `${row.provider}\0${row.model}`;
    const model = models.get(modelKey) ?? {
      model: row.model,
      provider: row.provider,
      costUsd: 0,
      totalTokens: 0,
    };
    model.costUsd += cost;
    model.totalTokens += total;
    models.set(modelKey, model);
  }
  const sessionsFor = (provider: string) =>
    finite(sessions.find((entry) => entry.provider === provider)?.sessions[windowDays] ?? 0);
  const byProvider: UsageProviderAggregate[] = [...providers.values()]
    .map((provider) => ({
      ...provider,
      sessions: sessionsFor(provider.provider),
      costShare: share(provider.costUsd, costUsd),
    }))
    .sort(byCostThenTokens((item) => item.provider));
  const byModel: UsageModelAggregate[] = [...models.values()]
    .map((model) => ({ ...model, costShare: share(model.costUsd, costUsd) }))
    .sort(byCostThenTokens((item) => `${item.provider}/${item.model}`));
  const totals: UsageDetailedTotals = {
    processedTokens: cachedInputTokens + uncachedInputTokens + outputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    cacheSavingsUsd,
    costUsd,
    sessions: byProvider.reduce((sum, provider) => sum + provider.sessions, 0),
    turns,
  };
  return { windowDays, startDay, byProvider, byModel, totals };
}

/**
 * Série diária (só dias com consumo, dentro dos últimos 90) e um resumo por
 * janela. Sessões não se somam entre dias — uma sessão que atravessa a
 * meia-noite contaria duas vezes —, então chegam já distintas por janela.
 */
export function buildUsageAnalytics(
  rows: readonly UsageRollupRow[],
  sessions: readonly UsageProviderSessions[],
  today: string,
): UsageAnalytics {
  const firstDay = usageWindowStartDay(today, USAGE_ANALYTICS_MAX_DAYS);
  const byDay = new Map<string, { costUsd: number; totalTokens: number; byProvider: Map<string, UsageDayProviderSlice> }>();
  for (const row of rows) {
    if (row.day < firstDay || row.day > today) continue;
    const day = byDay.get(row.day) ?? { costUsd: 0, totalTokens: 0, byProvider: new Map() };
    const cost = finite(row.costUsd);
    const tokens = rowTotalTokens(row);
    day.costUsd += cost;
    day.totalTokens += tokens;
    const slice = day.byProvider.get(row.provider) ?? { costUsd: 0, totalTokens: 0 };
    day.byProvider.set(row.provider, {
      costUsd: slice.costUsd + cost,
      totalTokens: slice.totalTokens + tokens,
    });
    byDay.set(row.day, day);
  }
  const days: UsageDayPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({
      day,
      costUsd: value.costUsd,
      totalTokens: value.totalTokens,
      byProvider: Object.fromEntries(value.byProvider),
    }));
  const windows = Object.fromEntries(
    USAGE_WINDOW_OPTIONS.map((windowDays) => [
      windowDays,
      summarizeWindow(rows, sessions, today, windowDays),
    ]),
  ) as Record<UsageWindowDays, UsageWindowSummary>;
  return { today, days, windows };
}

/** Um dia da janela já preenchido (dia sem consumo vale zero). */
export interface UsageFilledDay {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: Readonly<Record<string, UsageDayProviderSlice>>;
}

/**
 * A janela inteira, um ponto por dia local, do mais antigo a `today`: o
 * gráfico precisa dos dias sem consumo para não ligar picos distantes.
 */
export function fillUsageWindow(
  days: readonly UsageDayPoint[],
  windowDays: UsageWindowDays,
  today: string,
): UsageFilledDay[] {
  const known = new Map(days.map((day) => [day.day, day]));
  const start = usageWindowStartDay(today, windowDays);
  return Array.from({ length: windowDays }, (_, index) => {
    const day = shiftDayKey(start, index);
    const point = known.get(day);
    return point ?? { day, costUsd: 0, totalTokens: 0, byProvider: {} };
  });
}
