/**
 * Per-case scoring — pure, unit-testable.
 *
 * s = 100 * (0.55*pass + 0.20*qualityExtra - 0.15*costNorm - 0.05*timeNorm - 0.05*risk)
 */

import type { EvalCaseResult } from './suite-types';

export const CASE_SCORE_WEIGHTS = {
  pass: 0.55,
  qualityExtra: 0.2,
  cost: 0.15,
  time: 0.05,
  risk: 0.05,
} as const;

/** Absolute ceilings so a full pass with low cost lands near 75–90, not ~55. */
export const ABS_COST_REF_USD = 0.25;
export const ABS_TIME_REF_MS = 120_000;

/** Normalize against max(batch max, absolute ref) so single-model batches do not self-penalize. */
export function normalizeMetric(
  value: number | undefined,
  maxInBatch: number,
  absoluteRef: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  const denom = Math.max(
    Number.isFinite(maxInBatch) ? maxInBatch : 0,
    Number.isFinite(absoluteRef) ? absoluteRef : 0,
    1e-9,
  );
  return Math.min(1, value / denom);
}

export function clipScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

export function scoreCase(
  result: EvalCaseResult,
  norms: { maxCostUsd: number; maxDurationMs: number },
): number {
  const pass = clamp01(result.pass);
  const qualityExtra = clamp01(result.qualityExtra ?? pass);
  const costNorm = normalizeMetric(
    result.costUsd,
    norms.maxCostUsd,
    ABS_COST_REF_USD,
  );
  const timeNorm = normalizeMetric(
    result.durationMs,
    norms.maxDurationMs,
    ABS_TIME_REF_MS,
  );
  const risk = clamp01(result.risk ?? 0);

  const raw =
    100 *
    (CASE_SCORE_WEIGHTS.pass * pass +
      CASE_SCORE_WEIGHTS.qualityExtra * qualityExtra -
      CASE_SCORE_WEIGHTS.cost * costNorm -
      CASE_SCORE_WEIGHTS.time * timeNorm -
      CASE_SCORE_WEIGHTS.risk * risk);

  return clipScore(raw);
}

export function batchNorms(cases: readonly EvalCaseResult[]): {
  maxCostUsd: number;
  maxDurationMs: number;
} {
  let maxCostUsd = 0;
  let maxDurationMs = 0;
  for (const c of cases) {
    if (typeof c.costUsd === 'number' && c.costUsd > maxCostUsd) maxCostUsd = c.costUsd;
    if (typeof c.durationMs === 'number' && c.durationMs > maxDurationMs) {
      maxDurationMs = c.durationMs;
    }
  }
  return { maxCostUsd, maxDurationMs };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
