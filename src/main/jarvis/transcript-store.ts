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
}

const DEFAULT_APP_SUPPORT_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'NexusIDE',
  'transcripts',
);

export class TranscriptStore {
  private readonly baseDir: string;
  private readonly now: () => Date;
  private readonly sessionFiles = new Map<string, string>();

  constructor(options: TranscriptStoreOptions = {}) {
    this.baseDir = options.baseDir ?? DEFAULT_APP_SUPPORT_DIR;
    this.now = options.now ?? (() => new Date());
  }

  append(sessionId: string, line: TranscriptAppend): TranscriptRecord {
    const record: TranscriptRecord = {
      ts: this.now().toISOString(),
      role: line.role,
      text: line.text,
      audio_url: line.audio_url ?? null,
      final: line.final,
    };
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.appendFileSync(
      this.pathForSession(sessionId),
      `${JSON.stringify(record)}\n`,
      'utf-8',
    );
    return record;
  }

  pathForSession(sessionId: string): string {
    const existing = this.sessionFiles.get(sessionId);
    if (existing) return existing;
    const startedAt = this.now().toISOString().replace(/[:.]/g, '-');
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(this.baseDir, `${startedAt}-${safeSessionId}.jsonl`);
    this.sessionFiles.set(sessionId, file);
    return file;
  }
}

export const transcriptStore = new TranscriptStore();
