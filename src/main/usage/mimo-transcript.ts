import { z } from 'zod';
import type { UsageRecord } from './usage-store';

const count = z.number().int().nonnegative().safe();
const id = z.string().min(1).max(256);
const rowSchema = z.object({ id, session_id: id, data: z.string().max(1_048_576) });
const assistantSchema = z.object({
  role: z.literal('assistant'), modelID: id, providerID: id,
  path: z.object({ cwd: z.string().min(1).max(4096) }),
  time: z.object({ created: count }), cost: z.number().finite().nonnegative(),
  tokens: z.object({ input: count, output: count, reasoning: count,
    cache: z.object({ read: count, write: count }),
  }),
});

/** Official SQLite message.data fields; no prompt or response content escapes. */
export function parseMimoUsageRow(raw: unknown): { event: UsageRecord; cwd: string } | null {
  const row = rowSchema.safeParse(raw);
  if (!row.success) return null;
  try {
    const parsed = assistantSchema.safeParse(JSON.parse(row.data.data));
    if (!parsed.success) return null;
    const value = parsed.data;
    const outputTokens = value.tokens.output + value.tokens.reasoning;
    const model = `${value.providerID}/${value.modelID}`;
    if (!Number.isSafeInteger(outputTokens) || model.length > 256) return null;
    return { cwd: value.path.cwd, event: {
      sessionId: row.data.session_id, messageId: row.data.id,
      model,
      inputTokens: value.tokens.input, outputTokens,
      cacheReadTokens: value.tokens.cache.read,
      // The legacy store has two cache-write buckets. MiMo reports no TTL;
      // this preserves its count, while reportedCostUsd avoids a guessed tariff.
      cacheWrite5mTokens: value.tokens.cache.write, cacheWrite1hTokens: 0,
      timestamp: value.time.created, reportedCostUsd: value.cost,
    } };
  } catch { return null; }
}
