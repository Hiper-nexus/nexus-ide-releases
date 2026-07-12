import { describe, expect, it } from 'vitest';
import {
  batchNorms,
  clipScore,
  normalizeMetric,
  scoreCase,
} from './scorer';

describe('scorer', () => {
  it('clips scores to 0..100', () => {
    expect(clipScore(-5)).toBe(0);
    expect(clipScore(150)).toBe(100);
    expect(clipScore(42.2)).toBe(42.2);
  });

  it('normalizes cost against max(batch, absolute ref)', () => {
    expect(normalizeMetric(5, 10, 10)).toBe(0.5);
    expect(normalizeMetric(0, 10, 10)).toBe(0);
    expect(normalizeMetric(20, 10, 10)).toBe(1);
    // absolute ref floors the denominator so tiny batches do not self-penalize
    expect(normalizeMetric(0.01, 0.01, 0.25)).toBeCloseTo(0.04, 5);
  });

  it('scores a full pass near the top when cost/time are low', () => {
    const norms = { maxCostUsd: 1, maxDurationMs: 60_000 };
    const high = scoreCase(
      {
        caseId: 'a',
        dimension: 'coding',
        pass: 1,
        qualityExtra: 1,
        costUsd: 0.01,
        durationMs: 1_000,
        risk: 0,
      },
      norms,
    );
    const fail = scoreCase(
      {
        caseId: 'b',
        dimension: 'coding',
        pass: 0,
        qualityExtra: 0,
        costUsd: 1,
        durationMs: 60_000,
        risk: 0.5,
      },
      norms,
    );
    expect(high).toBeGreaterThan(70);
    expect(fail).toBeLessThan(20);
    expect(high).toBeGreaterThan(fail);
  });

  it('batchNorms tracks max cost and duration', () => {
    const norms = batchNorms([
      {
        caseId: '1',
        dimension: 'coding',
        pass: 1,
        costUsd: 0.2,
        durationMs: 10_000,
      },
      {
        caseId: '2',
        dimension: 'coding',
        pass: 1,
        costUsd: 0.5,
        durationMs: 5_000,
      },
    ]);
    expect(norms.maxCostUsd).toBe(0.5);
    expect(norms.maxDurationMs).toBe(10_000);
  });
});
