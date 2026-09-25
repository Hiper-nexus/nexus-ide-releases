import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-'));

vi.mock('electron', () => ({ app: { getPath: () => userData } }));

afterEach(async () => {
  const { closeDb } = await import('./db');
  closeDb();
});

describe('nexus.db', () => {
  it('opens in WAL with full sync, so a write does not rewrite a rollback journal', async () => {
    const { getDb } = await import('./db');
    const db = getDb();
    expect(db).not.toBeNull();
    const mode = db!.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const sync = db!.prepare('PRAGMA synchronous').get() as { synchronous: number };
    expect(mode.journal_mode).toBe('wal');
    // FULL (2): WAL must not trade durability for speed.
    expect(sync.synchronous).toBe(2);
    fs.rmSync(userData, { recursive: true, force: true });
  });
});
