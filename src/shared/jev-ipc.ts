import { z } from 'zod';

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
});

export const jevDecisionFeedbackRequestSchema = z.object({
  id: z.string().uuid(),
  verdict: z.enum(['right', 'wrong']),
});

/** Uma linha do diário de decisões — nunca contém texto do state. */
export interface JevDecisionRow {
  id: string;
  at: number;
  surface: string;
  sessionId?: string;
  missionId?: string;
  model: string;
  questions: string[];
  probabilities: Record<string, number>;
  confidence?: Record<string, number>;
  decision: string;
  inputTokens: number;
  usd: number;
  feedback?: 'right' | 'wrong';
  feedbackAt?: number;
}

export interface JevDecisionStatsResult {
  totals: { calls: number; usd: number; inputTokens: number };
  bySurface: Record<
    string,
    {
      calls: number;
      usd: number;
      decisions: Record<string, number>;
      feedback: { right: number; wrong: number };
      suggestion?: string;
    }
  >;
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
