import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ProjectExecutionScope } from '../../shared/types';
import type { UsageRecord } from './usage-store';
import { parseMimoUsageRow } from './mimo-transcript';

export interface MimoSessionBinding {
  readonly ptySessionId: string;
  readonly paneId: string;
  readonly accountId?: string;
  /** Private native credential identity; never projected into usage or renderer DTOs. */
  readonly nativeOwnerKey?: string;
  readonly missionId?: string;
  readonly scope: ProjectExecutionScope;
  readonly cwd: string;
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly providerSessionId: string;
}
export type MimoRuntime = Omit<MimoSessionBinding, 'providerSessionId'>;
const POLL_MS = 1_000;
const MAX_ROWS = 128;
const MAX_SEEN_MESSAGES = 8_192;

/** Only the Main-provided checkout database; no native profile discovery. */
function openDatabase(runtime: MimoRuntime): Database.Database | null {
  try {
    if (path.basename(runtime.stateRoot) !== runtime.scope.checkoutId ||
      path.basename(path.dirname(runtime.stateRoot)) !== 'mimo-code' ||
      runtime.databasePath !== path.join(runtime.stateRoot, 'database', 'mimocode.db') ||
      fs.realpathSync(runtime.stateRoot) !== runtime.stateRoot ||
      fs.realpathSync(runtime.databasePath) !== runtime.databasePath) return null;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const stat = fs.lstatSync(`${runtime.databasePath}${suffix}`, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink > 1)) return null;
    }
    const db = new Database(runtime.databasePath, { readonly: true, fileMustExist: true, timeout: 100 });
    db.pragma('query_only = ON');
    db.pragma('trusted_schema = OFF');
    return db;
  } catch { return null; }
}

function rootMatches(db: Database.Database, runtime: MimoRuntime, id: string): boolean {
  const row = db.prepare('SELECT directory, parent_id FROM session WHERE id = ?').get(id) as
    { directory: unknown; parent_id: unknown } | undefined;
  return row?.parent_id === null && typeof row.directory === 'string' &&
    fs.realpathSync(row.directory) === fs.realpathSync(runtime.cwd);
}

export function validateMimoRootSession(runtime: MimoRuntime, id: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) return false;
  const db = openDatabase(runtime);
  if (!db) return false;
  try { return rootMatches(db, runtime, id); }
  catch { return false; }
  finally { db.close(); }
}

interface ScanState {
  binding: MimoSessionBinding;
  cursor: { at: number; id: string };
  highWatermark: number;
  seen: Map<string, string>;
}

/** Poll exact bound roots and their descendants. Rewritten messages update one row. */
export class MimoUsageScanner {
  readonly #states = new Map<string, ScanState>();
  #timer: ReturnType<typeof setInterval> | null = null;
  constructor(readonly onEvent: (binding: MimoSessionBinding, event: UsageRecord) => void) {}

  bind(binding: MimoSessionBinding): void {
    const previous = this.#states.get(binding.ptySessionId);
    if (previous?.binding.providerSessionId === binding.providerSessionId) return;
    if (previous) this.#scanState(previous);
    this.#states.set(binding.ptySessionId, { binding, cursor: { at: 0, id: '' }, highWatermark: 0, seen: new Map() });
  }

  start(): void {
    if (!this.#timer) this.#timer = setInterval(() => this.scan(), POLL_MS);
    this.#timer.unref?.();
  }

  remove(ptySessionId: string): void {
    const state = this.#states.get(ptySessionId);
    if (state) this.#scanState(state);
    this.#states.delete(ptySessionId);
  }

  scan(): void {
    for (const state of this.#states.values()) this.#scanState(state);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#states.clear();
  }

  #scanState(state: ScanState): void {
    const db = openDatabase(state.binding);
    if (!db) return;
    try {
      if (!rootMatches(db, state.binding, state.binding.providerSessionId)) return;
      const rows = db.prepare(`
        WITH RECURSIVE owned(id) AS (
          SELECT ? UNION SELECT s.id FROM session s JOIN owned o ON s.parent_id = o.id LIMIT 256
        )
        SELECT m.id, m.session_id, m.time_updated, m.data FROM message m
        JOIN owned o ON m.session_id = o.id
        WHERE (m.time_updated > ? OR (m.time_updated = ? AND m.id > ?))
          AND length(m.data) <= 65536
        ORDER BY m.time_updated, m.id LIMIT ?
      `).all(state.binding.providerSessionId, state.cursor.at, state.cursor.at, state.cursor.id, MAX_ROWS) as
        Array<{ id: string; session_id: string; time_updated: number; data: string }>;
      for (const row of rows) this.#consume(state, row);
      if (rows.length < MAX_ROWS) state.cursor = { at: Math.max(0, state.highWatermark - 1), id: '' };
    } catch {
      // Startup/migration/SQLite locks are transient; retry the same cursor.
    } finally { db.close(); }
  }

  #consume(state: ScanState, row: { id: string; time_updated: number }): void {
    if (!Number.isSafeInteger(row.time_updated) || row.time_updated < 0) return;
    state.cursor = { at: row.time_updated, id: row.id };
    state.highWatermark = Math.max(state.highWatermark, row.time_updated);
    const parsed = parseMimoUsageRow(row);
    if (!parsed) return;
    const cwd = fs.realpathSync(parsed.cwd);
    const allowed = [state.binding.cwd, path.join(state.binding.stateRoot, 'worktree')].some(root => {
      const relative = path.relative(root, cwd);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (!allowed) return;
    const fingerprint = JSON.stringify(parsed.event);
    if (state.seen.get(row.id) === fingerprint) return;
    this.onEvent(state.binding, parsed.event);
    state.seen.set(row.id, fingerprint);
    if (state.seen.size > MAX_SEEN_MESSAGES) state.seen.delete(state.seen.keys().next().value!);
  }
}
