import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  missionStatusSchema,
  type Mission,
  type MissionRouteTrace,
  type MissionStatus,
} from '../../shared/orch-types';
import type { RouteDecision } from './task-router';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
} from './scoped-store';

const entityIdSchema = z.string().min(1).max(256);
const sessionIdSchema = z.string().min(1).max(256);
const timestampSchema = z.number().int().nonnegative();
const routeReservationTtlSchema = z.number().int().min(1_000).max(30 * 60_000);

const routeCandidateSchema = z
  .object({
    adapterId: z.string().min(1).max(128),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
  })
  .strict();

const routeDecisionSchema = z
  .object({
    tier: z.enum(['trivial', 'easy', 'medium', 'hard', 'critical']),
    adapterId: z.string().min(1).max(128),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
    reason: z.string().min(1).max(16_384),
    alternatives: z.array(routeCandidateSchema).max(256),
  })
  .strict();

const routeReservationRowSchema = z
  .object({
    id: entityIdSchema,
    mission_id: entityIdSchema,
    intent_version: z.number().int().nonnegative(),
    task_preview: z.string().max(512),
    decision_json: z.string(),
    adapter_id: z.string().min(1).max(128),
    model: z.string().min(1).max(256).nullable(),
    effort: z.string().min(1).max(64).nullable(),
    created_at: timestampSchema,
    expires_at: timestampSchema,
    consumed_at: timestampSchema.nullable(),
    consumed_by_session: sessionIdSchema.nullable(),
  })
  .strict();

const routeReservationExpectationSchema = z
  .object({
    reservationId: entityIdSchema,
    missionId: entityIdSchema,
    adapterId: z.string().min(1).max(128),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
    at: timestampSchema.optional(),
  })
  .strict();

const routeReservationMissionSchema = z
  .object({
    status: missionStatusSchema,
    intent_version: z.number().int().nonnegative(),
  })
  .strict();

export const ROUTE_RESERVATION_TTL_MS = 5 * 60_000;

export interface MissionRouteReservation {
  readonly id: string;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly taskPreview: string;
  readonly decision: RouteDecision;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt?: number;
  readonly consumedBySession?: string;
}

export interface RouteReservationExpectation {
  readonly reservationId: string;
  readonly missionId: string;
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: string;
  /** Test seam; production uses the scoped store clock. */
  readonly at?: number;
}

function cloneRouteDecision(decision: RouteDecision): RouteDecision {
  return {
    ...decision,
    alternatives: decision.alternatives.map((candidate) => ({ ...candidate })),
  };
}

function parseRouteDecision(raw: string): RouteDecision {
  try {
    return routeDecisionSchema.parse(JSON.parse(raw)) as RouteDecision;
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission route reservation', {
      cause: error,
    });
  }
}

function routeReservationFromRow(raw: unknown): MissionRouteReservation {
  let row: z.infer<typeof routeReservationRowSchema>;
  try {
    row = routeReservationRowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission route reservation', {
      cause: error,
    });
  }
  const decision = parseRouteDecision(row.decision_json);
  if (
    decision.adapterId !== row.adapter_id ||
    (decision.model ?? null) !== row.model ||
    (decision.effort ?? null) !== row.effort
  ) {
    throw new ScopedStoreCorruptionError('mission route reservation');
  }
  return Object.freeze({
    id: row.id,
    missionId: row.mission_id,
    intentVersion: row.intent_version,
    taskPreview: row.task_preview,
    decision: cloneRouteDecision(decision),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.consumed_by_session === null
      ? {}
      : { consumedBySession: row.consumed_by_session }),
  });
}

function assertExpectedRoute(
  reservation: MissionRouteReservation,
  expected: RouteReservationExpectation,
  mission: { readonly status: MissionStatus; readonly intent_version: number },
  at: number,
): void {
  if (
    reservation.missionId !== expected.missionId ||
    mission.status !== 'running'
  ) {
    throw new Error(
      'route_reservation_invalid: a reserva não pertence a uma missão em execução; chame nexus_route_task novamente',
    );
  }
  if (reservation.intentVersion !== mission.intent_version) {
    throw new Error(
      'route_reservation_stale: a intenção da missão mudou; chame nexus_route_task novamente',
    );
  }
  if (reservation.consumedAt !== undefined) {
    throw new Error(
      'route_reservation_invalid: a reserva já foi consumida; chame nexus_route_task novamente',
    );
  }
  if (reservation.expiresAt <= at) {
    throw new Error(
      'route_reservation_invalid: a reserva expirou; chame nexus_route_task novamente',
    );
  }
  const decision = reservation.decision;
  if (
    decision.adapterId !== expected.adapterId ||
    decision.model !== expected.model ||
    decision.effort !== expected.effort
  ) {
    throw new Error(
      'route_reservation_invalid: adapter/model/effort não correspondem à rota reservada; use exatamente o retorno de nexus_route_task',
    );
  }
}

/**
 * Durable mission-route ledger. It deliberately shares the mission store's
 * binding so its transaction, clock, id generation and change notification
 * semantics remain identical while the persistence concern stays isolated.
 */
export class MissionRouteReservationLedger {
  readonly #binding: ScopedStoreBinding;

  constructor(binding: ScopedStoreBinding) {
    this.#binding = binding;
  }

  reserveRouteDecision(
    rawMissionId: string,
    rawTask: string,
    rawDecision: RouteDecision,
    rawTtlMs: number = ROUTE_RESERVATION_TTL_MS,
  ): MissionRouteReservation {
    const missionId = entityIdSchema.parse(rawMissionId);
    const task = z.string().min(1).max(65_536).parse(rawTask);
    const decision = routeDecisionSchema.parse(rawDecision) as RouteDecision;
    const ttlMs = routeReservationTtlSchema.parse(rawTtlMs);
    const createdAt = this.#binding.now();
    const expiresAt = createdAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new Error('route reservation expiry is outside the safe timestamp range');
    }
    const reservationId = this.#binding.makeId('route-reservation');
    const db = this.#binding.writeDatabase();
    db.transaction(() => {
      const missionRaw = db
        .prepare('SELECT status, intent_version FROM missions WHERE id = ?')
        .get(missionId);
      if (!missionRaw) {
        throw new Error(`route_reservation_invalid: missão não encontrada: ${missionId}`);
      }
      const mission = routeReservationMissionSchema.parse(missionRaw);
      if (mission.status !== 'running') {
        throw new Error(
          'route_reservation_invalid: nexus_route_task só reserva rota para missão running',
        );
      }
      db.prepare(
        `INSERT INTO mission_route_reservations
           (id, mission_id, intent_version, task_preview, decision_json,
            adapter_id, model, effort, created_at, expires_at,
            consumed_at, consumed_by_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        reservationId,
        missionId,
        mission.intent_version,
        task.slice(0, 512),
        JSON.stringify(decision),
        decision.adapterId,
        decision.model ?? null,
        decision.effort ?? null,
        createdAt,
        expiresAt,
      );
    })();
    const reservation = this.#getRouteReservationFromDatabase(db, reservationId);
    if (!reservation) {
      throw new Error('route reservation was not persisted');
    }
    this.#binding.emitChange();
    return reservation;
  }

  getRouteReservation(rawReservationId: string): MissionRouteReservation | null {
    const reservationId = entityIdSchema.parse(rawReservationId);
    return this.#getRouteReservationFromDatabase(
      this.#binding.readDatabase(),
      reservationId,
    );
  }

  assertRouteReservation(
    rawExpected: RouteReservationExpectation,
  ): MissionRouteReservation {
    const expected = routeReservationExpectationSchema.parse(rawExpected);
    const at = expected.at ?? this.#binding.now();
    const db = this.#binding.readDatabase();
    return this.#assertRouteReservationInDatabase(db, expected, at);
  }

  consumeRouteReservation(
    rawExpected: RouteReservationExpectation,
    rawConsumerSessionId: string,
  ): MissionRouteReservation {
    const expected = routeReservationExpectationSchema.parse(rawExpected);
    const consumerSessionId = sessionIdSchema.parse(rawConsumerSessionId);
    const at = expected.at ?? this.#binding.now();
    const db = this.#binding.writeDatabase();
    const consumed = db.transaction(() => {
      this.#assertRouteReservationInDatabase(db, expected, at);
      const result = db
        .prepare(
          `UPDATE mission_route_reservations
           SET consumed_at = ?, consumed_by_session = ?
           WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(at, consumerSessionId, expected.reservationId, at);
      if (result.changes !== 1) {
        throw new Error(
          'route_reservation_invalid: a reserva expirou ou já foi consumida; chame nexus_route_task novamente',
        );
      }
      const reservation = this.#getRouteReservationFromDatabase(
        db,
        expected.reservationId,
      );
      if (!reservation) {
        throw new Error('route reservation disappeared during consumption');
      }
      return reservation;
    })();
    this.#binding.emitChange();
    return consumed;
  }

  withLatestRoute<T extends Mission>(
    db: Database.Database,
    mission: T,
  ): T {
    const raw = db
      .prepare(
        `SELECT id, mission_id, intent_version, task_preview, decision_json,
                adapter_id, model, effort, created_at, expires_at,
                consumed_at, consumed_by_session
         FROM mission_route_reservations
         WHERE mission_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(mission.id);
    if (raw === undefined) return mission;
    const reservation = routeReservationFromRow(raw);
    const trace: MissionRouteTrace = {
      reservationId: reservation.id,
      taskPreview: reservation.taskPreview,
      tier: reservation.decision.tier,
      adapterId: reservation.decision.adapterId,
      model: reservation.decision.model,
      effort: reservation.decision.effort,
      reason: reservation.decision.reason,
      state:
        reservation.consumedAt !== undefined
          ? 'consumed'
          : reservation.expiresAt <= this.#binding.now()
            ? 'expired'
            : 'reserved',
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
      consumedAt: reservation.consumedAt,
      consumedBySession: reservation.consumedBySession,
    };
    return { ...mission, latestRoute: trace };
  }

  #getRouteReservationFromDatabase(
    db: Database.Database,
    reservationId: string,
  ): MissionRouteReservation | null {
    const raw = db
      .prepare(
        `SELECT id, mission_id, intent_version, task_preview, decision_json,
                adapter_id, model, effort, created_at, expires_at,
                consumed_at, consumed_by_session
         FROM mission_route_reservations WHERE id = ?`,
      )
      .get(reservationId);
    return raw === undefined ? null : routeReservationFromRow(raw);
  }

  #assertRouteReservationInDatabase(
    db: Database.Database,
    expected: RouteReservationExpectation,
    at: number,
  ): MissionRouteReservation {
    const reservation = this.#getRouteReservationFromDatabase(
      db,
      expected.reservationId,
    );
    const missionRaw = db
      .prepare('SELECT status, intent_version FROM missions WHERE id = ?')
      .get(expected.missionId);
    if (!reservation || !missionRaw) {
      throw new Error(
        'route_reservation_invalid: reserva ou missão não encontrada; chame nexus_route_task novamente',
      );
    }
    const mission = routeReservationMissionSchema.parse(missionRaw);
    assertExpectedRoute(reservation, expected, mission, at);
    return reservation;
  }
}
