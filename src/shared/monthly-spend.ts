import {
  MAX_SPEND_ENTRY_USD,
  type SpendEntry,
  type SpendEntryKind,
} from './settings-types';

/**
 * Gasto mensal REAL com IA (USD): o que o operador paga em assinaturas e em
 * API avulsa, contra o que o mesmo uso custaria em API pública. Puro: o
 * renderer traz os planos detectados (linhas de cota), as linhas salvas em
 * `settings.spend` e a estimativa de API; daqui sai o total e a economia.
 */

/** Atalhos de valor do cartão; qualquer outro valor é digitado. */
export const MONTHLY_SPEND_PRESETS_USD = [20, 100, 200, 500] as const;

export interface PlanPreset {
  readonly id: string;
  readonly label: string;
  /** adapter do logo. */
  readonly provider: string;
  /** Preço de lista em USD/mês — sugestão; o operador corrige na linha. */
  readonly monthlyUsd: number;
}

/**
 * Só planos com preço de lista que o Nexus já usa em `account-plan.ts`.
 * Cursor, Grok, GLM e Gemini entram como linha livre: preço inventado aqui
 * viraria número errado no total.
 */
export const PLAN_PRESETS: readonly PlanPreset[] = [
  { id: 'claude-pro', label: 'Claude Pro', provider: 'claude', monthlyUsd: 20 },
  { id: 'claude-max-5x', label: 'Claude Max 5×', provider: 'claude', monthlyUsd: 100 },
  { id: 'claude-max-20x', label: 'Claude Max 20×', provider: 'claude', monthlyUsd: 200 },
  { id: 'chatgpt-plus', label: 'ChatGPT Plus', provider: 'codex', monthlyUsd: 20 },
  { id: 'chatgpt-pro', label: 'ChatGPT Pro', provider: 'codex', monthlyUsd: 200 },
];

/** Ferramentas oferecidas ao adicionar uma linha (logo + nome sugerido). */
export const SPEND_PROVIDER_OPTIONS: readonly { readonly provider: string; readonly label: string }[] = [
  { provider: 'claude', label: 'Claude' },
  { provider: 'codex', label: 'ChatGPT / Codex' },
  { provider: 'cursor-agent', label: 'Cursor' },
  { provider: 'grok', label: 'Grok' },
  { provider: 'glm', label: 'GLM' },
  { provider: 'agy', label: 'Gemini / Antigravity' },
  { provider: '', label: 'Outro' },
];

/** Plano lido de uma linha de cota (fonte do próprio provider). */
export interface DetectedPlan {
  /** id da linha de cota (`claude`, `codex:acc-1`): estável por conta. */
  readonly key: string;
  readonly provider: string;
  /** Nome da conta/conexão na tela de cotas. */
  readonly accountLabel: string;
  /** 'Claude Max 20×'. */
  readonly planLabel: string;
  /** Preço de lista; null = plano sem preço público (Team, tier novo). */
  readonly monthlyUsd: number | null;
}

export type SpendRowSource = 'detected' | 'saved';

export interface SpendRow {
  readonly id: string;
  readonly label: string;
  readonly kind: SpendEntryKind;
  readonly provider: string;
  /** null = plano detectado sem preço e ainda não informado pelo operador. */
  readonly monthlyUsd: number | null;
  readonly active: boolean;
  /** detected = valor de lista ainda não confirmado; saved = o operador gravou. */
  readonly source: SpendRowSource;
  /** Plano detectado da conta, quando a linha veio (ou casa com) uma conta. */
  readonly detected?: DetectedPlan;
}

export interface MonthlySpendSummary {
  readonly subscriptionsUsd: number;
  readonly apiUsd: number;
  /** Total mensal gasto com IA: assinaturas ativas + API avulsa. */
  readonly totalUsd: number;
  readonly activeCount: number;
  /** Linhas ativas sem preço: o total está incompleto enquanto existirem. */
  readonly unpricedCount: number;
  /** Equivalente de API pública no mesmo período; null = sem leitura. */
  readonly apiEquivalentUsd: number | null;
  /** apiEquivalent − total. Negativo = pagou mais que a API custaria. */
  readonly savingsUsd: number | null;
}

export function detectedSpendId(key: string): string {
  return `plan:${key}`;
}

/** Centavos, sem lixo de ponto flutuante. */
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Valor digitado → USD. Aceita "$20", "20.5", "20,50", "1,200.00" e
 * "1.200,50". Vazio, negativo, acima do teto ou texto vira null.
 */
export function parseUsdInput(raw: string): number | null {
  let text = raw.replace(/\s+/gu, '').replace(/^(?:US)?\$/iu, '');
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // O separador que vem por último é o decimal; o outro é de milhar.
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    text = text.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    // "20,5"/"20,50" é decimal brasileiro; "1,200" é milhar.
    text = /,\d{1,2}$/u.test(text) && text.indexOf(',') === lastComma
      ? text.replace(',', '.')
      : text.split(',').join('');
  }
  if (!/^\d+(\.\d+)?$/u.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > MAX_SPEND_ENTRY_USD) return null;
  return roundUsd(value);
}

/**
 * Linhas do cartão: cada plano detectado (com o valor salvo, quando o
 * operador já corrigiu) e depois as linhas salvas avulsas. Assinaturas antes
 * de API. Linha salva de conta que sumiu continua: o plano pode seguir pago.
 */
export function buildSpendRows(
  saved: readonly SpendEntry[],
  detected: readonly DetectedPlan[],
): SpendRow[] {
  const savedById = new Map(saved.map((entry) => [entry.id, entry]));
  const used = new Set<string>();
  const rows: SpendRow[] = [];
  for (const plan of detected) {
    const id = detectedSpendId(plan.key);
    if (used.has(id)) continue;
    used.add(id);
    const entry = savedById.get(id);
    rows.push(
      entry
        ? { ...entry, source: 'saved', detected: plan }
        : {
            id,
            label: `${plan.planLabel} · ${plan.accountLabel}`,
            kind: 'subscription',
            provider: plan.provider,
            monthlyUsd: plan.monthlyUsd,
            active: true,
            source: 'detected',
            detected: plan,
          },
    );
  }
  for (const entry of saved) {
    if (used.has(entry.id)) continue;
    used.add(entry.id);
    rows.push({ ...entry, source: 'saved' });
  }
  const rank = (row: SpendRow) => (row.kind === 'subscription' ? 0 : 1);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

export function computeMonthlySpend(
  rows: readonly SpendRow[],
  apiEquivalentUsd: number | null,
): MonthlySpendSummary {
  let subscriptionsUsd = 0;
  let apiUsd = 0;
  let activeCount = 0;
  let unpricedCount = 0;
  for (const row of rows) {
    if (!row.active) continue;
    activeCount += 1;
    if (row.monthlyUsd === null || !Number.isFinite(row.monthlyUsd)) {
      unpricedCount += 1;
      continue;
    }
    const value = Math.max(0, row.monthlyUsd);
    if (row.kind === 'api') apiUsd += value;
    else subscriptionsUsd += value;
  }
  const totalUsd = roundUsd(subscriptionsUsd + apiUsd);
  const equivalent =
    apiEquivalentUsd !== null && Number.isFinite(apiEquivalentUsd)
      ? roundUsd(Math.max(0, apiEquivalentUsd))
      : null;
  return {
    subscriptionsUsd: roundUsd(subscriptionsUsd),
    apiUsd: roundUsd(apiUsd),
    totalUsd,
    activeCount,
    unpricedCount,
    apiEquivalentUsd: equivalent,
    savingsUsd: equivalent === null ? null : roundUsd(equivalent - totalUsd),
  };
}

/**
 * Linha salva a partir de uma linha da tela: é assim que um plano detectado
 * vira "o valor que eu pago" — o id continua `plan:<conta>`.
 */
export function toSpendEntry(row: SpendRow, patch: Partial<Pick<SpendEntry, 'label' | 'monthlyUsd' | 'active' | 'kind'>> = {}): SpendEntry {
  const monthlyUsd = patch.monthlyUsd ?? row.monthlyUsd ?? 0;
  return {
    id: row.id,
    label: (patch.label ?? row.label).trim().slice(0, 64) || 'Assinatura',
    kind: patch.kind ?? row.kind,
    provider: row.provider,
    monthlyUsd: roundUsd(Math.min(MAX_SPEND_ENTRY_USD, Math.max(0, monthlyUsd))),
    active: patch.active ?? row.active,
  };
}

/**
 * Substitui (ou acrescenta) a linha `entry` na lista salva, preservando a
 * ordem das demais.
 */
export function upsertSpendEntry(
  saved: readonly SpendEntry[],
  entry: SpendEntry,
): SpendEntry[] {
  const index = saved.findIndex((item) => item.id === entry.id);
  if (index < 0) return [...saved, entry];
  return saved.map((item, position) => (position === index ? entry : item));
}

export function removeSpendEntry(saved: readonly SpendEntry[], id: string): SpendEntry[] {
  return saved.filter((entry) => entry.id !== id);
}

/** id novo para linha avulsa, sem colidir com as já salvas. */
export function newSpendEntryId(saved: readonly SpendEntry[], seed: number): string {
  const taken = new Set(saved.map((entry) => entry.id));
  let counter = Math.max(0, Math.floor(seed));
  let id = `custom-${counter.toString(36)}`;
  while (taken.has(id)) {
    counter += 1;
    id = `custom-${counter.toString(36)}`;
  }
  return id;
}

/**
 * Equivalente de API dos últimos `days` dias locais terminados em `today`,
 * somando o rollup diário de todos os projetos (`usage:history`).
 */
export function recentApiEquivalentUsd(
  history: readonly { readonly day: string; readonly usdEquivalent: number }[],
  fromDay: string,
  today: string,
): number {
  return roundUsd(
    history.reduce(
      (sum, bucket) =>
        bucket.day >= fromDay && bucket.day <= today && Number.isFinite(bucket.usdEquivalent)
          ? sum + Math.max(0, bucket.usdEquivalent)
          : sum,
      0,
    ),
  );
}
