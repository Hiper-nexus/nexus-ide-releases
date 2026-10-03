import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseMimoUsageRow } from './mimo-transcript';
import { MIMO_RAW_ROW_BYTES, MIMO_SCAN_ROWS, mimoWorkerRequestSchema,
  type MimoRuntimeInput, type MimoWorkerReply, type MimoWorkerRequest } from './mimo-worker-protocol';

function openDatabase(runtime: MimoRuntimeInput): Database.Database | null {
  try {
    if (path.basename(runtime.stateRoot) !== runtime.checkoutId ||
      path.basename(path.dirname(runtime.stateRoot)) !== 'mimo-code' ||
      runtime.databasePath !== path.join(runtime.stateRoot, 'database', 'mimocode.db') ||
      fs.realpathSync(runtime.stateRoot) !== runtime.stateRoot ||
      fs.realpathSync(runtime.databasePath) !== runtime.databasePath) return null;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const stat = fs.lstatSync(`${runtime.databasePath}${suffix}`, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink > 1)) return null;
    }
    const db = new Database(runtime.databasePath, { readonly: true, fileMustExist: true, timeout: 100 });
    db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF');
    return db;
  } catch { return null; }
}

/** Only the dedicated worker calls this: SQLite VM work is synchronous there. */
export function readMimoDatabase(raw: MimoWorkerRequest): MimoWorkerReply {
  const input = mimoWorkerRequestSchema.parse(raw);
  const cursor = input.cursor ?? { at: 0, id: '' };
  const empty = { job: input.job, valid: false, fetched: 0, cursor, highWatermark: cursor.at, events: [] };
  const db = openDatabase(input.runtime);
  if (!db) return empty;
  try {
    const root = db.prepare('SELECT directory, parent_id FROM session WHERE id = ?').get(input.rootId) as
      { directory: unknown; parent_id: unknown } | undefined;
    if (root?.parent_id !== null || typeof root.directory !== 'string' ||
      fs.realpathSync(root.directory) !== fs.realpathSync(input.runtime.cwd)) return empty;
    if (input.kind === 'validate') return { ...empty, valid: true };
    const rows = db.prepare(`WITH RECURSIVE owned(id) AS (
      SELECT ? UNION SELECT s.id FROM session s JOIN owned o ON s.parent_id = o.id LIMIT 256
    ) SELECT m.id, m.session_id, m.time_updated, m.data FROM message m JOIN owned o ON m.session_id = o.id
      WHERE (m.time_updated > ? OR (m.time_updated = ? AND m.id > ?))
        AND typeof(m.time_updated) = 'integer' AND m.time_updated BETWEEN 0 AND ?
        AND typeof(m.id) = 'text' AND length(CAST(m.id AS BLOB)) BETWEEN 1 AND 256
        AND length(CAST(m.data AS BLOB)) <= ?
      ORDER BY m.time_updated, m.id LIMIT ?`).all(input.rootId, cursor.at, cursor.at, cursor.id,
        Number.MAX_SAFE_INTEGER, MIMO_RAW_ROW_BYTES, MIMO_SCAN_ROWS) as
        Array<{ id: string; session_id: string; time_updated: number; data: string }>;
    const events = [];
    let last = cursor; let highWatermark = cursor.at;
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length > 256) continue;
      last = { at: row.time_updated, id: row.id }; highWatermark = Math.max(highWatermark, row.time_updated);
      const parsed = parseMimoUsageRow(row);
      if (!parsed) continue;
      try {
        const cwd = fs.realpathSync(parsed.cwd);
        if (![input.runtime.cwd, path.join(input.runtime.stateRoot, 'worktree')].some(rootPath => {
          const relative = path.relative(rootPath, cwd);
          return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        })) continue;
        events.push({ ...parsed.event, sessionId: row.session_id, messageId: row.id });
      } catch { /* unavailable/foreign cwd is never attributed */ }
    }
    return { job: input.job, valid: true, fetched: rows.length, cursor: last, highWatermark, events };
  } catch { return empty; }
  finally { db.close(); }
}
