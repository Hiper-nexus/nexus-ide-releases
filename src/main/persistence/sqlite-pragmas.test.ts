import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { configureSqliteDurability } from './sqlite-pragmas';

it('chooses sync from the effective journal mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-durability-'));
  const file = new Database(path.join(directory, 'file.sqlite3'));
  const memory = new Database(':memory:');
  try {
    configureSqliteDurability(file);
    configureSqliteDurability(memory);
    expect(file.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(file.pragma('synchronous', { simple: true })).toBe(1);
    expect(memory.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(memory.pragma('synchronous', { simple: true })).toBe(2);
  } finally {
    file.close(); memory.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
