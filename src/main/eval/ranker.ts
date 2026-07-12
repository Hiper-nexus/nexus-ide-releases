/**
 * Aggregate per-case scores into ModelQualityEvaluation-compatible ranking.
 */

import type { ModelQualityEvaluation } from '../../shared/adapter-types';
import { batchNorms, clipScore, scoreCase } from './scorer';
import type {
  DimensionAggregate,
  EvalDimension,
  EvalSuiteMeta,
  ModelCaseBundle,
  ModelRankResult,
} from './suite-types';

export const OVERALL_WEIGHTS: Record<EvalDimension, number> = {
  coding: 0.4,
  reasoning: 0.25,
  frontend: 0.15,
  security: 0.2,
};

export const DEFAULT_N_MIN = 5;

/**
 * Build quality.source accepted by model-catalog safeModels:
 * /^nexus-eval\/[A-Za-z0-9._/-]{1,120}$/  (@ is not allowed)
 * Format: nexus-eval/<suiteId>/<suiteRevision>
 */
export function buildEvalSource(suiteId: string, suiteRevision: string): string {
  const id = suiteId.trim().replace(/[^A-Za-z0-9._-]/g, '');
  const rev = suiteRevision.trim().replace(/[^A-Za-z0-9._-]/g, '');
  const source = `nexus-eval/${id}/${rev}`;
  if (!/^nexus-eval\/[A-Za-z0-9._/-]{1,120}$/.test(source)) {
    throw new Error(`invalid eval source: ${source}`);
  }
  return source;
}

export function confidenceFor(caseCount: number, nMin: number): number {
  if (nMin <= 0) return 1;
  return Math.min(1, caseCount / nMin);
}

export function aggregateDimension(
  cases: readonly { score: number }[],
  dimension: EvalDimension,
  nMin: number,
): DimensionAggregate {
  if (cases.length === 0) {
    return { dimension, score: 0, caseCount: 0, confidence: 0 };
  }
  const mean = cases.reduce((sum, c) => sum + c.score, 0) / cases.length;
  const conf = confidenceFor(cases.length, nMin);
  return {
    dimension,
    score: clipScore(mean * conf + mean * (1 - conf) * 0.85),
    caseCount: cases.length,
    confidence: conf,
  };
}

/**
 * Rank one model from its case results.
 * Overall is a weighted blend of available dimensions (renormalized if some missing).
 */
export function rankModel(
  bundle: ModelCaseBundle,
  meta: EvalSuiteMeta,
): ModelRankResult {
  const nMin = meta.nMinPerDimension ?? DEFAULT_N_MIN;
  const source = buildEvalSource(meta.suiteId, meta.suiteRevision);
  const norms = batchNorms(bundle.cases);
  const scored = bundle.cases.map((c) => ({
    dimension: c.dimension,
    score: scoreCase(c, norms),
  }));

  const byDim = new Map<EvalDimension, { score: number }[]>();
  for (const row of scored) {
    const list = byDim.get(row.dimension) ?? [];
    list.push({ score: row.score });
    byDim.set(row.dimension, list);
  }

  const dimensions: DimensionAggregate[] = (
    ['coding', 'reasoning', 'frontend', 'security'] as const
  ).map((dim) => aggregateDimension(byDim.get(dim) ?? [], dim, nMin));

  const present = dimensions.filter((d) => d.caseCount > 0);
  let weightSum = 0;
  let overallRaw = 0;
  for (const d of present) {
    const w = OVERALL_WEIGHTS[d.dimension];
    weightSum += w;
    overallRaw += w * d.score;
  }
  const overall = present.length === 0 ? 0 : clipScore(overallRaw / weightSum);

  const totalCases = bundle.cases.length;
  const conf =
    present.length === 0
      ? 0
      : present.reduce((s, d) => s + d.confidence, 0) / present.length;

  const pick = (dim: EvalDimension): number | undefined => {
    const row = dimensions.find((d) => d.dimension === dim);
    return row && row.caseCount > 0 ? row.score : undefined;
  };

  return {
    subject: bundle.subject,
    overall,
    coding: pick('coding'),
    reasoning: pick('reasoning'),
    frontend: pick('frontend'),
    security: pick('security'),
    confidence: conf,
    caseCount: totalCases,
    dimensions,
    evaluatedAt: meta.evaluatedAt,
    source,
  };
}

export function rankAllModels(
  bundles: readonly ModelCaseBundle[],
  meta: EvalSuiteMeta,
): ModelRankResult[] {
  return bundles
    .map((b) => rankModel(b, meta))
    .sort((a, b) => b.overall - a.overall);
}

/** Convert rank result to the catalog quality block. */
export function toModelQualityEvaluation(
  result: ModelRankResult,
): ModelQualityEvaluation {
  return {
    overall: Math.round(result.overall),
    coding:
      result.coding !== undefined ? Math.round(result.coding) : undefined,
    reasoning:
      result.reasoning !== undefined ? Math.round(result.reasoning) : undefined,
    frontend:
      result.frontend !== undefined ? Math.round(result.frontend) : undefined,
    security:
      result.security !== undefined ? Math.round(result.security) : undefined,
    evaluatedAt: result.evaluatedAt,
    source: result.source,
  };
}
