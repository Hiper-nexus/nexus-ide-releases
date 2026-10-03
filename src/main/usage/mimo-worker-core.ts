import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { parseMimoUsageRow } from './mimo-transcript';
import { MIMO_RAW_ROW_BYTES, MIMO_SCAN_ROWS, mimoWorkerRequestSchema,
  type MimoRuntimeInput, type MimoWorkerReply, type MimoWorkerRequest } from './mimo-worker-protocol';

function sameFile(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
interface SnapshotDatabase { readonly db: Database.Database; readonly dispose: () => void }
function openDatabase(runtime: MimoRuntimeInput, privateRoot?: string): SnapshotDatabase | null {
  let snapshot: string | undefined; let db: Database.Database | undefined;
  const descriptors: number[] = [];
  try {
    if (path.basename(runtime.stateRoot) !== runtime.checkoutId ||
      path.basename(path.dirname(runtime.stateRoot)) !== 'mimo-code' ||
      runtime.databasePath !== path.join(runtime.stateRoot, 'database', 'mimocode.db') ||
      fs.realpathSync(runtime.stateRoot) !== runtime.stateRoot ||
      fs.realpathSync(runtime.databasePath) !== runtime.databasePath) return null;
    const sources = ['', '-wal', '-shm', '-journal'].map(suffix => {
      const file = `${runtime.databasePath}${suffix}`;
      const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1n)) throw new Error('Unsafe MiMo source');
      return { suffix, file, stat };
    });
    if (!sources[0]!.stat) return null;
    snapshot = fs.mkdtempSync(path.join(privateRoot ?? os.tmpdir(), 'mimo-snapshot-'));
    fs.chmodSync(snapshot, 0o700);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (const source of sources) {
      if (!source.stat) continue;
      // Pin the checked object before reading bytes. fstat rejects directory
      // swaps even where O_NOFOLLOW is unavailable; SQLite never opens this name.
      const fd = fs.openSync(source.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      descriptors.push(fd);
      if (!sameFile(source.stat, fs.fstatSync(fd, { bigint: true })) ||
        fs.realpathSync(source.file) !== source.file) throw new Error('MiMo source replaced');
      // Build a private WAL index rather than copying/modifying native -shm.
      if (source.suffix !== '-shm') {
        const target = fs.openSync(path.join(snapshot, `mimocode.db${source.suffix}`), 'wx', 0o600);
        try {
          let position = 0;
          for (;;) {
            const size = fs.readSync(fd, buffer, 0, buffer.length, position);
            if (size === 0) break;
            let written = 0;
            while (written < size) written += fs.writeSync(target, buffer, written, size - written);
            position += size;
          }
        } finally { fs.closeSync(target); }
      }
      if (!sameFile(source.stat, fs.fstatSync(fd, { bigint: true }))) throw new Error('MiMo source changed');
    }
    for (const source of sources) {
      const current = fs.lstatSync(source.file, { bigint: true, throwIfNoEntry: false });
      if (source.stat ? !current || !sameFile(source.stat, current) || fs.realpathSync(source.file) !== source.file : current) {
        throw new Error('MiMo source replaced during snapshot');
      }
    }
    if (fs.realpathSync(runtime.stateRoot) !== runtime.stateRoot) throw new Error('MiMo root replaced');
    db = new Database(path.join(snapshot, 'mimocode.db'), { readonly: true, fileMustExist: true, timeout: 100 });
    db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF');
    const ownedDb = db; const ownedSnapshot = snapshot;
    return { db: ownedDb, dispose: () => { try { ownedDb.close(); }
      finally { fs.rmSync(ownedSnapshot, { recursive: true, force: true }); } } };
  } catch {
    try { db?.close(); } catch { /* Failed opens have no live SQL authority. */ }
    if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true });
    return null;
  } finally { for (const fd of descriptors) fs.closeSync(fd); }
}

/** Only the isolated process calls this: native VM and snapshot IO stay off Main. */
export function readMimoDatabase(raw: MimoWorkerRequest, privateRoot?: string): MimoWorkerReply {
  const input = mimoWorkerRequestSchema.parse(raw);
  const cursor = input.cursor ?? { at: 0, id: '' };
  const empty = { job: input.job, valid: false, fetched: 0, cursor, highWatermark: cursor.at, events: [] };
  const snapshot = openDatabase(input.runtime, privateRoot);
  if (!snapshot) return empty;
  const db = snapshot.db;
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
        input.through ?? Number.MAX_SAFE_INTEGER, MIMO_RAW_ROW_BYTES, MIMO_SCAN_ROWS) as
        Array<{ id: string; session_id: string; time_updated: number; data: string }>;
    const events = [];
    let last = cursor; let highWatermark = cursor.at;
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length > 256) continue;
      last = { at: row.time_updated, id: row.id }; highWatermark = Math.max(highWatermark, row.time_updated);
      const parsed = parseMimoUsageRow(row);
      if (!parsed || parsed.event.timestamp === null) continue;
      try {
        const cwd = fs.realpathSync(parsed.cwd);
        if (![input.runtime.cwd, path.join(input.runtime.stateRoot, 'worktree')].some(rootPath => {
          const relative = path.relative(rootPath, cwd);
          return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        })) continue;
        events.push({ ...parsed.event, timestamp: parsed.event.timestamp, sessionId: row.session_id,
          messageId: row.id, nativeUpdatedAt: row.time_updated });
      } catch { /* unavailable/foreign cwd is never attributed */ }
    }
    return { job: input.job, valid: true, fetched: rows.length, cursor: last, highWatermark, events };
  } catch { return empty; }
  finally { snapshot.dispose(); }
}
