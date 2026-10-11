import path from 'node:path';
import { app } from 'electron';
import { migrateSchema, planSchemaMigration } from './schema-migrations';
import {
  confirmDbMigrationBoot,
  markDbMigrationApplied,
  pruneDbMigrationSnapshots,
  readDbMigrationState,
  recoverInterruptedDbMigration,
  restoreDbMigrationSnapshot,
  takeDbMigrationSnapshot,
  type DbMigrationState,
} from './db-migration-snapshot';

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
  runtime_source_squad_id    TEXT,
  runtime_source_squad_hash  TEXT,
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

CREATE TABLE IF NOT EXISTS provider_session_accounts (
  installation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  account_id TEXT,
  PRIMARY KEY (installation_id, project_id, checkout_id, adapter_id, session_id)
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

/* F-1237: arquivos que cada conversa do provider editou (PostToolUse de
   edição, recebido pelo bearer do próprio pane), relativos à raiz de execução.
   O portão de regressão de um pane que retoma exatamente a conversa os conta
   como dele quando a última escrita no arquivo é a registrada aqui. */
CREATE TABLE IF NOT EXISTS provider_conversation_edits (
  installation_id TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  checkout_id     TEXT NOT NULL,
  adapter_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  root_real_path  TEXT NOT NULL,
  rel_path        TEXT NOT NULL,
  edited_at       INTEGER NOT NULL,
  PRIMARY KEY (installation_id, project_id, checkout_id, adapter_id, session_id, root_real_path, rel_path)
);

/* tmux-backed PTY sessions that survive app quit (feature.pty.persistentSession). */
CREATE TABLE IF NOT EXISTS persistent_pty_sessions (
  workspace_id TEXT NOT NULL,
  pane_id      TEXT NOT NULL,
  tmux_name    TEXT NOT NULL UNIQUE,
  cwd          TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, pane_id)
);
`;

let db: Db | null = null;
let initialized = false;
let degraded = false;
/** nexus.db cuja migração ainda espera o primeiro mount do renderer. */
let awaitingBootConfirmation: string | null = null;

function appVersion(): string {
  try {
    return typeof app.getVersion === 'function' ? app.getVersion() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Snapshot antes de migrar (DSK-05). Só existe migração pendente quando falta
 * tabela ou coluna; banco novo ou já atual não gera cópia. Se o snapshot
 * falhar (disco cheio, permissão), a migração segue como antes desta mudança:
 * o snapshot é uma rede extra, nunca um motivo novo para o modo degradado.
 */
function snapshotBeforeMigration(open: Db, file: string): DbMigrationState | null {
  const plan = planSchemaMigration(open, SCHEMA);
  if (plan.fresh || plan.pending.length === 0) return null;
  try {
    return takeDbMigrationSnapshot(open, file, {
      fromSchema: plan.fromVersion,
      toSchema: plan.toVersion,
      appVersion: appVersion(),
    });
  } catch (err) {
    console.error(
      '[nexus] não consegui gravar o snapshot do nexus.db antes de migrar ' +
        `(${plan.pending.join(', ')}); migrando SEM cópia de segurança:`,
      err,
    );
    return null;
  }
}

/** Migração de um boot anterior que nunca montou a interface: espera este boot. */
function noteUnconfirmedMigration(file: string): void {
  try {
    const state = readDbMigrationState(file);
    if (state?.phase !== 'migrated') return;
    awaitingBootConfirmation = file;
    console.warn(
      `[nexus] o boot anterior (app ${state.appVersion}) migrou o nexus.db e não chegou a ` +
        `montar a interface; snapshot ${state.snapshot} preservado em db-snapshots/ até um boot confirmar.`,
    );
  } catch (err) {
    console.warn('[nexus] estado de migração do nexus.db ilegível:', err);
  }
}

/** Lazily open the DB and create the schema. Returns null if unavailable. */
export function getDb(): Db | null {
  if (initialized) return db;
  initialized = true;
  let file: string | null = null;
  let snapshot: DbMigrationState | null = null;
  try {
    // Required lazily so a missing/broken native binary is contained here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (file: string) => Db;
    file = path.join(app.getPath('userData'), 'nexus.db');
    const recovered = recoverInterruptedDbMigration(file);
    if (recovered) {
      console.warn(
        `[nexus] o boot anterior caiu no meio da migração do nexus.db (app ${recovered.appVersion}); ` +
          `banco restaurado do snapshot ${recovered.snapshot} — dados intactos, migrando de novo.`,
      );
    }
    db = new Database(file);
    // WAL + synchronous FULL: a mesma durabilidade do journal de rollback,
    // com um fsync por commit em vez de criar/apagar o -journal a cada
    // escrita (contas, cooldowns e sessões de pane são gravados no spawn), e
    // leitores que não bloqueiam o escritor. Mesmo padrão dos bancos de
    // runtime do projeto. Cópias do arquivo precisam levar -wal e -shm juntos.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    snapshot = snapshotBeforeMigration(db, file);
    db.exec(SCHEMA);
    migrateSchema(db);
    db.exec(`INSERT OR IGNORE INTO provider_session_accounts
      SELECT installation_id, project_id, checkout_id, adapter_id, session_id, account_id
      FROM provider_pane_sessions WHERE adapter_id = 'mimo-code' AND session_key = 'session_id'`);
    if (snapshot) {
      // Dentro do try de propósito: se nem o estado `migrated` grava, o
      // `migrating` no disco faria o próximo boot desfazer esta sessão inteira;
      // restaurar agora não perde nada (ninguém escreveu desde o snapshot).
      snapshot = markDbMigrationApplied(file, snapshot);
      awaitingBootConfirmation = file;
    } else {
      noteUnconfirmedMigration(file);
    }
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
    if (file && snapshot) {
      try {
        restoreDbMigrationSnapshot(file, snapshot);
        console.error(
          `[nexus] a migração do nexus.db falhou; banco restaurado do snapshot ${snapshot.snapshot} ` +
            '— dados intactos no disco. O próximo boot tenta migrar de novo.',
        );
      } catch (restoreErr) {
        console.error(
          `[nexus] a restauração do snapshot ${snapshot.snapshot} não terminou; ` +
            'o próximo boot conclui antes de abrir o banco:',
          restoreErr,
        );
      }
    }
  }
  if (file) {
    try {
      pruneDbMigrationSnapshots(file);
    } catch (err) {
      console.warn('[nexus] retenção de snapshots do nexus.db falhou:', err);
    }
  }
  return db;
}

/**
 * Boot confirmado: a versão que migrou o nexus.db montou o renderer. Chamado
 * no primeiro mount da sessão (window.ts); sem migração em aberto, não faz nada.
 */
export function confirmDbBoot(): void {
  const file = awaitingBootConfirmation;
  if (!file) return;
  awaitingBootConfirmation = null;
  try {
    confirmDbMigrationBoot(file);
  } catch (err) {
    console.warn('[nexus] não consegui gravar o boot confirmado do nexus.db:', err);
  }
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
