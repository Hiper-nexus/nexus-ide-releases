import { describe, expect, it } from 'vitest';
import {
  buildEvalSource,
  rankAllModels,
  rankModel,
  toModelQualityEvaluation,
} from './ranker';
import { V1_FIXTURE_BUNDLES, V1_EVALUATED_AT, V1_SUITE_ID, V1_SUITE_REVISION } from './fixtures/v1-case-results';
import type { ModelCaseBundle } from './suite-types';

const meta = {
  suiteId: V1_SUITE_ID,
  suiteRevision: V1_SUITE_REVISION,
  evaluatedAt: V1_EVALUATED_AT,
  nMinPerDimension: 5,
};

describe('ranker', () => {
  it('builds nexus-eval source accepted by catalog validator pattern', () => {
    const source = buildEvalSource('v1', 'fixture');
    expect(source).toBe('nexus-eval/v1/fixture');
    expect(/^nexus-eval\/[A-Za-z0-9._/-]{1,120}$/.test(source)).toBe(true);
  });

  it('aggregates fixture bundles into 0..100 multi-dimension scores', () => {
    const ranks = rankAllModels(V1_FIXTURE_BUNDLES, meta);
    expect(ranks.length).toBe(V1_FIXTURE_BUNDLES.length);
    for (const r of ranks) {
      expect(r.overall).toBeGreaterThanOrEqual(0);
      expect(r.overall).toBeLessThanOrEqual(100);
      expect(r.coding).toBeDefined();
      expect(r.reasoning).toBeDefined();
      expect(r.frontend).toBeDefined();
      expect(r.security).toBeDefined();
      expect(r.source).toMatch(/^nexus-eval\//);
      expect(r.confidence).toBe(1);
    }
    // Opus should beat grok-4-fast overall on these fixtures
    const opus = ranks.find((r) => r.subject.modelId === 'claude-opus-4-8');
    const fast = ranks.find((r) => r.subject.modelId === 'grok-4-fast');
    expect(opus!.overall).toBeGreaterThan(fast!.overall);
  });

  it('produces ModelQualityEvaluation-compatible blocks', () => {
    const rank = rankModel(V1_FIXTURE_BUNDLES[0]!, meta);
    const q = toModelQualityEvaluation(rank);
    expect(q.overall).toBeGreaterThanOrEqual(0);
    expect(q.overall).toBeLessThanOrEqual(100);
    expect(q.evaluatedAt).toBe(V1_EVALUATED_AT);
    expect(q.source).toBe('nexus-eval/v1/fixture');
  });

  it('prefers stronger frontend outcomes for frontend-heavy model', () => {
    const ranks = rankAllModels(V1_FIXTURE_BUNDLES, meta);
    const grok41 = ranks.find((r) => r.subject.modelId === 'grok-4.1');
    const haiku = ranks.find((r) => r.subject.modelId === 'claude-haiku-4-5');
    expect(grok41!.frontend!).toBeGreaterThan(haiku!.frontend!);
  });

  it('handles partial dimensions by renormalizing overall weights', () => {
    const bundle: ModelCaseBundle = {
      subject: { adapterId: 'x', modelId: 'y', costTier: 'low' },
      cases: Array.from({ length: 5 }, (_, i) => ({
        caseId: `c${i}`,
        dimension: 'coding' as const,
        pass: 1,
        qualityExtra: 1,
        // zero cost/time so batch norms do not self-penalize a single-model suite
        costUsd: 0,
        durationMs: 0,
      })),
    };
    const rank = rankModel(bundle, meta);
    expect(rank.coding).toBeGreaterThan(70);
    expect(rank.reasoning).toBeUndefined();
    expect(rank.overall).toBe(rank.coding);
  });
});
