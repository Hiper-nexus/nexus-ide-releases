/**
 * Offline eval pipeline entry — fixtures → ranks → catalog quality → public DTO.
 * Live multi-provider runs can plug in later; this path is the CI/gating bar.
 */

import type { ModelCatalog } from '../adapters/model-catalog';
import { applyRanksToCatalog } from './catalog-publisher';
import {
  V1_EVALUATED_AT,
  V1_FIXTURE_BUNDLES,
  V1_SUITE_ID,
  V1_SUITE_REVISION,
} from './fixtures/v1-case-results';
import {
  buildPublicRankingFromRanks,
} from './public-ranking';
import { rankAllModels } from './ranker';
import type { ModelRankResult } from './suite-types';
import type { PublicModelRankingSnapshot } from '../../shared/eval-ranking-types';

export interface OfflineEvalResult {
  ranks: ModelRankResult[];
  catalogOverlay: ModelCatalog;
  publicRanking: PublicModelRankingSnapshot;
}

export function runOfflineEvalV1(
  baseCatalog: ModelCatalog = {},
): OfflineEvalResult {
  const meta = {
    suiteId: V1_SUITE_ID,
    suiteRevision: V1_SUITE_REVISION,
    evaluatedAt: V1_EVALUATED_AT,
    nMinPerDimension: 5,
  };
  const ranks = rankAllModels(V1_FIXTURE_BUNDLES, meta);
  const catalogOverlay = applyRanksToCatalog(baseCatalog, ranks);
  const publicRanking = buildPublicRankingFromRanks(
    ranks,
    V1_SUITE_ID,
    V1_SUITE_REVISION,
    V1_EVALUATED_AT,
  );
  return { ranks, catalogOverlay, publicRanking };
}
