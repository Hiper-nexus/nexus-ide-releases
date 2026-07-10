import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ProjectMigration } from './project-runtime-schema';

export type ProjectRuntimeFailureCode =
  | 'unsafe_storage'
  | 'database_open_failed'
  | 'integrity_check_failed'
  | 'foreign_keys_unavailable'
  | 'unmanaged_database'
  | 'migration_history_invalid'
  | 'migration_checksum_mismatch'
  | 'runtime_scope_mismatch'
  | 'backup_failed'
  | 'migration_failed';

export class ProjectRuntimeFault extends Error {
  readonly code: ProjectRuntimeFailureCode;
  readonly lastBackupPath: string | null;

  constructor(
    code: ProjectRuntimeFailureCode,
    message: string,
    options: { cause?: unknown; lastBackupPath?: string | null } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProjectRuntimeFault';
    this.code = code;
    this.lastBackupPath = options.lastBackupPath ?? null;
  }
}

interface AppliedMigrationRow {
  migration_id: string;
  checksum: string;
  schema_version: number;
  app_version: string;
  applied_by_app_version: string;
  applied_at: number;
}

interface RuntimeScopeRow {
  project_id: string;
  checkout_id: string;
}

export interface ProjectMigrationRunInput {
  db: Database.Database;
  runtimeDirectory: string;
  projectId: string;
  checkoutId: string;
  appVersion: string;
  migrations: readonly ProjectMigration[];
  now: () => number;
}

export interface ProjectMigrationRunResult {
  schemaVersion: number;
  quickCheck: readonly string[];
  lastBackupPath: string | null;
}

const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS __nexus_runtime_scope (
  singleton                  INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id                 TEXT NOT NULL,
  checkout_id                TEXT NOT NULL,
  initialized_at             INTEGER NOT NULL,
  initialized_by_app_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS __nexus_schema_migrations (
  migration_id           TEXT PRIMARY KEY,
  checksum               TEXT NOT NULL,
  schema_version         INTEGER NOT NULL UNIQUE,
  app_version            TEXT NOT NULL,
  applied_by_app_version TEXT NOT NULL,
  applied_at             INTEGER NOT NULL
);
`;

function fault(
  code: ProjectRuntimeFailureCode,
  message: string,
  cause?: unknown,
): ProjectRuntimeFault {
  return new ProjectRuntimeFault(code, message, { cause });
}

function configureSafetyPragmas(db: Database.Database): void {
  db.pragma('busy_timeout = 5000');
  db.pragma('trusted_schema = OFF');
  db.pragma('foreign_keys = ON');
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  if (foreignKeys !== 1) {
    throw fault(
      'foreign_keys_unavailable',
      'SQLite foreign key enforcement could not be enabled',
    );
  }
}

function configureOperationalPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('wal_autocheckpoint = 1000');
}

function assertMigrationTransaction(db: Database.Database): void {
  if (!db.inTransaction) {
    throw fault(
      'migration_failed',
      'project migration escaped its BEGIN IMMEDIATE transaction',
    );
  }
}

function quickCheck(db: Database.Database): readonly string[] {
  let values: string[];
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<
      Record<string, unknown>
    >;
    values = rows.map((row) => String(Object.values(row)[0] ?? ''));
  } catch (error) {
    throw fault(
      'integrity_check_failed',
      'SQLite quick_check could not inspect the project database',
      error,
    );
  }
  if (values.length !== 1 || values[0] !== 'ok') {
    throw fault(
      'integrity_check_failed',
      `SQLite quick_check failed: ${values.join('; ') || 'no result'}`,
    );
  }
  return Object.freeze(values);
}

function userTableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function appliedMigrations(db: Database.Database): AppliedMigrationRow[] {
  return db
    .prepare(
      `SELECT migration_id, checksum, schema_version, app_version,
              applied_by_app_version, applied_at
       FROM __nexus_schema_migrations
       ORDER BY schema_version`,
    )
    .all() as AppliedMigrationRow[];
}

function validateAppliedHistory(
  applied: readonly AppliedMigrationRow[],
  migrations: readonly ProjectMigration[],
): void {
  if (applied.length > migrations.length) {
    throw fault(
      'migration_history_invalid',
      'project database schema is newer than this application',
    );
  }

  for (let index = 0; index < applied.length; index += 1) {
    const row = applied[index];
    const expected = migrations[index];
    if (
      row.migration_id !== expected.id ||
      row.schema_version !== expected.schemaVersion ||
      row.app_version !== expected.appVersion
    ) {
      throw fault(
        'migration_history_invalid',
        `project migration history diverged at schema ${row.schema_version}`,
      );
    }
    if (row.checksum !== expected.checksum) {
      throw fault(
        'migration_checksum_mismatch',
        `project migration checksum mismatch: ${row.migration_id}`,
      );
    }
    if (
      row.applied_by_app_version.length === 0 ||
      !Number.isSafeInteger(row.applied_at) ||
      row.applied_at < 0
    ) {
      throw fault(
        'migration_history_invalid',
        `invalid project migration metadata: ${row.migration_id}`,
      );
    }
  }
}

function currentUserVersion(db: Database.Database): number {
  const value = db.pragma('user_version', { simple: true });
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw fault('migration_history_invalid', 'invalid SQLite user_version');
  }
  return Number(value);
}

function validateUserVersion(
  db: Database.Database,
  applied: readonly AppliedMigrationRow[],
): void {
  const expected = applied.at(-1)?.schema_version ?? 0;
  if (currentUserVersion(db) !== expected) {
    throw fault(
      'migration_history_invalid',
      'SQLite user_version does not match migration history',
    );
  }
}

function runtimeScope(db: Database.Database): RuntimeScopeRow {
  const rows = db
    .prepare(
      `SELECT project_id, checkout_id
       FROM __nexus_runtime_scope`,
    )
    .all() as RuntimeScopeRow[];
  if (rows.length !== 1) {
    throw fault(
      'runtime_scope_mismatch',
      'project database has invalid runtime scope metadata',
    );
  }
  return rows[0];
}

function validateRuntimeScope(
  db: Database.Database,
  projectId: string,
  checkoutId: string,
): void {
  const stored = runtimeScope(db);
  if (stored.project_id !== projectId || stored.checkout_id !== checkoutId) {
    throw fault(
      'runtime_scope_mismatch',
      'project database belongs to a different project or checkout',
    );
  }
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('backup path is not a real directory');
    }
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    throw fault('backup_failed', 'project database backup directory is unsafe', error);
  }
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  try {
    fsyncFile(directory);
  } catch {
    // Some filesystems do not permit fsync on directory descriptors.
  }
}

function backupBeforeMigration(
  db: Database.Database,
  runtimeDirectory: string,
  fromVersion: number,
  toVersion: number,
  now: () => number,
): string {
  const backupDirectory = path.join(runtimeDirectory, 'backups');
  ensurePrivateDirectory(backupDirectory);
  const backupPath = path.join(
    backupDirectory,
    `runtime-schema-${fromVersion}-to-${toVersion}-${now()}-${randomUUID()}.sqlite3`,
  );
  try {
    db.prepare('VACUUM INTO ?').run(backupPath);
    fs.chmodSync(backupPath, 0o600);
    fsyncFile(backupPath);
    fsyncDirectory(backupDirectory);
    return backupPath;
  } catch (error) {
    fs.rmSync(backupPath, { force: true });
    throw new ProjectRuntimeFault(
      'backup_failed',
      'project database backup failed; migration was not started',
      { cause: error },
    );
  }
}

function applyPendingMigrations(
  input: ProjectMigrationRunInput,
  applied: readonly AppliedMigrationRow[],
  pending: readonly ProjectMigration[],
): string {
  const fromVersion = applied.at(-1)?.schema_version ?? 0;
  const toVersion = pending.at(-1)?.schemaVersion ?? fromVersion;
  const backupPath = backupBeforeMigration(
    input.db,
    input.runtimeDirectory,
    fromVersion,
    toVersion,
    input.now,
  );

  let transactionStarted = false;
  try {
    input.db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    assertMigrationTransaction(input.db);
    // Another process may have completed the same migration while this opener
    // waited on BEGIN IMMEDIATE. Re-read under the write lock rather than
    // applying a stale pending set.
    const lockedTables = userTableNames(input.db);
    const hasLockedScope = lockedTables.has('__nexus_runtime_scope');
    const hasLockedHistory = lockedTables.has('__nexus_schema_migrations');
    if (hasLockedScope !== hasLockedHistory) {
      throw fault(
        'migration_history_invalid',
        'project database control schema is incomplete',
      );
    }
    if (!hasLockedHistory && lockedTables.size > 0) {
      throw fault(
        'unmanaged_database',
        'existing SQLite database is not managed by Nexus project migrations',
      );
    }
    const lockedApplied = hasLockedHistory ? appliedMigrations(input.db) : [];
    validateAppliedHistory(lockedApplied, input.migrations);
    validateUserVersion(input.db, lockedApplied);
    if (hasLockedScope) {
      validateRuntimeScope(input.db, input.projectId, input.checkoutId);
    }

    input.db.exec(CONTROL_SCHEMA);
    assertMigrationTransaction(input.db);
    if (lockedApplied.length === 0) {
      input.db
        .prepare(
          `INSERT INTO __nexus_runtime_scope
             (singleton, project_id, checkout_id, initialized_at,
              initialized_by_app_version)
           VALUES (1, ?, ?, ?, ?)`,
        )
        .run(input.projectId, input.checkoutId, input.now(), input.appVersion);
    } else {
      validateRuntimeScope(input.db, input.projectId, input.checkoutId);
    }

    const lockedPending = input.migrations.slice(lockedApplied.length);
    const record = input.db.prepare(
      `INSERT INTO __nexus_schema_migrations
         (migration_id, checksum, schema_version, app_version,
          applied_by_app_version, applied_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const migration of lockedPending) {
      input.db.exec(migration.sql);
      assertMigrationTransaction(input.db);
      record.run(
        migration.id,
        migration.checksum,
        migration.schemaVersion,
        migration.appVersion,
        input.appVersion,
        input.now(),
      );
      assertMigrationTransaction(input.db);
    }
    const lockedVersion =
      lockedPending.at(-1)?.schemaVersion ??
      lockedApplied.at(-1)?.schema_version ??
      0;
    input.db.exec(`PRAGMA user_version = ${lockedVersion}`);
    input.db.exec('COMMIT');
    transactionStarted = false;
    return backupPath;
  } catch (error) {
    if (transactionStarted) {
      try {
        input.db.exec('ROLLBACK');
      } catch {
        // Preserve the migration failure; rollback failure is secondary evidence.
      }
    }
    if (error instanceof ProjectRuntimeFault) {
      throw new ProjectRuntimeFault(error.code, error.message, {
        cause: error,
        lastBackupPath: backupPath,
      });
    }
    throw new ProjectRuntimeFault(
      'migration_failed',
      'project database migration failed and was rolled back',
      {
        cause: error,
        lastBackupPath: backupPath,
      },
    );
  }
}

export function initializeProjectDatabase(
  input: ProjectMigrationRunInput,
): ProjectMigrationRunResult {
  configureSafetyPragmas(input.db);
  quickCheck(input.db);

  const tables = userTableNames(input.db);
  const hasScope = tables.has('__nexus_runtime_scope');
  const hasHistory = tables.has('__nexus_schema_migrations');
  if (hasScope !== hasHistory) {
    throw fault(
      'migration_history_invalid',
      'project database control schema is incomplete',
    );
  }
  if (!hasHistory && tables.size > 0) {
    throw fault(
      'unmanaged_database',
      'existing SQLite database is not managed by Nexus project migrations',
    );
  }

  const applied = hasHistory ? appliedMigrations(input.db) : [];
  validateAppliedHistory(applied, input.migrations);
  validateUserVersion(input.db, applied);
  if (hasScope) {
    validateRuntimeScope(input.db, input.projectId, input.checkoutId);
  }

  const pending = input.migrations.slice(applied.length);
  const lastBackupPath =
    pending.length > 0
      ? applyPendingMigrations(input, applied, pending)
      : null;

  try {
    const verified = appliedMigrations(input.db);
    validateAppliedHistory(verified, input.migrations);
    validateUserVersion(input.db, verified);
    validateRuntimeScope(input.db, input.projectId, input.checkoutId);
    const result = quickCheck(input.db);
    configureOperationalPragmas(input.db);

    return {
      schemaVersion: verified.at(-1)?.schema_version ?? 0,
      quickCheck: result,
      lastBackupPath,
    };
  } catch (error) {
    if (!lastBackupPath) throw error;
    if (error instanceof ProjectRuntimeFault) {
      throw new ProjectRuntimeFault(error.code, error.message, {
        cause: error,
        lastBackupPath,
      });
    }
    throw new ProjectRuntimeFault(
      'database_open_failed',
      'project database post-migration validation failed',
      { cause: error, lastBackupPath },
    );
  }
}

export function configureSafeReadOnlyDatabase(db: Database.Database): void {
  db.pragma('query_only = ON');
  const queryOnly = db.pragma('query_only', { simple: true });
  if (queryOnly !== 1 || !db.readonly) {
    throw fault(
      'database_open_failed',
      'SQLite safe read-only mode could not be enforced',
    );
  }
}
