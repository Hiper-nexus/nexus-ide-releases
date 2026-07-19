import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeModelCatalogs,
  PUBLISHED_MODEL_CATALOG,
} from '../adapters/model-catalog';
import { applyRanksToCatalog, applyVerifiedBenchmarkRunToCatalog } from './catalog-publisher';
import { benchmarkManifestHash, benchmarkRunId, evidenceHash, type BenchmarkRunManifest } from './benchmark-contract';
import { runOfflineEvalV1 } from './eval-pipeline';
import {
  FIXTURE_ESTIMATE_SOURCE_LABEL,
  buildPublicRankingFromCatalog,
  buildPublicRankingFromRanks,
  isFixtureEvalSource,
  isPublicModelRankingSnapshot,
  parseEvalSource,
  publicEntriesFromCatalog,
  withFixtureEstimateMark,
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
    // Fixture-derived entries are stamped as estimates, never as a real audit.
    expect(first.estimate).toBe(true);
    expect(first.sourceLabel).toBe(FIXTURE_ESTIMATE_SOURCE_LABEL);
    expect(snap.entries.every((e) => e.estimate === true)).toBe(true);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/api[_-]?key|secret|password|token/i);
    expect(json).not.toContain(os.homedir());
  });

  it('never stamps the estimate mark on real-audit revisions', () => {
    // A future live evaluation ships a run-id revision: no estimate mark,
    // no sourceLabel — the badge stays off.
    const ranks = rankAllModels(V1_FIXTURE_BUNDLES, {
      suiteId: V1_SUITE_ID,
      suiteRevision: 'run-2026-07-18',
      evaluatedAt: V1_EVALUATED_AT,
    });
    const snap = buildPublicRankingFromRanks(
      ranks,
      V1_SUITE_ID,
      'run-2026-07-18',
      V1_EVALUATED_AT,
    );
    expect(snap.entries.length).toBeGreaterThan(0);
    expect(snap.entries.every((e) => e.estimate === undefined)).toBe(true);
    expect(snap.entries.every((e) => e.sourceLabel === undefined)).toBe(true);
  });

  it('withFixtureEstimateMark is idempotent and leaves real entries untouched', () => {
    const base = {
      id: 'claude/claude-opus-4-8',
      adapterId: 'claude',
      modelId: 'claude-opus-4-8',
      overall: 61,
      evaluatedAt: V1_EVALUATED_AT,
      source: 'nexus-eval/v1/run-2026-07-18',
    };
    // Real audit: pass-through (same reference, no mark).
    expect(withFixtureEstimateMark(base)).toBe(base);

    const once = withFixtureEstimateMark({
      ...base,
      source: 'nexus-eval/v1/fixture',
    });
    expect(once.estimate).toBe(true);
    expect(once.sourceLabel).toBe(FIXTURE_ESTIMATE_SOURCE_LABEL);
    // Idempotent: re-stamping never duplicates or rewrites the label.
    expect(withFixtureEstimateMark(once)).toEqual(once);
    // A pre-existing custom label is preserved.
    expect(
      withFixtureEstimateMark({ ...once, sourceLabel: 'custom' }).sourceLabel,
    ).toBe('custom');
  });

  it('fixture source detection + snapshot validator stay backward-compatible', () => {
    expect(isFixtureEvalSource('nexus-eval/v1/fixture')).toBe(true);
    expect(isFixtureEvalSource('nexus-eval/v1/offline-fixture')).toBe(true);
    expect(isFixtureEvalSource('nexus-eval/v1/run-2026-07-18')).toBe(false);
    expect(isFixtureEvalSource('manual')).toBe(false);

    const ranks = rankAllModels(V1_FIXTURE_BUNDLES, {
      suiteId: V1_SUITE_ID,
      suiteRevision: V1_SUITE_REVISION,
      evaluatedAt: V1_EVALUATED_AT,
    });
    const marked = buildPublicRankingFromRanks(
      ranks,
      V1_SUITE_ID,
      V1_SUITE_REVISION,
      V1_EVALUATED_AT,
    );
    expect(isPublicModelRankingSnapshot(marked)).toBe(true);

    // Pre-mark payloads (shipped before this field existed) stay valid.
    const legacy = JSON.parse(JSON.stringify(marked)) as typeof marked;
    for (const e of legacy.entries) {
      delete e.estimate;
      delete e.sourceLabel;
    }
    expect(isPublicModelRankingSnapshot(legacy)).toBe(true);

    // Wrong-typed marks are rejected.
    const tampered = JSON.parse(JSON.stringify(marked)) as {
      entries: Array<{ estimate: unknown }>;
    };
    tampered.entries[0]!.estimate = 'yes';
    expect(isPublicModelRankingSnapshot(tampered)).toBe(false);
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
    expect(isPublicModelRankingSnapshot({ schemaVersion: 99, entries: [] })).toBe(
      false,
    );
    // O catálogo publicado não carrega quality até uma avaliação real ser
    // publicada: o snapshot derivado do catálogo é válido e vazio (defaults).
    const snap = buildPublicRankingFromCatalog(PUBLISHED_MODEL_CATALOG);
    expect(isPublicModelRankingSnapshot(snap)).toBe(true);
    expect(snap.entries).toEqual([]);
    expect(snap.suiteId).toBe('v1');
    expect(snap.suiteRevision).toBe('unknown');
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

  it('does not publish an empty or tampered benchmark journal', () => {
    const manifest: BenchmarkRunManifest = {
      version: 1,
      methodology: 'nexus-bench-v1',
      suiteId: 'publish-smoke',
      suiteRevision: 'v1',
      seed: 'seed',
      promptPolicyHash: 'a'.repeat(64),
      subjects: [
        { id: 'opus', adapterId: 'claude', modelId: 'opus' },
        { id: 'codex', adapterId: 'codex', modelId: 'gpt' },
      ],
      cases: [{
        id: 'case-1',
        dimension: 'security',
        revision: '1',
        publicHash: 'b'.repeat(64),
        privateHash: null,
      }],
    };
    const entry = {
      version: 1 as const,
      runId: benchmarkRunId(manifest),
      manifestHash: benchmarkManifestHash(manifest),
      sequence: 1,
      matchId: 'match-1',
      caseId: 'case-1',
      subjectA: 'opus',
      subjectB: 'codex',
      outcome: 'no-contest' as const,
      winnerId: null,
      evidenceHash: evidenceHash({ answerA: 'a', answerB: 'b' }),
      timestamp: '2026-07-14T12:00:00.000Z',
    };

    expect(() => applyVerifiedBenchmarkRunToCatalog({}, manifest, [], [])).toThrow(/empty/);
    expect(() => applyVerifiedBenchmarkRunToCatalog({}, manifest, [{ ...entry, winnerId: 'codex' }], [])).toThrow();
    expect(applyVerifiedBenchmarkRunToCatalog({}, manifest, [entry], []).version).toBe(1);
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
