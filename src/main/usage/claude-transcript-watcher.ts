import { randomUUID } from 'node:crypto';
import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  claudeProjectSlug,
  readTranscriptLine,
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
  /**
   * `requestStartedAt`: início da requisição que gerou a mensagem (última
   * linha `user` antes da 1ª linha dela), ou null quando o watcher não viu
   * esse começo (retomada por offset).
   */
  onEvent: (
    event: UsageEvent,
    file: string,
    timing: { requestStartedAt: number | null },
  ) => void;
  /** Roots de config do Claude (multi-conta). Default: ~/.claude. */
  configDirs?: string[];
  /**
   * Intervalo do rescan de segurança (fs.watch perde eventos). Omitido: 5 s
   * enquanto algum diretório está sem watch saudável, 30 s com fs.watch ativo
   * em todos. Explícito é literal (testes/operador): sem adaptação.
   */
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
  /** Stat da última leitura COMPLETA (offset === size): o ciclo ignora o arquivo quando mtime+size batem. */
  mtimeMs: number;
  size: number;
  /** Última linha `user` (prompt/resultado de tool) vista neste arquivo. */
  requestAt: number | null;
  /** Mensagem em curso: tools rodam no meio dela e não reiniciam a janela. */
  messageId: string | null;
  messageStartedAt: number | null;
}

const DEFAULT_POLL_MS = 5_000;
/** Rescan de segurança com fs.watch saudável em todos os dirs: o watch entrega na hora. */
const WATCHED_POLL_MS = 30_000;
/** Nunca aloca um transcript inteiro: projetos ativos somam centenas de MB. */
const READ_CHUNK_BYTES = 512 * 1024;
/** Limita parse + consumidor síncronos antes de timers e IPC terem vez. */
const MAX_LINES_PER_SLICE = 32;
const MAX_SLICE_MS = 8;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Só ENOENT prova que o arquivo sumiu; EIO/EACCES/EMFILE são falhas transitórias. */
async function fileIsGone(file: string): Promise<boolean> {
  try {
    await fs.promises.stat(file);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function freshFileState(): FileState {
  return {
    offset: 0,
    committedOffset: 0,
    savedOffset: 0,
    remainder: '',
    decoder: new StringDecoder('utf8'),
    restored: false,
    mtimeMs: -1,
    size: -1,
    requestAt: null,
    messageId: null,
    messageStartedAt: null,
  };
}

export class ClaudeTranscriptWatcher {
  private files = new Map<string, FileState>();
  private watchers = new Map<string, fs.FSWatcher>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private armedPollMs = 0;
  private scanInFlight: Promise<void> | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  private stopped = false;
  private readonly controller = new AbortController();
  private readonly taskId = `usage-claude:${randomUUID()}`;

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
    if (this.pollTimer || this.stopped) return;
    this.armPoll(this.opts.pollMs ?? DEFAULT_POLL_MS);
    this.scheduleScan();
  }

  private armPoll(ms: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.scheduleScan(), ms);
    // unref: o watcher nunca deve segurar o processo vivo no quit.
    this.pollTimer.unref?.();
    this.armedPollMs = ms;
  }

  /**
   * Com fs.watch saudável em todos os diretórios o poll é só rede de
   * segurança e pode ser 6× mais lento; qualquer dir sem watch devolve o
   * rescan para o ritmo de descoberta (5 s). pollMs explícito não adapta.
   */
  private reschedulePoll(activeDirs: readonly string[]): void {
    if (this.stopped || !this.pollTimer) return;
    if (this.opts.pollMs !== undefined) return;
    const watched = activeDirs.length > 0 && activeDirs.every((dir) => this.watchers.has(dir));
    const desired = watched ? WATCHED_POLL_MS : DEFAULT_POLL_MS;
    if (desired !== this.armedPollMs) this.armPoll(desired);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort(new Error('Claude transcript watcher stopped'));
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
    await stopPeriodicTask(this.taskId);
    await this.scanInFlight?.catch(() => undefined);
    // onEvent runs before the asynchronous digest/checkpoint completes. A
    // replacement watcher must not load its cursor until that work is saved.
    await this.queueTail;
    await this.opts.resumeStore?.saveAsync();
  }

  private watchDirectory(dir: string): void {
    if (this.watchers.has(dir)) return;
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
        this.reschedulePoll(this.projectDirs());
      });
      this.watchers.set(dir, watcher);
    } catch {
      // Sem dir de projeto ainda (primeira sessão) — o poll descobre depois.
    }
  }

  /** Um rescan por vez: o poll não empilha varreduras enquanto uma corre. */
  private scheduleScan(): void {
    if (this.stopped || this.scanInFlight) return;
    const scan = runPeriodicTask(this.taskId, (context) => this.scanAll(context), { signal: this.controller.signal, cadenceMs: this.armedPollMs || this.opts.pollMs || DEFAULT_POLL_MS }).then(
      () => {
        if (this.scanInFlight === scan) this.scanInFlight = null;
      },
      () => {
        if (this.scanInFlight === scan) this.scanInFlight = null;
      },
    );
    this.scanInFlight = scan;
  }

  private async scanAll(context: PeriodicTaskContext): Promise<void> {
    if (this.stopped) return;
    await context.wait(this.opts.resumeStore?.loadAsync() ?? Promise.resolve());
    // Uma resolução por ciclo: antes projectDirs() era recomputado por arquivo.
    // Revogação de root passa a valer no próximo ciclo, não no meio do diretório.
    const activeDirs = this.projectDirs();
    const listedDirs = new Set<string>();
    const scanned = new Set<string>();
    for (const dir of activeDirs) {
      await context.checkpoint();
      if (this.stopped) return;
      this.watchDirectory(dir);
      let directory: Awaited<ReturnType<typeof fs.promises.opendir>>;
      try { directory = await fs.promises.opendir(dir, { bufferSize: 32 }); }
      catch { continue; }
      listedDirs.add(dir);
      try {
        for (;;) {
          await context.checkpoint();
          if (this.stopped) break;
          const entry = await context.wait(directory.read());
          if (!entry) break;
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const file = path.join(dir, entry.name);
            scanned.add(file);
            await context.wait(this.scanFile(file));
          }
        }
      } finally { await directory.close(); }
    }
    // Sumiu da listagem de um dir varrido com sucesso: solta o estado e o
    // registro de resume. Dir que falhou no opendir NÃO varre — falha
    // transitória de listagem não pode apagar registros (reemissão). E a
    // listagem pode omitir arquivo vivo (corrida com rename, FS de rede): só
    // ENOENT no stat prova que sumiu.
    for (const file of [...this.files.keys()]) {
      if (scanned.has(file)) continue;
      if (!listedDirs.has(path.dirname(file))) continue;
      if (!(await context.wait(fileIsGone(file)))) continue;
      this.files.delete(file);
      this.opts.resumeStore?.delete(file);
    }
    this.reschedulePoll(activeDirs);
    await this.opts.resumeStore?.saveAsync();
  }

  /**
   * Um stat por arquivo por ciclo: intacto (mesmo mtime+size do último
   * ingest) não entra na fila — antes todo arquivo pagava enqueue + ingest +
   * stat a cada rescan.
   */
  private async scanFile(file: string): Promise<void> {
    const state = this.files.get(file);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return; // sumiu entre a listagem e o stat — a varredura do ciclo limpa
    }
    if (state && state.mtimeMs === stat.mtimeMs && state.size === stat.size) return;
    await this.enqueue(file);
  }

  /**
   * Todo ingest (varredura e fs.watch) corre nesta fila, um arquivo por vez.
   * Um arquivo já na fila não entra de novo: a execução pendente lê tudo o
   * que houver quando chegar a vez dele.
   */
  private enqueue(file: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.queued.has(file)) return this.queueTail;
    this.queued.add(file);
    const run = this.queueTail.then(async () => {
      this.queued.delete(file);
      await this.opts.resumeStore?.loadAsync();
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
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return; // arquivo sumiu — nada a fazer
    }
    const size = stat.size;
    if (size < state.offset) {
      // Truncado/rotacionado: recomeça.
      Object.assign(state, freshFileState(), { restored: true });
      this.opts.resumeStore?.delete(file);
    }
    if (size === state.offset) {
      this.markIntact(state, stat);
      return;
    }

    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(file, 'r');
    } catch {
      return; // leitura falhou — mtime/size não foram marcados: o próximo poll tenta de novo
    }
    const slice = { lines: 0, startedAt: Date.now() };
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

        const { lines, remainder } = splitTailChunk(
          state.remainder,
          state.decoder.write(bytes),
        );
        state.remainder = remainder;
        if (!(await this.deliverLines(lines, file, state, slice))) return;
        if (boundary >= 0) state.committedOffset = readOffset + boundary;
      }
      this.markIntact(state, stat);
    } finally {
      await fh.close().catch(() => undefined);
      // Even an interrupted read may have fully delivered earlier chunks.
      // committedOffset advances only after every line in a chunk is delivered.
      await this.checkpoint(file, state);
    }
  }

  /**
   * mtime+size é o que o próximo ciclo compara para pular arquivo intacto, e
   * o stat que manda é o do ingest (a fila é assíncrona). Só vale quando o
   * arquivo foi lido ATÉ esse stat: falha de open/read com offset < size deixa
   * o registro anterior, que difere do stat atual, e o ciclo seguinte tenta de
   * novo — senão o último turno de uma sessão ociosa só entraria no próximo
   * write ou restart.
   */
  private markIntact(state: FileState, stat: fs.Stats): void {
    if (state.offset !== stat.size) return;
    state.mtimeMs = stat.mtimeMs;
    state.size = stat.size;
  }

  /** Entrega as linhas cedendo o event loop a cada fatia; false = watcher parado. */
  private async deliverLines(
    lines: readonly string[],
    file: string,
    state: FileState,
    slice: { lines: number; startedAt: number },
  ): Promise<boolean> {
    for (let index = 0; index < lines.length; index += 1) {
      if (this.stopped) return false;
      const line = lines[index]!;
      const { usage: event, requestAt } = readTranscriptLine(line);
      if (requestAt !== null) state.requestAt = requestAt;
      if (event) {
        if (event.messageId === null || event.messageId !== state.messageId) {
          state.messageId = event.messageId;
          state.messageStartedAt = state.requestAt;
        }
        this.emit(event, file, state.messageStartedAt);
      }
      slice.lines += 1;
      // A stop from the final onEvent must still commit this complete chunk.
      if (index === lines.length - 1) return true;
      if (slice.lines < MAX_LINES_PER_SLICE && Date.now() - slice.startedAt < MAX_SLICE_MS) {
        continue;
      }
      await yieldToEventLoop();
      if (this.stopped) return false;
      slice.lines = 0;
      slice.startedAt = Date.now();
    }
    return true;
  }

  private emit(event: UsageEvent, file: string, requestStartedAt: number | null): void {
    try {
      this.opts.onEvent(event, file, { requestStartedAt });
    } catch {
      // Consumidor nunca pode derrubar o watcher.
    }
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
