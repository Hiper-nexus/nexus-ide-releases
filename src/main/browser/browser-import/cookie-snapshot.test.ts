// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: CookieDatabase.test.ts sem Effect — mesmos casos (WAL commitado, falha sem sobra de diretório, limpeza ao fim) com better-sqlite3, mais o banco preso em lock exclusivo por outro handle, como o Chromium mantém o dele.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCookieSnapshot } from './cookie-snapshot';

const roots: string[] = [];
const handles: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-snapshot-test-')); roots.push(dir); return dir; };
/** Records the private directories the snapshot creates (other suites share os.tmpdir() in parallel). */
function trackSnapshotDirs(): string[] {
  const created: string[] = [];
  const mkdtemp = fs.mkdtempSync;
  vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string, options?: fs.EncodingOption) => {
    const directory = mkdtemp(prefix, options);
    created.push(directory);
    return directory;
  }) as typeof fs.mkdtempSync);
  return created;
}
const allRemoved = (created: string[]) => created.length === 1 && created.every((directory) => !fs.existsSync(directory));
const names = (db: Database.Database) => (db.prepare('SELECT name FROM cookies ORDER BY name').all() as Array<{ name: string }>).map((row) => row.name);

/** A live database another handle keeps open, as a running browser does. */
function liveDatabase(exclusive: boolean): { file: string; holder: Database.Database } {
  const file = path.join(tempDir(), 'Cookies');
  const holder = new Database(file);
  handles.push(holder);
  if (exclusive) holder.pragma('locking_mode = EXCLUSIVE');
  holder.pragma('journal_mode = WAL');
  holder.pragma('wal_autocheckpoint = 0');
  holder.exec('CREATE TABLE cookies(name TEXT NOT NULL)');
  holder.prepare('INSERT INTO cookies(name) VALUES (?)').run('committed-in-wal');
  expect(fs.existsSync(`${file}-wal`)).toBe(true);
  return { file, holder };
}

describe('withCookieSnapshot', () => {
  it('includes committed WAL data while another handle keeps the database open', () => {
    const { file } = liveDatabase(false);
    const created = trackSnapshotDirs();
    expect(withCookieSnapshot(file, names)).toEqual({ ok: true, value: ['committed-in-wal'] });
    expect(allRemoved(created)).toBe(true);
  });

  it('reads a database held in exclusive locking mode, without asking to close the owner', () => {
    const { file, holder } = liveDatabase(true);
    // A reader that honours the lock is refused, which is what made the old
    // import say "Feche o Chrome".
    const reader = new Database(file, { readonly: true, timeout: 50 });
    try { expect(() => reader.prepare('SELECT count(*) FROM cookies').get()).toThrow(/locked|busy/i); } finally { reader.close(); }
    const sourceBefore = fs.readFileSync(file);
    expect(withCookieSnapshot(file, names)).toEqual({ ok: true, value: ['committed-in-wal'] });
    // The browser's own files are untouched.
    expect(fs.readFileSync(file)).toEqual(sourceBefore);
    holder.prepare('INSERT INTO cookies(name) VALUES (?)').run('still-writable');
    expect(names(holder)).toEqual(['committed-in-wal', 'still-writable']);
  });

  it('fails a non-database file without leaving its temporary directory behind', () => {
    const file = path.join(tempDir(), 'Cookies');
    fs.writeFileSync(file, 'not a sqlite database');
    const created = trackSnapshotDirs();
    expect(withCookieSnapshot(file, names)).toEqual({ ok: false, reason: 'readFailed' });
    expect(allRemoved(created)).toBe(true);
  });

  it('removes the snapshot when the reader throws', () => {
    const file = path.join(tempDir(), 'Cookies');
    const db = new Database(file);
    db.exec('CREATE TABLE meta(key TEXT)');
    db.close();
    const created = trackSnapshotDirs();
    expect(() => withCookieSnapshot(file, names)).toThrow(/no such table/);
    expect(allRemoved(created)).toBe(true);
  });
});
