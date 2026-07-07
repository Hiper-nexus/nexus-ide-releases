import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptAppend {
  role: TranscriptRole;
  text: string;
  final: boolean;
  audio_url?: string | null;
}

export interface TranscriptRecord extends TranscriptAppend {
  ts: string;
  audio_url: string | null;
}

export interface TranscriptStoreOptions {
  baseDir?: string;
  now?: () => Date;
  maxFileBytes?: number;
  maxTextChars?: number;
  retentionDays?: number;
}

const DEFAULT_APP_SUPPORT_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'NexusIDE',
  'transcripts',
);
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 4_000;
const DEFAULT_RETENTION_DAYS = 30;

interface SessionFile {
  dateKey: string;
  index: number;
  file: string;
}

export class TranscriptStore {
  private readonly baseDir: string;
  private readonly now: () => Date;
  private readonly maxFileBytes: number;
  private readonly maxTextChars: number;
  private readonly retentionDays: number;
  private readonly sessionFiles = new Map<string, SessionFile>();

  constructor(options: TranscriptStoreOptions = {}) {
    this.baseDir = options.baseDir ?? DEFAULT_APP_SUPPORT_DIR;
    this.now = options.now ?? (() => new Date());
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  append(sessionId: string, line: TranscriptAppend): TranscriptRecord | null {
    if (!line.final) return null;
    const now = this.now();
    const record: TranscriptRecord = {
      ts: now.toISOString(),
      role: line.role,
      text: this.truncateText(line.text),
      audio_url: line.audio_url ?? null,
      final: line.final,
    };
    const serialized = `${JSON.stringify(record)}\n`;
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.pruneExpired(now);
    let target = this.pathForSessionAt(sessionId, now);
    if (this.wouldOverflow(target.file, serialized)) {
      target = this.rotateSessionFile(sessionId, now, target.index + 1);
    }
    fs.appendFileSync(target.file, serialized, 'utf-8');
    return record;
  }

  pathForSession(sessionId: string): string {
    return this.pathForSessionAt(sessionId, this.now()).file;
  }

  private pathForSessionAt(sessionId: string, now: Date): SessionFile {
    const existing = this.sessionFiles.get(sessionId);
    const dateKey = dateKeyFor(now);
    if (existing?.dateKey === dateKey) return existing;
    return this.rotateSessionFile(sessionId, now, 0);
  }

  private rotateSessionFile(sessionId: string, now: Date, index: number): SessionFile {
    const dateKey = dateKeyFor(now);
    const startedAt = now.toISOString().replace(/[:.]/g, '-');
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const suffix = index === 0 ? '' : `.${index}`;
    const entry = {
      dateKey,
      index,
      file: path.join(this.baseDir, `${startedAt}-${safeSessionId}${suffix}.jsonl`),
    };
    this.sessionFiles.set(sessionId, entry);
    return entry;
  }

  private truncateText(text: string): string {
    if (text.length <= this.maxTextChars) return text;
    return text.slice(0, this.maxTextChars);
  }

  private wouldOverflow(file: string, nextLine: string): boolean {
    const nextBytes = Buffer.byteLength(nextLine, 'utf-8');
    if (nextBytes > this.maxFileBytes) return true;
    if (!fs.existsSync(file)) return false;
    return fs.statSync(file).size + nextBytes > this.maxFileBytes;
  }

  private pruneExpired(now: Date): void {
    if (this.retentionDays <= 0 || !fs.existsSync(this.baseDir)) return;
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - this.retentionDays);
    const cutoffKey = dateKeyFor(cutoff);
    for (const name of fs.readdirSync(this.baseDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const fileDate = name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
      if (!fileDate || fileDate >= cutoffKey) continue;
      const file = path.join(this.baseDir, name);
      try {
        fs.unlinkSync(file);
      } catch {
        // Retention is best-effort; append must not fail because cleanup raced.
      }
      for (const [sessionId, entry] of this.sessionFiles) {
        if (entry.file === file) this.sessionFiles.delete(sessionId);
      }
    }
  }
}

export const transcriptStore = new TranscriptStore();

function dateKeyFor(date: Date): string {
  return date.toISOString().slice(0, 10);
}
