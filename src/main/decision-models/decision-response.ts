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
  usage: decisionUsageSchema,
});
const PROBABILITY_SUM_TOLERANCE = 0.001;

function hasDistribution(answer: Exclude<JevAnswer, { type: 'noul' }>, keys: readonly string[]): boolean {
  if (Object.keys(answer.probabilities).length !== keys.length) return false;
  if (keys.some(key => !Object.hasOwn(answer.probabilities, key))) return false;
  const total = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0);
  return Math.abs(total - 1) <= PROBABILITY_SUM_TOLERANCE;
}

function matchesQuestion(answer: JevAnswer, question: JevQuestion): boolean {
  if (answer.type !== question.type) return false;
  if (answer.type === 'noul') return true;
  if (answer.type === 'choice' && question.type === 'choice') {
    return Object.hasOwn(question.criteria, answer.choice) && hasDistribution(answer, Object.keys(question.criteria));
  }
  if (answer.type === 'score' && question.type === 'score') {
    const keys = question.criteria.map((_level, index) => String(index));
    return answer.score >= 0 && answer.score <= keys.length - 1 && hasDistribution(answer, keys)
      && keys.every(key => Object.hasOwn(answer.legend, key));
  }
  return false;
}

/** Typed output is accepted only when every requested judgment is supported. */
export function validateDecisionResponse(data: unknown, questions: Record<string, JevQuestion>): JevResult | null {
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success) return null;
  const entries = Object.entries(questions);
  if (Object.keys(parsed.data.answers).length !== entries.length) return null;
  if (entries.some(([id, question]) => !parsed.data.answers[id] || !matchesQuestion(parsed.data.answers[id], question))) return null;
  return parsed.data;
}
