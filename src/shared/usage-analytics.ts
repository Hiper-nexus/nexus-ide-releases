import {
  USAGE_ANALYTICS_MAX_DAYS,
  type UsageAnalytics,
  type UsageDayPoint,
  type UsageDayProviderSlice,
  type UsageDayStats,
  type UsageDetailedTotals,
  type UsageMetric,
  type UsageModelAggregate,
  type UsageProviderAggregate,
  type UsageQuery,
  type UsageRangeSummary,
  type UsageRollupRow,
  type UsageSessionActivity,
} from './usage-types';

/**
 * Aritmética pura do painel de Uso e custos. O store do Main entrega o rollup
 * (dia local × ferramenta × modelo) e as sessões; daqui sai TUDO que a tela
 * mostra — 7/30/90 dias, intervalo, um dia, uma ferramenta, um modelo — pela
 * mesma conta (`summarizeUsage`), então gráfico, totais, lista por ferramenta
 * e detalhamento nunca divergem entre si. Sem I/O, sem relógio implícito:
 * "hoje" chega pronto, então a mesma entrada dá o mesmo resumo.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Teto de dias de um recorte: o rollup tem 90; a folga só protege de entrada inválida. */
const MAX_RANGE_DAYS = 366;

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

/**
 * Intervalo que o seletor de datas pode pedir: dentro dos 90 dias do rollup e
 * com `from <= to` (extremos trocados viram o intervalo certo, nunca vazio).
 */
export function clampUsageRange(
  today: string,
  from: string,
  to: string,
): { readonly from: string; readonly to: string } {
  const min = usageWindowStartDay(today, USAGE_ANALYTICS_MAX_DAYS);
  const clamp = (day: string) => (day < min ? min : day > today ? today : day);
  const a = clamp(from);
  const b = clamp(to);
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
}

function byCostThenTokens<T extends { costUsd: number; totalTokens: number }>(
  key: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) =>
    b.costUsd - a.costUsd ||
    b.totalTokens - a.totalTokens ||
    key(a).localeCompare(key(b));
}

function compareRows(a: UsageRollupRow, b: UsageRollupRow): number {
  return (
    a.day.localeCompare(b.day) ||
    a.provider.localeCompare(b.provider) ||
    a.model.localeCompare(b.model)
  );
}

/**
 * Empacota o que o store leu do SQLite: só os últimos 90 dias até `today`, em
 * ordem estável, e sem sessão que ficou sem nenhum dia dentro da janela.
 */
export function buildUsageAnalytics(
  rows: readonly UsageRollupRow[],
  sessions: readonly UsageSessionActivity[],
  today: string,
): UsageAnalytics {
  const firstDay = usageWindowStartDay(today, USAGE_ANALYTICS_MAX_DAYS);
  const inWindow = (day: string) => day >= firstDay && day <= today;
  return {
    today,
    rows: rows.filter((row) => inWindow(row.day)).sort(compareRows),
    sessions: sessions
      .map((session) => ({
        provider: session.provider,
        cells: session.cells.filter(([day]) => inWindow(day)),
      }))
      .filter((session) => session.cells.length > 0),
  };
}

interface MutableProvider {
  provider: string;
  costUsd: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

interface MutableDay {
  costUsd: number;
  totalTokens: number;
  byProvider: Map<string, UsageDayProviderSlice>;
}

/** Cada dia local de `from` a `to`, inclusive. */
function daysInRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to && days.length < MAX_RANGE_DAYS; day = shiftDayKey(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * Tudo que a tela mostra de um recorte, calculado de uma vez. Filtros valem
 * para todos os números: totais, ferramentas, modelos, dias e sessões saem das
 * mesmas linhas, então a soma das partes sempre fecha com o todo.
 */
export function summarizeUsage(
  data: Pick<UsageAnalytics, 'rows' | 'sessions'>,
  query: UsageQuery,
): UsageRangeSummary {
  const { from, to } = query;
  const provider = query.provider ?? null;
  // O nome do modelo sozinho pode repetir entre ferramentas: só vale com ela.
  const model = provider === null ? null : (query.model ?? null);

  const byDay = new Map<string, MutableDay>();
  const providers = new Map<string, MutableProvider>();
  const models = new Map<string, { model: string; provider: string; costUsd: number; totalTokens: number }>();
  let costUsd = 0;
  let cachedInputTokens = 0;
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheSavingsUsd = 0;
  let turns = 0;
  for (const row of data.rows) {
    if (row.day < from || row.day > to) continue;
    if (provider !== null && row.provider !== provider) continue;
    if (model !== null && row.model !== model) continue;
    const cost = finite(row.costUsd);
    const cached = finite(row.cachedInputTokens);
    const uncached = finite(row.inputTokens) + finite(row.cacheWriteTokens);
    const output = finite(row.outputTokens);
    const total = cached + uncached + output;
    // Evento sem consumo (mensagem sintética, erro de API): conta o turno, mas não
    // vira ferramenta nem modelo na lista — "$0.00 · 0,0% · 0" não diz nada a ninguém.
    if (cost === 0 && total === 0) {
      turns += finite(row.turns);
      continue;
    }
    costUsd += cost;
    cachedInputTokens += cached;
    uncachedInputTokens += uncached;
    outputTokens += output;
    cacheSavingsUsd += finite(row.cacheSavingsUsd);
    turns += finite(row.turns);

    const day = byDay.get(row.day) ?? { costUsd: 0, totalTokens: 0, byProvider: new Map() };
    day.costUsd += cost;
    day.totalTokens += total;
    const slice = day.byProvider.get(row.provider) ?? { costUsd: 0, totalTokens: 0 };
    day.byProvider.set(row.provider, {
      costUsd: slice.costUsd + cost,
      totalTokens: slice.totalTokens + total,
    });
    byDay.set(row.day, day);

    const entry = providers.get(row.provider) ?? {
      provider: row.provider,
      costUsd: 0,
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    entry.costUsd += cost;
    entry.totalTokens += total;
    entry.inputTokens += uncached;
    entry.cachedInputTokens += cached;
    entry.outputTokens += output;
    providers.set(row.provider, entry);

    const modelKey = `${row.provider}\0${row.model}`;
    const modelEntry = models.get(modelKey) ?? {
      model: row.model,
      provider: row.provider,
      costUsd: 0,
      totalTokens: 0,
    };
    modelEntry.costUsd += cost;
    modelEntry.totalTokens += total;
    models.set(modelKey, modelEntry);
  }

  // Sessão conta uma vez por ferramenta se algum par [dia, modelo] casa.
  const sessionsByProvider = new Map<string, number>();
  for (const session of data.sessions) {
    if (provider !== null && session.provider !== provider) continue;
    const active = session.cells.some(
      ([day, cellModel]) => day >= from && day <= to && (model === null || cellModel === model),
    );
    if (active) sessionsByProvider.set(session.provider, (sessionsByProvider.get(session.provider) ?? 0) + 1);
  }

  const processedTokens = cachedInputTokens + uncachedInputTokens + outputTokens;
  const byProvider: UsageProviderAggregate[] = [...providers.values()]
    .map((entry) => ({
      ...entry,
      sessions: sessionsByProvider.get(entry.provider) ?? 0,
      costShare: share(entry.costUsd, costUsd),
      tokenShare: share(entry.totalTokens, processedTokens),
    }))
    .sort(byCostThenTokens((item) => item.provider));
  const byModel: UsageModelAggregate[] = [...models.values()]
    .map((entry) => ({
      ...entry,
      costShare: share(entry.costUsd, costUsd),
      tokenShare: share(entry.totalTokens, processedTokens),
    }))
    .sort(byCostThenTokens((item) => `${item.provider}/${item.model}`));
  const totals: UsageDetailedTotals = {
    processedTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    cacheSavingsUsd,
    costUsd,
    sessions: byProvider.reduce((sum, entry) => sum + entry.sessions, 0),
    turns,
  };
  const days: UsageDayPoint[] = daysInRange(from, to).map((day) => {
    const value = byDay.get(day);
    return value
      ? {
          day,
          costUsd: value.costUsd,
          totalTokens: value.totalTokens,
          byProvider: Object.fromEntries(value.byProvider),
        }
      : { day, costUsd: 0, totalTokens: 0, byProvider: {} };
  });
  return { from, to, byProvider, byModel, totals, days };
}

/**
 * Total, pico e média de uma série diária. A média divide pelos dias COM uso:
 * dia sem registro (antes de o histórico começar, fim de semana parado) não
 * rebaixa o "quanto gastamos num dia de trabalho". O pico é do dia de maior
 * valor da medida pedida; sem valor nela (custo zero com tokens), o de mais tokens.
 */
export function usageDayStats(days: readonly UsageDayPoint[], metric: UsageMetric): UsageDayStats {
  const valueOf = (day: UsageDayPoint) => (metric === 'cost' ? day.costUsd : day.totalTokens);
  let costUsd = 0;
  let totalTokens = 0;
  let activeDays = 0;
  let peak: UsageDayPoint | null = null;
  // Uso sem custo (plano grátis, preço desconhecido): o pico em dólar não existe,
  // mas o dia de mais tokens segue sendo o dia a destacar.
  let tokenPeak: UsageDayPoint | null = null;
  for (const day of days) {
    costUsd += day.costUsd;
    totalTokens += day.totalTokens;
    if (day.costUsd > 0 || day.totalTokens > 0) activeDays += 1;
    if (valueOf(day) > 0 && (peak === null || valueOf(day) > valueOf(peak))) peak = day;
    if (day.totalTokens > 0 && (tokenPeak === null || day.totalTokens > tokenPeak.totalTokens)) tokenPeak = day;
  }
  return {
    dayCount: days.length,
    activeDays,
    costUsd,
    totalTokens,
    averageCostUsd: activeDays > 0 ? costUsd / activeDays : 0,
    averageTokens: activeDays > 0 ? totalTokens / activeDays : 0,
    peak: peak ?? tokenPeak,
  };
}
