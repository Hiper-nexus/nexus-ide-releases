import { z } from 'zod';
import type { JevDecisionEntry, JevNoAnswerReason } from './jev-decision-log';

/** Todos os motivos conhecidos — o parser do diário aceita só estes. */
export const JEV_NO_ANSWER_REASONS = [
  'timeout', 'rate-limited', 'client-error', 'server-error', 'network', 'malformed', 'aborted',
  'internal-error', 'refusal', 'ambiguous', 'divergent', 'budget',
] as const satisfies readonly JevNoAnswerReason[];

// Todo motivo do tipo precisa estar na lista (senão o parser apagaria o motivo novo).
type MissingReason = Exclude<JevNoAnswerReason, typeof JEV_NO_ANSWER_REASONS[number]>;
const everyReasonListed: [MissingReason] extends [never] ? true : never = true;
void everyReasonListed;

const finiteOrNull = z.number().finite().nullable().catch(null);
const optionalFinite = z.number().finite().optional().catch(undefined);

/**
 * One JSONL line of the decision journal. The file is hand-editable and survives
 * app versions, so every field is checked on read: a bad optional field degrades
 * to "unknown", a bad identity field drops the row. Unknown keys are kept so a
 * feedback rewrite never erases data written by a newer version.
 */
const rowSchema = z.looseObject({
  id: z.string().min(1),
  at: z.number().finite(),
  surface: z.string().min(1),
  model: z.string().min(1),
  kind: z.enum(['decision', 'no-answer', 'optimization']).optional().catch(undefined),
  /** Motivo desconhecido (versão futura, edição à mão) vira ausente; a linha continua. */
  reason: z.enum(JEV_NO_ANSWER_REASONS).optional().catch(undefined),
  provider: z.enum(['jev', 'clef', 'luna']).optional().catch(undefined),
  questions: z.array(z.string()).catch([]),
  probabilities: z.record(z.string(), z.number().finite()).catch({}),
  decision: z.string().catch(''),
  inputTokens: finiteOrNull,
  usd: finiteOrNull,
  /** F-1164: cobrado pelo livro de orçamento; ausente em linhas antigas. */
  budgetChargedUsd: z.number().finite().min(0).optional().catch(undefined),
  durationMs: optionalFinite,
  requestCount: optionalFinite,
  feedbackAt: optionalFinite,
  usageIncomplete: z.boolean().optional().catch(undefined),
  diverged: z.boolean().optional().catch(undefined),
  ensemblePeers: z.record(z.string(), z.record(z.string(), z.number().finite())).optional().catch(undefined),
  feedback: z.enum(['right', 'wrong']).optional().catch(undefined),
});

/** `null` when the line cannot be trusted as a journal row. */
export function parseDecisionRow(raw: unknown): JevDecisionEntry | null {
  const parsed = rowSchema.safeParse(raw);
  return parsed.success ? (parsed.data as unknown as JevDecisionEntry) : null;
}
