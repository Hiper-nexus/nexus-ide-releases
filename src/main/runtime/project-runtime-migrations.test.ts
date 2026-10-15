import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { initializeProjectDatabase } from './project-runtime-migrations';
import { INITIAL_PROJECT_MIGRATIONS } from './project-runtime-schema';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pragmas-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function open(file: string) {
  const db = new Database(file); databases.push(db);
  const prepare = vi.spyOn(db, 'prepare');
  const input = { db, runtimeDirectory: directory, projectId: 'p', checkoutId: 'c',
    appVersion: 'test', migrations: INITIAL_PROJECT_MIGRATIONS, now: () => 1 };
  return { db, prepare, input };
}

it('checks integrity twice when migrating, once when reopening an unchanged schema', () => {
  const { db, prepare, input } = open(path.join(directory, 'runtime.sqlite3'));
  initializeProjectDatabase(input);
  expect(prepare.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check')).toHaveLength(2);
  prepare.mockClear();
  initializeProjectDatabase(input);
  expect(prepare.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check')).toHaveLength(1);
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('synchronous', { simple: true })).toBe(1);
});

it('keeps FULL when WAL is unavailable (memory journal)', () => {
  const { db, input } = open(':memory:');
  initializeProjectDatabase(input);
  expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
  expect(db.pragma('synchronous', { simple: true })).toBe(2);
});
