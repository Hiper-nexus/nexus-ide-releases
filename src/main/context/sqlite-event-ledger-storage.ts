import type Database from 'better-sqlite3';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  prepareCached,
} from '../orch/scoped-store';
import { canonicalJson } from './canonical-json';
import {
  parseLedgerEvent,
  verifyEventChain,
  type LedgerEvent,
  type LedgerStorage,
} from './event-ledger';

const GENESIS_HASH = '0'.repeat(64);

interface VerifiedTip {
  readonly db: WeakRef<Database.Database>;
  readonly totalChanges: number;
  readonly dataVersion: number;
  readonly last: LedgerEvent | null;
}

function databaseRevision(db: Database.Database): Omit<VerifiedTip, 'db' | 'last'> {
  return prepareCached(db,
    `SELECT total_changes() AS totalChanges, data_version AS dataVersion
     FROM pragma_data_version`,
  ).get() as { totalChanges: number; dataVersion: number };
}

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
  #verifiedTip: VerifiedTip | null = null;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope);
  }

  readLast(): LedgerEvent | null {
    const db = this.#binding.readDatabase();
    // A caller-owned transaction can roll back without changing total_changes().
    if (db.inTransaction) return this.#listFromDatabase(db).at(-1) ?? null;
    return db.transaction(() => this.#readVerifiedTip(db).last)();
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
    const callerTransaction = db.inTransaction;
    let appendedTip: VerifiedTip | null = null;
    const appended = db.transaction(() => {
      // BEGIN IMMEDIATE fences writers until both the prefix and append are proved.
      const verified = callerTransaction
        ? this.#listFromDatabase(db).at(-1) ?? null
        : this.#readVerifiedTip(db).last;
      const last = prepareCached(db,
        `SELECT sequence, event_hash FROM event_ledger
         ORDER BY sequence DESC LIMIT 1`,
      ).get() as { sequence: number; event_hash: string } | undefined;
      const actualSequence = last?.sequence ?? 0;
      const actualHash = last?.event_hash ?? GENESIS_HASH;
      if ((verified?.sequence ?? 0) !== actualSequence ||
          (verified?.eventHash ?? GENESIS_HASH) !== actualHash) {
        throw new ScopedStoreCorruptionError('event ledger tip');
      }
      if (actualSequence !== expectedSequence || actualHash !== expectedHash) {
        return false;
      }
      const beforeAppend = databaseRevision(db);
      const result = prepareCached(db,
        `INSERT INTO event_ledger
           (sequence, id, mission_id, event_type, previous_hash,
            event_hash, event_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.sequence,
        parsed.id,
        parsed.missionId ?? null,
        parsed.type,
        parsed.previousHash,
        parsed.eventHash,
        canonicalJson(parsed),
        parsed.occurredAt,
      );
      if (result.changes !== 1) return false;
      const afterAppend = databaseRevision(db);
      // A trigger or additional write is not a proved one-event extension.
      if (afterAppend.totalChanges === beforeAppend.totalChanges + 1 &&
          afterAppend.dataVersion === beforeAppend.dataVersion) {
        appendedTip = { db: new WeakRef(db), ...afterAppend, last: parsed };
      }
      return true;
    }).immediate();
    // Never promote an uncommitted append from an enclosing transaction.
    if (appendedTip && !callerTransaction) this.#verifiedTip = appendedTip;
    return appended;
  }

  #readVerifiedTip(db: Database.Database): VerifiedTip {
    // Pin the WAL snapshot before sampling its data_version. An external writer
    // during this snapshot is observed on the following transaction.
    prepareCached(db,
      'SELECT sequence FROM event_ledger ORDER BY sequence DESC LIMIT 1',
    ).get();
    const revision = databaseRevision(db);
    const tip = this.#verifiedTip;
    if (tip?.db.deref() === db && tip.totalChanges === revision.totalChanges &&
        tip.dataVersion === revision.dataVersion) return tip;
    // ponytail: unrelated DB writes conservatively reverify the full prefix.
    // A table-specific revision trigger could narrow invalidation if needed.
    const last = this.#listFromDatabase(db).at(-1) ?? null;
    this.#verifiedTip = { db: new WeakRef(db), ...revision, last };
    return this.#verifiedTip;
  }

  list(): readonly LedgerEvent[] {
    return this.#listFromDatabase(this.#binding.readDatabase());
  }

  #listFromDatabase(db: Database.Database): readonly LedgerEvent[] {
    const rows = prepareCached(db,
      'SELECT event_json FROM event_ledger ORDER BY sequence',
    ).all() as EventRow[];
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
