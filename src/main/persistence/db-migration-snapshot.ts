// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: the launcher's async
// copy of db/-wal/-shm becomes a synchronous `VACUUM INTO` of the open nexus.db
// inside getDb(); the `.restore-pending` marker becomes a durable JSON phase
// (migrating → migrated → confirmed, or restoring); commit is the first renderer
// mount; snapshots are kept by count instead of per update id.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/atomic-write';
import { sqliteFilePath } from '../runtime/project-runtime-migrations';

/**
 * Snapshot do nexus.db antes de migrar o schema (padrão "Database rollback" do
 * T3 Code, docs/internals/server-updates.md).
 *
 *   migrating  snapshot gravado; a migração pode estar pela metade. Um boot que
 *              encontra esta fase restaura ANTES de abrir o banco.
 *   restoring  marcador durável gravado antes de tocar nos arquivos vivos: uma
 *              restauração interrompida termina no boot seguinte.
 *   migrated   migração confirmada pelo SQLite; falta a nova versão provar que
 *              sobe (primeiro mount do renderer). O snapshot não é podado.
 *   confirmed  boot confirmado: o snapshot vira histórico comum da retenção.
 *
 * Arquivos fora do SQLite (settings.json, layout JSON) estão fora desta fronteira.
 */

export const DB_SNAPSHOT_DIRNAME = 'db-snapshots';
/** Poucos snapshots: proteção de disco, não racionamento (cada um é uma cópia cheia). */
export const MAX_DB_SNAPSHOTS = 3;
const STATE_FILE = 'migration-state.json';
/** SQLite persists across the main file plus its WAL and shared-memory sidecars. */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;
const SNAPSHOT_NAME = /^nexus-schema-(\d+)-to-(\d+)-app-([A-Za-z0-9._-]+)-(\d+)\.db$/;

export type DbMigrationPhase = 'migrating' | 'restoring' | 'migrated' | 'confirmed';

export interface DbMigrationState {
  version: 1;
  phase: DbMigrationPhase;
  /** Nome do arquivo dentro de db-snapshots/ (nunca um caminho). */
  snapshot: string;
  appVersion: string;
  fromSchema: number;
  toSchema: number;
  createdAt: number;
  confirmedAt?: number;
}

interface SnapshotSource {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

export function dbSnapshotDir(dbFile: string): string {
  return path.join(path.dirname(dbFile), DB_SNAPSHOT_DIRNAME);
}

function statePath(dbFile: string): string {
  return path.join(dbSnapshotDir(dbFile), STATE_FILE);
}

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

// Opened read-write: Windows refuses to flush a handle without write access.
function syncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Flushes a directory entry so a rename into it survives power loss. Windows
// has no directory fsync; NTFS journals the rename on its own.
function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Best effort: some platforms/filesystems refuse fsync on directories.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function ensureSnapshotDir(dbFile: string): string {
  const dir = dbSnapshotDir(dbFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${dir} não é um diretório real`);
  }
  return dir;
}

function snapshotTimestamp(name: string): number | null {
  const match = SNAPSHOT_NAME.exec(name);
  return match ? Number(match[4]) : null;
}

function safeVersionLabel(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

function isState(value: unknown): value is DbMigrationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    (state.phase === 'migrating' ||
      state.phase === 'restoring' ||
      state.phase === 'migrated' ||
      state.phase === 'confirmed') &&
    typeof state.snapshot === 'string' &&
    SNAPSHOT_NAME.test(state.snapshot) &&
    typeof state.appVersion === 'string' &&
    Number.isSafeInteger(state.fromSchema) &&
    Number.isSafeInteger(state.toSchema) &&
    Number.isSafeInteger(state.createdAt)
  );
}

export function readDbMigrationState(dbFile: string): DbMigrationState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath(dbFile), 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw cause;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isState(parsed)) return parsed;
  } catch {
    // Fall through: an unreadable marker is reported, never trusted.
  }
  console.warn(`[nexus] ${statePath(dbFile)} inválido — ignorado (snapshots preservados).`);
  return null;
}

function writeState(dbFile: string, state: DbMigrationState): void {
  ensureSnapshotDir(dbFile);
  writeJsonAtomic(statePath(dbFile), state);
}

function clearState(dbFile: string): void {
  fs.rmSync(statePath(dbFile), { force: true });
  syncDirectory(dbSnapshotDir(dbFile));
}

/**
 * Snapshot consistente do banco aberto (inclui o que está no WAL), gravado em
 * staging e publicado por rename; só depois o estado `migrating` é gravado.
 */
export function takeDbMigrationSnapshot(
  db: SnapshotSource,
  dbFile: string,
  input: { fromSchema: number; toSchema: number; appVersion: string; now?: () => number },
): DbMigrationState {
  const dir = ensureSnapshotDir(dbFile);
  const createdAt = (input.now ?? Date.now)();
  const snapshot =
    `nexus-schema-${input.fromSchema}-to-${input.toSchema}` +
    `-app-${safeVersionLabel(input.appVersion)}-${createdAt}.db`;
  const finalPath = path.join(dir, snapshot);
  const stagingPath = `${finalPath}.partial`;
  fs.rmSync(stagingPath, { force: true });
  try {
    db.prepare('VACUUM INTO ?').run(sqliteFilePath(stagingPath));
    fs.chmodSync(stagingPath, 0o600);
    syncFile(stagingPath);
    fs.renameSync(stagingPath, finalPath);
    syncDirectory(dir);
  } catch (cause) {
    fs.rmSync(stagingPath, { force: true });
    throw cause;
  }
  const state: DbMigrationState = {
    version: 1,
    phase: 'migrating',
    snapshot,
    appVersion: input.appVersion,
    fromSchema: input.fromSchema,
    toSchema: input.toSchema,
    createdAt,
  };
  writeState(dbFile, state);
  return state;
}

export function markDbMigrationApplied(dbFile: string, state: DbMigrationState): DbMigrationState {
  const next: DbMigrationState = { ...state, phase: 'migrated' };
  writeState(dbFile, next);
  return next;
}

/** Durable "boot confirmado": the snapshot stops being the open rollback point. */
export function confirmDbMigrationBoot(dbFile: string, now: () => number = Date.now): boolean {
  const state = readDbMigrationState(dbFile);
  if (!state || state.phase !== 'migrated') return false;
  writeState(dbFile, { ...state, phase: 'confirmed', confirmedAt: now() });
  return true;
}

/**
 * Restore is retryable after any process crash while the marker remains. The
 * database must be closed. Sidecars go first: a stale -wal replayed onto the
 * restored main file would resurrect the failed migration.
 */
export function restoreDbMigrationSnapshot(dbFile: string, state: DbMigrationState): void {
  const source = path.join(dbSnapshotDir(dbFile), state.snapshot);
  if (!pathExists(source)) {
    throw new Error(`snapshot ${state.snapshot} não existe mais`);
  }
  if (state.phase !== 'restoring') writeState(dbFile, { ...state, phase: 'restoring' });
  for (const suffix of DB_SIDECAR_SUFFIXES) fs.rmSync(`${dbFile}${suffix}`, { force: true });
  const restorePath = `${dbFile}.restore-tmp`;
  fs.rmSync(restorePath, { force: true });
  fs.copyFileSync(source, restorePath);
  fs.chmodSync(restorePath, 0o600);
  syncFile(restorePath);
  fs.renameSync(restorePath, dbFile);
  syncDirectory(path.dirname(dbFile));
  clearState(dbFile);
}

/**
 * Boot: termina, antes de abrir o banco, uma migração ou restauração que o
 * processo anterior não concluiu. Devolve o estado restaurado (para o aviso).
 */
export function recoverInterruptedDbMigration(dbFile: string): DbMigrationState | null {
  const state = readDbMigrationState(dbFile);
  if (!state || (state.phase !== 'migrating' && state.phase !== 'restoring')) return null;
  if (!pathExists(path.join(dbSnapshotDir(dbFile), state.snapshot))) {
    console.error(
      `[nexus] migração do nexus.db interrompida, mas o snapshot ${state.snapshot} ` +
        'sumiu — abrindo o banco como está.',
    );
    clearState(dbFile);
    return null;
  }
  restoreDbMigrationSnapshot(dbFile, state);
  return state;
}

/** Mantém os `keep` snapshots mais novos e nunca o rollback ainda aberto. */
export function pruneDbMigrationSnapshots(dbFile: string, keep = MAX_DB_SNAPSHOTS): string[] {
  const dir = dbSnapshotDir(dbFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }
  const state = readDbMigrationState(dbFile);
  const protectedName = state && state.phase !== 'confirmed' ? state.snapshot : null;
  const removed: string[] = [];
  for (const name of names) {
    // Staging de um snapshot que não chegou a ser publicado.
    if (name.endsWith('.partial') && SNAPSHOT_NAME.test(name.slice(0, -'.partial'.length))) {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    }
  }
  const snapshots = names
    .map((name) => ({ name, at: snapshotTimestamp(name) }))
    .filter((entry): entry is { name: string; at: number } => entry.at !== null)
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  let kept = 0;
  for (const entry of snapshots) {
    if (entry.name === protectedName) continue;
    if (kept < keep) {
      kept += 1;
      continue;
    }
    fs.rmSync(path.join(dir, entry.name), { force: true });
    removed.push(entry.name);
  }
  if (removed.length > 0) syncDirectory(dir);
  return removed;
}
