import fs from 'node:fs';
import path from 'node:path';
import {
  verifyBenchmarkJournal,
  type BenchmarkJournalEntry,
  type BenchmarkRunManifest,
} from './benchmark-contract';

export interface BenchmarkJournalSink {
  append(entry: BenchmarkJournalEntry): Promise<void>;
}

export interface BenchmarkJournalStore extends BenchmarkJournalSink {
  read(): BenchmarkJournalEntry[];
}

/**
 * Single-writer JSONL journal. Existing lines are verified before every append;
 * the store never rewrites or truncates a valid journal.
 */
export function createJsonlBenchmarkJournal(
  filePath: string,
  manifest: BenchmarkRunManifest,
): BenchmarkJournalStore {
  const read = (): BenchmarkJournalEntry[] => {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const entries = lines.map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`invalid benchmark journal JSON at line ${index + 1}`, { cause: error });
      }
    });
    return verifyBenchmarkJournal(entries, manifest).entries;
  };

  return {
    read,
    append: async (entry) => {
      const current = read();
      if (entry.sequence !== current.length + 1) {
        throw new Error(`journal sequence must append at ${current.length + 1}`);
      }
      verifyBenchmarkJournal([...current, entry], manifest);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    },
  };
}
