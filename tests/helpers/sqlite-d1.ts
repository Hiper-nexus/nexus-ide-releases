import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Test D1 adapter backed by the same SQLite statements used in the Worker.
 * It deliberately does not emulate Postgres or expose transactions to services.
 */
class SqliteStatement implements D1PreparedStatement {
  constructor(readonly database: DatabaseSync, readonly query: string, readonly values: readonly SQLInputValue[] = [], readonly onExecuted?: () => void) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const bound = values.map((value): SQLInputValue => {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      throw new TypeError('Unsupported D1 binding');
    });
    return new SqliteStatement(this.database, this.query, bound, this.onExecuted);
  }

  execute<T>(): D1Result<T> {
    const statement = this.database.prepare(this.query);
    const results = statement.columns().length ? statement.all(...this.values) : [];
    const change = statement.columns().length ? this.database.prepare('SELECT changes() AS changes, last_insert_rowid() AS id').get() : statement.run(...this.values);
    const isRead = /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(this.query);
    const changes = isRead ? 0 : Number(change?.changes ?? 0);
    const lastRowId = Number(change && 'id' in change ? change.id : change && 'lastInsertRowid' in change ? change.lastInsertRowid : 0);
    const meta: D1Meta & Record<string, unknown> = {
      duration: 0, size_after: 0, rows_read: results.length, rows_written: changes,
      last_row_id: lastRowId, changed_db: changes > 0, changes, served_by_primary: true,
    };
    this.onExecuted?.();
    return { success: true, results: results as T[], meta };
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.execute<Record<string, unknown>>().results[0];
    if (!row) return null;
    if (colName !== undefined && !(colName in row)) throw new Error('D1 column does not exist');
    return (colName === undefined ? row : row[colName]) as T;
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.database.prepare(this.query);
    const columns = statement.columns().map((column) => column.name);
    const rows = statement.all(...this.values).map((row) => columns.map((column) => row[column]) as T);
    this.onExecuted?.();
    return options?.columnNames ? [columns, ...rows] : rows;
  }
}

export class SqliteD1 implements D1Database {
  readonly sqlite: DatabaseSync;
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of ['0001_core.sql', '0002_trial_admin.sql', '0003_checkout_reservation.sql', '0004_oauth_client.sql', '0005_license_codes.sql', '0006_account_notices.sql']) {
      this.sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
  }
  prepare(query: string): D1PreparedStatement { return new SqliteStatement(this.sqlite, query); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteStatement) || statement.database !== this.sqlite) throw new Error('Foreign D1 statement');
        return statement.execute<T>();
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  async exec(query: string): Promise<D1ExecResult> { this.sqlite.exec(query); return { count: 1, duration: 0 }; }
  withSession(_constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    let used = false;
    return {
      prepare: (query) => new SqliteStatement(this.sqlite, query, [], () => { used = true; }),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => { used = true; return this.batch<T>(statements); },
      getBookmark: () => used ? 'sqlite-test-primary' : null,
    };
  }
  async dump(): Promise<ArrayBuffer> { throw new Error('Deprecated D1 dump is not used by tests'); }
  close(): void { this.sqlite.close(); }
}
