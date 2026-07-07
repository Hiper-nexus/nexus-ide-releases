import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeProjectSlug,
  parseTranscriptLine,
  splitTailChunk,
  type UsageEvent,
} from './claude-transcript';

/**
 * Observa os transcripts do Claude Code de um workspace e emite eventos de uso
 * REAL de tokens conforme as linhas chegam. Um watcher por workspace aberto.
 *
 * Regras de robustez (formato de terceiro, muda sem aviso):
 * - offsets por BYTES por arquivo; só lê o delta (tail), nunca o arquivo todo
 *   de novo (exceto no primeiro contato, para o seed histórico da sessão);
 * - linha parcial (sem \n) fica no remainder até o próximo chunk;
 * - linha malformada é ignorada em silêncio — NUNCA derruba o main;
 * - ingest do mesmo arquivo é serializado (uma leitura por vez);
 * - arquivo truncado/rotacionado (size < offset) reinicia o offset.
 *
 * A atribuição sessionId → pane fica no consumidor (onEvent): quem faz spawn
 * dita --session-id e sabe o dono determinístico de cada sessão.
 */

export interface WatcherOptions {
  workspacePath: string;
  onEvent: (event: UsageEvent, file: string) => void;
  /** Roots de config do Claude (multi-conta). Default: ~/.claude. */
  configDirs?: string[];
  /** Intervalo do rescan de segurança (fs.watch perde eventos). */
  pollMs?: number;
}

interface FileState {
  offset: number;
  remainder: string;
  ingesting: boolean;
  pendingScan: boolean;
}

const DEFAULT_POLL_MS = 5_000;

export class ClaudeTranscriptWatcher {
  private files = new Map<string, FileState>();
  private watchers: fs.FSWatcher[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private opts: WatcherOptions) {}

  /** Diretórios de projeto candidatos (um por root de config). */
  projectDirs(): string[] {
    const roots = this.opts.configDirs ?? [path.join(os.homedir(), '.claude')];
    const slug = claudeProjectSlug(this.opts.workspacePath);
    return roots.map((root) => path.join(root, 'projects', slug));
  }

  start(): void {
    for (const dir of this.projectDirs()) {
      try {
        if (!fs.existsSync(dir)) continue;
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename && filename.endsWith('.jsonl')) {
            void this.ingest(path.join(dir, filename.toString()));
          }
        });
        watcher.on('error', () => {
          /* dir removido — o poll re-descobre */
        });
        this.watchers.push(watcher);
      } catch {
        // Sem dir de projeto ainda (primeira sessão) — o poll descobre depois.
      }
    }
    this.pollTimer = setInterval(() => void this.scanAll(), this.opts.pollMs ?? DEFAULT_POLL_MS);
    // unref: o watcher nunca deve segurar o processo vivo no quit.
    this.pollTimer.unref?.();
    void this.scanAll();
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async scanAll(): Promise<void> {
    if (this.stopped) return;
    for (const dir of this.projectDirs()) {
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith('.jsonl')) void this.ingest(path.join(dir, name));
      }
    }
  }

  /** Lê o delta do arquivo desde o último offset e emite os eventos novos. */
  private async ingest(file: string): Promise<void> {
    if (this.stopped) return;
    let state = this.files.get(file);
    if (!state) {
      state = { offset: 0, remainder: '', ingesting: false, pendingScan: false };
      this.files.set(file, state);
    }
    // Serialização por arquivo: se já há um ingest em voo, marca re-scan.
    if (state.ingesting) {
      state.pendingScan = true;
      return;
    }
    state.ingesting = true;
    try {
      do {
        state.pendingScan = false;
        await this.ingestTail(file, state);
      } while (state.pendingScan && !this.stopped);
    } finally {
      state.ingesting = false;
    }
  }

  private async ingestTail(file: string, state: FileState): Promise<void> {
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return; // arquivo sumiu — nada a fazer
    }
    if (size < state.offset) {
      // Truncado/rotacionado: recomeça.
      state.offset = 0;
      state.remainder = '';
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
      return; // leitura falhou — o próximo poll tenta de novo
    }
    state.offset = size;

    const { lines, remainder } = splitTailChunk(state.remainder, chunk);
    state.remainder = remainder;
    for (const line of lines) {
      const event = parseTranscriptLine(line);
      if (!event) continue;
      try {
        this.opts.onEvent(event, file);
      } catch {
        // Consumidor nunca pode derrubar o watcher.
      }
    }
  }
}
