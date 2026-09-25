import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the Claude transcript watcher stopped in each file, so a restart
 * reads only what was appended since — not the whole history (hundreds of MB
 * of JSONL for an active project) on every boot.
 *
 * One JSON file per watched scope. Same contract as the Codex resume store:
 * atomic write (tmp + rename), tolerant read (anything invalid means "read
 * that file from the start"), and a record is only trusted after its prefix
 * digests still match the file (see codex-rollout-resume-state).
 */

export interface ClaudeTranscriptResumeRecord {
  /** Byte offset just past the last complete line already ingested. */
  readonly offset: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
}

interface ResumeFile {
  readonly version: 1;
  readonly files: Record<string, ClaudeTranscriptResumeRecord>;
}

const MAX_RECORDS = 4_000;

function isRecord(value: unknown): value is ClaudeTranscriptResumeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.offset) &&
    (record.offset as number) >= 0 &&
    typeof record.headDigest === 'string' &&
    typeof record.boundaryDigest === 'string'
  );
}

export class ClaudeTranscriptResumeStore {
  private cache = new Map<string, ClaudeTranscriptResumeRecord>();
  private loaded = false;
  private dirty = false;

  constructor(private readonly file: string) {}

  get(transcript: string): ClaudeTranscriptResumeRecord | null {
    this.ensureLoaded();
    return this.cache.get(transcript) ?? null;
  }

  set(transcript: string, record: ClaudeTranscriptResumeRecord): void {
    this.ensureLoaded();
    // delete + set renews the insertion order, so the cap evicts the oldest.
    this.cache.delete(transcript);
    this.cache.set(transcript, record);
    this.dirty = true;
  }

  delete(transcript: string): void {
    this.ensureLoaded();
    if (this.cache.delete(transcript)) this.dirty = true;
  }

  /** Persists pending changes; never throws (the watcher never blocks on fs). */
  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      while (this.cache.size > MAX_RECORDS) {
        const oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload: ResumeFile = { version: 1, files: Object.fromEntries(this.cache) };
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload));
      fs.renameSync(temporary, this.file);
    } catch (error) {
      console.warn('[claude-usage] resume store save skipped', error);
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ResumeFile>;
      if (parsed?.version !== 1 || !parsed.files || typeof parsed.files !== 'object') {
        return;
      }
      for (const [transcript, record] of Object.entries(parsed.files)) {
        if (isRecord(record)) this.cache.set(transcript, record);
      }
    } catch {
      this.cache.clear();
    }
  }
}
