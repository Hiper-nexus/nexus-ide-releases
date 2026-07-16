import path from 'node:path';
import { app } from 'electron';
import { migrateSchema } from './schema-migrations';

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

CREATE TABLE IF NOT EXISTS mission_panes (
  id         TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  model      TEXT,
  account_id TEXT,
  cwd        TEXT,
  title      TEXT NOT NULL,
  agent_name TEXT,
  role       TEXT NOT NULL DEFAULT 'worker',
  effort     TEXT,
  scope_json TEXT,
  allowed_tools_json TEXT,
  allowed_skills_json TEXT,
  created_at INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  adapter_id     TEXT NOT NULL,
  label          TEXT NOT NULL,
  mode           TEXT NOT NULL,
  upstream       TEXT NOT NULL DEFAULT 'anthropic',
  email          TEXT,
  cooldown_until INTEGER,
  last_error     TEXT,
  active          INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

/* Derived from can1357/oh-my-pi@03c48d073 auth-storage cooldown machine (MIT):
   espelho SQLite dos blocos de cooldown por conta+escopo (auth_credential_blocks
   no omp). block_scope '' = conta inteira; 'tier:<família>' = só aquele tier.
   probe_after = min(blocked_until, marcação+30min): instante a partir do qual
   UMA sondagem last-resort é permitida; probed_at marca a sondagem consumida.
   Migração: CREATE TABLE IF NOT EXISTS roda em todo open (padrão do repo). */
CREATE TABLE IF NOT EXISTS account_cooldown_blocks (
  account_id    TEXT NOT NULL,
  block_scope   TEXT NOT NULL DEFAULT '',
  blocked_until INTEGER NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  probe_after   INTEGER NOT NULL,
  probed_at     INTEGER,
  PRIMARY KEY (account_id, block_scope)
);

CREATE TABLE IF NOT EXISTS provider_pane_sessions (
  installation_id TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  checkout_id     TEXT NOT NULL,
  pane_id         TEXT NOT NULL,
  adapter_id      TEXT NOT NULL,
  session_key     TEXT NOT NULL CHECK (session_key IN ('session_id', 'conversation_id')),
  session_id      TEXT NOT NULL,
  transcript_path TEXT,
  updated_at      INTEGER NOT NULL,
  /** Vault account that owns this provider session (exact resume guard). */
  account_id      TEXT,
  PRIMARY KEY (installation_id, project_id, checkout_id, pane_id, adapter_id)
);
`;

let db: Db | null = null;
let initialized = false;
let degraded = false;

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
    migrateSchema(db);
  } catch (err) {
    degraded = true;
    console.error(
      '[nexus] SQLite indisponível — MODO DEGRADADO: missões, squads e ' +
        'histórico NÃO serão persistidos nesta sessão (apenas estado em memória/JSON):',
      err,
    );
    try {
      db?.close();
    } catch {
      // The original open/migration error is the actionable failure.
    }
    db = null;
  }
  return db;
}

/** True quando o better-sqlite3 falhou no load e a persistência está degradada. */
export function isDbDegraded(): boolean {
  return degraded;
}

export function closeDb(): void {
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
}
