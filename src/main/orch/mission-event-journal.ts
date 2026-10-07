import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  missionEventAppendInputSchema,
  missionEventCursorSchema,
  missionEventReplayQuerySchema,
  missionEventSchema,
  type MissionEvent,
  type MissionEventAppendInput,
  type MissionEventCursor,
  type MissionEventReplayQuery,
} from '../../shared/mission-events';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreOptions,
} from './scoped-store';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { canonicalJson } from '../context/canonical-json';
import {
  MISSION_REPLAY_MAX_ENCODED_BYTES,
  MISSION_REPLAY_MAX_EVENTS,
  MISSION_REPLAY_SNAPSHOT_EVENTS,
  decideMissionEventReplay,
  isMissionReplayRawPayloadSafe,
  missionReplayEncodedBytes,
} from './mission-event-replay-budget';

/** ORC-10: replay por cursor para o IPC — idêntico abaixo do teto, snapshot acima. */
export type MissionEventReplayResult =
  | { readonly mode: 'replay'; readonly events: readonly MissionEvent[] }
  | {
      readonly mode: 'snapshot';
      /** Eventos mais recentes, em ordem crescente, dentro dos tetos. */
      readonly events: readonly MissionEvent[];
      /** Maior sequência no momento do snapshot: o próximo replay parte daqui. */
      readonly cursor: number;
      /** Há eventos mais antigos que o primeiro do snapshot. */
      readonly hasMoreHistory: boolean;
    };

/**
 * Append-only mission event journal with consumer cursors and ACK.
 * Does not replace event_ledger hash chain, budgets, or effectMayHaveCommitted.
 */

const rowSchema = z
  .object({
    sequence: z.number().int().positive(),
    id: z.string().min(1).max(128),
    mission_id: z.string().min(1).max(128),
    run_id: z.string().min(1).max(128),
    parent_run_id: z.string().min(1).max(128).nullable(),
    event_type: z.string().min(1).max(64),
    payload_json: z.string(),
    idempotency_key: z.string().min(8).max(128),
    occurred_at: z.number().int().nonnegative(),
    origin: z.string().min(1).max(32),
    delivery_status: z.string().min(1).max(32),
  })
  .strict();

const cursorRowSchema = z
  .object({
    consumer_id: z.string().min(1).max(128),
    mission_id: z.string().min(1).max(128),
    last_sequence: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

const MAX_PAYLOAD_BYTES = 64 * 1024;

export class MissionEventJournal {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  /**
   * Transactional append with idempotency. Returns existing event when key
   * was already written (dedupe), never double-increments sequence.
   */
  append(raw: MissionEventAppendInput): MissionEvent {
    const input = missionEventAppendInputSchema.parse(raw);
    const payloadJson = JSON.stringify(input.payload ?? {});
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error('mission event payload exceeds size limit');
    }

    const db = this.#binding.writeDatabase();
    const existing = db
      .prepare(
        `SELECT * FROM mission_events
         WHERE mission_id = ? AND idempotency_key = ?`,
      )
      .get(input.missionId, input.idempotencyKey);
    if (existing) {
      const event = rowToEvent(existing);
      const isSameEvent =
        event.runId === input.runId &&
        event.parentRunId === input.parentRunId &&
        event.type === input.type &&
        event.origin === input.origin &&
        canonicalJson(event.payload) === canonicalJson(input.payload ?? {}) &&
        (input.occurredAt === undefined || event.occurredAt === input.occurredAt);
      if (!isSameEvent) {
        throw new Error('mission event idempotency conflict');
      }
      return event;
    }

    const occurredAt = input.occurredAt ?? this.#binding.now();
    const insert = db.transaction(() => {
      const next = db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
           FROM mission_events WHERE mission_id = ?`,
        )
        .get(input.missionId) as { next_seq: number };

      const id = this.#binding.makeId('mevt');
      db.prepare(
        `INSERT INTO mission_events (
           sequence, id, mission_id, run_id, parent_run_id, event_type,
           payload_json, idempotency_key, occurred_at, origin, delivery_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        next.next_seq,
        id,
        input.missionId,
        input.runId,
        input.parentRunId ?? null,
        input.type,
        payloadJson,
        input.idempotencyKey,
        occurredAt,
        input.origin,
      );

      return db
        .prepare(
          `SELECT * FROM mission_events WHERE mission_id = ? AND sequence = ?`,
        )
        .get(input.missionId, next.next_seq);
    });

    return rowToEvent(insert());
  }

  replay(raw: MissionEventReplayQuery): readonly MissionEvent[] {
    const query = missionEventReplayQuerySchema.parse(raw);
    const db = this.#binding.readDatabase();
    const rows = query.runId
      ? db
          .prepare(
            `SELECT * FROM mission_events
             WHERE mission_id = ? AND sequence > ? AND run_id = ?
             ORDER BY sequence ASC LIMIT ?`,
          )
          .all(query.missionId, query.afterSequence, query.runId, query.limit)
      : db
          .prepare(
            `SELECT * FROM mission_events
             WHERE mission_id = ? AND sequence > ?
             ORDER BY sequence ASC LIMIT ?`,
          )
          .all(query.missionId, query.afterSequence, query.limit);

    return rows.map((row) => rowToEvent(row));
  }

  /**
   * ORC-10: replay por cursor com teto, para consumidores fora do Main (IPC).
   * Abaixo do teto devolve exatamente `replay(query)`. Acima do teto de
   * eventos ou de bytes — ou com cursor além da maior sequência — devolve
   * snapshot (cauda limitada) + cursor, sem decodificar o intervalo inteiro.
   */
  replayBounded(raw: MissionEventReplayQuery): MissionEventReplayResult {
    const query = missionEventReplayQuerySchema.parse(raw);
    const db = this.#binding.readDatabase();
    const runFilter = query.runId ? ' AND run_id = ?' : '';
    const runArgs = query.runId ? [query.runId] : [];
    const { highWater } = db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS highWater
         FROM mission_events WHERE mission_id = ?`,
      )
      .get(query.missionId) as { highWater: number };
    // Pré-checagem sem decodificar: lê no máximo teto+1 linhas do intervalo.
    const gap = db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS rawBytes
         FROM (SELECT payload_json FROM mission_events
               WHERE mission_id = ? AND sequence > ?${runFilter}
               ORDER BY sequence ASC LIMIT ?)`,
      )
      .get(
        query.missionId,
        query.afterSequence,
        ...runArgs,
        MISSION_REPLAY_MAX_EVENTS + 1,
      ) as { count: number; rawBytes: number };
    const decide = (replayEncodedBytes: number) =>
      decideMissionEventReplay({
        afterSequence: query.afterSequence,
        highWater,
        replayEventCount: gap.count,
        replayEncodedBytes,
      });
    if (decide(0).mode === 'replay' && isMissionReplayRawPayloadSafe(gap.rawBytes)) {
      const events = this.replay(query);
      if (decide(missionReplayEncodedBytes(events)).mode === 'replay') {
        return { mode: 'replay', events };
      }
    }
    const rows = db
      .prepare(
        `SELECT * FROM mission_events
         WHERE mission_id = ? AND sequence <= ?${runFilter}
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(query.missionId, highWater, ...runArgs, MISSION_REPLAY_SNAPSHOT_EVENTS);
    const events: MissionEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      const event = rowToEvent(row);
      const cost = missionReplayEncodedBytes([event]);
      if (bytes + cost > MISSION_REPLAY_MAX_ENCODED_BYTES) break;
      bytes += cost;
      events.push(event);
    }
    events.reverse();
    const older = db
      .prepare(
        `SELECT 1 AS found FROM mission_events
         WHERE mission_id = ? AND sequence < ?${runFilter} LIMIT 1`,
      )
      .get(query.missionId, events[0]?.sequence ?? highWater + 1, ...runArgs);
    return {
      mode: 'snapshot',
      events,
      cursor: highWater,
      hasMoreHistory: older !== undefined,
    };
  }

  getCursor(consumerId: string, missionId: string): MissionEventCursor {
    const db = this.#binding.readDatabase();
    const row = db
      .prepare(
        `SELECT * FROM mission_event_cursors
         WHERE consumer_id = ? AND mission_id = ?`,
      )
      .get(consumerId, missionId);
    if (!row) {
      return missionEventCursorSchema.parse({
        consumerId,
        missionId,
        lastSequence: 0,
        updatedAt: 0,
      });
    }
    return cursorRowToCursor(row);
  }

  /**
   * Advance cursor only forward (monotonic). ACK marks delivered rows acked.
   */
  ack(
    consumerId: string,
    missionId: string,
    upToSequence: number,
  ): MissionEventCursor {
    if (!Number.isSafeInteger(upToSequence) || upToSequence < 0) {
      throw new Error('invalid ack sequence');
    }
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();

    const apply = db.transaction(() => {
      // An ACK beyond the last persisted sequence would advance the cursor
      // past events that do not exist yet, silently skipping them on replay.
      const { maxSequence } = db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) AS maxSequence
           FROM mission_events
           WHERE mission_id = ?`,
        )
        .get(missionId) as { maxSequence: number };
      if (upToSequence > maxSequence) {
        throw new Error(
          `ack sequence ${upToSequence} exceeds last persisted sequence ${maxSequence}`,
        );
      }
      const current = this.getCursor(consumerId, missionId);
      const nextSeq = Math.max(current.lastSequence, upToSequence);

      db.prepare(
        `INSERT INTO mission_event_cursors
           (consumer_id, mission_id, last_sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(consumer_id, mission_id) DO UPDATE SET
           last_sequence = excluded.last_sequence,
           updated_at = excluded.updated_at
         WHERE excluded.last_sequence >= mission_event_cursors.last_sequence`,
      ).run(consumerId, missionId, nextSeq, now);

      if (upToSequence > 0) {
        db.prepare(
          `UPDATE mission_events
           SET delivery_status = 'acked'
           WHERE mission_id = ?
             AND sequence <= ?
             AND delivery_status IN ('pending', 'delivered')`,
        ).run(missionId, upToSequence);
      }

      return this.getCursor(consumerId, missionId);
    });

    return apply();
  }

  /** Mark pending events as delivered up to sequence (without ACK). */
  markDelivered(missionId: string, upToSequence: number): number {
    const db = this.#binding.writeDatabase();
    const info = db
      .prepare(
        `UPDATE mission_events
         SET delivery_status = 'delivered'
         WHERE mission_id = ?
           AND sequence <= ?
           AND delivery_status = 'pending'`,
      )
      .run(missionId, upToSequence) as { changes?: number };
    return info.changes ?? 0;
  }

  /**
   * Raw `observer.session_spawned` payloads in append order. Dumb pipe for
   * pane→session attribution (F-143): callers parse and validate, skipping
   * malformed rows. Capped — spawns are ~1/pane, so the bound is headroom,
   * not a correctness limit the matcher may rely on.
   */
  listSessionSpawnedPayloads(missionId: string, limit = 2000): readonly string[] {
    if (!missionId) return [];
    const capped = Math.min(Math.max(1, Math.floor(limit)), 5000);
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `SELECT payload_json FROM mission_events
         WHERE mission_id = ? AND event_type = 'observer.session_spawned'
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(missionId, capped) as { payload_json: string }[];
    return rows.map((row) => row.payload_json);
  }

  /** UI projection: last N events newest-first. */
  projectRecent(missionId: string, limit = 50): readonly MissionEvent[] {
    const capped = Math.min(Math.max(1, limit), 200);
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `SELECT * FROM mission_events
         WHERE mission_id = ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(missionId, capped);
    return rows.map((row) => rowToEvent(row)).reverse();
  }
}

function rowToEvent(raw: unknown): MissionEvent {
  let row: z.infer<typeof rowSchema>;
  try {
    row = rowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission event', { cause: error });
  }
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission event payload', {
      cause: error,
    });
  }

  return missionEventSchema.parse({
    sequence: row.sequence,
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    parentRunId: row.parent_run_id ?? undefined,
    type: row.event_type,
    payload,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
    origin: row.origin,
    deliveryStatus: row.delivery_status,
  });
}

function cursorRowToCursor(raw: unknown): MissionEventCursor {
  let row: z.infer<typeof cursorRowSchema>;
  try {
    row = cursorRowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission event cursor', {
      cause: error,
    });
  }
  return missionEventCursorSchema.parse({
    consumerId: row.consumer_id,
    missionId: row.mission_id,
    lastSequence: row.last_sequence,
    updatedAt: row.updated_at,
  });
}

/** Deterministic fixture helper for tests. */
export function createMissionEventFixture(
  overrides: Partial<MissionEventAppendInput> = {},
): MissionEventAppendInput {
  return missionEventAppendInputSchema.parse({
    missionId: overrides.missionId ?? 'mission-fixture',
    runId: overrides.runId ?? 'run-fixture',
    parentRunId: overrides.parentRunId,
    type: overrides.type ?? 'driver.tick',
    payload: overrides.payload ?? { n: 1 },
    idempotencyKey:
      overrides.idempotencyKey ?? `idem-${randomUUID().slice(0, 12)}`,
    origin: overrides.origin ?? 'system',
    occurredAt: overrides.occurredAt,
  });
}
