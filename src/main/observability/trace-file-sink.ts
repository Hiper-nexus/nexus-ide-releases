import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const NORMAL_QUEUE_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const HISTORY_FILE = /^lifecycle-(\d{4}-\d{2}-\d{2})\.ndjson$/;
interface Entry { line: string; history?: string; day: string; bytes: number }

/** One physical writer, bounded memory, and a reserved queue for lifecycle records. */
export class TraceFileSink {
  private readonly queue: Entry[] = [];
  private flight: Promise<void> | null = null;
  private queuedBytes = 0;
  private dropped = 0;
  private failed = false;
  private size: number | null = null;
  private lastPrunedDay = '';
  constructor(private readonly dir: string, private readonly options: { rotationBytes?: number } = {}) {}

  enqueue(line: string, at: number, history?: string): boolean {
    const bytes = Buffer.byteLength(line) + Buffer.byteLength(history ?? '');
    const cap = history ? MAX_QUEUE_BYTES : NORMAL_QUEUE_BYTES;
    if (bytes > MAX_LINE_BYTES || this.queuedBytes + bytes > cap ||
        this.queue.length >= (history ? 4096 : 2048) || !Number.isFinite(at)) {
      this.dropped++; return false;
    }
    const day = new Date(at).toISOString().slice(0, 10);
    this.queue.push({ line, history, day, bytes });
    this.queuedBytes += bytes;
    this.startDrain();
    return true;
  }

  stats() { return { queuedBytes: this.queuedBytes, dropped: this.dropped, failed: this.failed }; }
  async flush(): Promise<void> { while (this.flight) await this.flight; }

  private startDrain(): void {
    if (this.flight) return;
    this.flight = this.drain().finally(() => {
      this.flight = null;
      if (this.queue.length) this.startDrain();
    });
  }

  private async rotate(file: string): Promise<void> {
    for (let i = 2; i >= 0; i--) {
      try { await fs.rename(i ? `${file}.${i}` : file, `${file}.${i + 1}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.size = 0;
  }

  private async pruneHistory(day: string): Promise<void> {
    if (this.lastPrunedDay === day) return;
    // Keep fourteen full days plus today's partial day. Size rotation is separate.
    const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
    const entries = await fs.opendir(this.dir);
    for await (const entry of entries) {
      const match = HISTORY_FILE.exec(entry.name);
      if (entry.isFile() && match && match[1] < cutoff) await fs.unlink(path.join(this.dir, entry.name));
    }
    this.lastPrunedDay = day;
  }

  private async drain(): Promise<void> {
    const file = path.join(this.dir, 'main.trace.ndjson');
    let writing = 0;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      if (this.size === null) {
        try { this.size = (await fs.stat(file)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.size = 0; }
      }
      while (this.queue.length) {
        const batch: Entry[] = [];
        let bytes = 0;
        while (this.queue.length && bytes < MAX_LINE_BYTES && batch.length < 128) {
          const entry = this.queue.shift()!; batch.push(entry); bytes += entry.bytes;
        }
        writing = batch.length;
        try {
          if (this.size >= (this.options.rotationBytes ?? 5 * 1024 * 1024)) await this.rotate(file);
          const text = batch.map(entry => entry.line).join('');
          await fs.appendFile(file, text, { encoding: 'utf8', mode: 0o600 });
          this.size += Buffer.byteLength(text);
          const history = new Map<string, string>();
          for (const entry of batch) if (entry.history) history.set(entry.day, (history.get(entry.day) ?? '') + entry.history);
          for (const [day, text] of history) {
            await fs.appendFile(path.join(this.dir, `lifecycle-${day}.ndjson`), text, { encoding: 'utf8', mode: 0o600 });
            await this.pruneHistory(day);
          }
        } finally { this.queuedBytes -= bytes; }
        writing = 0;
      }
    } catch {
      this.failed = true;
      this.dropped += this.queue.length + writing;
      this.queue.length = 0;
      this.queuedBytes = 0;
    }
  }
}
