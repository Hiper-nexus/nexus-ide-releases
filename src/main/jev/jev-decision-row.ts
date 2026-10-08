import { z } from 'zod';
import type { JevDecisionEntry } from './jev-decision-log';

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
  provider: z.enum(['jev', 'clef', 'luna']).optional().catch(undefined),
  questions: z.array(z.string()).catch([]),
  probabilities: z.record(z.string(), z.number().finite()).catch({}),
  decision: z.string().catch(''),
  inputTokens: finiteOrNull,
  usd: finiteOrNull,
  durationMs: optionalFinite,
  requestCount: optionalFinite,
  feedbackAt: optionalFinite,
  usageIncomplete: z.boolean().optional().catch(undefined),
  feedback: z.enum(['right', 'wrong']).optional().catch(undefined),
});

/** `null` when the line cannot be trusted as a journal row. */
export function parseDecisionRow(raw: unknown): JevDecisionEntry | null {
  const parsed = rowSchema.safeParse(raw);
  return parsed.success ? (parsed.data as unknown as JevDecisionEntry) : null;
}
