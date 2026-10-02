import { z } from 'zod';
import type { JevQuestion, JevResult, JevAnswer } from '../jev/jev-client';

const probability = z.number().min(0).max(1);
export const decisionUsageSchema = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() });
const probabilities = z.record(z.string(), probability);
const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities, confidence: probability }),
  z.object({ type: z.literal('score'), score: z.number(), legend: z.record(z.string(), z.string()), probabilities, confidence: probability }),
]);
const resultSchema = z.object({
  model: z.string().min(1).max(100),
  answers: z.record(z.string(), answerSchema),
  usage: decisionUsageSchema.optional(),
});

/** What each provider is held to. Clef is strict; Jev keeps the tolerance its production API has always had. */
export interface DecisionResponsePolicy { readonly sumTolerance: number; readonly usageRequired: boolean }
export const CLEF_RESPONSE_POLICY: DecisionResponsePolicy = { sumTolerance: 0.001, usageRequired: true };
/** Measured 01/10/2026 against the real API: sums were exactly 1 and `usage` present; the slack is rounding insurance. */
export const JEV_RESPONSE_POLICY: DecisionResponsePolicy = { sumTolerance: 0.02, usageRequired: false };

function hasDistribution(answer: Exclude<JevAnswer, { type: 'noul' }>, keys: readonly string[], tolerance: number): boolean {
  if (Object.keys(answer.probabilities).length !== keys.length) return false;
  if (keys.some(key => !Object.hasOwn(answer.probabilities, key))) return false;
  const total = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0);
  return Math.abs(total - 1) <= tolerance;
}

function matchesQuestion(answer: JevAnswer, question: JevQuestion, tolerance: number): boolean {
  if (answer.type !== question.type) return false;
  if (answer.type === 'noul') return true;
  if (answer.type === 'choice' && question.type === 'choice') {
    return Object.hasOwn(question.criteria, answer.choice) && hasDistribution(answer, Object.keys(question.criteria), tolerance);
  }
  if (answer.type === 'score' && question.type === 'score') {
    const keys = question.criteria.map((_level, index) => String(index));
    return answer.score >= 0 && answer.score <= keys.length - 1 && hasDistribution(answer, keys, tolerance)
      && keys.every(key => Object.hasOwn(answer.legend, key));
  }
  return false;
}

/**
 * Typed output is accepted only when every requested judgment is supported.
 * Missing Jev `usage` stays unknown (`usageMissing`), never a measured zero.
 */
export function validateDecisionResponse(
  data: unknown, questions: Record<string, JevQuestion>, policy: DecisionResponsePolicy = CLEF_RESPONSE_POLICY,
): JevResult | null {
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success) return null;
  if (!parsed.data.usage && policy.usageRequired) return null;
  const entries = Object.entries(questions);
  if (Object.keys(parsed.data.answers).length !== entries.length) return null;
  if (entries.some(([id, question]) => !parsed.data.answers[id] || !matchesQuestion(parsed.data.answers[id], question, policy.sumTolerance))) return null;
  const { usage, ...rest } = parsed.data;
  return usage ? { ...rest, usage } : { ...rest, usage: { input_tokens: 0, output_tokens: 0 }, usageMissing: true };
}
