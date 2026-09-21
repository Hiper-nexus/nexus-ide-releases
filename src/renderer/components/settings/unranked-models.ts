import type { ModelCostTier } from '../../../shared/adapter-types';
import type { PublicModelRankingEntry } from '../../../shared/eval-ranking-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';

type ModelProvider = Pick<ProviderSettingsInfo, 'adapterId' | 'label' | 'installed' | 'enabled'> &
  Partial<Pick<ProviderSettingsInfo, 'models' | 'modelInfo'>>;

/** Catalog identity without a score: absence of evaluation is never zero. */
export interface UnrankedModel {
  id: string;
  adapterId: string;
  modelId: string;
  label: string;
  installed: boolean;
  costTier?: ModelCostTier;
  source?: string;
}

export function unrankedModels(
  providers: readonly ModelProvider[],
  entries: readonly PublicModelRankingEntry[],
): UnrankedModel[] {
  const seen = new Set(entries.map((entry) => `${entry.adapterId}/${entry.modelId}`));
  return providers.flatMap((provider) => (provider.models ?? []).flatMap((modelId) => {
    const id = `${provider.adapterId}/${modelId}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const info = provider.modelInfo?.[modelId];
    return [{
      id, adapterId: provider.adapterId, modelId, label: provider.label,
      installed: provider.installed && provider.enabled,
      costTier: info?.costTier,
      source: info?.source,
    }];
  }));
}
