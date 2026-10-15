import type { Db } from './db';

/** WAL preserves integrity with NORMAL; other journals keep FULL durability. */
export function configureSqliteDurability(db: Pick<Db, 'exec' | 'prepare'>): void {
  db.exec('PRAGMA journal_mode = WAL');
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  db.exec(`PRAGMA synchronous = ${mode.journal_mode.toLowerCase() === 'wal' ? 'NORMAL' : 'FULL'}`);
}
