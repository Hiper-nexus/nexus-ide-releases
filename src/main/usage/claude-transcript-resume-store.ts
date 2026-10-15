import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { readRegularFileCappedAsync } from '../redline/redline-safe-read';
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
  private loadFlight: Promise<void> | null = null;
  private saveFlight: Promise<void> | null = null;
  private revision = 0;
  private savedRevision = -1;
  private dirty = false;

  constructor(private readonly file: string) {}

  get(transcript: string): ClaudeTranscriptResumeRecord | null {
    this.ensureLoaded();
    return this.cache.get(transcript) ?? null;
  }

  set(transcript: string, record: ClaudeTranscriptResumeRecord): void {
    this.ensureLoaded();
    const existing = this.cache.get(transcript);
    // Regravar o mesmo registro não é mudança: sem dirty nem revision nova.
    if (
      existing &&
      existing.offset === record.offset &&
      existing.headDigest === record.headDigest &&
      existing.boundaryDigest === record.boundaryDigest
    ) {
      return;
    }
    // delete + set renews the insertion order, so the cap evicts the oldest.
    this.cache.delete(transcript);
    this.cache.set(transcript, record);
    this.revision++;
    this.dirty = true;
  }

  delete(transcript: string): void {
    this.ensureLoaded();
    if (this.cache.delete(transcript)) { this.dirty = true; this.revision++; }
  }

  /** Periodic callers initialize before synchronous cache lookup. */
  loadAsync(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadFlight) return this.loadFlight;
    const flight = (async () => {
      // A carga espelha o disco: sem mutação durante ela, nada há a gravar.
      // Mutacao no meio do load sobe revision e continua exigindo save.
      const revisionAtLoad = this.revision;
      const result = await readRegularFileCappedAsync(this.file, 1024 * 1024);
      if (this.loaded) return;
      this.loaded = true;
      this.savedRevision = revisionAtLoad;
      if (result.kind !== 'text') return;
      try {
        const parsed = JSON.parse(result.text) as Partial<ResumeFile>;
        if (parsed?.version !== 1 || !parsed.files || typeof parsed.files !== 'object') return;
        let steps = 0;
        for (const [file, record] of Object.entries(parsed.files)) {
          if (isRecord(record)) this.cache.set(file, record);
          if (++steps % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          if (this.cache.size >= MAX_RECORDS) break;
        }
      } catch { this.cache.clear(); }
    })();
    this.loadFlight = flight;
    return flight;
  }

  /** Last-wins physical persistence; a replacement scanner must await it. */
  saveAsync(): Promise<void> {
    if (this.saveFlight) return this.saveFlight;
    const flight = (async () => {
      await this.loadAsync();
      while (this.revision !== this.savedRevision) {
        while (this.cache.size > MAX_RECORDS) this.cache.delete(this.cache.keys().next().value!);
        const revision = this.revision;
        const entries: string[] = [];
        let steps = 0;
        for (const [file, record] of [...this.cache]) {
          entries.push(`${JSON.stringify(file)}:${JSON.stringify(record)}`);
          if (++steps % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const temporary = `${this.file}.${process.pid}.${randomUUID()}.async.tmp`;
        try {
          await fsp.mkdir(path.dirname(this.file), { recursive: true });
          await fsp.writeFile(temporary, `{"version":1,"files":{${entries.join(',')}}}`, { mode: 0o600, flag: 'wx' });
          await fsp.rename(temporary, this.file);
          this.savedRevision = revision;
          if (this.revision === revision) this.dirty = false;
        } catch (error) {
          console.warn('[usage] async resume store save skipped', error);
          return;
        } finally { await fsp.unlink(temporary).catch(() => undefined); }
      }
    })();
    this.saveFlight = flight;
    void flight.finally(() => { if (this.saveFlight === flight) this.saveFlight = null; });
    return flight;
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
    // A leitura síncrona espelha o disco: marca como já gravado para o
    // primeiro saveAsync não reescrever um conteúdo idêntico.
    this.savedRevision = this.revision;
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
