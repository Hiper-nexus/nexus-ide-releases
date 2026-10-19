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
  /** invoke → ModelComparisonSnapshot (Ajustes → Comparar modelos, F-1588). */
  modelComparison: 'eval:model-comparison',
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

/**
 * Ajustes → Comparar modelos (F-1588). Só número que existe: o benchmark
 * oficial publicado pelo fabricante (a mesma tabela que a escolha automática
 * usa, F-675) ou uma avaliação medida pelo Nexus. A fixture offline do
 * `nexus-eval` não entra: ela foi escrita à mão e nunca mediu modelo nenhum.
 */
export type ModelComparisonCli = 'ready' | 'disabled' | 'missing';

/** Benchmarks publicados, em %, como o fabricante divulgou. */
export interface ModelComparisonBenchmarks {
  deepSWE?: number;
  terminalBench21?: number;
  swebenchVerified?: number;
}

/**
 * De quem são os números: do próprio modelo, de uma variante de esforço ou
 * contexto, do mesmo modelo servido por outro id, ou do antecessor da linha
 * (piso da regra "modelo mais novo sempre").
 */
export type ModelComparisonOrigin = 'own' | 'variant' | 'same-model' | 'predecessor';

export interface ModelComparisonMeasured {
  overall: number;
  coding?: number;
  reasoning?: number;
  frontend?: number;
  security?: number;
  evaluatedAt: string;
}

export interface ModelComparisonEntry {
  /** `adapterId/modelId`. */
  id: string;
  adapterId: string;
  adapterLabel: string;
  modelId: string;
  /** CLI instalada e ligada (`ready`), desligada em Providers ou ausente. */
  cli: ModelComparisonCli;
  costTier?: ModelCostTier;
  availability?: string;
  /** 0..100: nota medida, ou a média normalizada dos benchmarks publicados. */
  score: number | null;
  scoreKind: 'measured' | 'published' | 'none';
  benchmarks: ModelComparisonBenchmarks;
  measured?: ModelComparisonMeasured;
  /** URL (ou nome do documento) da fonte primária dos números. */
  source?: string;
  origin?: ModelComparisonOrigin;
  /** Id do modelo dono dos números quando não é este (`origin` ≠ `own`). */
  numbersFrom?: string;
}

export interface ModelComparisonSnapshot {
  generatedAt: string;
  entries: ModelComparisonEntry[];
  /** Versões antigas fora da lista porque a mesma linha tem versão mais nova. */
  olderVersionsHidden: number;
}
