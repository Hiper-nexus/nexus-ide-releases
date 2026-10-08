import { randomUUID } from 'node:crypto';
import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { splitTailChunk, type UsageEvent } from './claude-transcript';
import {
  findLastLineBoundary,
  isResumablePrefixLength,
  readHeadDigest,
  readPrefixDigests,
  verifyResumedPrefix,
} from './codex-rollout-resume-state';
import { CodexResumeStore } from './codex-resume-store';
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
  decoder: StringDecoder;
  ingest: CodexFileIngest;
  skip: boolean;
  /** Known cwd not currently owned by an active project scope. */
  inactiveCwd: string | null;
  /** Maior offset em fim-de-linha completa alcançado (fronteira persistível). */
  committedOffset: number;
  /** Offset já gravado no resume store (evita re-digest por scan). */
  savedOffset: number;
  /** Tamanho visto no último save (detecta rotação sob skip). */
  savedSize: number;
}

export interface CodexRolloutSource {
  /** Canonical provider session used by exact resume. */
  providerSessionId: string;
  /** Physical thread that owns this rollout. */
  threadId: string;
  /** Physical thread id encoded in the immutable rollout filename. */
  rolloutSessionId: string | null;
  /** Creation time from the first (file-owning) session_meta. */
  sessionStartedAt: number | null;
  parentThreadId?: string;
}

export interface CodexScannerOptions {
  isWatched: (cwd: string) => boolean;
  onEvent: (
    event: UsageEvent,
    cwd: string,
    source: CodexRolloutSource,
  ) => void;
  sessionsDir?: string;
  /**
   * Raízes de sessão adicionais — o estado Nexus por checkout (F-566):
   * `<userData>/provider-state/codex/<checkoutId>/sessions`. Avaliada a cada
   * varredura porque o conjunto de checkouts observados cresce sem reiniciar
   * o scanner.
   */
  sessionsDirs?: () => readonly string[];
  pollMs?: number;
  /**
   * Diretório do resume store (`codex-resume.json`). Omitido = `<userData>/usage`
   * no Electron; fora dele (testes sem dir) o resume desliga e o scanner opera
   * só em memória, como antes.
   */
  persistDir?: string;
}

function defaultPersistDir(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron só existe no app; fora dele o catch desliga a persistência
    const electron = require('electron') as {
      app?: { getPath(name: 'userData'): string };
    };
    if (typeof electron?.app?.getPath !== 'function') return null;
    return path.join(electron.app.getPath('userData'), 'usage');
  } catch {
    return null;
  }
}

const DEFAULT_POLL_MS = 10_000;
/** Após ler este tanto sem session_meta, o arquivo é considerado inatribuível. */
const META_DISCOVERY_BYTES = 128 * 1024;
/** Never allocate an entire long-running rollout in the Electron main process. */
const READ_CHUNK_BYTES = 512 * 1024;
/** Bound synchronous JSON/SQLite work before timers and IPC get another turn. */
const MAX_LINES_PER_SLICE = 32;
const MAX_SLICE_MS = 8;
const ROLLOUT_SESSION_ID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function dayDir(root: string, date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(root, String(y), m, d);
}

export class CodexUsageScanner {
  private files = new Map<string, FileState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanInFlight: Promise<void> | null = null;
  private stopped = false;
  private controller = new AbortController();
  private readonly taskId = `usage-codex:${randomUUID()}`;
  private stopping: Promise<void> | null = null;
  private readonly resumeStore: CodexResumeStore | null;
  private resumeDirty = false;

  constructor(private opts: CodexScannerOptions) {
    const dir = opts.persistDir ?? defaultPersistDir();
    this.resumeStore = dir ? new CodexResumeStore(dir) : null;
  }

  start(): void {
    if (this.timer) return;
    if (this.stopping || this.scanInFlight) throw new Error('Codex scanner still settling');
    this.stopped = false;
    this.controller = new AbortController();
    this.timer = setInterval(
      () => this.scheduleScan(),
      this.opts.pollMs ?? DEFAULT_POLL_MS,
    );
    this.timer.unref?.();
    this.scheduleScan();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.controller.abort(new Error('Codex usage scanner stopped'));
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const flight = (async () => {
      await stopPeriodicTask(this.taskId);
      await this.scanInFlight?.catch(() => undefined);
      await this.flushResumeStore();
    })();
    this.stopping = flight;
    void flight.finally(() => { if (this.stopping === flight) this.stopping = null; });
    return flight;
  }

  private async flushResumeStore(): Promise<void> {
    if (!this.resumeDirty || !this.resumeStore) return;
    this.resumeDirty = false;
    await this.resumeStore.saveAsync();
  }

  private roots(): string[] {
    return [
      ...new Set<string>([
        this.opts.sessionsDir ??
          path.join(os.homedir(), '.codex', 'sessions'),
        ...(this.opts.sessionsDirs?.() ?? []),
      ]),
    ];
  }

  private scheduleScan(): void {
    if (this.stopped || this.scanInFlight) return;
    const scan = runPeriodicTask(this.taskId, (context) => this.scan(context), { signal: this.controller.signal, cadenceMs: this.opts.pollMs ?? DEFAULT_POLL_MS });
    this.scanInFlight = scan;
    void scan.then(
      () => {
        if (this.scanInFlight === scan) this.scanInFlight = null;
      },
      () => {
        if (this.scanInFlight === scan) this.scanInFlight = null;
      },
    );
  }

  private async scan(context: PeriodicTaskContext): Promise<void> {
    if (this.stopped) return;
    await context.wait(this.resumeStore?.loadAsync() ?? Promise.resolve());
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    const dirs = this.roots().flatMap((root) => [
      dayDir(root, now),
      dayDir(root, yesterday),
    ]);
    for (const dir of dirs) {
      await context.checkpoint();
      if (this.stopped) return;
      let directory: Awaited<ReturnType<typeof fs.promises.opendir>>;
      try { directory = await fs.promises.opendir(dir, { bufferSize: 32 }); }
      catch { continue; }
      try {
        for (;;) {
          await context.checkpoint();
          if (this.stopped) return;
          const entry = await context.wait(directory.read());
          if (!entry) break;
          if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
          await context.wait(this.ingestTail(path.join(dir, entry.name)));
        }
      } finally { await directory.close(); }
    }
    await this.flushResumeStore();
  }

  private freshFileState(): FileState {
    return {
      offset: 0,
      remainder: '',
      decoder: new StringDecoder('utf8'),
      ingest: new CodexFileIngest(),
      skip: false,
      inactiveCwd: null,
      committedOffset: 0,
      savedOffset: 0,
      savedSize: 0,
    };
  }

  /**
   * Tenta retomar o arquivo a partir do resume store. Qualquer dúvida (sem
   * registro, digest divergente, snapshot inválido) cai para reparse integral
   * — o estado fresco já está montado, basta não tocar nele.
   */
  private async tryRestoreResume(file: string, state: FileState): Promise<void> {
    const store = this.resumeStore;
    if (!store) return;
    const record = store.get(file);
    if (!record) return;
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return;
    }
    if (record.skip) {
      // skip sem meta no head vale entre restarts; rotação (encolheu) ou head
      // trocado invalida — sem isso um arquivo novo com nome velho sumiria.
      if (size < record.size) {
        store.delete(file);
        this.resumeDirty = true;
        return;
      }
      if (record.headDigest !== null) {
        const current = await readHeadDigest(file);
        if (current !== record.headDigest) {
          store.delete(file);
          this.resumeDirty = true;
          return;
        }
      }
      state.skip = true;
      state.savedOffset = 0;
      state.savedSize = record.size;
      return;
    }
    if (record.inactiveCwd) {
      // Rotação sob park: arquivo novo precisa de head fresco, não do cwd velho.
      if (size < record.size) {
        store.delete(file);
        this.resumeDirty = true;
        return;
      }
      // O replay-sob-ativação recomeça do head de qualquer forma.
      state.inactiveCwd = record.inactiveCwd;
      state.savedSize = record.size;
      return;
    }
    if (
      !record.ingest ||
      record.headDigest === null ||
      record.boundaryDigest === null
    ) {
      store.delete(file);
      this.resumeDirty = true;
      return;
    }
    const verified = await verifyResumedPrefix(file, {
      offset: record.offset,
      headDigest: record.headDigest,
      boundaryDigest: record.boundaryDigest,
    });
    if (!verified) {
      store.delete(file);
      this.resumeDirty = true;
      return;
    }
    state.ingest.restore(record.ingest);
    state.offset = record.offset;
    state.committedOffset = record.offset;
    state.savedOffset = record.offset;
    state.savedSize = size;
  }

  private async checkpointResume(
    file: string,
    state: FileState,
    size: number,
  ): Promise<void> {
    const store = this.resumeStore;
    if (!store) return;
    if (state.skip) {
      // Achado Rabbit: sem digest de head, não persiste skip — um registro sem
      // prova enfraqueceria todos os restarts futuros; revarrer uma vez por
      // boot até o digest vingar é limitado e seguro.
      const headDigest = await readHeadDigest(file);
      if (headDigest === null) return;
      store.set(file, {
        offset: 0,
        size,
        ingest: null,
        skip: true,
        inactiveCwd: null,
        headDigest,
        boundaryDigest: null,
      });
      state.savedSize = size;
      this.resumeDirty = true;
      return;
    }
    if (state.inactiveCwd) {
      store.set(file, {
        offset: 0,
        size,
        ingest: null,
        skip: false,
        inactiveCwd: state.inactiveCwd,
        headDigest: null,
        boundaryDigest: null,
      });
      state.savedSize = size;
      this.resumeDirty = true;
      return;
    }
    if (state.committedOffset <= state.savedOffset) return;
    if (!isResumablePrefixLength(state.committedOffset)) return;
    const snapshot = state.ingest.snapshot();
    if (!snapshot) return;
    const digests = await readPrefixDigests(file, state.committedOffset);
    if (!digests) return;
    store.set(file, {
      offset: state.committedOffset,
      size,
      ingest: snapshot,
      skip: false,
      inactiveCwd: null,
      headDigest: digests.headDigest,
      boundaryDigest: digests.boundaryDigest,
    });
    state.savedOffset = state.committedOffset;
    state.savedSize = size;
    this.resumeDirty = true;
  }

  private async ingestTail(file: string): Promise<void> {
    if (this.stopped) return;
    let state = this.files.get(file);
    if (!state) {
      state = this.freshFileState();
      this.files.set(file, state);
      await this.tryRestoreResume(file, state);
      if (this.stopped) return;
    }
    if (state.skip) return;
    if (state.inactiveCwd) {
      if (!this.opts.isWatched(state.inactiveCwd)) return;
      // The project became active after this rollout was first discovered.
      // Replay from the head exactly once so restart/historical accounting is
      // complete without repeatedly scanning unrelated projects.
      state.offset = 0;
      state.remainder = '';
      state.decoder = new StringDecoder('utf8');
      state.ingest = new CodexFileIngest();
      state.inactiveCwd = null;
      state.committedOffset = 0;
      state.savedOffset = 0;
      if (this.resumeStore) {
        // Achado review: sem isto, rollout < piso regravava o registro
        // inactive a cada boot e repetia o replay para sempre.
        this.resumeStore.delete(file);
        this.resumeDirty = true;
      }
    }

    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return;
    }
    if (size < state.offset) {
      // Truncado/rotacionado — recomeça com ingest limpo.
      state = this.freshFileState();
      this.files.set(file, state);
      if (this.resumeStore) {
        this.resumeStore.delete(file);
        this.resumeDirty = true;
      }
    }
    if (size === state.offset) return;

    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(file, 'r');
    } catch {
      return;
    }

    let linesInSlice = 0;
    let sliceStartedAt = Date.now();
    const rolloutSessionId =
      ROLLOUT_SESSION_ID.exec(path.basename(file))?.[1] ?? null;
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
        state.offset = readOffset + bytesRead;
        const lastNewline = findLastLineBoundary(
          buffer.subarray(0, bytesRead),
        );
        if (lastNewline >= 0) {
          state.committedOffset = Math.max(
            state.committedOffset,
            readOffset + lastNewline,
          );
        }

        const chunk = state.decoder.write(buffer.subarray(0, bytesRead));
        const { lines, remainder } = splitTailChunk(state.remainder, chunk);
        state.remainder = remainder;
        for (const line of lines) {
          const event = state.ingest.ingestLine(line);
          const cwd = state.ingest.cwd;
          // A workspace can become active later. Park the rollout and replay it
          // from the head when its immutable scope is registered.
          if (cwd && !this.opts.isWatched(cwd)) {
            state.inactiveCwd = cwd;
            await this.checkpointResume(file, state, size);
            return;
          }
          if (event && cwd) {
            if (this.stopped) return;
            try {
              const threadId = state.ingest.threadId;
              if (!threadId) {
                throw new Error('Codex usage event has no rollout thread id');
              }
              this.opts.onEvent(event, cwd, {
                providerSessionId: event.sessionId,
                threadId,
                rolloutSessionId,
                sessionStartedAt: state.ingest.sessionStartedAt,
                ...(state.ingest.parentThreadId
                  ? { parentThreadId: state.ingest.parentThreadId }
                  : {}),
              });
            } catch {
              // Consumidor nunca derruba o scanner.
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
        // Head suficiente lido sem session_meta: inatribuível, não insiste.
        if (
          lines.length > 0 &&
          !state.ingest.cwd &&
          state.offset > META_DISCOVERY_BYTES
        ) {
          state.skip = true;
          await this.checkpointResume(file, state, size);
          return;
        }
      }
      await this.checkpointResume(file, state, size);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
}
