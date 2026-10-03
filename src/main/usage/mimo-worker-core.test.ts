import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { readMimoDatabase } from './mimo-worker-core';
const roots: string[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(cwd?: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-file-race-'))); roots.push(root);
  const stateRoot = path.join(root, 'mimo-code', 'checkout');
  fs.mkdirSync(path.join(stateRoot, 'database'), { recursive: true });
  const databasePath = path.join(stateRoot, 'database', 'mimocode.db');
  const db = new Database(databasePath); databases.push(db);
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?, ?, NULL)').run('ses_root', cwd ?? root);
  db.prepare('INSERT INTO message VALUES (?, ?, 1, ?)').run('msg-owned', 'ses_root', JSON.stringify({
    role: 'assistant', modelID: 'mimo-v2.6-flash', providerID: 'xiaomi', path: { cwd: cwd ?? root },
    time: { created: 100 }, cost: 0.01, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    privateText: 'private fixture text',
  }));
  return { db, runtime: { cwd: cwd ?? root, stateRoot, databasePath, checkoutId: 'checkout' } };
}
it.each(['', '-wal', '-shm', '-journal', 'directory'])('rejects %s replacement between the last path check and SQLite open', suffix => {
  const a = fixture(); const b = fixture(a.runtime.cwd);
  a.db.close(); databases.splice(databases.indexOf(a.db), 1);
  b.db.close(); databases.splice(databases.indexOf(b.db), 1);
  if (suffix && suffix !== 'directory') {
    fs.writeFileSync(`${a.runtime.databasePath}${suffix}`, 'owned sidecar fixture');
    fs.writeFileSync(`${b.runtime.databasePath}${suffix}`, 'foreign sidecar fixture');
  }
  const original = fs.lstatSync.bind(fs);
  let swapped = false;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options: any) => {
    const stat = original(file, options);
    if (file === `${a.runtime.databasePath}-journal` && !swapped) {
      swapped = true;
      if (suffix === 'directory') {
        const directory = path.dirname(a.runtime.databasePath);
        fs.renameSync(directory, `${directory}-owned`); fs.symlinkSync(path.dirname(b.runtime.databasePath), directory);
      } else {
        fs.unlinkSync(`${a.runtime.databasePath}${suffix}`);
        fs.symlinkSync(`${b.runtime.databasePath}${suffix}`, `${a.runtime.databasePath}${suffix}`);
      }
    }
    return stat;
  }) as typeof fs.lstatSync);
  const result = readMimoDatabase({ job: 1, kind: 'scan', rootId: 'ses_root', runtime: a.runtime });
  expect(swapped).toBe(true); expect(result.valid).toBe(false); expect(result.events).toEqual([]);
});
it('reads committed WAL usage without changing any native DB or sidecar bytes', () => {
  const { db, runtime } = fixture();
  db.pragma('journal_mode = WAL');
  db.prepare('UPDATE message SET time_updated=2').run();
  const files = ['', '-wal', '-shm'].map(suffix => `${runtime.databasePath}${suffix}`);
  const before = files.map(file => fs.readFileSync(file));
  const result = readMimoDatabase({ job: 2, kind: 'scan', rootId: 'ses_root', runtime });
  expect(result.valid).toBe(true); expect(result.events).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('privateText');
  expect(files.map((file, i) => fs.readFileSync(file).equals(before[i]))).toEqual([true, true, true]);
});
