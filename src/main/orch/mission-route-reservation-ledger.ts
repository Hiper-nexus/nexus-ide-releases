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
export const ROUTE_RESERVATION_TTL_MIN_MS = 1_000;
export const ROUTE_RESERVATION_TTL_MAX_MS = 30 * 60_000;
const routeReservationTtlSchema = z
  .number()
  .int()
  .min(ROUTE_RESERVATION_TTL_MIN_MS)
  .max(ROUTE_RESERVATION_TTL_MAX_MS);

/**
 * TTL é proteção, não contrato: um pedido fora da faixa (Maestro chutou 1h,
 * NaN, float) vira o limite mais próximo em vez de derrubar a reserva. Caso
 * de campo 20/08: o PRÓPRIO default (60min) violava o teto do schema (30min,
 * b34907b3) e TODO nexus_route_task falhava com erro zod sem nome de campo —
 * missão inteira presa em route_reservation_required.
 */
export function clampRouteReservationTtlMs(raw: number): number {
  if (!Number.isFinite(raw)) return ROUTE_RESERVATION_TTL_MAX_MS;
  return Math.min(
    ROUTE_RESERVATION_TTL_MAX_MS,
    Math.max(ROUTE_RESERVATION_TTL_MIN_MS, Math.round(raw)),
  );
}

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
    specialty: z
      .enum(['visual', 'security', 'bug', 'feature', 'doc', 'ops', 'general'])
      .optional(),
    policySource: z.enum(['heuristic', 'nexus-eval', 'benchmark']).optional(),
    judgeUnavailable: z.boolean().optional(),
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
    squad_id: z.string().min(1).max(128).nullable(),
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
    squad_id: z.string().min(1).max(128).nullable(),
  })
  .strict();

/** Default = teto do schema; um default acima do teto brickava toda rota. */
export const ROUTE_RESERVATION_TTL_MS = ROUTE_RESERVATION_TTL_MAX_MS;

export interface MissionRouteReservation {
  readonly id: string;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly taskPreview: string;
  readonly decision: RouteDecision;
  /** Sealed squad the mission was bound to when the route was reserved. */
  readonly squadId?: string;
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
    ...(row.squad_id === null ? {} : { squadId: row.squad_id }),
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
  mission: {
    readonly status: MissionStatus;
    readonly intent_version: number;
    readonly squad_id: string | null;
  },
  at: number,
): void {
  // One message for two causes sent the agent in circles: when the mission had
  // stopped running, "chame nexus_route_task novamente" led straight back to
  // reserveRouteDecision, which refuses on the same predicate. Same checks,
  // separate CTAs — the one for a stopped mission now points at the exit that
  // actually exists.
  if (reservation.missionId !== expected.missionId) {
    throw new Error(
      'route_reservation_invalid: a reserva pertence a outra missão; chame nexus_route_task novamente',
    );
  }
  if (mission.status !== 'running') {
    throw new Error(
      `route_reservation_invalid: a missão não está em execução (status=${mission.status}); use “Retomar missão” antes de rotear`,
    );
  }
  if (reservation.intentVersion !== mission.intent_version) {
    throw new Error(
      'route_reservation_stale: a intenção da missão mudou; chame nexus_route_task novamente',
    );
  }
  // Vínculo durável do squad: uma reserva só pode ser consumida enquanto a
  // missão continuar vinculada ao MESMO squad selado com que a rota foi
  // reservada. Um rebind de squad (ou uma reserva de outro squad) invalida a
  // rota — é o gate que faz o pane_spawn respeitar o squad salvo no caminho
  // agêntico, sem nunca colapsar o roster heterogêneo.
  if ((reservation.squadId ?? null) !== (mission.squad_id ?? null)) {
    throw new Error(
      'route_reservation_squad_mismatch: a reserva não pertence ao squad vinculado ' +
        'da missão; chame nexus_route_task novamente',
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
    const ttlMs = routeReservationTtlSchema.parse(
      clampRouteReservationTtlMs(rawTtlMs),
    );
    const createdAt = this.#binding.now();
    const expiresAt = createdAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new Error('route reservation expiry is outside the safe timestamp range');
    }
    const reservationId = this.#binding.makeId('route-reservation');
    const db = this.#binding.writeDatabase();
    db.transaction(() => {
      const missionRaw = db
        .prepare('SELECT status, intent_version, squad_id FROM missions WHERE id = ?')
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
      // Vincula a reserva ao squad selado ATUAL da missão. O squad selado é uma
      // cópia imutável (mission-runtime-*/agentic-runtime-*) que carrega o roster
      // COMPLETO com o cli/provider de cada membro — o binding preserva a
      // composição heterogênea, nunca colapsa num provider só.
      db.prepare(
        `INSERT INTO mission_route_reservations
           (id, mission_id, intent_version, task_preview, decision_json,
            adapter_id, model, effort, squad_id, created_at, expires_at,
            consumed_at, consumed_by_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        reservationId,
        missionId,
        mission.intent_version,
        task.slice(0, 512),
        JSON.stringify(decision),
        decision.adapterId,
        decision.model ?? null,
        decision.effort ?? null,
        mission.squad_id,
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

  /**
   * Adapter ids of unconsumed, unexpired reservations for this mission.
   * Fan-out `nexus_route_task` calls must count these so the second worker
   * of a wave does not inherit the same GLM/table lead as the first.
   */
  listOpenRouteAdapterIds(rawMissionId: string, rawAt?: number): string[] {
    const missionId = entityIdSchema.parse(rawMissionId);
    const at =
      rawAt === undefined
        ? this.#binding.now()
        : timestampSchema.parse(rawAt);
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT adapter_id FROM mission_route_reservations
          WHERE mission_id = ?
            AND consumed_at IS NULL
            AND expires_at > ?
          ORDER BY created_at ASC`,
      )
      .all(missionId, at) as Array<{ adapter_id: string }>;
    return rows.map((row) => row.adapter_id);
  }

  /**
   * F-232: reservas CONSUMIDAS por adapter neste checkout desde `sinceMs`,
   * em todas as missões — alimenta o fair-share global do task-router.
   */
  consumedCountsByAdapterSince(rawSinceMs: number): Map<string, number> {
    const sinceMs = timestampSchema.parse(rawSinceMs);
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT adapter_id, COUNT(*) AS n FROM mission_route_reservations
          WHERE consumed_at IS NOT NULL AND consumed_at >= ?
          GROUP BY adapter_id`,
      )
      .all(sinceMs) as Array<{ adapter_id: string; n: number }>;
    return new Map(rows.map((row) => [row.adapter_id, row.n]));
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
                adapter_id, model, effort, squad_id, created_at, expires_at,
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
                adapter_id, model, effort, squad_id, created_at, expires_at,
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
      .prepare('SELECT status, intent_version, squad_id FROM missions WHERE id = ?')
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
