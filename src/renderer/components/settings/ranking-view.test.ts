import { describe, expect, it } from 'vitest';
import type { PublicModelRankingEntry } from '../../../shared/eval-ranking-types';
import {
  costEfficiency,
  estimateBadge,
  pickForDimension,
  pickValue,
  radarPoints,
  radarPolygon,
  scoreWithQuota,
  sortEntries,
  sortEntriesWithQuota,
} from './ranking-view';

function entry(
  patch: Partial<PublicModelRankingEntry> & Pick<PublicModelRankingEntry, 'id' | 'modelId'>,
): PublicModelRankingEntry {
  return {
    adapterId: 'claude',
    overall: 50,
    coding: 50,
    reasoning: 50,
    frontend: 50,
    security: 50,
    evaluatedAt: '2026-07-11T21:00:00.000Z',
    source: 'nexus-eval/v1/fixture',
    ...patch,
  };
}

describe('ranking-view', () => {
  const pack = [
    entry({
      id: 'a/opus',
      modelId: 'opus',
      overall: 61,
      coding: 63,
      frontend: 40,
      costTier: 'high',
    }),
    entry({
      id: 'b/fast',
      modelId: 'fast',
      adapterId: 'grok',
      overall: 45,
      coding: 50,
      frontend: 65,
      costTier: 'low',
      availability: 'cheap',
    }),
    entry({
      id: 'c/mid',
      modelId: 'mid',
      adapterId: 'glm',
      overall: 58,
      coding: 62,
      frontend: 57,
      costTier: 'low',
    }),
  ];

  it('sorts by active dimension', () => {
    expect(sortEntries(pack, 'frontend').map((e) => e.modelId)).toEqual([
      'fast',
      'mid',
      'opus',
    ]);
  });

  it('picks mission winners per axis', () => {
    expect(pickForDimension(pack, 'coding')?.modelId).toBe('opus');
    expect(pickForDimension(pack, 'frontend')?.modelId).toBe('fast');
  });

  it('picks value model among low cost', () => {
    expect(pickValue(pack)?.modelId).toBe('mid');
  });

  it('scores cost efficiency higher for cheap models', () => {
    const high = entry({ id: 'h', modelId: 'h', overall: 60, costTier: 'high' });
    const low = entry({ id: 'l', modelId: 'l', overall: 50, costTier: 'low' });
    expect(costEfficiency(low)).toBeGreaterThan(costEfficiency(high));
  });

  it('builds a closed radar polygon with five vertices', () => {
    const pts = radarPoints(pack[0]!, 100, 100, 80);
    expect(pts).toHaveLength(5);
    const poly = radarPolygon(pts);
    expect(poly.split(' ')).toHaveLength(5);
    // overall axis points up from center
    expect(pts[0]!.y).toBeLessThan(100);
  });

  it('scoreWithQuota boosts freer accounts without inventing free when null', () => {
    const e = pack[0]!;
    const free = scoreWithQuota(e, 1);
    const tight = scoreWithQuota(e, 0);
    const unknown = scoreWithQuota(e, null);
    expect(free).toBeGreaterThan(tight);
    expect(unknown).toBeGreaterThan(tight);
    expect(unknown).toBeLessThan(free);
  });

  it('sortEntriesWithQuota demotes exhausted adapters on overall sort', () => {
    const quota = new Map<string, number | null>([
      ['claude', 0.1],
      ['grok', 0.95],
      ['glm', null],
    ]);
    const ranked = sortEntriesWithQuota(pack, 'overall', quota);
    const idx = (adapter: string) =>
      ranked.findIndex((e) => e.adapterId === adapter);
    // freer grok ranks above exhausted claude despite lower raw overall
    expect(scoreWithQuota(pack[1]!, 0.95)).toBeGreaterThan(
      scoreWithQuota(pack[0]!, 0.1),
    );
    expect(idx('grok')).toBeLessThan(idx('claude'));
    // unknown glm uses neutral weight — stays competitive with raw 58 overall
    expect(idx('glm')).toBeLessThan(idx('claude'));
    // coding sort ignores quota map path for non-overall keys
    const byCoding = sortEntriesWithQuota(pack, 'coding', quota);
    expect(byCoding[0]!.modelId).toBe(sortEntries(pack, 'coding')[0]!.modelId);
  });

  it('estimateBadge surfaces the fixture mark and stays null for real audits', () => {
    const fixture = entry({
      id: 'f/opus',
      modelId: 'opus',
      estimate: true,
      sourceLabel: 'estimativa (fixture)',
    });
    expect(estimateBadge(fixture)).toBe('estimativa (fixture)');
    // Mark without label falls back to the bare badge copy.
    expect(
      estimateBadge(entry({ id: 'f/bare', modelId: 'bare', estimate: true })),
    ).toBe('estimativa');
    // Real audits: no mark (or explicit false) → no badge.
    expect(
      estimateBadge(
        entry({
          id: 'r/opus',
          modelId: 'opus-real',
          source: 'nexus-eval/v1/run-2026-07-18',
        }),
      ),
    ).toBeNull();
    expect(
      estimateBadge(entry({ id: 'r/false', modelId: 'f', estimate: false })),
    ).toBeNull();
  });
});

