import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitTailChunk, type UsageEvent } from './claude-transcript';
import { CodexFileIngest } from './codex-transcript';

/**
 * Scanner de uso do Codex. Diferente do Claude (dir por workspace), o Codex
 * grava por DATA (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) — então o
 * scanner é GLOBAL: varre hoje+ontem, lê o session_meta (head) para descobrir
 * o cwd e só continua tailing quando o cwd pertence a um workspace observado.
 * Arquivo de outro workspace é marcado skip e nunca mais lido (custo zero).
 */

interface FileState {
  offset: number;
  remainder: string;
  ingest: CodexFileIngest;
  skip: boolean;
}

export interface CodexScannerOptions {
  isWatched: (cwd: string) => boolean;
  onEvent: (event: UsageEvent, cwd: string) => void;
  sessionsDir?: string;
  pollMs?: number;
}

const DEFAULT_POLL_MS = 10_000;
/** Após ler este tanto sem session_meta, o arquivo é considerado inatribuível. */
const META_DISCOVERY_BYTES = 128 * 1024;

function dayDir(root: string, date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(root, String(y), m, d);
}

export class CodexUsageScanner {
  private files = new Map<string, FileState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private opts: CodexScannerOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.scan(), this.opts.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
    void this.scan();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private root(): string {
    return this.opts.sessionsDir ?? path.join(os.homedir(), '.codex', 'sessions');
  }

  private async scan(): Promise<void> {
    if (this.stopped) return;
    const now = new Date();
    const dirs = [dayDir(this.root(), now), dayDir(this.root(), new Date(now.getTime() - 86_400_000))];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        await this.ingestTail(path.join(dir, name));
      }
    }
  }

  private async ingestTail(file: string): Promise<void> {
    let state = this.files.get(file);
    if (!state) {
      state = { offset: 0, remainder: '', ingest: new CodexFileIngest(), skip: false };
      this.files.set(file, state);
    }
    if (state.skip) return;

    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return;
    }
    if (size < state.offset) {
      // Truncado/rotacionado — recomeça com ingest limpo.
      this.files.set(file, {
        offset: 0,
        remainder: '',
        ingest: new CodexFileIngest(),
        skip: false,
      });
      state = this.files.get(file)!;
    }
    if (size === state.offset) return;

    let chunk: string;
    try {
      const fh = await fs.promises.open(file, 'r');
      try {
        const len = size - state.offset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, state.offset);
        chunk = buf.toString('utf-8');
      } finally {
        await fh.close();
      }
    } catch {
      return;
    }
    state.offset = size;

    const { lines, remainder } = splitTailChunk(state.remainder, chunk);
    state.remainder = remainder;
    for (const line of lines) {
      const event = state.ingest.ingestLine(line);
      const cwd = state.ingest.cwd;
      // cwd conhecido e fora dos workspaces observados → skip permanente.
      if (cwd && !this.opts.isWatched(cwd)) {
        state.skip = true;
        return;
      }
      if (event && cwd) {
        try {
          this.opts.onEvent(event, cwd);
        } catch {
          // Consumidor nunca derruba o scanner.
        }
      }
    }
    // Head inteiro lido sem session_meta: inatribuível, não insiste.
    if (!state.ingest.cwd && state.offset > META_DISCOVERY_BYTES) {
      state.skip = true;
    }
  }
}
