import type { DecisionImage } from '../../shared/decision-models';
import type { JudgeInput, JevAnswer, JevQuestion, JevResult } from '../jev/jev-client';
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import { decisionResultUsage } from './decision-usage';
import { z } from 'zod';

export const DECISION_EVAL_MODELS = ['jev', 'clef', 'clef-flash'] as const;
export type DecisionEvalModel = typeof DECISION_EVAL_MODELS[number];
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
  id: z.string().min(1).max(100), surface: z.enum(['toolPick', 'intake', 'judgeTool', 'paneState', 'handoffReview', 'dispatchGuard', 'researchTriage', 'browserTool', 'delegation', 'taskRouting', 'rankTool', 'terminalTriage', 'memoryDistill', 'helperReuse', 'businessModel']),
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
interface EvalObservation {
  caseId: string; surface: string; split: 'development' | 'heldout'; requestedModel: DecisionEvalModel;
  model?: string; status: 'answered' | 'failed' | 'unsupported'; correct: boolean | null;
  consequential: boolean; durationMs: number | null; usd: number | null; inputTokens: number | null;
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
  try {
    const result = await judge(requestedModel, { state: testCase.state, questions: testCase.questions, images: testCase.images });
    if (!result) return { ...base, status: 'failed' };
    const correct = Object.entries(testCase.expected).every(([id, expected]) => matches(result.answers[id], expected));
    const measured = decisionResultUsage(result);
    return { ...base, status: 'answered', correct, model: result.model,
      durationMs: result.durationMs ?? performance.now() - started,
      inputTokens: measured.inputTokens, usd: measured.usd };
  } catch { return { ...base, status: 'failed' }; }
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
    usd: eligible.some(row => row.usd === null) ? null : eligible.reduce((sum, row) => sum + row.usd!, 0),
    p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
    development: splitScore(rows, 'development'), heldout: splitScore(rows, 'heldout') };
}

/** Reference labels and input payloads never enter the report or the provider request. */
export async function evaluateDecisionCases(cases: readonly DecisionEvalCase[], judge: EvalJudge): Promise<DecisionEvalReport> {
  const observations: EvalObservation[] = [];
  for (const testCase of cases) {
    for (const model of DECISION_EVAL_MODELS) observations.push(await observe(testCase, model, judge));
  }
  const models = Object.fromEntries(DECISION_EVAL_MODELS.map(model => [model,
    modelScore(observations.filter(row => row.requestedModel === model))])) as Record<DecisionEvalModel, ModelScore>;
  return { models, observations };
}
