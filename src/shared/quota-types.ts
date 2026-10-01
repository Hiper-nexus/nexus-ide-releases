/**
 * Provider account quota windows (session / hours / weekly) — distinct from
 * project token spend in usage-types. Never invent usedRatio without a source.
 */

import type { FailoverReasonKind } from './account-types';

export const QUOTA_CHANNELS = {
  snapshot: 'quota:snapshot',
  changed: 'quota:changed',
  refresh: 'quota:refresh',
  connectMimo: 'quota:connect-mimo',
} as const;

export type QuotaWindowKind =
  | 'session'
  | 'hours'
  | 'weekly'
  | 'monthly'
  | 'credits'
  | 'local';

export type QuotaSource =
  | 'provider-api'
  | 'transcript-inferred'
  | 'limit-hit'
  | 'local-tokens'
  | 'cooldown'
  | 'unknown';

export type QuotaConfidence = 'high' | 'medium' | 'low';

export interface QuotaWindow {
  kind: QuotaWindowKind;
  /** Short UI label: "Sessão", "5 Horas", "Semanal". */
  label: string;
  /**
   * Fraction used 0..1. null = unknown (UI must NOT show 0%).
   */
  usedRatio: number | null;
  /** Epoch ms when this window resets, if known. */
  resetsAt?: number;
  remainingLabel?: string;
  source: QuotaSource;
  confidence: QuotaConfidence;
}

/**
 * Plano de assinatura detectado para a conta da linha — vindo de fonte do
 * próprio provider (`organizationRateLimitTier` no perfil Claude, claim
 * `chatgpt_plan_type` no id_token Codex, `currentTier` no loadCodeAssist).
 * Nunca inventado: sem fonte, `plan` fica ausente e a linha conta como
 * "não identificada" no resumo.
 */
export interface AccountPlan {
  /** 'detected' = veio do provider/perfil da conta. */
  source: 'detected';
  /** id cru do provider: 'default_claude_max_20x', 'pro', 'free-tier'. */
  tier: string;
  /** Rótulo curto: 'Claude Max 20×', 'ChatGPT Pro', 'Google AI Free'. */
  label: string;
  /**
   * USD/mês estimado do plano (preço de lista). null = plano detectado mas
   * preço não mapeado (Team/Enterprise por assento, tier novo).
   */
  monthlyUsd: number | null;
}

/**
 * Por que a linha não tem leitura — sinal honesto para a UI dizer o motivo
 * em vez de um «—» mudo. Só presente quando nenhuma janela conhecida veio.
 *
 *  - 'auth-expired': credencial existe mas está morta (OAuth expirado e sem
 *    refresh válido) — o caminho de saída é reautenticar a conta.
 *  - 'identity-mismatch': o provider provou que a credencial pertence a outra
 *    conta; nunca atribuir sua cota a esta linha.
 *  - 'no-credential': nenhuma credencial utilizável foi encontrada para a
 *    linha (sem conta vault, sem sessão nativa, sem API key).
 *  - 'cli-missing': a sonda depende do binário do CLI e ele não existe.
 *  - 'unavailable': credencial consultada, provider não devolveu janelas
 *    (rede, 429, endpoint sem dados para o plano — ex.: tier free).
 *  - 'quota-key-required': a CLI está logada, mas a cota está sem fonte agora
 *    (token da sessão vencido e nenhuma chave do plano, ex.: Subscription Key
 *    do Token Plan da MiniMax). Conta conectada — nunca «sem conta».
 */
export type QuotaReadHint =
  | 'auth-expired'
  | 'identity-mismatch'
  | 'no-credential'
  | 'cli-missing'
  | 'unavailable'
  | 'quota-key-required';

export interface ProviderQuotaEntry {
  /** Stable list key: adapterId or adapterId:accountId */
  id: string;
  adapterId: string;
  /** Declared API provider supplying quota; adapterId remains the owner of the row. */
  usageProviderId?: string;
  accountId?: string;
  /** Plano de assinatura detectado da conta, quando o provider expõe. */
  plan?: AccountPlan;
  /**
   * Linha representa uma assinatura consultável (claude/codex/agy, modo
   * OAuth) — false em rows de API key, que não são "plano".
   */
  planEligible?: boolean;
  /** True when this account is currently active for the adapter */
  active?: boolean;
  /** Display name (CLI label or account label). */
  label: string;
  /** Provider binary detected / online enough to care. */
  installed: boolean;
  /** Account on cooldown after limit hit. */
  onCooldown: boolean;
  /** Why spawning is paused. Auth/transient cooldowns are not quota usage. */
  cooldownKind?: FailoverReasonKind;
  cooldownUntil?: number;
  windows: QuotaWindow[];
  /** Motivo da ausência de leitura, quando toda janela é desconhecida. */
  readHint?: QuotaReadHint;
  /**
   * F-720: linhas lidas com a MESMA credencial são a mesma cota (GLM e GLM
   * Flash na mesma chave z.ai). Id opaco por execução (HMAC com sal
   * aleatório): só igualdade, nunca exibido nem comparado entre execuções.
   */
  quotaGroup?: string;
  updatedAt: number;
}

/**
 * F-720: uma linha por cota na apresentação (barra lateral, Configurações,
 * Redline). Mantém a primeira de cada `quotaGroup`, na ordem recebida; o
 * snapshot continua com uma entrada por adapter para failover e roteamento.
 */
export function collapseSharedQuotaEntries<T extends { readonly quotaGroup?: string }>(
  entries: readonly T[],
): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry.quotaGroup) return true;
    if (seen.has(entry.quotaGroup)) return false;
    seen.add(entry.quotaGroup);
    return true;
  });
}

/** Resumo dos planos de assinatura detectados na frota. */
export interface QuotaPlansSummary {
  /** Soma dos USD/mês conhecidos (planos com monthlyUsd ≠ null). */
  monthlyUsd: number;
  /** Linhas com plano detectado (com ou sem preço mapeado). */
  detected: number;
  /** Desses, quantos entraram na soma em dólares. */
  priced: number;
  /** Linhas da frota (cada conta/conexão que o painel já lista). */
  connected: number;
  /** Linhas elegíveis a plano (claude/codex/agy) sem tier detectado. */
  undetected: number;
}

export interface QuotaFleetSnapshot {
  updatedAt: number;
  entries: ProviderQuotaEntry[];
  /** Worst usedRatio among known windows (null if none known). */
  worstUsedRatio: number | null;
  /** Count of entries with any known window ≥ threshold. */
  highUsageCount: number;
  /** Entries with only unknown windows. */
  unknownCount: number;
  /** Total de assinaturas detectadas — presente só quando algo foi lido. */
  plans?: QuotaPlansSummary;
}

export const QUOTA_HIGH_USAGE_THRESHOLD = 0.8;

/** Highest known usedRatio on an entry. null = no honest reading (never treat as 0). */
export function peakUsedRatio(
  windows: readonly { usedRatio: number | null }[],
): number | null {
  let peak: number | null = null;
  for (const window of windows) {
    const ratio = window.usedRatio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      continue;
    }
    if (peak === null || ratio > peak) peak = ratio;
  }
  return peak;
}

export interface ConsumptionSortable {
  windows: readonly { usedRatio: number | null }[];
  active?: boolean;
  id?: string;
  label?: string;
}

/**
 * Watch the hungriest accounts first. Known used% descending, unknown last,
 * active as tie-break, then label. 0% is a real reading and ranks above "—".
 */
export function compareEntriesByConsumption(
  a: ConsumptionSortable,
  b: ConsumptionSortable,
): number {
  const aPeak = peakUsedRatio(a.windows);
  const bPeak = peakUsedRatio(b.windows);
  if (aPeak === null && bPeak === null) {
    const active = Number(Boolean(b.active)) - Number(Boolean(a.active));
    if (active !== 0) return active;
    return (a.label ?? a.id ?? '').localeCompare(b.label ?? b.id ?? '', 'pt');
  }
  if (aPeak === null) return 1;
  if (bPeak === null) return -1;
  if (bPeak !== aPeak) return bPeak - aPeak;
  const active = Number(Boolean(b.active)) - Number(Boolean(a.active));
  if (active !== 0) return active;
  return (a.label ?? a.id ?? '').localeCompare(b.label ?? b.id ?? '', 'pt');
}
