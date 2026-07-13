import { describe, expect, it } from 'vitest';
import type { PublicModelRankingEntry } from '../../../shared/eval-ranking-types';
import {
  costEfficiency,
  pickForDimension,
  pickValue,
  radarPoints,
  radarPolygon,
  sortEntries,
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
});
