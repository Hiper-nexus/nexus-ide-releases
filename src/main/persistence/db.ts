import path from 'node:path';
import { app } from 'electron';

/**
 * SQLite persistence layer.
 *
 * This phase (2a) uses a JSON file as the authoritative layout store (see
 * layout-store.ts). The SQLite schema is created here so later phases can grow
 * real workspace/session persistence without a migration scramble.
 *
 * better-sqlite3 is a native module; if it fails to load or rebuild we degrade
 * gracefully to null so the terminal app still runs.
 */

// Minimal structural type — we avoid importing better-sqlite3 types so a load
// failure never breaks the build.
export interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace (
  id          INTEGER PRIMARY KEY,
  layout_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS squads (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  builtin                   INTEGER NOT NULL DEFAULT 0,
  orchestrator_instructions TEXT NOT NULL DEFAULT '',
  roster_json               TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS missions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  squad_id        TEXT,
  milestones_json TEXT NOT NULL DEFAULT '[]',
  orch_session_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  session_id     TEXT,
  from_agent     TEXT,
  status         TEXT NOT NULL,
  summary        TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  delivered      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_lists (
  id         TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  mission_id TEXT,
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

let db: Db | null = null;
let initialized = false;

/** Lazily open the DB and create the schema. Returns null if unavailable. */
export function getDb(): Db | null {
  if (initialized) return db;
  initialized = true;
  try {
    // Required lazily so a missing/broken native binary is contained here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (file: string) => Db;
    const file = path.join(app.getPath('userData'), 'nexus.db');
    db = new Database(file);
    db.exec(SCHEMA);
    // Additive migrations: ALTER fails when the column already exists — safe
    // to ignore (CREATE TABLE IF NOT EXISTS never retrofits new columns).
    try {
      db.exec(
        "ALTER TABLE squads ADD COLUMN native_instructions TEXT NOT NULL DEFAULT ''",
      );
    } catch {
      // Column already present.
    }
  } catch (err) {
    console.warn('[nexus] SQLite unavailable, falling back to JSON only:', err);
    db = null;
  }
  return db;
}

export function closeDb(): void {
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
}
