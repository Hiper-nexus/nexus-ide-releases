import { z } from 'zod';
import type { UsageRecord } from './usage-store';

export const MIMO_SCAN_ROWS = 128;
export const MIMO_RAW_ROW_BYTES = 65_536;
export const MIMO_RESULT_BYTES = 256 * 1_024;
const integer = z.number().int().nonnegative().safe();
const id = z.string().min(1).max(256);
const runtime = z.object({ checkoutId: z.string().min(1).max(128), cwd: z.string().min(1).max(4096),
  stateRoot: z.string().min(1).max(4096), databasePath: z.string().min(1).max(4096) }).strict();
const cursor = z.object({ at: integer, id: z.string().max(256) }).strict();
export const mimoWorkerRequestSchema = z.object({ job: integer, kind: z.enum(['validate', 'scan']),
  runtime, rootId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), cursor: cursor.optional(), through: integer.optional() }).strict();
export type MimoWorkerRequest = z.infer<typeof mimoWorkerRequestSchema>;
export type MimoRuntimeInput = z.infer<typeof runtime>;
export type MimoScanCursor = z.infer<typeof cursor>;
const event = z.object({ sessionId: id, messageId: id, model: id, inputTokens: integer, outputTokens: integer,
  cacheReadTokens: integer, cacheWrite5mTokens: integer, cacheWrite1hTokens: integer,
  timestamp: integer, nativeUpdatedAt: integer, reportedCostUsd: z.number().finite().nonnegative() }).strict();
export const mimoWorkerReplySchema = z.object({ job: integer, valid: z.boolean(),
  fetched: integer.max(MIMO_SCAN_ROWS), cursor, highWatermark: integer,
  events: z.array(event).max(MIMO_SCAN_ROWS) }).strict();
export interface MimoWorkerReply extends Omit<z.infer<typeof mimoWorkerReplySchema>, 'events'> {
  readonly events: readonly (UsageRecord & { sessionId: string; messageId: string; timestamp: number; nativeUpdatedAt: number })[];
}

/** Bound collection length before schema traversal; never carry native message.data. */
export function parseMimoWorkerReply(raw: unknown): MimoWorkerReply | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { events?: unknown }).events) ||
    ((raw as { events: unknown[] }).events.length > MIMO_SCAN_ROWS)) return null;
  const parsed = mimoWorkerReplySchema.safeParse(raw);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > MIMO_RESULT_BYTES) return null;
  return parsed.data;
}
