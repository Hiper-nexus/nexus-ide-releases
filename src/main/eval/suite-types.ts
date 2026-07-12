/**
 * Internal eval suite types — pure data, no Electron.
 */

export type EvalDimension = 'coding' | 'reasoning' | 'frontend' | 'security';

export interface EvalCaseResult {
  caseId: string;
  dimension: EvalDimension;
  /** 0 = fail, 1 = full pass; partial credit allowed. */
  pass: number;
  /** Optional extra quality 0..1 (style, minimal diff, no thrash). */
  qualityExtra?: number;
  /** USD spent on this case (absolute). */
  costUsd?: number;
  /** Wall time ms. */
  durationMs?: number;
  /** 0..1 risk penalty (secrets, scope escape). */
  risk?: number;
}

export interface ModelEvalSubject {
  adapterId: string;
  modelId: string;
  costTier?: 'free' | 'low' | 'medium' | 'high' | 'unknown';
  availability?: string;
}

export interface ModelCaseBundle {
  subject: ModelEvalSubject;
  cases: EvalCaseResult[];
}

export interface EvalSuiteMeta {
  suiteId: string;
  /** Appears in quality.source as nexus-eval/<suiteId>/<suiteRevision> */
  suiteRevision: string;
  evaluatedAt: string;
  nMinPerDimension?: number;
}

export interface DimensionAggregate {
  dimension: EvalDimension;
  score: number;
  caseCount: number;
  confidence: number;
}

export interface ModelRankResult {
  subject: ModelEvalSubject;
  overall: number;
  coding?: number;
  reasoning?: number;
  frontend?: number;
  security?: number;
  confidence: number;
  caseCount: number;
  dimensions: DimensionAggregate[];
  evaluatedAt: string;
  source: string;
}
