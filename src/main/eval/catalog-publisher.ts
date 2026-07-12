/**
 * Merge ranked model quality into a ModelCatalog overlay (pure).
 */

import type {
  ModelCatalogEntryInfo,
  ModelCostTier,
} from '../../shared/adapter-types';
import type { ModelCatalog } from '../adapters/model-catalog';
import { toModelQualityEvaluation } from './ranker';
import type { ModelRankResult } from './suite-types';

export function qualityOverlayFromRanks(
  ranks: readonly ModelRankResult[],
): ModelCatalog {
  const adapters: ModelCatalog['adapters'] = {};

  for (const rank of ranks) {
    const { adapterId, modelId, costTier, availability } = rank.subject;
    if (!adapters[adapterId]) {
      adapters[adapterId] = { models: [] };
    }
    const allowedAvailability = new Set([
      'free',
      'cheap',
      'paid',
      'api-only',
      'deprecated',
    ]);
    const allowedCost = new Set(['free', 'low', 'medium', 'high', 'unknown']);
    const entry: ModelCatalogEntryInfo = {
      id: modelId,
      ...(availability && allowedAvailability.has(availability)
        ? {
            availability:
              availability as NonNullable<ModelCatalogEntryInfo['availability']>,
          }
        : {}),
      ...(costTier && allowedCost.has(costTier)
        ? { costTier: costTier as ModelCostTier }
        : {}),
      source: 'nexus-eval',
      quality: toModelQualityEvaluation(rank),
    };
    adapters[adapterId]!.models = [
      ...(adapters[adapterId]!.models ?? []),
      entry,
    ];
  }

  return {
    version: 1,
    updatedAt: ranks[0]?.evaluatedAt,
    adapters,
  };
}

/**
 * Apply quality from ranks onto an existing catalog (merge by adapter+model id).
 * Does not remove non-evaluated models.
 */
export function applyRanksToCatalog(
  base: ModelCatalog,
  ranks: readonly ModelRankResult[],
): ModelCatalog {
  const overlay = qualityOverlayFromRanks(ranks);
  const adapters: NonNullable<ModelCatalog['adapters']> = {
    ...(base.adapters ?? {}),
  };

  for (const [adapterId, overlayAdapter] of Object.entries(overlay.adapters ?? {})) {
    const baseAdapter = adapters[adapterId] ?? {};
    const byId = new Map<string, ModelCatalogEntryInfo>();
    for (const m of baseAdapter.models ?? []) byId.set(m.id, { ...m });
    for (const m of overlayAdapter.models ?? []) {
      const prev = byId.get(m.id) ?? { id: m.id };
      byId.set(m.id, {
        ...prev,
        ...m,
        quality: m.quality ?? prev.quality,
      });
    }
    adapters[adapterId] = {
      models: [...byId.values()],
      default: baseAdapter.default ?? overlayAdapter.default,
    };
  }

  return {
    version: overlay.version ?? base.version,
    updatedAt: overlay.updatedAt ?? base.updatedAt,
    adapters,
  };
}
