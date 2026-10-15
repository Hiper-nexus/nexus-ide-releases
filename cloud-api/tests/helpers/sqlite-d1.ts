import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Test D1 adapter backed by the same SQLite statements used in the Worker.
 * It deliberately does not emulate Postgres or expose transactions to services.
 */
/** Node 22.14 ainda não tem StatementSync.columns(); versões novas têm. */
function columnNames(statement: { columns?: () => Array<{ name: string }> }): string[] | null {
  return typeof statement.columns === 'function' ? statement.columns().map((column) => column.name) : null;
}

function returnsRows(query: string): boolean {
  const sql = query.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (/^(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) return true;
  return /^\s*WITH\b/i.test(sql) && /\bSELECT\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql);
}

/** O D1 reutiliza ?1/?2. O node:sqlite 22.14 só aceita ?. Cada ocorrência numerada
 * vira um ? posicional com o mesmo valor já ligado. */
function expandNumbered(query: string, values: readonly SQLInputValue[]): { query: string; values: SQLInputValue[] } {
  if (!/\?\d/.test(query)) return { query, values: [...values] };
  const expanded: SQLInputValue[] = [];
  const rewritten = query.replace(/\?(\d+)/g, (_match, digits: string) => {
    const index = Number(digits) - 1;
    if (index < 0 || index >= values.length) throw new Error(`SQLite numbered parameter ?${digits} has no binding`);
    expanded.push(values[index] as SQLInputValue);
    return '?';
  });
  return { query: rewritten, values: expanded };
}

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
    const expanded = expandNumbered(this.query, this.values);
    const statement = this.database.prepare(expanded.query);
    const names = columnNames(statement);
    const reads = names !== null ? names.length > 0 : returnsRows(this.query);
    const results = reads ? statement.all(...expanded.values).map((row) => ({ ...row })) : [];
    const change = reads ? this.database.prepare('SELECT changes() AS changes, last_insert_rowid() AS id').get() : statement.run(...expanded.values);
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
    const expanded = expandNumbered(this.query, this.values);
    const statement = this.database.prepare(expanded.query);
    const known = columnNames(statement);
    const source = statement.all(...expanded.values);
    const columns = known ?? Object.keys(source[0] ?? {});
    const rows = source.map((row) => columns.map((column) => row[column]) as T);
    this.onExecuted?.();
    return options?.columnNames ? [columns, ...rows] : rows;
  }
}

export class SqliteD1 implements D1Database {
  readonly sqlite: DatabaseSync;
  /** Chamadas ao banco como o D1 as conta: cada consulta avulsa e cada batch valem uma. */
  queryCount = 0;
  #inBatch = false;
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of ['0001_core.sql', '0002_trial_admin.sql', '0003_checkout_reservation.sql', '0004_oauth_client.sql', '0005_license_codes.sql', '0006_account_notices.sql', '0007_bug_reports.sql', '0008_billing_intervals_coupons.sql', '0009_account_activity.sql', '0010_refresh_families.sql', '0011_refresh_superseded.sql']) {
      this.sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
  }
  prepare(query: string): D1PreparedStatement { return new SqliteStatement(this.sqlite, query, [], () => { if (!this.#inBatch) this.queryCount += 1; }); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.queryCount += 1;
    this.#inBatch = true;
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
    } finally {
      this.#inBatch = false;
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
