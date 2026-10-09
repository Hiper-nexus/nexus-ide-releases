import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreOptions,
} from './scoped-store';
import type { ProjectExecutionScope } from '../../shared/types';
import type {
  ProjectRuntimeLease,
  ProjectRuntimeManager,
} from '../runtime/project-runtime-manager';

/**
 * ORC-01 — outbox transacional de efeitos (porte da política T3
 * `EffectOutbox.ts` @ 26285ab; casca reescrita em better-sqlite).
 *
 * Classe vem do TIPO do efeito (não de um campo livre):
 * - PROCESS_BOUND: turno/pedido amarrado a este processo. Após perda do
 *   processo NÃO reexecuta (pane duplicado) — `pending`/`running` → `cancelled`.
 * - REPLAY_SAFE: efeito idempotente. Após perda do processo reentra —
 *   `running` → `pending`.
 *
 * Status (mesmo vocabulário do T3): pending | running | succeeded | failed |
 * cancelled. Claim é por lease (`leaseOwner` + `leaseExpiresAt`).
 * Primeiro corte: não substitui `handoff-delivery-outbox`.
 */

/** Replay-safe após perda do processo (política T3 `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS`). */
export const REPLAY_SAFE_EFFECT_TYPES = [
  'runtime.continue',
  'session.detach',
  'thread.rollback',
  'checkpoint.capture',
  'terminal.cleanup',
  'attachment.cleanup',
  'thread-title.generate',
  'delegated-tasks.stop',
] as const;

/** Amarrado ao processo (política T3 `PROCESS_BOUND_EFFECT_TYPES`). */
export const PROCESS_BOUND_EFFECT_TYPES = [
  'turn.start',
  'turn.interrupt',
  'turn.steer',
  'turn.restart',
  'runtime-request.respond',
] as const;

export type ReplaySafeEffectType = (typeof REPLAY_SAFE_EFFECT_TYPES)[number];
export type ProcessBoundEffectType = (typeof PROCESS_BOUND_EFFECT_TYPES)[number];
export type EffectType = ReplaySafeEffectType | ProcessBoundEffectType;
export type EffectClass = 'process_bound' | 'replay_safe';
export type EffectOutboxStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

const KNOWN_EFFECT_TYPES = [
  ...REPLAY_SAFE_EFFECT_TYPES,
  ...PROCESS_BOUND_EFFECT_TYPES,
] as const;

export function effectClassFor(type: EffectType): EffectClass {
  if ((PROCESS_BOUND_EFFECT_TYPES as readonly string[]).includes(type)) {
    return 'process_bound';
  }
  if ((REPLAY_SAFE_EFFECT_TYPES as readonly string[]).includes(type)) {
    return 'replay_safe';
  }
  throw new Error('unknown effect type');
}

export interface EffectOutboxEntry {
  readonly id: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly type: EffectType;
  readonly class: EffectClass;
  readonly payload: unknown;
  readonly status: EffectOutboxStatus;
  readonly attemptCount: number;
  readonly availableAt: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly lastError: string | null;
}

export interface EffectOutboxEnqueueInput {
  readonly id?: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly type: EffectType;
  readonly payload?: unknown;
  readonly availableAt?: number;
}

export interface ClaimNextInput {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  /** Pula `runtime.continue` (continuação de restart) — política T3. */
  readonly excludeRestartContinuations?: boolean;
  /** Pula efeitos já tentados neste passe (retry os devolveu a pending). */
  readonly excludeIds?: ReadonlySet<string>;
}

export const SETTLED_EFFECT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const PROCESS_LOSS_CANCELLED_ERROR =
  'Cancelled because the server process ended before the effect completed.';
const PROCESS_LOSS_REQUEUED_ERROR =
  'Requeued after the previous server process ended.';
const LEASE_EXPIRED_FAILED_ERROR =
  'Failed because the running lease expired before the effect completed.';
const LEASE_EXPIRED_REQUEUED_ERROR =
  'Requeued because the running lease expired before the effect completed.';
const UNKNOWN_EFFECT_CANCELLED_ERROR =
  'Cancelled because the effect type is not known to this binary.';

const rowSchema = z
  .object({
    effect_id: z.string().min(1).max(128),
    command_id: z.string().min(1).max(128),
    thread_id: z.string().min(1).max(128),
    effect_type: z.enum(KNOWN_EFFECT_TYPES),
    payload_json: z.string(),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
    attempt_count: z.number().int().nonnegative(),
    available_at: z.number().int().nonnegative(),
    lease_owner: z.string().min(1).max(128).nullable(),
    lease_expires_at: z.number().int().nonnegative().nullable(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
    completed_at: z.number().int().nonnegative().nullable(),
    last_error: z.string().max(512).nullable(),
  })
  .strict();

const enqueueSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    commandId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(128),
    type: z.enum([
      ...REPLAY_SAFE_EFFECT_TYPES,
      ...PROCESS_BOUND_EFFECT_TYPES,
    ] as [EffectType, ...EffectType[]]),
    payload: z.unknown().optional(),
    availableAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const MAX_PAYLOAD_BYTES = 32 * 1024;

const handlerFlights = new Map<string, Set<string>>();
const handlerLeases = new Map<string, Map<string, ProjectRuntimeLease>>();
const unreconciledScopes = new Set<string>();

function scopeFlightKey(
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

function flightsFor(scopeKey: string): Set<string> {
  let flights = handlerFlights.get(scopeKey);
  if (!flights) {
    flights = new Set();
    handlerFlights.set(scopeKey, flights);
  }
  return flights;
}

function leasesFor(scopeKey: string): Map<string, ProjectRuntimeLease> {
  let leases = handlerLeases.get(scopeKey);
  if (!leases) {
    leases = new Map();
    handlerLeases.set(scopeKey, leases);
  }
  return leases;
}

/**
 * Escopo cujo reconcile de boot falhou. `claimNext` recusa o dreno até um
 * passe posterior conseguir escrever. A chave é a identidade do escopo, não
 * o handle SQLite que o LRU pode trocar.
 */
export function blockUnreconciledEffectOutbox(
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): void {
  unreconciledScopes.add(scopeFlightKey(scope));
}

export function clearUnreconciledEffectOutbox(
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): void {
  unreconciledScopes.delete(scopeFlightKey(scope));
}

export function isUnreconciledEffectOutbox(
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): boolean {
  return unreconciledScopes.has(scopeFlightKey(scope));
}

function cancelUnknownEffects(db: Database.Database, now: number): number {
  const updated = db
    .prepare(
      `UPDATE effect_outbox
       SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?, last_error = ?
       WHERE status IN ('pending', 'running')
         AND effect_type NOT IN (${KNOWN_EFFECT_TYPES.map(() => '?').join(',')})`,
    )
    .run(now, now, UNKNOWN_EFFECT_CANCELLED_ERROR, ...KNOWN_EFFECT_TYPES);
  return updated.changes;
}

function isClaimAttempt(attemptCount: number): boolean {
  return Number.isInteger(attemptCount) && attemptCount >= 1;
}

function excludedEffectIds(ids: ReadonlySet<string> | undefined): string[] {
  if (!ids || ids.size === 0) return [];
  const excluded: string[] = [];
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
      excluded.push(id);
    }
  }
  return excluded;
}

function rowToEntry(row: unknown): EffectOutboxEntry {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    throw new ScopedStoreCorruptionError('effect_outbox', { cause: parsed.error });
  }
  const value = parsed.data;
  let payload: unknown = {};
  try {
    payload = JSON.parse(value.payload_json) as unknown;
  } catch (error) {
    throw new ScopedStoreCorruptionError('effect_outbox payload', { cause: error });
  }
  return {
    id: value.effect_id,
    commandId: value.command_id,
    threadId: value.thread_id,
    type: value.effect_type,
    class: effectClassFor(value.effect_type),
    payload,
    status: value.status,
    attemptCount: value.attempt_count,
    availableAt: value.available_at,
    leaseOwner: value.lease_owner,
    leaseExpiresAt: value.lease_expires_at,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    completedAt: value.completed_at,
    lastError: value.last_error,
  };
}

export class EffectOutboxStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  /**
   * Persiste a linha (política T3: notificar workers só depois do commit).
   * O mesmo id com a mesma identidade devolve a linha existente, mesmo se o
   * payload mudou. commandId, threadId ou type diferentes são conflito.
   */
  enqueue(raw: EffectOutboxEnqueueInput): EffectOutboxEntry {
    const input = enqueueSchema.parse(raw);
    const payloadJson = JSON.stringify(input.payload ?? {});
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error('effect outbox payload exceeds size limit');
    }
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    const id = input.id ?? this.#binding.makeId('eff');
    return db.transaction((): EffectOutboxEntry => {
      const existing = db
        .prepare(`SELECT * FROM effect_outbox WHERE effect_id = ?`)
        .get(id);
      if (existing) {
        const current = rowToEntry(existing);
        if (
          current.commandId !== input.commandId ||
          current.threadId !== input.threadId ||
          current.type !== input.type
        ) {
          throw new Error('effect outbox id is already bound to another command');
        }
        return current;
      }
      db.prepare(
        `INSERT INTO effect_outbox (
           effect_id, command_id, thread_id, effect_type, payload_json,
           status, attempt_count, available_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).run(
        id,
        input.commandId,
        input.threadId,
        input.type,
        payloadJson,
        input.availableAt ?? now,
        now,
        now,
      );
      const inserted = db
        .prepare(`SELECT * FROM effect_outbox WHERE effect_id = ?`)
        .get(id);
      return rowToEntry(inserted);
    })();
  }

  get(id: string): EffectOutboxEntry | null {
    const row = this.#binding
      .readDatabase()
      .prepare(`SELECT * FROM effect_outbox WHERE effect_id = ?`)
      .get(id);
    return row ? rowToEntry(row) : null;
  }

  listByCommandId(commandId: string): EffectOutboxEntry[] {
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT * FROM effect_outbox WHERE command_id = ?
         ORDER BY created_at ASC, effect_id ASC`,
      )
      .all(commandId);
    return rows.map(rowToEntry);
  }

  /**
   * Efeitos bloqueadores ainda abertos. Com `threadId`, o filtro entra no
   * SQL (índice por thread) antes do limite: linhas de outra missão não
   * escondem o checkpoint desta. `truncated` é fail-closed — a janela
   * encheu e o gate não pode dizer que está tudo assentado.
   */
  listUnsettledBlocking(
    threadId?: string,
  ): { readonly rows: EffectOutboxEntry[]; readonly truncated: boolean } {
    const cap = 200;
    const blocking = ['checkpoint.capture', 'handoff.deliver'];
    const thread =
      threadId === undefined ? undefined : z.string().min(1).max(128).parse(threadId);
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT * FROM effect_outbox
         WHERE status IN ('pending', 'running')
           AND effect_type IN (?, ?)
           ${thread === undefined ? '' : 'AND thread_id = ?'}
         ORDER BY created_at ASC, effect_id ASC
         LIMIT ?`,
      )
      .all(
        ...blocking,
        ...(thread === undefined ? [] : [thread]),
        cap + 1,
      );
    return {
      rows: rows.slice(0, cap).map(rowToEntry),
      truncated: rows.length > cap,
    };
  }

  listByStatus(status: EffectOutboxStatus, limit = 100): EffectOutboxEntry[] {
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT * FROM effect_outbox WHERE status = ?
         ORDER BY available_at ASC, created_at ASC, effect_id ASC LIMIT ?`,
      )
      .all(status, Math.max(1, Math.min(limit, 1000)));
    return rows.map(rowToEntry);
  }

  /**
   * Claim por lease (política T3 `claimNext`): uma linha por vez, em ordem,
   * sem pular efeito anterior pendente do mesmo thread. Título
   * (`thread-title.generate`) tem faixa própria e não bloqueia lifecycle.
   */
  claimNext(input: ClaimNextInput): EffectOutboxEntry | null {
    if (unreconciledScopes.has(scopeFlightKey(this.scope))) {
      throw new Error('effect outbox scope was not reconciled');
    }
    const leaseMs = Math.max(1, input.leaseDurationMs);
    const excludeContinuations = input.excludeRestartContinuations === true;
    const excludeIds = input.excludeIds;
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    const leaseExpiresAt = now + leaseMs;
    return db.transaction((): EffectOutboxEntry | null => {
      cancelUnknownEffects(db, now);
      const replaySafePlaceholders = REPLAY_SAFE_EFFECT_TYPES.map(() => '?').join(',');
      const held = [...(handlerFlights.get(scopeFlightKey(this.scope)) ?? [])].filter(
        (id) => id.length > 0 && id.length <= 128,
      );
      const holdClause =
        held.length > 0
          ? `AND effect_id NOT IN (${held.map(() => '?').join(',')})`
          : '';
      // Lease vencido não pode continuar 'running': process_bound falha
      // (não reexecuta) e replay_safe volta a pending. Tipo fora da lista
      // replay-safe falha fechado, senão a linha bloqueia o thread para sempre.
      db.prepare(
        `UPDATE effect_outbox
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             completed_at = ?, updated_at = ?, last_error = ?
         WHERE status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
           AND effect_type NOT IN (${replaySafePlaceholders})
           ${holdClause}`,
      ).run(
        now,
        now,
        LEASE_EXPIRED_FAILED_ERROR,
        now,
        ...REPLAY_SAFE_EFFECT_TYPES,
        ...held,
      );
      db.prepare(
        `UPDATE effect_outbox
         SET status = 'pending', available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?, last_error = ?
         WHERE status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
           AND effect_type IN (${replaySafePlaceholders})
           ${holdClause}`,
      ).run(
        now,
        now,
        LEASE_EXPIRED_REQUEUED_ERROR,
        now,
        ...REPLAY_SAFE_EFFECT_TYPES,
        ...held,
      );
      // A exclusão entra no SQL, antes do LIMIT. Filtrar os 32 primeiros
      // em memória escondia o próximo efeito quando o passe já tinha
      // tentado justamente esses 32 (retry sem espera).
      const excluded = excludedEffectIds(excludeIds);
      const excludeClause =
        excluded.length > 0
          ? `AND candidate.effect_id NOT IN (${excluded.map(() => '?').join(',')})`
          : '';
      const candidates = db
        .prepare(
          `SELECT candidate.* FROM effect_outbox AS candidate
           WHERE candidate.status = 'pending'
             AND candidate.available_at <= ?
             AND candidate.effect_type IN (${KNOWN_EFFECT_TYPES.map(() => '?').join(',')})
             AND (? = 0 OR candidate.effect_type != 'runtime.continue')
             ${excludeClause}
             AND NOT EXISTS (
               SELECT 1 FROM effect_outbox AS active
               WHERE active.thread_id = candidate.thread_id
                 AND (
                   active.status = 'running'
                   OR (
                     active.status = 'pending'
                     AND active.rowid < candidate.rowid
                     AND (? = 0 OR active.effect_type != 'runtime.continue')
                   )
                 )
                 AND (
                   (candidate.effect_type = 'thread-title.generate'
                    AND active.effect_type = 'thread-title.generate')
                   OR
                   (candidate.effect_type != 'thread-title.generate'
                    AND active.effect_type != 'thread-title.generate')
                 )
             )
           ORDER BY candidate.available_at ASC, candidate.created_at ASC,
                    candidate.effect_id ASC
           LIMIT 32`,
        )
        .all(
          now,
          ...KNOWN_EFFECT_TYPES,
          excludeContinuations ? 1 : 0,
          ...excluded,
          excludeContinuations ? 1 : 0,
        ) as unknown[];
      const candidate = candidates.map(rowToEntry)[0];
      if (!candidate) return null;
      const updated = db
        .prepare(
          `UPDATE effect_outbox
           SET status = 'running', attempt_count = attempt_count + 1,
               lease_owner = ?, lease_expires_at = ?, updated_at = ?,
               last_error = NULL
           WHERE effect_id = ? AND status = 'pending'`,
        )
        .run(input.workerId, leaseExpiresAt, now, candidate.id);
      if (updated.changes === 0) return null;
      const row = db
        .prepare(`SELECT * FROM effect_outbox WHERE effect_id = ?`)
        .get(candidate.id);
      return rowToEntry(row);
    })();
  }

  succeed(id: string, workerId: string, attemptCount: number): boolean {
    if (!isClaimAttempt(attemptCount)) return false;
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    return db.transaction((): boolean => {
      const updated = db
        .prepare(
          `UPDATE effect_outbox
           SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
               completed_at = ?, updated_at = ?, last_error = NULL
           WHERE effect_id = ? AND status = 'running' AND lease_owner = ?
             AND attempt_count = ?`,
        )
        .run(now, now, id, workerId, attemptCount);
      if (updated.changes !== 1) return false;
      const row = db
        .prepare(
          `SELECT command_id, effect_type FROM effect_outbox WHERE effect_id = ?`,
        )
        .get(id) as { command_id: string; effect_type: string } | undefined;
      if (row?.effect_type === 'checkpoint.capture') {
        // Sequence 0 é o conjunto que o boot trata como comando no meio.
        // Checkpoint assentado sai desse conjunto na mesma transação.
        db.prepare(
          `UPDATE command_receipts
           SET result_sequence = 1, status = 'accepted', error = NULL
           WHERE command_id = ? AND result_sequence = 0`,
        ).run(row.command_id);
      }
      return true;
    })();
  }

  /**
   * Volta a `pending` com `availableAt` atrasado (backoff do worker).
   * Só a tentativa claimada, do dono do lease, assenta.
   */
  retry(
    id: string,
    workerId: string,
    error: string,
    delayMs: number,
    attemptCount: number,
  ): boolean {
    if (!isClaimAttempt(attemptCount)) return false;
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    const availableAt = now + Math.max(0, delayMs);
    return db.transaction((): boolean => {
      const updated = db
        .prepare(
          `UPDATE effect_outbox
           SET status = 'pending', available_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?, last_error = ?
           WHERE effect_id = ? AND status = 'running' AND lease_owner = ?
             AND attempt_count = ?`,
        )
        .run(availableAt, now, error.slice(0, 512), id, workerId, attemptCount);
      return updated.changes === 1;
    })();
  }

  fail(id: string, workerId: string, error: string, attemptCount: number): boolean {
    if (!isClaimAttempt(attemptCount)) return false;
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    return db.transaction((): boolean => {
      const updated = db
        .prepare(
          `UPDATE effect_outbox
           SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
               completed_at = ?, updated_at = ?, last_error = ?
           WHERE effect_id = ? AND status = 'running' AND lease_owner = ?
             AND attempt_count = ?`,
        )
        .run(now, now, error.slice(0, 512), id, workerId, attemptCount);
      return updated.changes === 1;
    })();
  }

  /**
   * Estende o lease só da tentativa que ainda está running. Não renova
   * attempt_count: um handler atrasado não alonga o claim seguinte.
   */
  /**
   * Enquanto o handler deste processo ainda não assentou, outro drain não
   * pode expirar o lease. A marca fica na identidade do escopo e o runtime
   * permanece pinado: o LRU não troca o handle no meio do efeito.
   */
  retainHandlerFlight(id: string): void {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return;
    const key = scopeFlightKey(this.scope);
    const flights = flightsFor(key);
    if (flights.has(id)) return;
    const lease = this.#binding.acquireLease();
    flights.add(id);
    leasesFor(key).set(id, lease);
  }

  releaseHandlerFlight(id: string): void {
    if (typeof id !== 'string' || id.length === 0) return;
    const key = scopeFlightKey(this.scope);
    const flights = handlerFlights.get(key);
    flights?.delete(id);
    if (flights && flights.size === 0) handlerFlights.delete(key);
    const leases = handlerLeases.get(key);
    const lease = leases?.get(id);
    if (!lease || !leases) return;
    leases.delete(id);
    if (leases.size === 0) handlerLeases.delete(key);
    lease.release();
  }

  renewLease(
    id: string,
    workerId: string,
    attemptCount: number,
    leaseDurationMs: number,
  ): boolean {
    if (!isClaimAttempt(attemptCount)) return false;
    const leaseMs = Math.max(1, leaseDurationMs);
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    return db.transaction((): boolean => {
      const updated = db
        .prepare(
          `UPDATE effect_outbox
           SET lease_expires_at = ?, updated_at = ?
           WHERE effect_id = ? AND status = 'running' AND lease_owner = ?
             AND attempt_count = ?`,
        )
        .run(now + leaseMs, now, id, workerId, attemptCount);
      return updated.changes === 1;
    })();
  }

  /**
   * ORC-06 / política T3 `reconcileAfterProcessLoss`:
   * - PROCESS_BOUND em pending OU running → `cancelled` (não reexecuta).
   * - REPLAY_SAFE em running → `pending` (reentra).
   * REPLAY_SAFE em pending já é reexecutável e fica. Succeeded/failed intocados.
   */
  reconcileAfterProcessLoss(): { requeued: number; cancelled: number } {
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    return db.transaction(() => {
      const unknownCancelled = cancelUnknownEffects(db, now);
      const cancelled = db
        .prepare(
          `UPDATE effect_outbox
           SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
               completed_at = ?, updated_at = ?, last_error = ?
           WHERE status IN ('pending', 'running')
             AND effect_type IN (${PROCESS_BOUND_EFFECT_TYPES.map(() => '?').join(',')})`,
        )
        .run(
          now,
          now,
          PROCESS_LOSS_CANCELLED_ERROR,
          ...PROCESS_BOUND_EFFECT_TYPES,
        );
      const requeued = db
        .prepare(
          `UPDATE effect_outbox
           SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
               available_at = ?, updated_at = ?, last_error = ?
           WHERE status = 'running'
             AND effect_type IN (${REPLAY_SAFE_EFFECT_TYPES.map(() => '?').join(',')})`,
        )
        .run(
          now,
          now,
          PROCESS_LOSS_REQUEUED_ERROR,
          ...REPLAY_SAFE_EFFECT_TYPES,
        );
      return {
        requeued: requeued.changes,
        cancelled: cancelled.changes + unknownCancelled,
      };
    })();
  }

  /**
   * Poda succeeded/cancelled com `completed_at <= now - retentionMs`.
   * `retentionMs = 0` poda todo assentado. Failed fica (limpeza de thread
   * mantém a worktree enquanto houver falha) — política T3.
   * `maxBatches` limita o tick: cada lote tem no máximo 500 linhas.
   */
  pruneSettled(
    retentionMs = SETTLED_EFFECT_RETENTION_MS,
    maxBatches = Number.POSITIVE_INFINITY,
  ): number {
    const db = this.#binding.writeDatabase();
    const cutoff = this.#binding.now() - Math.max(0, retentionMs);
    const batches = Math.max(0, maxBatches);
    return db.transaction((): number => {
      let deleted = 0;
      for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
        const batch = db
          .prepare(
            `SELECT effect_id, command_id FROM effect_outbox
             WHERE status IN ('succeeded', 'cancelled') AND completed_at <= ?
             LIMIT 500`,
          )
          .all(cutoff) as Array<{ effect_id: string; command_id: string }>;
        if (batch.length === 0) break;
        const effectIds = batch.map((row) => row.effect_id);
        const commandIds = batch.map((row) => row.command_id);
        const effectPlaceholders = effectIds.map(() => '?').join(', ');
        const removed = db
          .prepare(
            `DELETE FROM effect_outbox WHERE effect_id IN (${effectPlaceholders})`,
          )
          .run(...effectIds);
        deleted += removed.changes;
        // UUID inventado pelo despacho não é reapresentável. operationId
        // do chamador (generated_invocation = 0) continua o replay.
        const commandPlaceholders = commandIds.map(() => '?').join(', ');
        db.prepare(
          `DELETE FROM command_receipts
           WHERE generated_invocation = 1
             AND command_id IN (${commandPlaceholders})`,
        ).run(...commandIds);
        if (batch.length < 500) break;
      }
      return deleted;
    })();
  }
}

export function createScopedEffectOutboxStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): EffectOutboxStore {
  return new EffectOutboxStore(runtimeManager, scope, options);
}
