import { JEV_CALIBRATED_MODEL, LUNA_DECISION_MODEL, type DecisionImage, type DecisionUsageReceipt } from '../../shared/decision-models';
import type { JevNoAnswerReason } from '../jev/jev-decision-log';
import type { JudgeInput, JevAnswer, JevQuestion, JevResult } from '../jev/jev-client';
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import { decisionResultUsage } from './decision-usage';
import { z } from 'zod';

/** A Luna entra na avaliação (F-1165): a tabela de qualidade do roteador compara os cinco. */
export const DECISION_EVAL_MODELS = ['jev', 'clef', 'clef-flash', 'clef-omni', 'luna'] as const;
export type DecisionEvalModel = typeof DECISION_EVAL_MODELS[number];

/**
 * Id que o funil de decisão reconhece para cada chave da avaliação. `luna`
 * sozinho seria lido como modelo do Jev: a chave vira LUNA_DECISION_MODEL.
 */
export function decisionEvalModelId(model: DecisionEvalModel): string {
  if (model === 'luna') return LUNA_DECISION_MODEL;
  if (model === 'jev') return process.env.NEXUS_JEV_MODEL ?? JEV_CALIBRATED_MODEL;
  return model;
}
type Expected = string | boolean | { min: number; max: number };
export interface DecisionEvalCase {
  id: string; surface: JevDecisionSurface; split: 'development' | 'heldout';
  state: unknown; questions: Record<string, JevQuestion>; expected: Record<string, Expected>;
  consequential?: boolean; images?: readonly DecisionImage[];
}
export type EvalJudge = (model: DecisionEvalModel, input: JudgeInput) => Promise<JevResult | null>;
const instructionsSchema = z.union([z.string().min(1).max(4_000), z.object({ question: z.string().min(1).max(4_000) }).passthrough()]);
const evalQuestionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: instructionsSchema, criteria: z.object({ true: z.string(), false: z.string() }).optional() }),
  z.object({ type: z.literal('choice'), instructions: instructionsSchema, criteria: z.record(z.string(), z.string().nullable()) }),
  z.object({ type: z.literal('score'), instructions: instructionsSchema, criteria: z.array(z.string()).min(2).max(10) }),
]);
export const decisionEvalCasesSchema = z.array(z.object({
  id: z.string().min(1).max(100), surface: z.enum(['toolPick', 'intake', 'judgeTool', 'paneState', 'handoffReview', 'dispatchGuard', 'researchTriage', 'browserTool', 'delegation', 'taskRouting', 'rankTool', 'terminalTriage', 'memoryDistill', 'helperReuse', 'businessModel',
    // F-1167: surfaces consultivas da missão (F-1166) e as reversíveis do Automático entram na calibração.
    'missionKickoff', 'reviewTriage', 'recoveryAdvice', 'completionCheck', 'missionPick', 'catalogPick']),
  split: z.enum(['development', 'heldout']), state: z.unknown(),
  questions: z.record(z.string(), evalQuestionSchema),
  expected: z.record(z.string(), z.union([z.string(), z.boolean(), z.object({ min: z.number(), max: z.number() })])),
  consequential: z.boolean().optional(),
  images: z.array(z.object({ content_type: z.enum(['image/png', 'image/jpeg', 'image/webp']), base64: z.string() })).max(4).optional(),
}).refine(testCase => {
  const questionIds = Object.keys(testCase.questions);
  const labels = Object.entries(testCase.expected);
  return questionIds.length > 0 && labels.length === questionIds.length && labels.every(([id, expected]) =>
    questionIds.includes(id) && (typeof expected !== 'object' || expected.min <= expected.max));
}, 'Every question needs a valid reference label.')) .min(1).max(1_000)
  .refine(cases => new Set(cases.map(testCase => testCase.id)).size === cases.length, 'Case IDs must be unique.');
export interface EvalObservation {
  caseId: string; surface: string; split: 'development' | 'heldout'; requestedModel: DecisionEvalModel;
  model?: string; status: 'answered' | 'failed' | 'unsupported'; correct: boolean | null;
  /** Motivo categórico da falha (onNoAnswer); ausente = sem motivo (exceção, sem chave). */
  failureReason?: JevNoAnswerReason;
  consequential: boolean; durationMs: number | null; usd: number | null; inputTokens: number | null;
  /** Absent means unmeasured, not one HTTP request per evaluation case. */
  requestCount?: number;
  usageIncomplete?: boolean;
}
interface SplitScore { cases: number; correct: number; accuracy: number | null; consequentialErrors: number }
interface ModelScore {
  answered: number; failures: number; unsupported: number; usd: number | null;
  p50Ms: number | null; p95Ms: number | null; development: SplitScore; heldout: SplitScore;
}
export interface DecisionEvalReport {
  models: Record<DecisionEvalModel, ModelScore>;
  observations: EvalObservation[];
}

function matches(answer: JevAnswer | undefined, expected: Expected): boolean {
  if (!answer) return false;
  if (typeof expected === 'string') return answer.type === 'choice' && answer.choice === expected;
  if (typeof expected === 'boolean') return answer.type === 'noul' && (answer.noul >= 0.5) === expected;
  const value = answer.type === 'noul' ? answer.noul : answer.type === 'score' ? answer.score : NaN;
  return Number.isFinite(value) && value >= expected.min && value <= expected.max;
}

async function observe(testCase: DecisionEvalCase, requestedModel: DecisionEvalModel, judge: EvalJudge): Promise<EvalObservation> {
  const base = { caseId: testCase.id, surface: testCase.surface, split: testCase.split, requestedModel,
    consequential: Boolean(testCase.consequential), correct: null, durationMs: null, usd: null, inputTokens: null };
  if (requestedModel === 'jev' && testCase.images?.length) return { ...base, status: 'unsupported' };
  const started = performance.now();
  let failureReason: JevNoAnswerReason | undefined;
  let failureUsage: DecisionUsageReceipt | undefined;
  const failed = (): EvalObservation => ({ ...base, status: 'failed',
    durationMs: performance.now() - started, usageIncomplete: true,
    ...failureUsage, ...(failureReason ? { failureReason } : {}) });
  try {
    const result = await judge(requestedModel, { state: testCase.state, questions: testCase.questions, images: testCase.images,
      onNoAnswer: reason => { failureReason ??= reason; }, onUsage: receipt => { failureUsage = receipt; } });
    if (!result) return failed();
    const correct = Object.entries(testCase.expected).every(([id, expected]) => matches(result.answers[id], expected));
    const measured = decisionResultUsage(result);
    return { ...base, status: 'answered', correct, model: result.model,
      durationMs: measured.durationMs ?? performance.now() - started,
      inputTokens: measured.inputTokens, usd: measured.usd,
      requestCount: measured.requestCount, usageIncomplete: measured.usageIncomplete ?? false };
  } catch { return failed(); }
}

function splitScore(rows: readonly EvalObservation[], split: DecisionEvalCase['split']): SplitScore {
  const eligible = rows.filter(row => row.split === split && row.status !== 'unsupported');
  const correct = eligible.filter(row => row.correct === true).length;
  return { cases: eligible.length, correct, accuracy: eligible.length ? correct / eligible.length : null,
    consequentialErrors: eligible.filter(row => row.consequential && row.correct !== true).length };
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function modelScore(rows: readonly EvalObservation[]): ModelScore {
  const eligible = rows.filter(row => row.status !== 'unsupported');
  const answered = eligible.filter(row => row.status === 'answered');
  const durations = answered.flatMap(row => row.durationMs === null ? [] : [row.durationMs]);
  return { answered: answered.length, failures: eligible.length - answered.length, unsupported: rows.length - eligible.length,
    usd: eligible.some(row => row.usd === null || row.usageIncomplete) ? null : eligible.reduce((sum, row) => sum + row.usd!, 0),
    p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
    development: splitScore(rows, 'development'), heldout: splitScore(rows, 'heldout') };
}

/**
 * Reference labels and input payloads never enter the report or the provider request.
 * `only` restringe quem é consultado (ex.: só quem tem credencial); os demais
 * ficam sem observação e, na tabela de qualidade, seguem no prior.
 */
export async function evaluateDecisionCases(
  cases: readonly DecisionEvalCase[], judge: EvalJudge, only: readonly DecisionEvalModel[] = DECISION_EVAL_MODELS,
  signal?: AbortSignal,
): Promise<DecisionEvalReport> {
  const observations: EvalObservation[] = [];
  const consulted = DECISION_EVAL_MODELS.filter(model => only.includes(model));
  // Cancelado: para entre consultas (a que está em voo é abortada pelo próprio sinal).
  for (const testCase of cases) {
    for (const model of consulted) {
      if (signal?.aborted) break;
      observations.push(await observe(testCase, model, judge));
    }
  }
  const models = Object.fromEntries(DECISION_EVAL_MODELS.map(model => [model,
    modelScore(observations.filter(row => row.requestedModel === model))])) as Record<DecisionEvalModel, ModelScore>;
  return { models, observations };
}
