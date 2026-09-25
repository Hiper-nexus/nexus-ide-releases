import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  claudeProjectSlug,
  parseTranscriptLine,
  splitTailChunk,
  type UsageEvent,
} from './claude-transcript';
import type { ClaudeTranscriptResumeStore } from './claude-transcript-resume-store';
import {
  findLastLineBoundary,
  isResumablePrefixLength,
  readPrefixDigests,
  verifyResumedPrefix,
} from './codex-rollout-resume-state';

/**
 * Observa os transcripts do Claude Code de um checkout e das execution roots
 * explicitamente autorizadas para ele, emitindo uso REAL conforme as linhas
 * chegam. Um watcher por escopo de checkout, inclusive com vários worktrees.
 *
 * Regras de robustez (formato de terceiro, muda sem aviso):
 * - offsets por BYTES por arquivo; só lê o delta (tail), nunca o arquivo todo
 *   de novo. O primeiro contato lê o histórico da sessão uma vez; com
 *   `resumeStore` o offset sobrevive ao restart (prefixo provado por digest),
 *   então o boot não relê centenas de MB de JSONL a cada abertura;
 * - leitura em fatias de 512 KB com StringDecoder e yield entre lotes: nunca
 *   aloca um transcript inteiro nem prende o main thread;
 * - todo ingest passa por UMA fila: um arquivo aberto por vez (o boot com
 *   163 transcripts em paralelo chegava a ~400 MB de buffers);
 * - linha parcial (sem \n) fica no remainder até o próximo chunk;
 * - linha malformada é ignorada em silêncio — NUNCA derruba o main;
 * - arquivo truncado/rotacionado (size < offset) reinicia o offset.
 *
 * A atribuição sessionId → pane fica no consumidor (onEvent): quem faz spawn
 * dita --session-id e sabe o dono determinístico de cada sessão.
 */

export interface WatcherOptions {
  /** Coordination checkout kept for backwards compatibility. */
  workspacePath: string;
  /**
   * Additional main-authorized execution roots (for example task worktrees).
   * The resolver is intentionally lazy: a long-lived watcher sees roots that
   * are granted after it starts without scanning unrelated checkouts.
   */
  workspacePaths?: () => Iterable<string>;
  onEvent: (event: UsageEvent, file: string) => void;
  /** Roots de config do Claude (multi-conta). Default: ~/.claude. */
  configDirs?: string[];
  /** Intervalo do rescan de segurança (fs.watch perde eventos). */
  pollMs?: number;
  /**
   * Onde cada arquivo parou, entre restarts. Omitido = só memória: o primeiro
   * contato relê o arquivo inteiro, como antes.
   */
  resumeStore?: ClaudeTranscriptResumeStore;
}

interface FileState {
  /** Bytes já lidos (pode estar no meio de uma linha). */
  offset: number;
  /** Logo após o último \n lido: fronteira segura para retomar. */
  committedOffset: number;
  /** committedOffset já gravado no resumeStore. */
  savedOffset: number;
  remainder: string;
  decoder: StringDecoder;
  restored: boolean;
}

const DEFAULT_POLL_MS = 5_000;
/** Nunca aloca um transcript inteiro: projetos ativos somam centenas de MB. */
const READ_CHUNK_BYTES = 512 * 1024;
/** Limita parse + consumidor síncronos antes de timers e IPC terem vez. */
const MAX_LINES_PER_SLICE = 32;
const MAX_SLICE_MS = 8;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function freshFileState(): FileState {
  return {
    offset: 0,
    committedOffset: 0,
    savedOffset: 0,
    remainder: '',
    decoder: new StringDecoder('utf8'),
    restored: false,
  };
}

export class ClaudeTranscriptWatcher {
  private files = new Map<string, FileState>();
  private watchers = new Map<string, fs.FSWatcher>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private scanInFlight: Promise<void> | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  private stopped = false;

  constructor(private opts: WatcherOptions) {}

  /** Diretórios de projeto candidatos (um por root de config). */
  projectDirs(): string[] {
    const roots = this.opts.configDirs ?? [path.join(os.homedir(), '.claude')];
    const workspaces = new Set([this.opts.workspacePath]);
    for (const workspacePath of this.opts.workspacePaths?.() ?? []) {
      workspaces.add(workspacePath);
    }
    return [...workspaces].flatMap((workspacePath) => {
      const slug = claudeProjectSlug(workspacePath);
      return roots.map((root) => path.join(root, 'projects', slug));
    });
  }

  start(): void {
    this.pollTimer = setInterval(() => this.scheduleScan(), this.opts.pollMs ?? DEFAULT_POLL_MS);
    // unref: o watcher nunca deve segurar o processo vivo no quit.
    this.pollTimer.unref?.();
    this.scheduleScan();
  }

  stop(): void {
    this.stopped = true;
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.opts.resumeStore?.save();
  }

  private watchDirectory(dir: string): void {
    if (this.watchers.has(dir) || !fs.existsSync(dir)) return;
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          void this.enqueue(path.join(dir, filename.toString()));
        }
      });
      watcher.on('error', () => {
        if (this.watchers.get(dir) !== watcher) return;
        this.watchers.delete(dir);
        try {
          watcher.close();
        } catch {
          // O poll tenta observar o diretório novamente.
        }
      });
      this.watchers.set(dir, watcher);
    } catch {
      // Sem dir de projeto ainda (primeira sessão) — o poll descobre depois.
    }
  }

  /** Um rescan por vez: o poll não empilha varreduras enquanto uma corre. */
  private scheduleScan(): void {
    if (this.stopped || this.scanInFlight) return;
    const scan = this.scanAll().then(
      () => {
        if (this.scanInFlight === scan) this.scanInFlight = null;
      },
      () => {
        if (this.scanInFlight === scan) this.scanInFlight = null;
      },
    );
    this.scanInFlight = scan;
  }

  private async scanAll(): Promise<void> {
    if (this.stopped) return;
    for (const dir of this.projectDirs()) {
      if (this.stopped) return;
      this.watchDirectory(dir);
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (this.stopped) return;
        if (name.endsWith('.jsonl')) await this.enqueue(path.join(dir, name));
      }
    }
    this.opts.resumeStore?.save();
  }

  /**
   * Todo ingest (varredura e fs.watch) corre nesta fila, um arquivo por vez.
   * Um arquivo já na fila não entra de novo: a execução pendente lê tudo o
   * que houver quando chegar a vez dele.
   */
  private enqueue(file: string): Promise<void> {
    if (this.queued.has(file)) return this.queueTail;
    this.queued.add(file);
    const run = this.queueTail.then(async () => {
      this.queued.delete(file);
      await this.ingest(file);
    });
    this.queueTail = run.catch(() => undefined);
    return this.queueTail;
  }

  /** Lê o delta do arquivo desde o último offset e emite os eventos novos. */
  private async ingest(file: string): Promise<void> {
    if (this.stopped) return;
    let state = this.files.get(file);
    if (!state) {
      state = freshFileState();
      this.files.set(file, state);
    }
    if (!state.restored) {
      state.restored = true;
      await this.restore(file, state);
    }
    await this.ingestTail(file, state);
  }

  /** Retoma do offset gravado só se o prefixo provadamente não mudou. */
  private async restore(file: string, state: FileState): Promise<void> {
    const store = this.opts.resumeStore;
    const record = store?.get(file);
    if (!store || !record) return;
    if (!(await verifyResumedPrefix(file, record))) {
      store.delete(file);
      return;
    }
    state.offset = record.offset;
    state.committedOffset = record.offset;
    state.savedOffset = record.offset;
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
      Object.assign(state, freshFileState(), { restored: true });
      this.opts.resumeStore?.delete(file);
    }
    if (size === state.offset) return;

    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(file, 'r');
    } catch {
      return; // leitura falhou — o próximo poll tenta de novo
    }
    let linesInSlice = 0;
    let sliceStartedAt = Date.now();
    try {
      while (state.offset < size) {
        if (this.stopped) return;
        const readOffset = state.offset;
        const length = Math.min(READ_CHUNK_BYTES, size - readOffset);
        const buffer = Buffer.allocUnsafe(length);
        let bytesRead: number;
        try {
          ({ bytesRead } = await fh.read(buffer, 0, length, readOffset));
        } catch {
          return;
        }
        if (bytesRead <= 0) return;
        const bytes = buffer.subarray(0, bytesRead);
        state.offset = readOffset + bytesRead;
        const boundary = findLastLineBoundary(bytes);
        if (boundary >= 0) state.committedOffset = readOffset + boundary;

        const { lines, remainder } = splitTailChunk(
          state.remainder,
          state.decoder.write(bytes),
        );
        state.remainder = remainder;
        for (const line of lines) {
          const event = parseTranscriptLine(line);
          if (event) {
            try {
              this.opts.onEvent(event, file);
            } catch {
              // Consumidor nunca pode derrubar o watcher.
            }
          }
          linesInSlice += 1;
          if (
            linesInSlice >= MAX_LINES_PER_SLICE ||
            Date.now() - sliceStartedAt >= MAX_SLICE_MS
          ) {
            await yieldToEventLoop();
            if (this.stopped) return;
            linesInSlice = 0;
            sliceStartedAt = Date.now();
          }
        }
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
    await this.checkpoint(file, state);
  }

  /** Grava a fronteira da última linha completa, com os digests do prefixo. */
  private async checkpoint(file: string, state: FileState): Promise<void> {
    const store = this.opts.resumeStore;
    if (!store || state.committedOffset <= state.savedOffset) return;
    // Prefixo curto: reler é tão barato quanto provar, e não vale registro.
    if (!isResumablePrefixLength(state.committedOffset)) return;
    const digests = await readPrefixDigests(file, state.committedOffset);
    if (!digests) return;
    store.set(file, { offset: state.committedOffset, ...digests });
    state.savedOffset = state.committedOffset;
  }
}
