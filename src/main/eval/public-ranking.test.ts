import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeModelCatalogs,
  PUBLISHED_MODEL_CATALOG,
} from '../adapters/model-catalog';
import { applyRanksToCatalog } from './catalog-publisher';
import { runOfflineEvalV1 } from './eval-pipeline';
import {
  buildPublicRankingFromCatalog,
  buildPublicRankingFromRanks,
  isPublicModelRankingSnapshot,
  parseEvalSource,
  publicEntriesFromCatalog,
} from './public-ranking';
import { rankAllModels } from './ranker';
import {
  V1_EVALUATED_AT,
  V1_FIXTURE_BUNDLES,
  V1_SUITE_ID,
  V1_SUITE_REVISION,
} from './fixtures/v1-case-results';
import { PUBLIC_MODEL_RANKING_SCHEMA_VERSION } from '../../shared/eval-ranking-types';

// model-catalog doesn't export normalise — use merge via load path in pipeline tests

describe('public ranking', () => {
  it('builds versioned snapshot suitable for landing (no secrets)', () => {
    const ranks = rankAllModels(V1_FIXTURE_BUNDLES, {
      suiteId: V1_SUITE_ID,
      suiteRevision: V1_SUITE_REVISION,
      evaluatedAt: V1_EVALUATED_AT,
    });
    const snap = buildPublicRankingFromRanks(
      ranks,
      V1_SUITE_ID,
      V1_SUITE_REVISION,
      V1_EVALUATED_AT,
    );
    expect(snap.schemaVersion).toBe(PUBLIC_MODEL_RANKING_SCHEMA_VERSION);
    expect(snap.suiteId).toBe('v1');
    expect(snap.entries.length).toBeGreaterThan(0);
    const first = snap.entries[0]!;
    expect(first).toMatchObject({
      adapterId: expect.any(String),
      modelId: expect.any(String),
      overall: expect.any(Number),
      evaluatedAt: expect.any(String),
      source: expect.stringMatching(/^nexus-eval\//),
      rank: 1,
    });
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/api[_-]?key|secret|password|token/i);
    expect(json).not.toContain(os.homedir());
  });

  it('loads quality through catalog merge and rebuilds public entries', () => {
    const { ranks, catalogOverlay, publicRanking } = runOfflineEvalV1(
      PUBLISHED_MODEL_CATALOG,
    );
    expect(ranks.length).toBeGreaterThan(0);

    // Simulate what loadModelCatalog does: merge overlay onto published.
    const merged = mergeModelCatalogs(PUBLISHED_MODEL_CATALOG, catalogOverlay);
    const opus = merged.adapters?.claude?.models?.find(
      (m) => m.id === 'claude-opus-4-8',
    );
    expect(opus?.quality?.source).toMatch(/^nexus-eval\//);
    expect(opus?.quality?.overall).toBeGreaterThan(0);
    expect(opus?.quality?.overall).toBeLessThanOrEqual(100);

    const fromCatalog = buildPublicRankingFromCatalog(merged);
    expect(fromCatalog.entries.length).toBe(publicRanking.entries.length);
    expect(fromCatalog.entries[0]?.modelId).toBe(publicRanking.entries[0]?.modelId);
    expect(publicEntriesFromCatalog(merged).every((e) => e.source.startsWith('nexus-eval/'))).toBe(
      true,
    );
  });

  it('parses suite from nexus-eval source and validates public snapshots', () => {
    expect(parseEvalSource('nexus-eval/v1/fixture')).toEqual({
      suiteId: 'v1',
      suiteRevision: 'fixture',
    });
    expect(parseEvalSource('manual')).toBeNull();
    const snap = buildPublicRankingFromCatalog(PUBLISHED_MODEL_CATALOG);
    expect(isPublicModelRankingSnapshot(snap)).toBe(true);
    expect(isPublicModelRankingSnapshot({ schemaVersion: 99, entries: [] })).toBe(
      false,
    );
    expect(snap.suiteId).toBe('v1');
    expect(snap.suiteRevision).toBe('fixture');
  });

  it('applyRanksToCatalog preserves non-evaluated models', () => {
    const base = {
      adapters: {
        claude: {
          models: [
            { id: 'claude-sonnet-5', costTier: 'medium' as const, availability: 'paid' as const },
          ],
        },
      },
    };
    const ranks = rankAllModels(
      V1_FIXTURE_BUNDLES.filter((b) => b.subject.modelId === 'claude-opus-4-8'),
      {
        suiteId: V1_SUITE_ID,
        suiteRevision: V1_SUITE_REVISION,
        evaluatedAt: V1_EVALUATED_AT,
      },
    );
    const merged = applyRanksToCatalog(base, ranks);
    const ids = (merged.adapters?.claude?.models ?? []).map((m) => m.id);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-opus-4-8');
  });
});

describe('published resources carry quality when pipeline seeded', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('writes public ranking JSON that matches schema', () => {
    const { publicRanking } = runOfflineEvalV1();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rank-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-ranking.json');
    fs.writeFileSync(file, JSON.stringify(publicRanking, null, 2));
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(loaded.schemaVersion).toBe(1);
    expect(Array.isArray(loaded.entries)).toBe(true);
    expect(loaded.entries[0].overall).toBeGreaterThan(0);
  });
});
