import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ScopedStoreBinding, ScopedStoreCorruptionError } from '../orch/scoped-store';
import { canonicalJson } from './canonical-json';
import {
  parseLedgerEvent,
  verifyEventChain,
  type LedgerEvent,
  type LedgerStorage,
} from './event-ledger';

const GENESIS_HASH = '0'.repeat(64);

interface EventRow {
  event_json: string;
}

function parseRow(row: EventRow): LedgerEvent {
  try {
    if (Buffer.byteLength(row.event_json, 'utf8') > 512 * 1024) {
      throw new Error('ledger event exceeds storage limit');
    }
    return parseLedgerEvent(JSON.parse(row.event_json) as unknown);
  } catch (error) {
    throw new ScopedStoreCorruptionError('event ledger', { cause: error });
  }
}

export class SqliteEventLedgerStorage implements LedgerStorage {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope);
  }

  readLast(): LedgerEvent | null {
    return this.list().at(-1) ?? null;
  }

  compareAndAppend(
    expectedSequence: number,
    expectedHash: string,
    event: LedgerEvent,
  ): boolean {
    const parsed = parseLedgerEvent(event);
    if (
      parsed.projectId !== this.#binding.scope.projectId ||
      parsed.checkoutId !== this.#binding.scope.checkoutId
    ) {
      throw new Error('ledger event belongs to another project scope');
    }
    if (
      parsed.sequence !== expectedSequence + 1 ||
      parsed.previousHash !== expectedHash
    ) {
      return false;
    }
    const db = this.#binding.writeDatabase();
    return db.transaction(() => {
      const last = db
        .prepare(
          `SELECT sequence, event_hash FROM event_ledger
           ORDER BY sequence DESC LIMIT 1`,
        )
        .get() as { sequence: number; event_hash: string } | undefined;
      const actualSequence = last?.sequence ?? 0;
      const actualHash = last?.event_hash ?? GENESIS_HASH;
      if (actualSequence !== expectedSequence || actualHash !== expectedHash) {
        return false;
      }
      const result = db
        .prepare(
          `INSERT INTO event_ledger
             (sequence, id, mission_id, event_type, previous_hash,
              event_hash, event_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.sequence,
          parsed.id,
          parsed.missionId ?? null,
          parsed.type,
          parsed.previousHash,
          parsed.eventHash,
          canonicalJson(parsed),
          parsed.occurredAt,
        );
      return result.changes === 1;
    })();
  }

  list(): readonly LedgerEvent[] {
    const rows = this.#binding
      .readDatabase()
      .prepare('SELECT event_json FROM event_ledger ORDER BY sequence')
      .all() as EventRow[];
    const events = rows.map(parseRow);
    for (const event of events) {
      if (
        event.projectId !== this.#binding.scope.projectId ||
        event.checkoutId !== this.#binding.scope.checkoutId
      ) {
        throw new ScopedStoreCorruptionError('event ledger scope');
      }
    }
    const result = verifyEventChain(events);
    if (!result.valid) {
      throw new ScopedStoreCorruptionError(
        `event ledger chain at sequence ${result.brokenSequence}: ${result.reason}`,
      );
    }
    return Object.freeze(events);
  }
}

export function createSqliteEventLedgerStorage(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
): SqliteEventLedgerStorage {
  return new SqliteEventLedgerStorage(runtimeManager, scope);
}
