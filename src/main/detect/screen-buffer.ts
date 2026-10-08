// Per-session screen snapshot for the detection engine.
//
// Two engines implement ScreenSource:
//  - GhosttyScreenBuffer (default for agent sessions): a headless libghostty-vt
//    cell grid per session (ghostty-screen.ts). Soft wraps are rejoined,
//    cursor-addressed redraws replace the old frame, the alternate screen
//    replaces the primary one — the rendered grid Herdr's manifests target.
//  - SessionScreenBuffer (fallback): a rolling tail of ANSI-stripped PTY
//    output (stripAnsi from src/shared/ansi-text). Cursor movement is
//    flattened to an append stream, so a TUI repaint appends a fresh copy of
//    the redrawn region instead of replacing it; the bottom of the tail still
//    holds the latest frame. Used when the wasm cannot load, for sessions
//    without a manifest (shell panes never pay a grid) and over budget.

import { stripAnsi } from '../../shared/ansi-text';
import { loadGhosttyRuntime, type GhosttyRuntime } from './ghostty-runtime';
import { GhosttyScreen } from './ghostty-screen';

/** What the detector reads: one screen per PTY session. */
export interface ScreenSource {
  /**
   * Feed one raw PTY chunk. Returns a sequence number that differs from the
   * last contentSeq() result whenever the visible screen may have changed.
   */
  append(sessionId: string, rawData: string): number;
  /** Whole retained screen text (never null). */
  text(sessionId: string): string;
  /** Last `maxChars` of the screen, starting on a whole line. */
  tail(sessionId: string, maxChars: number): string;
  /** Monotonic counter bumped when the visible text changed. */
  contentSeq(sessionId: string): number;
  /** PTY winsize; the grid reflows like the real terminal does. */
  resize(sessionId: string, cols: number, rows: number): void;
  drop(sessionId: string): void;
}

/** Retained stripped characters per session (~256 KB of recent output). */
const MAX_BUFFER_CHARS = 262_144;
/** Held escape fragments longer than this come from a broken writer; strip. */
const MAX_HELD_ESCAPE = 4096;

const CSI_PREFIX = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
const OSC_TERMINATOR = /\x07|\x1b\\/;

interface ScreenBufferState {
  /** Stripped chunks since the last materialization; joined on read. */
  chunks: string[];
  chars: number;
  /** Materialized tail, valid until the next append. */
  cached: string | null;
  /** Raw tail held back because it ends mid-escape sequence. */
  pendingRaw: string;
  /** Monotonic content counter — bumped whenever visible text changed. */
  contentSeq: number;
}

/**
 * True when `suffix` (starting at the chunk's last ESC) is an escape sequence
 * that is still incomplete: a lone ESC, an OSC without its BEL/ST terminator,
 * or a CSI without its final byte. Complete sequences strip normally, so the
 * visible text never lags behind the stream in steady state.
 */
function endsMidEscape(suffix: string): boolean {
  if (suffix.length > MAX_HELD_ESCAPE) return false;
  if (suffix === '\x1b') return true;
  if (suffix.startsWith('\x1b]')) return !OSC_TERMINATOR.test(suffix);
  if (suffix.startsWith('\x1b[')) return !CSI_PREFIX.test(suffix);
  // ESC + one byte in @-_ is a complete two-byte sequence; anything else is
  // treated as complete garbage and stripped rather than held forever.
  return false;
}

function materialize(state: ScreenBufferState): string {
  if (state.cached !== null) return state.cached;
  const joined = state.chunks.join('');
  const tail =
    joined.length > MAX_BUFFER_CHARS ? joined.slice(-MAX_BUFFER_CHARS) : joined;
  state.chunks = tail ? [tail] : [];
  state.chars = tail.length;
  state.cached = tail;
  return tail;
}

/** Last `maxChars` of `text`, dropping the first line when the cut split it. */
function lineAlignedTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(-maxChars);
  // A primeira linha da janela veio cortada: só entram linhas inteiras.
  const newline = window.indexOf('\n');
  return newline >= 0 && newline < window.length - 1
    ? window.slice(newline + 1)
    : window;
}

export class SessionScreenBuffer implements ScreenSource {
  private readonly sessions = new Map<string, ScreenBufferState>();

  /** Feed one raw PTY chunk; bumps contentSeq when visible text results. */
  append(sessionId: string, rawData: string, decoded?: (text: string) => void): number {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { chunks: [], chars: 0, cached: '', pendingRaw: '', contentSeq: 0 };
      this.sessions.set(sessionId, state);
    }
    let combined = state.pendingRaw + rawData;
    state.pendingRaw = '';
    const lastEsc = combined.lastIndexOf('\x1b');
    if (lastEsc >= 0 && endsMidEscape(combined.slice(lastEsc))) {
      state.pendingRaw = combined.slice(lastEsc);
      combined = combined.slice(0, lastEsc);
    }
    const stripped = stripAnsi(combined);
    decoded?.(stripped);
    if (stripped.length === 0) return state.contentSeq;
    // Append is O(chunk): concatenating and slicing the full 256 KB tail on
    // every chunk dominated main-thread CPU under streaming output. The tail
    // is built when read (detector evals are debounced) and compacted here
    // only after it doubles, so memory stays bounded.
    state.chunks.push(stripped);
    state.chars += stripped.length;
    state.cached = null;
    if (state.chars > 2 * MAX_BUFFER_CHARS) materialize(state);
    state.contentSeq += 1;
    return state.contentSeq;
  }

  /** Current stripped tail for the session (never null). */
  text(sessionId: string): string {
    const state = this.sessions.get(sessionId);
    return state ? materialize(state) : '';
  }

  /**
   * Últimos `maxChars` do texto, começando numa linha inteira (F-764 C.3).
   * A avaliação dos manifestos olha a TELA, não 256 KB de histórico: com o
   * buffer cheio cada avaliação custava até ~9 ms (claude), dez vezes por
   * segundo por sessão. Junta só os chunks do fim, sem materializar o resto.
   */
  tail(sessionId: string, maxChars: number): string {
    const state = this.sessions.get(sessionId);
    if (!state) return '';
    let first = state.chunks.length;
    let collected = 0;
    while (first > 0 && collected < maxChars) {
      first -= 1;
      collected += state.chunks[first].length;
    }
    const joined =
      first === state.chunks.length - 1
        ? state.chunks[first]
        : state.chunks.slice(first).join('');
    return lineAlignedTail(joined, maxChars);
  }

  contentSeq(sessionId: string): number {
    return this.sessions.get(sessionId)?.contentSeq ?? 0;
  }

  /** A text stream has no geometry. */
  resize(): void {}

  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export type GhosttyFallbackReason =
  | 'unavailable'
  | 'session-cap'
  | 'memory-budget'
  | 'grid-too-large'
  | 'runtime-trap';

/**
 * Ghostty preheats a page pool per terminal: ~5 MiB each whatever the grid
 * size (measured), so 32 grids cost ~160 MiB of Worker memory at most.
 */
export const GHOSTTY_MAX_TERMINALS = 32;
/**
 * Linear memory never shrinks. Past this high-water mark no new grid starts,
 * and a write/resize that grows memory beyond it sends its session to text.
 */
export const GHOSTTY_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
/**
 * Grids above this many cells stay on the text stream. Up to 500×200 fits
 * the preheated pool (+0.1 MiB measured); 1000×500 grew a grid by +8.5 MiB.
 */
export const GHOSTTY_MAX_GRID_CELLS = 100_000;
/**
 * Linear memory one session's writes/resizes may add after its grid exists.
 * Normal TUI output measured ≤0.1 MiB; a combining-mark flood grew 2 GiB.
 */
export const GHOSTTY_MAX_SESSION_GROWTH_BYTES = 16 * 1024 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 1_000;
const MAX_ROWS = 500;

export interface GhosttyScreenBufferOptions {
  /** Sessions that get a grid; the rest stay on the stripped-text stream. */
  eligible?: (sessionId: string) => boolean;
  /** Once per reason per buffer: the session(s) fell back to the text stream. */
  onFallback?: (reason: GhosttyFallbackReason, detail: string) => void;
  maxTerminals?: number;
  maxMemoryBytes?: number;
  maxGridCells?: number;
  maxSessionGrowthBytes?: number;
  /** Infinity disables the cluster clamp (tests of the generic memory budget). */
  maxClusterExtenders?: number;
}

interface GridState {
  cols: number;
  rows: number;
  screen: GhosttyScreen | null;
  /** A grid was refused (budget/trap): this session stays on the text stream. */
  textOnly: boolean;
  /** Linear memory this session's grid grew after it was created. */
  grown: number;
  /** Cluster-extender run left open by the previous chunk (clamp carry-over). */
  extenderRun: number;
  seq: number;
  /** Formatted grid, valid until the next write/resize. */
  rendered: string | null;
  /** Grid text when `seq` last moved. */
  seqText: string;
}

function clampDimension(value: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
}

/**
 * Longest run of cluster-extending code points one grid cell receives. Real
 * text needs a handful (accents, emoji ZWJ families); a flood of combining
 * marks grew one cell's grapheme storage to 2 GiB and cost ~0.9 s per 16K
 * chunk inside the wasm — past the Worker's 250 ms watchdog.
 */
export const GHOSTTY_MAX_CLUSTER_EXTENDERS = 32;
/** Combining marks (incl. variation selectors), ZWJ(+pictograph), conjoining jamo. */
const CLUSTER_EXTENDERS = /(?:\p{M}|\u200D\p{Extended_Pictographic}?|[\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF])+/gu;
const CLUSTER_EXTENDER_HINT = /[\p{M}\u200D\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF]/u;

/**
 * Trim every extender run to the cap, counting a run carried over from the
 * previous chunk (`carried`). Returns the text and the run left open at its end.
 */
export function clampClusterExtenders(
  text: string,
  carried: number,
  max = GHOSTTY_MAX_CLUSTER_EXTENDERS,
): { text: string; trailing: number } {
  if (!Number.isFinite(max) || (carried === 0 && !CLUSTER_EXTENDER_HINT.test(text))) return { text, trailing: 0 };
  let trailing = 0;
  const clamped = text.replace(CLUSTER_EXTENDERS, (run: string, offset: number) => {
    const before = offset === 0 ? carried : 0;
    const allowed = Math.max(0, max - before);
    let kept = '';
    let count = 0;
    for (const codePoint of run) {
      if (count === allowed) {
        count += 1;
        break;
      }
      kept += codePoint;
      count += 1;
    }
    if (offset + run.length === text.length) {
      trailing = Math.min(max, before + count);
    }
    return kept;
  });
  return { text: clamped, trailing };
}

function failureDetail(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code.slice(0, 64);
  return error instanceof Error ? error.name.slice(0, 64) : 'Error';
}

/**
 * libghostty-vt grid per eligible session, with the stripped-text stream as
 * the automatic fallback (ineligible session, budget, or a wasm trap).
 */
export class GhosttyScreenBuffer implements ScreenSource {
  readonly #sessions = new Map<string, GridState>();
  readonly #fallback = new SessionScreenBuffer();
  readonly #reported = new Set<GhosttyFallbackReason>();

  constructor(
    private readonly runtime: GhosttyRuntime,
    private readonly options: GhosttyScreenBufferOptions = {},
  ) {}

  /** True while the session is rendered by a Ghostty grid. */
  hasGrid(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.screen != null;
  }

  append(sessionId: string, rawData: string): number {
    const state = this.#state(sessionId);
    if (!state.screen && !state.textOnly) this.#attach(sessionId, state);
    if (state.screen) {
      const memoryBefore = this.runtime.memory.buffer.byteLength;
      try {
        const clamped = clampClusterExtenders(rawData, state.extenderRun, this.options.maxClusterExtenders);
        state.extenderRun = clamped.trailing;
        state.screen.write(clamped.text);
        state.rendered = null;
      } catch (error) {
        this.#trap(error);
      }
      // Formatting is deferred to contentSeq(); any write may have moved the
      // screen, so report a value the last scan cannot have seen. A grid
      // evicted by this very write hands the chunk to the text stream below.
      if (state.screen && !this.#grewPastBudget(state, memoryBefore)) return state.seq + 1;
    }
    const before = this.#fallback.contentSeq(sessionId);
    if (this.#fallback.append(sessionId, rawData) !== before) state.seq += 1;
    return state.seq;
  }

  text(sessionId: string): string {
    const state = this.#sessions.get(sessionId);
    if (!state) return '';
    const rendered = state.screen ? this.#render(state) : null;
    return rendered ?? this.#fallback.text(sessionId);
  }

  tail(sessionId: string, maxChars: number): string {
    const state = this.#sessions.get(sessionId);
    if (!state) return '';
    const rendered = state.screen ? this.#render(state) : null;
    return rendered === null
      ? this.#fallback.tail(sessionId, maxChars)
      : lineAlignedTail(rendered, maxChars);
  }

  contentSeq(sessionId: string): number {
    const state = this.#sessions.get(sessionId);
    if (!state) return 0;
    if (state.screen) {
      const rendered = this.#render(state);
      if (rendered !== null && rendered !== state.seqText) {
        state.seq += 1;
        state.seqText = rendered;
      }
    }
    return state.seq;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const state = this.#state(sessionId);
    const nextCols = clampDimension(cols, MAX_COLS, state.cols);
    const nextRows = clampDimension(rows, MAX_ROWS, state.rows);
    if (nextCols === state.cols && nextRows === state.rows) return;
    state.cols = nextCols;
    state.rows = nextRows;
    if (!state.screen) return;
    if (nextCols * nextRows > this.#maxGridCells()) {
      // Not permanent: a later resize that fits brings a fresh grid back.
      this.#evict(state, 'grid-too-large', `cells=${nextCols * nextRows}`, false);
      return;
    }
    const memoryBefore = this.runtime.memory.buffer.byteLength;
    try {
      state.screen.resize(nextCols, nextRows);
      state.rendered = null;
    } catch (error) {
      this.#trap(error);
      return;
    }
    this.#grewPastBudget(state, memoryBefore);
  }

  drop(sessionId: string): void {
    const screen = this.#sessions.get(sessionId)?.screen;
    if (screen && !this.runtime.broken) {
      try {
        screen.dispose();
      } catch (error) {
        this.#trap(error);
      }
    }
    this.#sessions.delete(sessionId);
    this.#fallback.drop(sessionId);
  }

  #state(sessionId: string): GridState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        screen: null,
        textOnly: false,
        grown: 0,
        extenderRun: 0,
        seq: 0,
        rendered: null,
        seqText: '',
      };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #attach(sessionId: string, state: GridState): void {
    if (this.options.eligible && !this.options.eligible(sessionId)) return;
    if (this.runtime.broken) {
      state.textOnly = true;
      this.#report('runtime-trap', 'runtime-broken');
      return;
    }
    const maxTerminals = this.options.maxTerminals ?? GHOSTTY_MAX_TERMINALS;
    if (this.runtime.liveTerminals >= maxTerminals) {
      state.textOnly = true;
      this.#report('session-cap', `live=${this.runtime.liveTerminals}`);
      return;
    }
    const memoryBytes = this.runtime.memory.buffer.byteLength;
    if (memoryBytes >= this.#maxMemoryBytes()) {
      state.textOnly = true;
      this.#report('memory-budget', `bytes=${memoryBytes}`);
      return;
    }
    if (state.cols * state.rows > this.#maxGridCells()) {
      // Retried on later chunks: a resize that fits brings the grid back.
      this.#report('grid-too-large', `cells=${state.cols * state.rows}`);
      return;
    }
    try {
      state.screen = GhosttyScreen.create(this.runtime, state.cols, state.rows);
    } catch (error) {
      state.textOnly = true;
      this.#trap(error);
      return;
    }
    // A session that became eligible late starts a fresh grid; the TUI's next
    // repaint fills it. The text it streamed so far is no longer the screen.
    this.#fallback.drop(sessionId);
    state.grown = 0;
    state.extenderRun = 0;
    state.seq += 1;
    state.seqText = '';
    state.rendered = null;
  }

  #maxMemoryBytes(): number {
    return this.options.maxMemoryBytes ?? GHOSTTY_MAX_MEMORY_BYTES;
  }

  #maxGridCells(): number {
    return this.options.maxGridCells ?? GHOSTTY_MAX_GRID_CELLS;
  }

  /**
   * The ceiling checked before a grid starts is not enough: resizes and
   * output (styles, hyperlinks, grapheme clusters) grow a live grid too.
   * After every write/resize, growth of the real linear memory is charged to
   * that session; past its share or past the global ceiling, it goes to text.
   */
  #grewPastBudget(state: GridState, memoryBefore: number): boolean {
    const memoryAfter = this.runtime.memory.buffer.byteLength;
    if (memoryAfter <= memoryBefore) return false;
    state.grown += memoryAfter - memoryBefore;
    if (memoryAfter >= this.#maxMemoryBytes()) {
      this.#evict(state, 'memory-budget', `bytes=${memoryAfter}`, true);
      return true;
    }
    if (state.grown > (this.options.maxSessionGrowthBytes ?? GHOSTTY_MAX_SESSION_GROWTH_BYTES)) {
      this.#evict(state, 'memory-budget', `session-growth=${state.grown}`, true);
      return true;
    }
    return false;
  }

  /** Session leaves the grid; its pages return to the allocator for reuse. */
  #evict(state: GridState, reason: GhosttyFallbackReason, detail: string, permanent: boolean): void {
    const screen = state.screen;
    state.screen = null;
    state.rendered = null;
    state.seq += 1;
    if (permanent) state.textOnly = true;
    try {
      screen?.dispose();
    } catch (error) {
      this.#trap(error);
    }
    this.#report(reason, detail);
  }

  #render(state: GridState): string | null {
    if (state.rendered !== null) return state.rendered;
    try {
      state.rendered = state.screen!.plainText();
      return state.rendered;
    } catch (error) {
      this.#trap(error);
      return null;
    }
  }

  /** A failed wasm call poisons the instance: every session leaves the grid. */
  #trap(error: unknown): void {
    this.runtime.broken = true;
    for (const state of this.#sessions.values()) {
      if (!state.screen) continue;
      state.screen = null;
      state.textOnly = true;
      state.rendered = null;
      state.seq += 1;
    }
    this.#report('runtime-trap', failureDetail(error));
  }

  #report(reason: GhosttyFallbackReason, detail: string): void {
    if (this.#reported.has(reason)) return;
    this.#reported.add(reason);
    try {
      this.options.onFallback?.(reason, detail);
    } catch {
      // Instrumentação nunca derruba a detecção.
    }
  }
}

/**
 * Detector screen with the grid on by default and fail-soft: if the wasm
 * cannot load (missing artifact, foreign revision, compile error) every
 * session uses the stripped-text stream and `onFallback('unavailable')` fires.
 */
export function createDetectorScreenSource(
  options: GhosttyScreenBufferOptions & { wasmPath?: string } = {},
): ScreenSource {
  let runtime: GhosttyRuntime;
  try {
    runtime = loadGhosttyRuntime(options.wasmPath);
  } catch (error) {
    try {
      options.onFallback?.('unavailable', failureDetail(error));
    } catch {
      // Instrumentação nunca derruba a detecção.
    }
    return new SessionScreenBuffer();
  }
  return new GhosttyScreenBuffer(runtime, options);
}
