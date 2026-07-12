/**
 * Public ranking read path — exercises the same builder the IPC handler uses.
 * Avoids spinning Electron; validates getPublicModelRanking via exported helpers
 * and the catalog/normalizer path that IPC depends on.
 */

import { describe, expect, it } from 'vitest';
import {
  mergeModelCatalogs,
  PUBLISHED_MODEL_CATALOG,
} from '../adapters/model-catalog';
import { runOfflineEvalV1 } from './eval-pipeline';
import {
  buildPublicRankingFromCatalog,
  publicEntriesFromCatalog,
} from './public-ranking';
import { PUBLIC_MODEL_RANKING_SCHEMA_VERSION } from '../../shared/eval-ranking-types';

describe('public ranking read path (IPC payload contract)', () => {
  it('published catalog quality yields public ranking for UI and landing', () => {
    // After export-public-ranking.mjs, published catalog carries quality blocks.
    const entries = publicEntriesFromCatalog(PUBLISHED_MODEL_CATALOG);
    expect(entries.length).toBeGreaterThanOrEqual(4);

    const snapshot = buildPublicRankingFromCatalog(PUBLISHED_MODEL_CATALOG);
    expect(snapshot.schemaVersion).toBe(PUBLIC_MODEL_RANKING_SCHEMA_VERSION);
    expect(snapshot.entries.every((e) => e.source.startsWith('nexus-eval/'))).toBe(
      true,
    );
    for (const e of snapshot.entries) {
      expect(e.overall).toBeGreaterThanOrEqual(0);
      expect(e.overall).toBeLessThanOrEqual(100);
      expect(e.modelId.length).toBeGreaterThan(0);
      expect(e.adapterId.length).toBeGreaterThan(0);
      expect(e.evaluatedAt).toBeTruthy();
      expect(e.rank).toBeGreaterThan(0);
    }
    // Must not require auth material
    const raw = JSON.stringify(snapshot);
    expect(raw).not.toMatch(/sk-|apiKey|password|Bearer /i);
  });

  it('offline pipeline + merge matches catalog-derived ranking shape', () => {
    const { catalogOverlay, publicRanking } = runOfflineEvalV1(
      PUBLISHED_MODEL_CATALOG,
    );
    const merged = mergeModelCatalogs(PUBLISHED_MODEL_CATALOG, catalogOverlay);
    const fromMerged = buildPublicRankingFromCatalog(merged);
    expect(fromMerged.entries.length).toBe(publicRanking.entries.length);
    expect(fromMerged.entries[0]?.id).toBe(publicRanking.entries[0]?.id);
  });
});
