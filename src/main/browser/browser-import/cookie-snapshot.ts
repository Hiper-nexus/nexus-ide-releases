// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: CookieDatabase.ts sem Effect — snapshot com better-sqlite3 (VACUUM INTO num mkdtemp 0700 apagado no fim; quando o navegador segura o lock exclusivo, cópia crua de banco/WAL/journal e VACUUM INTO da cópia), falhas como {ok:false, reason} e conversão para o ProfileCookie do Perfil Nexus no lugar do ImportedCookie do Electron.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { profileCookieSchema, type ProfileCookie } from '../browser-profile-cookies';

/** A cookie as a source browser stores it, before validation for the profile. */
export interface StoredCookie {
  /** Host as stored: a leading dot marks a domain cookie, none a host-only one. */
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Seconds since the UNIX epoch; absent for a session cookie. */
  expires?: number;
}

export type CookieSkipReason = 'partitioned' | 'encrypted' | 'expired' | 'invalid';
export type CookieDecode = { ok: true; cookie: ProfileCookie } | { ok: false; reason: CookieSkipReason };

export function toProfileCookie(stored: StoredCookie, now: number): CookieDecode {
  if (stored.expires !== undefined && stored.expires <= now) return { ok: false, reason: 'expired' };
  // Chromium refuses SameSite=None without Secure, and one refused cookie
  // fails the whole CDP batch. Dropping the attribute narrows the cookie to
  // the browser default (Lax); it never widens it.
  const sameSite = stored.sameSite === 'None' && !stored.secure ? undefined : stored.sameSite;
  const parsed = profileCookieSchema.safeParse({
    name: stored.name, value: stored.value, domain: stored.host, path: stored.path,
    secure: stored.secure, httpOnly: stored.httpOnly,
    ...(sameSite ? { sameSite } : {}), ...(stored.expires !== undefined ? { expires: stored.expires } : {}),
  });
  return parsed.success ? { ok: true, cookie: parsed.data } : { ok: false, reason: 'invalid' };
}

export type SnapshotFailure = 'locked' | 'permissionDenied' | 'readFailed';
export type SnapshotRead<T> = { ok: true; value: T } | { ok: false; reason: SnapshotFailure };

const errorCode = (error: unknown): string => String((error as { code?: unknown } | undefined)?.code ?? '');

function vacuumInto(source: string, target: string, readonly: boolean): boolean {
  let db: Database.Database | undefined;
  try {
    // Short: a browser in exclusive locking mode never yields, and the copy below handles it.
    db = new Database(source, { readonly, fileMustExist: true, timeout: 100 });
    db.prepare('VACUUM INTO ?').run(target);
    return true;
  } catch {
    fs.rmSync(target, { force: true });
    return false;
  } finally { db?.close(); }
}

/**
 * Copies the live database with its rollback journal or WAL. Chromium keeps
 * its cookie store in SQLite's exclusive locking mode, so a reader that honours
 * the lock gets SQLITE_BUSY for as long as the browser runs; POSIX locks are
 * advisory, so the bytes can still be copied. Opening the private copy lets
 * SQLite replay a hot journal or committed WAL frames into a consistent view.
 * ponytail: one attempt — a copy torn by a concurrent checkpoint fails as
 * `readFailed` and the user retries; loop here if that ever shows up in QA.
 */
function copyThenVacuum(source: string, directory: string, target: string): SnapshotFailure | undefined {
  const copy = path.join(directory, 'source.sqlite');
  for (const suffix of ['', '-wal', '-journal']) {
    try { fs.copyFileSync(source + suffix, copy + suffix); }
    catch (error) {
      const code = errorCode(error);
      if (suffix && code === 'ENOENT') continue;
      // Windows reports a file opened without sharing as EBUSY: the browser
      // holds it while running, which no copy can get around.
      if (code === 'EBUSY') return 'locked';
      return code === 'EPERM' || code === 'EACCES' ? 'permissionDenied' : 'readFailed';
    }
  }
  return vacuumInto(copy, target, false) ? undefined : 'readFailed';
}

/**
 * Reads a transactionally consistent snapshot of a live cookie database, taken
 * in a private temporary directory that is removed before returning. The
 * browser's own file is only ever opened read-only, and never needs closing.
 * ponytail: synchronous (better-sqlite3), so a very large jar blocks Main for
 * the VACUUM; move it to a worker if imports of >100 MB stores appear.
 */
export function withCookieSnapshot<T>(cookiePath: string, read: (db: Database.Database) => T): SnapshotRead<T> {
  // mkdtemp creates the directory 0700: the snapshot holds the same secrets as the source.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cookie-import-'));
  try {
    const target = path.join(directory, 'snapshot.sqlite');
    if (!vacuumInto(cookiePath, target, true)) {
      const failure = copyThenVacuum(cookiePath, directory, target);
      if (failure) return { ok: false, reason: failure };
    }
    const db = new Database(target, { readonly: true, fileMustExist: true });
    try { return { ok: true, value: read(db) }; } finally { db.close(); }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
