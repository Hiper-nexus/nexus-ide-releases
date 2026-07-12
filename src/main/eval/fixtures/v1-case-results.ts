/**
 * Deterministic offline eval fixtures — enough cases per dimension for confidence.
 * Scores are hand-authored outcomes (pass/cost/time), not live LLM calls.
 * The ranker + scorer produce real quality vectors from these.
 */

import type { ModelCaseBundle } from '../suite-types';

export const V1_SUITE_ID = 'v1';
export const V1_SUITE_REVISION = 'fixture';
export const V1_EVALUATED_AT = '2026-07-11T21:00:00.000Z';

function cases(
  dimension: 'coding' | 'reasoning' | 'frontend' | 'security',
  rows: Array<{
    id: string;
    pass: number;
    qualityExtra?: number;
    costUsd?: number;
    durationMs?: number;
    risk?: number;
  }>,
) {
  return rows.map((r) => ({
    caseId: r.id,
    dimension,
    pass: r.pass,
    qualityExtra: r.qualityExtra,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    risk: r.risk,
  }));
}

/** Five cases per dimension for each model (n_min default). */
export const V1_FIXTURE_BUNDLES: ModelCaseBundle[] = [
  {
    subject: {
      adapterId: 'claude',
      modelId: 'claude-opus-4-8',
      costTier: 'high',
      availability: 'paid',
    },
    cases: [
      ...cases('coding', [
        { id: 'c1', pass: 1, qualityExtra: 0.95, costUsd: 0.12, durationMs: 40_000 },
        { id: 'c2', pass: 1, qualityExtra: 0.9, costUsd: 0.15, durationMs: 55_000 },
        { id: 'c3', pass: 1, qualityExtra: 0.92, costUsd: 0.11, durationMs: 38_000 },
        { id: 'c4', pass: 0.9, qualityExtra: 0.88, costUsd: 0.14, durationMs: 48_000 },
        { id: 'c5', pass: 1, qualityExtra: 0.93, costUsd: 0.13, durationMs: 42_000 },
      ]),
      ...cases('reasoning', [
        { id: 'r1', pass: 1, qualityExtra: 0.95, costUsd: 0.18, durationMs: 60_000 },
        { id: 'r2', pass: 1, qualityExtra: 0.9, costUsd: 0.2, durationMs: 70_000 },
        { id: 'r3', pass: 0.95, qualityExtra: 0.9, costUsd: 0.17, durationMs: 58_000 },
        { id: 'r4', pass: 1, qualityExtra: 0.92, costUsd: 0.19, durationMs: 65_000 },
        { id: 'r5', pass: 0.9, qualityExtra: 0.88, costUsd: 0.16, durationMs: 50_000 },
      ]),
      ...cases('frontend', [
        { id: 'f1', pass: 0.9, qualityExtra: 0.85, costUsd: 0.1, durationMs: 35_000 },
        { id: 'f2', pass: 0.85, qualityExtra: 0.8, costUsd: 0.11, durationMs: 40_000 },
        { id: 'f3', pass: 0.9, qualityExtra: 0.88, costUsd: 0.12, durationMs: 38_000 },
        { id: 'f4', pass: 0.8, qualityExtra: 0.78, costUsd: 0.1, durationMs: 36_000 },
        { id: 'f5', pass: 0.9, qualityExtra: 0.85, costUsd: 0.11, durationMs: 37_000 },
      ]),
      ...cases('security', [
        { id: 's1', pass: 1, qualityExtra: 0.95, costUsd: 0.14, durationMs: 45_000, risk: 0 },
        { id: 's2', pass: 1, qualityExtra: 0.92, costUsd: 0.15, durationMs: 50_000 },
        { id: 's3', pass: 0.95, qualityExtra: 0.9, costUsd: 0.13, durationMs: 42_000 },
        { id: 's4', pass: 1, qualityExtra: 0.93, costUsd: 0.14, durationMs: 44_000 },
        { id: 's5', pass: 0.95, qualityExtra: 0.9, costUsd: 0.12, durationMs: 40_000 },
      ]),
    ],
  },
  {
    subject: {
      adapterId: 'codex',
      modelId: 'gpt-5.5',
      costTier: 'high',
      availability: 'paid',
    },
    cases: [
      ...cases('coding', [
        { id: 'c1', pass: 1, qualityExtra: 0.92, costUsd: 0.11, durationMs: 38_000 },
        { id: 'c2', pass: 0.95, qualityExtra: 0.9, costUsd: 0.13, durationMs: 50_000 },
        { id: 'c3', pass: 1, qualityExtra: 0.9, costUsd: 0.1, durationMs: 36_000 },
        { id: 'c4', pass: 0.9, qualityExtra: 0.88, costUsd: 0.12, durationMs: 45_000 },
        { id: 'c5', pass: 0.95, qualityExtra: 0.9, costUsd: 0.11, durationMs: 40_000 },
      ]),
      ...cases('reasoning', [
        { id: 'r1', pass: 0.95, qualityExtra: 0.9, costUsd: 0.16, durationMs: 55_000 },
        { id: 'r2', pass: 0.9, qualityExtra: 0.88, costUsd: 0.18, durationMs: 62_000 },
        { id: 'r3', pass: 0.95, qualityExtra: 0.9, costUsd: 0.15, durationMs: 52_000 },
        { id: 'r4', pass: 0.9, qualityExtra: 0.85, costUsd: 0.17, durationMs: 58_000 },
        { id: 'r5', pass: 0.9, qualityExtra: 0.88, costUsd: 0.14, durationMs: 48_000 },
      ]),
      ...cases('frontend', [
        { id: 'f1', pass: 0.85, qualityExtra: 0.82, costUsd: 0.09, durationMs: 32_000 },
        { id: 'f2', pass: 0.8, qualityExtra: 0.78, costUsd: 0.1, durationMs: 35_000 },
        { id: 'f3', pass: 0.85, qualityExtra: 0.8, costUsd: 0.1, durationMs: 34_000 },
        { id: 'f4', pass: 0.8, qualityExtra: 0.75, costUsd: 0.09, durationMs: 33_000 },
        { id: 'f5', pass: 0.85, qualityExtra: 0.8, costUsd: 0.1, durationMs: 34_000 },
      ]),
      ...cases('security', [
        { id: 's1', pass: 0.95, qualityExtra: 0.9, costUsd: 0.13, durationMs: 42_000 },
        { id: 's2', pass: 0.9, qualityExtra: 0.88, costUsd: 0.14, durationMs: 46_000 },
        { id: 's3', pass: 0.95, qualityExtra: 0.9, costUsd: 0.12, durationMs: 40_000 },
        { id: 's4', pass: 0.9, qualityExtra: 0.85, costUsd: 0.13, durationMs: 41_000 },
        { id: 's5', pass: 0.9, qualityExtra: 0.88, costUsd: 0.11, durationMs: 38_000 },
      ]),
    ],
  },
  {
    subject: {
      adapterId: 'grok',
      modelId: 'grok-4.1',
      costTier: 'medium',
      availability: 'paid',
    },
    cases: [
      ...cases('coding', [
        { id: 'c1', pass: 0.9, qualityExtra: 0.85, costUsd: 0.06, durationMs: 28_000 },
        { id: 'c2', pass: 0.85, qualityExtra: 0.82, costUsd: 0.07, durationMs: 32_000 },
        { id: 'c3', pass: 0.9, qualityExtra: 0.88, costUsd: 0.05, durationMs: 26_000 },
        { id: 'c4', pass: 0.85, qualityExtra: 0.8, costUsd: 0.06, durationMs: 30_000 },
        { id: 'c5', pass: 0.9, qualityExtra: 0.85, costUsd: 0.06, durationMs: 29_000 },
      ]),
      ...cases('reasoning', [
        { id: 'r1', pass: 0.85, qualityExtra: 0.8, costUsd: 0.08, durationMs: 35_000 },
        { id: 'r2', pass: 0.8, qualityExtra: 0.78, costUsd: 0.09, durationMs: 40_000 },
        { id: 'r3', pass: 0.85, qualityExtra: 0.8, costUsd: 0.07, durationMs: 34_000 },
        { id: 'r4', pass: 0.8, qualityExtra: 0.75, costUsd: 0.08, durationMs: 36_000 },
        { id: 'r5', pass: 0.85, qualityExtra: 0.8, costUsd: 0.07, durationMs: 33_000 },
      ]),
      ...cases('frontend', [
        { id: 'f1', pass: 0.95, qualityExtra: 0.92, costUsd: 0.05, durationMs: 24_000 },
        { id: 'f2', pass: 0.95, qualityExtra: 0.9, costUsd: 0.055, durationMs: 26_000 },
        { id: 'f3', pass: 0.9, qualityExtra: 0.9, costUsd: 0.05, durationMs: 25_000 },
        { id: 'f4', pass: 0.95, qualityExtra: 0.92, costUsd: 0.05, durationMs: 24_000 },
        { id: 'f5', pass: 0.9, qualityExtra: 0.88, costUsd: 0.055, durationMs: 25_000 },
      ]),
      ...cases('security', [
        { id: 's1', pass: 0.75, qualityExtra: 0.7, costUsd: 0.06, durationMs: 28_000 },
        { id: 's2', pass: 0.7, qualityExtra: 0.68, costUsd: 0.07, durationMs: 30_000 },
        { id: 's3', pass: 0.75, qualityExtra: 0.72, costUsd: 0.06, durationMs: 27_000 },
        { id: 's4', pass: 0.7, qualityExtra: 0.65, costUsd: 0.06, durationMs: 29_000 },
        { id: 's5', pass: 0.75, qualityExtra: 0.7, costUsd: 0.05, durationMs: 26_000 },
      ]),
    ],
  },
  {
    subject: {
      adapterId: 'glm',
      modelId: 'glm-5.2',
      costTier: 'low',
      availability: 'cheap',
    },
    cases: [
      ...cases('coding', [
        { id: 'c1', pass: 0.88, qualityExtra: 0.85, costUsd: 0.02, durationMs: 22_000 },
        { id: 'c2', pass: 0.85, qualityExtra: 0.82, costUsd: 0.025, durationMs: 25_000 },
        { id: 'c3', pass: 0.9, qualityExtra: 0.86, costUsd: 0.02, durationMs: 20_000 },
        { id: 'c4', pass: 0.85, qualityExtra: 0.8, costUsd: 0.022, durationMs: 23_000 },
        { id: 'c5', pass: 0.88, qualityExtra: 0.84, costUsd: 0.02, durationMs: 21_000 },
      ]),
      ...cases('reasoning', [
        { id: 'r1', pass: 0.8, qualityExtra: 0.78, costUsd: 0.03, durationMs: 28_000 },
        { id: 'r2', pass: 0.78, qualityExtra: 0.75, costUsd: 0.032, durationMs: 30_000 },
        { id: 'r3', pass: 0.82, qualityExtra: 0.78, costUsd: 0.028, durationMs: 27_000 },
        { id: 'r4', pass: 0.75, qualityExtra: 0.72, costUsd: 0.03, durationMs: 29_000 },
        { id: 'r5', pass: 0.8, qualityExtra: 0.76, costUsd: 0.027, durationMs: 26_000 },
      ]),
      ...cases('frontend', [
        { id: 'f1', pass: 0.8, qualityExtra: 0.78, costUsd: 0.018, durationMs: 18_000 },
        { id: 'f2', pass: 0.78, qualityExtra: 0.75, costUsd: 0.02, durationMs: 20_000 },
        { id: 'f3', pass: 0.82, qualityExtra: 0.8, costUsd: 0.019, durationMs: 19_000 },
        { id: 'f4', pass: 0.75, qualityExtra: 0.72, costUsd: 0.018, durationMs: 18_000 },
        { id: 'f5', pass: 0.8, qualityExtra: 0.76, costUsd: 0.02, durationMs: 19_000 },
      ]),
      ...cases('security', [
        { id: 's1', pass: 0.72, qualityExtra: 0.7, costUsd: 0.022, durationMs: 22_000 },
        { id: 's2', pass: 0.7, qualityExtra: 0.68, costUsd: 0.025, durationMs: 24_000 },
        { id: 's3', pass: 0.75, qualityExtra: 0.72, costUsd: 0.02, durationMs: 21_000 },
        { id: 's4', pass: 0.68, qualityExtra: 0.65, costUsd: 0.022, durationMs: 23_000 },
        { id: 's5', pass: 0.72, qualityExtra: 0.7, costUsd: 0.02, durationMs: 20_000 },
      ]),
    ],
  },
  {
    subject: {
      adapterId: 'grok',
      modelId: 'grok-4-fast',
      costTier: 'low',
      availability: 'cheap',
    },
    cases: [
      ...cases('coding', [
        { id: 'c1', pass: 0.7, qualityExtra: 0.65, costUsd: 0.01, durationMs: 12_000 },
        { id: 'c2', pass: 0.65, qualityExtra: 0.6, costUsd: 0.012, durationMs: 14_000 },
        { id: 'c3', pass: 0.72, qualityExtra: 0.68, costUsd: 0.01, durationMs: 11_000 },
        { id: 'c4', pass: 0.68, qualityExtra: 0.62, costUsd: 0.011, durationMs: 13_000 },
        { id: 'c5', pass: 0.7, qualityExtra: 0.65, costUsd: 0.01, durationMs: 12_000 },
      ]),
      ...cases('reasoning', [
        { id: 'r1', pass: 0.6, qualityExtra: 0.55, costUsd: 0.012, durationMs: 15_000 },
        { id: 'r2', pass: 0.55, qualityExtra: 0.5, costUsd: 0.014, durationMs: 16_000 },
        { id: 'r3', pass: 0.62, qualityExtra: 0.58, costUsd: 0.011, durationMs: 14_000 },
        { id: 'r4', pass: 0.58, qualityExtra: 0.52, costUsd: 0.012, durationMs: 15_000 },
        { id: 'r5', pass: 0.6, qualityExtra: 0.55, costUsd: 0.01, durationMs: 13_000 },
      ]),
      ...cases('frontend', [
        { id: 'f1', pass: 0.72, qualityExtra: 0.7, costUsd: 0.01, durationMs: 10_000 },
        { id: 'f2', pass: 0.7, qualityExtra: 0.68, costUsd: 0.011, durationMs: 11_000 },
        { id: 'f3', pass: 0.75, qualityExtra: 0.7, costUsd: 0.01, durationMs: 10_000 },
        { id: 'f4', pass: 0.68, qualityExtra: 0.65, costUsd: 0.01, durationMs: 11_000 },
        { id: 'f5', pass: 0.72, qualityExtra: 0.68, costUsd: 0.011, durationMs: 10_000 },
      ]),
      ...cases('security', [
        { id: 's1', pass: 0.5, qualityExtra: 0.45, costUsd: 0.01, durationMs: 12_000, risk: 0.1 },
        { id: 's2', pass: 0.48, qualityExtra: 0.42, costUsd: 0.012, durationMs: 13_000, risk: 0.1 },
        { id: 's3', pass: 0.52, qualityExtra: 0.48, costUsd: 0.01, durationMs: 11_000 },
        { id: 's4', pass: 0.45, qualityExtra: 0.4, costUsd: 0.011, durationMs: 12_000, risk: 0.15 },
        { id: 's5', pass: 0.5, qualityExtra: 0.45, costUsd: 0.01, durationMs: 11_000 },
      ]),
    ],
  },
  {
    subject: {
      adapterId: 'claude',
      modelId: 'claude-haiku-4-5',
      costTier: 'low',
      availability: 'cheap',
    },
    cases: [
      ...cases('coding', [
        { id: 'c1', pass: 0.75, qualityExtra: 0.72, costUsd: 0.015, durationMs: 15_000 },
        { id: 'c2', pass: 0.72, qualityExtra: 0.7, costUsd: 0.018, durationMs: 17_000 },
        { id: 'c3', pass: 0.78, qualityExtra: 0.74, costUsd: 0.014, durationMs: 14_000 },
        { id: 'c4', pass: 0.7, qualityExtra: 0.68, costUsd: 0.016, durationMs: 16_000 },
        { id: 'c5', pass: 0.75, qualityExtra: 0.7, costUsd: 0.015, durationMs: 15_000 },
      ]),
      ...cases('reasoning', [
        { id: 'r1', pass: 0.65, qualityExtra: 0.6, costUsd: 0.02, durationMs: 18_000 },
        { id: 'r2', pass: 0.62, qualityExtra: 0.58, costUsd: 0.022, durationMs: 20_000 },
        { id: 'r3', pass: 0.68, qualityExtra: 0.62, costUsd: 0.018, durationMs: 17_000 },
        { id: 'r4', pass: 0.6, qualityExtra: 0.55, costUsd: 0.02, durationMs: 19_000 },
        { id: 'r5', pass: 0.65, qualityExtra: 0.6, costUsd: 0.017, durationMs: 16_000 },
      ]),
      ...cases('frontend', [
        { id: 'f1', pass: 0.78, qualityExtra: 0.75, costUsd: 0.012, durationMs: 12_000 },
        { id: 'f2', pass: 0.75, qualityExtra: 0.72, costUsd: 0.014, durationMs: 13_000 },
        { id: 'f3', pass: 0.8, qualityExtra: 0.76, costUsd: 0.012, durationMs: 12_000 },
        { id: 'f4', pass: 0.72, qualityExtra: 0.7, costUsd: 0.013, durationMs: 13_000 },
        { id: 'f5', pass: 0.78, qualityExtra: 0.74, costUsd: 0.012, durationMs: 12_000 },
      ]),
      ...cases('security', [
        { id: 's1', pass: 0.6, qualityExtra: 0.55, costUsd: 0.015, durationMs: 14_000 },
        { id: 's2', pass: 0.55, qualityExtra: 0.52, costUsd: 0.018, durationMs: 16_000 },
        { id: 's3', pass: 0.62, qualityExtra: 0.58, costUsd: 0.014, durationMs: 13_000 },
        { id: 's4', pass: 0.55, qualityExtra: 0.5, costUsd: 0.016, durationMs: 15_000 },
        { id: 's5', pass: 0.6, qualityExtra: 0.55, costUsd: 0.014, durationMs: 14_000 },
      ]),
    ],
  },
];
