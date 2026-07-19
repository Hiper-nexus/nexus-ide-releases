/**
 * Public LLM ranking contract — shared by main, renderer, and future landing page.
 * No auth, secrets, or user-private state. Schema version is intentional for publish.
 */

import type { ModelCostTier } from './adapter-types';

/** Bump when the public JSON shape breaks consumers (landing, external tools). */
export const PUBLIC_MODEL_RANKING_SCHEMA_VERSION = 1 as const;

export const EVAL_RANKING_CHANNELS = {
  /** invoke → PublicModelRankingSnapshot (public, no secrets). */
  publicRanking: 'eval:public-ranking',
} as const;

export type RankingQualityDimension =
  | 'overall'
  | 'coding'
  | 'reasoning'
  | 'frontend'
  | 'security';

export interface PublicModelRankingEntry {
  /** Stable key for lists: adapterId/modelId */
  id: string;
  adapterId: string;
  modelId: string;
  overall: number;
  coding?: number;
  reasoning?: number;
  frontend?: number;
  security?: number;
  costTier?: ModelCostTier;
  availability?: string;
  evaluatedAt: string;
  /** Always nexus-eval/... when produced by the Nexus pipeline. */
  source: string;
  /** 0..1 confidence from case count. */
  confidence?: number;
  rank?: number;
  /**
   * True when scores come from offline fixtures, not a real benchmark audit.
   * Fixture-derived entries must never pose as audited results; a future real
   * evaluation (source revision != fixture) never carries this mark.
   */
  estimate?: boolean;
  /** Human-readable source label for the UI badge (e.g. 'estimativa (fixture)'). */
  sourceLabel?: string;
}

export interface PublicModelRankingSnapshot {
  schemaVersion: typeof PUBLIC_MODEL_RANKING_SCHEMA_VERSION;
  /** ISO time when this snapshot was assembled. */
  generatedAt: string;
  /** Suite id that produced scores (e.g. v1). */
  suiteId: string;
  /** Git-ish or fixture tag in source path. */
  suiteRevision: string;
  /** Public-safe description for landing page copy. */
  description: string;
  entries: PublicModelRankingEntry[];
}
