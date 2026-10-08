import { z } from 'zod';
import type { DecisionProvider, DecisionRoute } from './decision-models';

/** Variável de ambiente da chave TypeSafe (espelha o CLI `jev`). */
export const JEV_ENV_VAR = 'TYPESAFE_API_KEY';

export const setJevKeyRequestSchema = z.object({
  /** Empty string clears the stored key. */
  key: z.string().max(512),
});

export type SetJevKeyRequest = z.infer<typeof setJevKeyRequestSchema>;

/** Status sem segredo — presença apenas, nunca o valor da chave. */
export interface JevStatus {
  hasStoredKey: boolean;
  hasEnv: boolean;
  keyMasked: string | null;
  secureStorageAvailable: boolean;
  autopilot: boolean;
  model: string;
  stats: {
    calls: number;
    failures: number;
    inputTokens: number;
    estimatedUsd: number;
  };
}

export interface JevTestResult {
  ok: boolean;
  detail: string;
}

export const jevDecisionsListRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  surface: z.string().max(64).optional(),
  /** Inclui consultas sem resposta (kind 'no-answer'). Default: só decisões. */
  includeNoAnswer: z.boolean().optional(),
});

export const jevDecisionFeedbackRequestSchema = z.object({
  id: z.string().uuid(),
  verdict: z.enum(['right', 'wrong']),
});

/** Uma linha do diário de decisões — nunca contém texto do state. */
export interface JevDecisionRow {
  id: string;
  at: number;
  /** 'no-answer' = consulta sem resposta (ausente em linhas antigas = decisão). */
  kind?: 'decision' | 'no-answer';
  reason?:
    | 'timeout'
    | 'rate-limited'
    | 'client-error'
    | 'server-error'
    | 'network'
    | 'malformed'
    | 'aborted'
    | 'internal-error'
    | 'refusal'
    | 'ambiguous'
    | 'divergent';
  surface: string;
  sessionId?: string;
  missionId?: string;
  model: string;
  provider?: DecisionProvider;
  route?: DecisionRoute;
  durationMs?: number;
  requestCount?: number;
  questions: string[];
  probabilities: Record<string, number>;
  confidence?: Record<string, number>;
  decision: string;
  /** `null` nas linhas sem resposta — métrica ausente, nunca zero fabricado. */
  inputTokens: number | null;
  usd: number | null;
  feedback?: 'right' | 'wrong';
  feedbackAt?: number;
  optimization?: JevOptimizationEvidence;
}

/** Mechanical evidence, never a claim about billed LLM tokens. */
export interface JevOptimizationEvidence {
  jevRequestsAvoided?: number;
  llmRoutingBypassed?: boolean;
  /** UTF-8 bytes before/after passage selection, before JSON/outline formatting. */
  contextBytesBefore?: number;
  contextBytesAfter?: number;
}

export interface JevOptimizationStats {
  observations: number;
  jevRequestsAvoided: number;
  llmRoutingBypassed: number;
  contextSelections: number;
  contextBytesBefore: number;
  contextBytesAfter: number;
}

export interface JevWindowStatsResult {
  consultations: number;
  answered: number;
  noAnswer: number;
  usd: number;
  inputTokens: number;
  optimization?: JevOptimizationStats;
}

export interface JevDecisionStatsResult {
  byProvider?: Record<string, DecisionUsageStats>;
  byModel?: Record<string, DecisionUsageStats>;
  /** calls = decisões respondidas; noAnswer = consultas sem resposta. */
  totals: { calls: number; usd: number; inputTokens: number; noAnswer: number };
  windows: {
    today: JevWindowStatsResult;
    last30d: JevWindowStatsResult;
    allTime: JevWindowStatsResult;
  };
  bySurface: Record<
    string,
    {
      calls: number;
      usd: number;
      noAnswer: number;
      /** jev = decisões respondidas na janela; rule = quedas p/ a regra. */
      last30d: { jev: number; rule: number; usd: number };
      decisions: Record<string, number>;
      feedback: { right: number; wrong: number };
      suggestion?: string;
      optimization?: JevOptimizationStats;
    }
  >;
  pricing: { usdPerInputToken: number; source: 'typesafe-published' };
}

export interface DecisionUsageStats {
  incompleteUsageCalls?: number;
  calls: number;
  noAnswer: number;
  inputTokens: number;
  usd: number;
  /** Soma só das linhas medidas; `null` quando nenhuma linha mediu tentativas HTTP. */
  requests: number | null;
  durationMs: number | null;
  /** Linhas com tentativas medidas × linhas antigas sem medição (contadas à parte, nunca somadas como zero). */
  measuredRows: number;
  legacyRows: number;
}

/** Hint do classificador Jev de estado do pane (surface `paneState`). */
export interface JevPaneHint {
  state: 'working' | 'waiting_for_human' | 'finished' | 'errored' | 'idle_prompt';
  confidence: number;
  needsHuman: number;
  at: number;
  model: string;
}

/** Payload do push `jev:paneHint` (main → renderer). */
export interface JevPaneHintEvent {
  sessionId: string;
  paneId?: string;
  hint: JevPaneHint;
}
