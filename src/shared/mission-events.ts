import { z } from 'zod';

/**
 * Mission event journal contracts (append-only, consumer cursor + ACK).
 * Complements context `event_ledger` (hash-chained integrity) without replacing
 * effectMayHaveCommitted / budgets / step receipts.
 */

export const MISSION_EVENT_TYPES = [
  'mission.created',
  'mission.status_changed',
  'mission.intent_armed',
  'mission.run_started',
  'mission.run_finished',
  'agent.spawned',
  'agent.finished',
  'agent.needs_input',
  'agent.reaped',
  'tool.invoked',
  'tool.completed',
  'tool.denied',
  'observer.turn_started',
  'observer.turn_ended',
  'observer.tool_call',
  'observer.tool_result',
  'observer.status_changed',
  'observer.session_spawned',
  'observer.session_exited',
  'observer.stall_suspected',
  'observer.provider_error',
  'handoff.submitted',
  'handoff.acked',
  'budget.reserved',
  'budget.released',
  'driver.tick',
  'driver.error',
  'ui.projection',
  'custom',
] as const;

export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

export const missionEventTypeSchema = z.enum(MISSION_EVENT_TYPES);

export const MISSION_EVENT_ORIGINS = [
  'main',
  'driver',
  'mcp',
  'renderer',
  'voice',
  'system',
] as const;

export type MissionEventOrigin = (typeof MISSION_EVENT_ORIGINS)[number];

export const missionEventOriginSchema = z.enum(MISSION_EVENT_ORIGINS);

export const MISSION_EVENT_DELIVERY = [
  'pending',
  'delivered',
  'acked',
  'failed',
] as const;

export type MissionEventDeliveryStatus =
  (typeof MISSION_EVENT_DELIVERY)[number];

export const missionEventDeliverySchema = z.enum(MISSION_EVENT_DELIVERY);

const idSchema = z.string().min(1).max(128);
const payloadSchema = z.record(z.string().max(128), z.unknown()).default({});

export const missionEventAppendInputSchema = z
  .object({
    missionId: idSchema,
    runId: idSchema,
    parentRunId: idSchema.optional(),
    type: missionEventTypeSchema,
    payload: payloadSchema,
    idempotencyKey: z.string().min(8).max(128),
    origin: missionEventOriginSchema,
    occurredAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type MissionEventAppendInput = z.infer<
  typeof missionEventAppendInputSchema
>;

export const missionEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    id: idSchema,
    missionId: idSchema,
    runId: idSchema,
    parentRunId: idSchema.optional(),
    type: missionEventTypeSchema,
    payload: payloadSchema,
    idempotencyKey: z.string().min(8).max(128),
    occurredAt: z.number().int().nonnegative(),
    origin: missionEventOriginSchema,
    deliveryStatus: missionEventDeliverySchema,
  })
  .strict();

export type MissionEvent = z.infer<typeof missionEventSchema>;

export const missionEventCursorSchema = z
  .object({
    consumerId: z.string().min(1).max(128),
    missionId: idSchema,
    /** Last sequence this consumer has fully processed (0 = none). */
    lastSequence: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type MissionEventCursor = z.infer<typeof missionEventCursorSchema>;

export const missionEventReplayQuerySchema = z
  .object({
    missionId: idSchema,
    afterSequence: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(1000).default(100),
    runId: idSchema.optional(),
  })
  .strict();

export type MissionEventReplayQuery = z.infer<
  typeof missionEventReplayQuerySchema
>;
