import type {
  AdapterInfo,
  ModelCostTier,
} from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { ProviderQuotaEntry } from '../../shared/quota-types';

/**
 * Pure ranking engine behind the unified ModelPicker (herança Orca: cada
 * CLI usa sua sessão nativa — o picker só projeta prontidão, nunca inventa).
 *
 * Ordem: sessão pronta primeiro → custo menor → quota mais livre.
 * Quota desconhecida (null) é neutra e nunca desvia sozinha; login-needed
 * sem modelo pronto vai para o fim, com o motivo para o humano agir.
 */

const COST_RANK: Record<ModelCostTier, number> = {
  free: 0,
  low: 1,
  unknown: 2,
  medium: 3,
  high: 4,
};

export function costRankForModel(adapter: AdapterInfo, model: string): number {
  const info = adapter.models.info?.[model];
  if (!info) return COST_RANK.unknown;
  if (info.availability === 'api-only' || info.availability === 'deprecated') {
    return Number.POSITIVE_INFINITY;
  }
  if (info.costTier) return COST_RANK[info.costTier];
  if (info.availability === 'free') return COST_RANK.free;
  if (info.availability === 'cheap') return COST_RANK.low;
  if (info.availability === 'paid') return COST_RANK.high;
  return COST_RANK.unknown;
}

export interface ModelAuthView {
  /** true = sessão pronta; false = login necessário; null = ainda verificando. */
  ready: boolean | null;
  reason?: string;
}

export function authViewForModel(
  provider: ProviderSettingsInfo | undefined,
  model: string,
): ModelAuthView {
  if (!provider) return { ready: null, reason: 'verificando sessão…' };
  if (!provider.enabled) {
    return { ready: false, reason: 'desabilitado em Configurações › Conta e acesso a IAs › Contas de IA' };
  }
  if (provider.authStrategy !== 'login-needed') return { ready: true };
  if (Array.isArray(provider.authReadyModels)) {
    const readyModels = new Set(
      provider.authReadyModels.map((ready) => ready.trim()),
    );
    if (readyModels.has(model.trim())) {
      return { ready: true };
    }
    const login = provider.loginCommand?.trim();
    return {
      ready: false,
      reason: login ? `sessão necessária — rode \`${login}\`` : 'sessão necessária',
    };
  }
  return { ready: null, reason: 'verificando sessão…' };
}

export function worstQuotaFor(
  entries: readonly ProviderQuotaEntry[],
  adapterId: string,
): number | null {
  let worst: number | null = null;
  for (const entry of entries) {
    if (entry.adapterId !== adapterId) continue;
    for (const window of entry.windows) {
      if (window.usedRatio === null) continue;
      if (worst === null || window.usedRatio > worst) worst = window.usedRatio;
    }
    if (entry.onCooldown) return 1;
  }
  return worst;
}

export interface RankedModelOption {
  adapterId: string;
  adapterLabel: string;
  adapterIcon: string;
  model: string;
  isDefault: boolean;
  ready: boolean | null;
  reason?: string;
  costRank: number;
  quotaWorst: number | null;
}

export interface RankModelOptionsInput {
  adapters: readonly AdapterInfo[];
  providers: readonly ProviderSettingsInfo[];
  quotaEntries: readonly ProviderQuotaEntry[];
}

function quotaPenalty(worst: number | null): number {
  // Desconhecida = neutra-levemente cautelosa (mesmo 0.55 de quota-policy).
  if (worst === null) return 1 - 0.55;
  return worst;
}

/**
 * Comparador à prova de Infinity: `Inf - Inf` é NaN (falsy, cai no próximo
 * critério por acidente). Explícito aqui — bloqueado sempre perde, empate
 * de bloqueados desempata nos critérios seguintes.
 */
export function compareCost(a: number, b: number): number {
  const finiteA = Number.isFinite(a);
  const finiteB = Number.isFinite(b);
  if (finiteA && finiteB) return a - b;
  if (finiteA) return -1;
  if (finiteB) return 1;
  return 0;
}

export function rankModelOptions(
  input: RankModelOptionsInput,
): RankedModelOption[] {
  const providersById = new Map(
    input.providers.map((provider) => [provider.adapterId, provider]),
  );
  const options: RankedModelOption[] = [];
  for (const adapter of input.adapters) {
    if (!adapter.installed) continue;
    const provider = providersById.get(adapter.id);
    const models = adapter.models.list.length > 0
      ? adapter.models.list
      : [adapter.models.default];
    for (const model of models) {
      const auth = authViewForModel(provider, model);
      options.push({
        adapterId: adapter.id,
        adapterLabel: adapter.label,
        adapterIcon: adapter.icon,
        model,
        isDefault: model === adapter.models.default,
        ready: auth.ready,
        ...(auth.reason ? { reason: auth.reason } : {}),
        costRank: costRankForModel(adapter, model),
        quotaWorst: worstQuotaFor(input.quotaEntries, adapter.id),
      });
    }
  }
  const readyRank = (ready: boolean | null): number =>
    ready === true ? 0 : ready === null ? 1 : 2;
  return options.sort(
    (a, b) =>
      readyRank(a.ready) - readyRank(b.ready) ||
      compareCost(a.costRank, b.costRank) ||
      quotaPenalty(a.quotaWorst) - quotaPenalty(b.quotaWorst) ||
      a.adapterLabel.localeCompare(b.adapterLabel) ||
      a.model.localeCompare(b.model),
  );
}
