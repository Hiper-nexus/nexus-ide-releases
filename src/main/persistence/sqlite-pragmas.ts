import type { Db } from './db';

/**
 * Teto do arquivo -wal depois de cada checkpoint: sem ele o WAL guarda o pico
 * de escrita para sempre (dezenas de MB por banco de projeto).
 */
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

/** WAL preserves integrity with NORMAL; other journals keep FULL durability. */
export function configureSqliteDurability(db: Pick<Db, 'exec' | 'prepare'>): void {
  db.exec('PRAGMA journal_mode = WAL');
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  db.exec(`PRAGMA synchronous = ${mode.journal_mode.toLowerCase() === 'wal' ? 'NORMAL' : 'FULL'}`);
  db.exec(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`);
}
