import { LUNA_DECISION_MODEL } from '../../shared/decision-models';
import type { JevAnswer, JevQuestion, JevQuestionInstructions, JevResult } from '../jev/jev-client';
import type { JevNoAnswerReason } from '../jev/jev-decision-log';
import { JEV_RESPONSE_POLICY, validateDecisionResponse } from './decision-response';

export type LunaMapFailure = Extract<JevNoAnswerReason, 'malformed' | 'ambiguous' | 'refusal'>;

function instructionsText(instructions: JevQuestionInstructions): string {
  return typeof instructions === 'string' ? instructions : JSON.stringify(instructions);
}

/** Pergunta do contrato Jev no formato da Decisions API. `null` quando não cabe no contrato. */
export function toLunaQuestion(name: string, question: JevQuestion): Record<string, unknown> | null {
  const instructions = instructionsText(question.instructions).trim();
  if (!instructions) return null;
  if (question.type === 'noul') return { type: 'predicate', name, instructions };
  if (question.type === 'choice') {
    const choices = Object.entries(question.criteria);
    if (choices.length < 2 || choices.length > 255) return null;
    return { type: 'choice', name, instructions, choices: choices.map(([value, description]) => ({ value, description: description ?? value })) };
  }
  if (question.criteria.length < 2 || question.criteria.length > 10) return null;
  return { type: 'score', name, instructions, levels: question.criteria.map((label, index) => ({
    label: label || String(index), description: label || String(index),
  })) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readUsage(value: unknown): { input_tokens: number; output_tokens: number } | null {
  if (!isRecord(value) || typeof value.input_tokens !== 'number' || !Number.isInteger(value.input_tokens) || value.input_tokens < 0) return null;
  const output = value.output_tokens;
  const outputTokens = typeof output === 'number' && Number.isInteger(output) && output >= 0 ? output : 0;
  return { input_tokens: value.input_tokens, output_tokens: outputTokens };
}

function probabilityList(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(isRecord) ? value : null;
}

function mapOne(answer: Record<string, unknown>, question: JevQuestion): JevAnswer | null {
  if (question.type === 'noul') {
    return answer.type === 'predicate' && typeof answer.probability === 'number' ? { type: 'noul', noul: answer.probability } : null;
  }
  if (typeof answer.confidence !== 'number') return null;
  const rows = probabilityList(answer.probabilities);
  if (!rows) return null;
  if (question.type === 'choice') {
    if (answer.type !== 'choice' || typeof answer.choice !== 'string') return null;
    const probabilities: Record<string, number> = {};
    for (const row of rows) {
      if (typeof row.value !== 'string' || typeof row.probability !== 'number' || Object.hasOwn(probabilities, row.value)) return null;
      probabilities[row.value] = row.probability;
    }
    return { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities };
  }
  if (answer.type !== 'score' || typeof answer.score !== 'number') return null;
  const probabilities: Record<string, number> = {};
  for (const row of rows) {
    if (typeof row.value !== 'number' || !Number.isInteger(row.value) || typeof row.probability !== 'number') return null;
    const key = String(row.value);
    if (Object.hasOwn(probabilities, key)) return null;
    probabilities[key] = row.probability;
  }
  return { type: 'score', score: answer.score, confidence: answer.confidence, probabilities,
    legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])) };
}

/**
 * Converte a resposta da Decisions API para o contrato Jev.
 * Recusa de qualquer resposta derruba a chamada inteira — nunca vira noul 0.
 * A legenda do score é a nossa, pelo índice, não o rótulo ecoado pelo modelo.
 */
export function mapLunaResponse(data: unknown, questions: Record<string, JevQuestion>, ids: ReadonlyMap<string, string>):
  { ok: true; result: JevResult; usage: { input_tokens: number; output_tokens: number } | null } | { ok: false; reason: LunaMapFailure } {
  if (!isRecord(data) || !Array.isArray(data.answers)) return { ok: false, reason: 'malformed' };
  if (data.model !== undefined && data.model !== LUNA_DECISION_MODEL) return { ok: false, reason: 'malformed' };
  if (data.answers.some(answer => isRecord(answer) && answer.type === 'refusal')) return { ok: false, reason: 'refusal' };
  if (data.answers.some(answer => !isRecord(answer) || typeof answer.name !== 'string' || typeof answer.type !== 'string')) {
    return { ok: false, reason: 'malformed' };
  }
  if (data.answers.length !== ids.size) return { ok: false, reason: 'ambiguous' };
  const answers: Record<string, JevAnswer> = {};
  for (const raw of data.answers) {
    const answer = raw as Record<string, unknown>;
    const original = ids.get(answer.name as string);
    const question = original ? questions[original] : undefined;
    if (!question || answers[original!]) return { ok: false, reason: 'ambiguous' };
    const mapped = mapOne(answer, question);
    if (!mapped) return { ok: false, reason: 'ambiguous' };
    answers[original!] = mapped;
  }
  const usage = readUsage(data.usage);
  const validated = validateDecisionResponse(usage
    ? { model: LUNA_DECISION_MODEL, answers, usage }
    : { model: LUNA_DECISION_MODEL, answers }, questions, JEV_RESPONSE_POLICY);
  if (!validated) return { ok: false, reason: 'ambiguous' };
  return { ok: true, result: { ...validated, model: LUNA_DECISION_MODEL }, usage };
}
