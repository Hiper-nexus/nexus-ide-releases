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

// F-1406: [0-?]* (ECMA-48, 0x30–0x3F) cobre parâmetros privados — o Codex
// 0.162 emite ESC[>4;0m/ESC[>7u no boot; sem isso um CSI privado cortado no
// meio do chunk vazava ">4;0" como texto visível.
const CSI_PREFIX = /^\x1b\[[0-?]*[ -/]*[@-~]/;
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
  | 'runtime-trap'
  /** Not a fallback: the instance was rebuilt to return memory; sessions kept their grids. */
  | 'runtime-recycled';

const MiB = 1024 * 1024;
/** Live grids per Worker; past it a session waits on the text stream for one to leave. */
export const GHOSTTY_MAX_TERMINALS = 32;
/**
 * Memory the live grids may reserve, and the linear-memory high-water mark.
 * Admission counts what the live grids reserve, never the linear memory size:
 * WebAssembly.Memory never shrinks, so its size remembers past peaks. When
 * the linear memory reaches this mark without live grids to justify it, the
 * instance is rebuilt (live grids replayed into a fresh one).
 */
export const GHOSTTY_MAX_MEMORY_BYTES = 256 * MiB;
/**
 * Measured on the vendored wasm: Ghostty preheats a page pool per terminal
 * (5.06–5.5 MiB) that holds any grid up to 320 000 cells with ≤0.5 MiB more
 * when filled (640×180, 334×300, 250×401, 1000×320); 350 000–500 000 cells
 * (700×500 … 1000×500) need a second allocation, 13.5 MiB in total.
 */
export const GHOSTTY_GRID_POOL_BYTES = 6 * MiB;
export const GHOSTTY_GRID_POOL_CELLS = 320_000;
export const GHOSTTY_LARGE_GRID_BYTES = 14 * MiB;
/** An instance with no terminal: 1.25 MiB measured. */
export const GHOSTTY_RUNTIME_BASE_BYTES = 2 * MiB;
/**
 * Linear memory one session's writes may add beyond its grid's reservation.
 * Normal TUI output measured ≤0.1 MiB; a combining-mark flood grew 2 GiB.
 */
export const GHOSTTY_MAX_SESSION_GROWTH_BYTES = 16 * MiB;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 1_000;
const MAX_ROWS = 500;

/** Reservation for one grid of this size (any size the PTY protocol accepts). */
export function ghosttyGridBytes(cols: number, rows: number): number {
  const cells = cols * rows;
  if (cells <= GHOSTTY_GRID_POOL_CELLS) return GHOSTTY_GRID_POOL_BYTES;
  return Math.max(GHOSTTY_LARGE_GRID_BYTES, Math.ceil((GHOSTTY_LARGE_GRID_BYTES * cells) / (MAX_COLS * MAX_ROWS)));
}

export interface GhosttyScreenBufferOptions {
  /** Sessions that get a grid; the rest stay on the stripped-text stream. */
  eligible?: (sessionId: string) => boolean;
  /** Once per reason per buffer: the session(s) fell back to the text stream. */
  onFallback?: (reason: GhosttyFallbackReason, detail: string) => void;
  maxTerminals?: number;
  maxMemoryBytes?: number;
  maxSessionGrowthBytes?: number;
  /** Infinity disables the cluster clamp (tests of the generic memory budget). */
  maxClusterExtenders?: number;
}

interface GridState {
  cols: number;
  rows: number;
  screen: GhosttyScreen | null;
  /** Its own output ran away (or the instance trapped): text until dropped. */
  textOnly: boolean;
  /**
   * Refused or evicted for lack of room: retried once memory is released
   * (another grid left, the instance was rebuilt) or this session resized.
   */
  waitFor: number | null;
  /** Linear memory this session's writes grew beyond its grid's reservation. */
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
/**
 * Code points libghostty-vt stores in the previous cell with zero width,
 * swept one by one over U+00A0–U+323AF and U+E0000–U+E0FFF on the vendored
 * wasm: nonspacing/enclosing marks, format characters (ZWJ, ZWNJ, ZWSP, bidi
 * marks and embeddings, word joiner, BOM, ALM, Mongolian VS, tags, musical
 * format), default-ignorables (variation selectors, Hangul fillers,
 * unassigned E0xxx), vowel/final conjoining jamo, U+2028/2029 and the Kirat
 * Rai signs newer than this regex engine's Unicode. Each one grew a 16K run
 * by 17 MiB. Leading jamo (width 2) start their own cell, so NFD Hangul never
 * builds a run past one syllable; prepended concatenation marks and the soft
 * hyphen are Cf but printed in their own cell, so they are left alone.
 */
const CLUSTER_EXTENDER_CLASS =
  '(?![\\u00AD\\u0600-\\u0605\\u06DD\\u070F\\u0890\\u0891\\u08E2\\u{110BD}\\u{110CD}])' +
  '[\\p{Mn}\\p{Me}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u1160-\\u11FF\\uD7B0-\\uD7FF\\u2028\\u2029\\u{16D63}\\u{16D67}-\\u{16D6A}]';
const CLUSTER_EXTENDERS = new RegExp(`(?:\\u200D\\p{Extended_Pictographic}?|${CLUSTER_EXTENDER_CLASS})+`, 'gu');
const CLUSTER_EXTENDER_HINT = new RegExp(CLUSTER_EXTENDER_CLASS, 'u');

/** True when Ghostty would store this code point in the previous cell. */
export function isClusterExtender(codePoint: number): boolean {
  return CLUSTER_EXTENDER_HINT.test(String.fromCodePoint(codePoint));
}

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
  #runtime: GhosttyRuntime;
  /** Bumped whenever grid memory is released: a grid left or the instance was rebuilt. */
  #releases = 0;

  constructor(
    runtime: GhosttyRuntime,
    private readonly options: GhosttyScreenBufferOptions = {},
  ) {
    this.#runtime = runtime;
  }

  /** The instance the grids live in; replaced when it is recycled. */
  get runtime(): GhosttyRuntime {
    return this.#runtime;
  }

  /** True while the session is rendered by a Ghostty grid. */
  hasGrid(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.screen != null;
  }

  append(sessionId: string, rawData: string): number {
    const state = this.#state(sessionId);
    if (!state.screen && !state.textOnly) this.#attach(sessionId, state);
    if (state.screen) {
      const memoryBefore = this.#memoryBytes();
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
      if (state.screen && !this.#settle(state, memoryBefore, 0)) return state.seq + 1;
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
    const previousBytes = ghosttyGridBytes(state.cols, state.rows);
    state.cols = nextCols;
    state.rows = nextRows;
    // Its reservation changed: a session waiting for room may fit now.
    state.waitFor = null;
    if (!state.screen) return;
    const nextBytes = ghosttyGridBytes(nextCols, nextRows);
    // #reserved() already counts this grid at its new size.
    const reserved = this.#reserved();
    if (nextBytes > previousBytes && reserved > this.#maxMemoryBytes()) {
      this.#evict(state, 'memory-budget', `reserved=${reserved}`, false);
      return;
    }
    const memoryBefore = this.#memoryBytes();
    try {
      state.screen.resize(nextCols, nextRows);
      state.rendered = null;
    } catch (error) {
      this.#trap(error);
      return;
    }
    this.#settle(state, memoryBefore, Math.max(0, nextBytes - previousBytes));
  }

  drop(sessionId: string): void {
    const screen = this.#sessions.get(sessionId)?.screen;
    if (screen && !this.#runtime.broken) {
      try {
        screen.dispose();
      } catch (error) {
        this.#trap(error);
      }
    }
    this.#sessions.delete(sessionId);
    this.#fallback.drop(sessionId);
    if (screen) {
      this.#releases += 1;
      this.#reclaim();
    }
  }

  #state(sessionId: string): GridState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        screen: null,
        textOnly: false,
        waitFor: null,
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
    if (this.#runtime.broken) {
      state.textOnly = true;
      this.#report('runtime-trap', 'runtime-broken');
      return;
    }
    // Refused earlier and nothing was released since: no per-chunk retries.
    if (state.waitFor === this.#releases) return;
    const maxTerminals = this.options.maxTerminals ?? GHOSTTY_MAX_TERMINALS;
    if (this.#runtime.liveTerminals >= maxTerminals) {
      this.#refuse(state, 'session-cap', `live=${this.#runtime.liveTerminals}`);
      return;
    }
    const gridBytes = ghosttyGridBytes(state.cols, state.rows);
    const reserved = this.#reserved() + gridBytes;
    if (reserved > this.#maxMemoryBytes()) {
      this.#refuse(state, 'memory-budget', `reserved=${reserved}`);
      return;
    }
    // The live grids leave room but past peaks filled the linear memory.
    if (this.#memoryBytes() + gridBytes > this.#maxMemoryBytes() && !this.#recycle()) {
      this.#refuse(state, 'memory-budget', `bytes=${this.#memoryBytes()}`);
      return;
    }
    const memoryBefore = this.#memoryBytes();
    try {
      state.screen = GhosttyScreen.create(this.#runtime, state.cols, state.rows);
    } catch (error) {
      state.textOnly = true;
      this.#trap(error);
      return;
    }
    // A session that became eligible late starts a fresh grid; the TUI's next
    // repaint fills it. The text it streamed so far is no longer the screen.
    this.#fallback.drop(sessionId);
    state.waitFor = null;
    state.grown = 0;
    state.extenderRun = 0;
    state.seq += 1;
    state.seqText = '';
    state.rendered = null;
    this.#settle(state, memoryBefore, gridBytes);
  }

  #maxMemoryBytes(): number {
    return this.options.maxMemoryBytes ?? GHOSTTY_MAX_MEMORY_BYTES;
  }

  #memoryBytes(): number {
    return this.#runtime.memory.buffer.byteLength;
  }

  /** What the live grids hold: instance base + each grid's size + its measured growth. */
  #reserved(): number {
    let total = GHOSTTY_RUNTIME_BASE_BYTES;
    for (const state of this.#sessions.values()) {
      if (state.screen) total += ghosttyGridBytes(state.cols, state.rows) + state.grown;
    }
    return total;
  }

  /**
   * After a write/resize/attach, growth of the real linear memory beyond what
   * the grid reserved (`allowance`) is charged to that session. Past its own
   * share it goes to text for good (its output ran away). Past the high-water
   * mark the instance is rebuilt when the live grids do not justify it;
   * otherwise this session yields its grid until memory is released.
   * Returns true when the session left the grid.
   */
  #settle(state: GridState, memoryBefore: number, allowance: number): boolean {
    const memoryAfter = this.#memoryBytes();
    if (memoryAfter <= memoryBefore) return false;
    state.grown += Math.max(0, memoryAfter - memoryBefore - allowance);
    if (state.grown > (this.options.maxSessionGrowthBytes ?? GHOSTTY_MAX_SESSION_GROWTH_BYTES)) {
      this.#evict(state, 'memory-budget', `session-growth=${state.grown}`, true);
      return true;
    }
    if (memoryAfter < this.#maxMemoryBytes()) return false;
    if (this.#reserved() <= this.#maxMemoryBytes() && this.#recycle()) return !state.screen;
    this.#evict(state, 'memory-budget', `bytes=${memoryAfter}`, false);
    return true;
  }

  #refuse(state: GridState, reason: GhosttyFallbackReason, detail: string): void {
    state.waitFor = this.#releases;
    this.#report(reason, detail);
  }

  /** Session leaves the grid; its pages return to the allocator for reuse. */
  #evict(state: GridState, reason: GhosttyFallbackReason, detail: string, permanent: boolean): void {
    const screen = state.screen;
    state.screen = null;
    state.rendered = null;
    state.grown = 0;
    state.seq += 1;
    if (permanent) state.textOnly = true;
    // Waits for a release other than its own (the one counted just below).
    else state.waitFor = this.#releases + 1;
    try {
      screen?.dispose();
    } catch (error) {
      this.#trap(error);
    }
    this.#releases += 1;
    this.#report(reason, detail);
    this.#reclaim();
  }

  /**
   * After a grid leaves: linear memory the live grids do not justify — at the
   * high-water mark, a quarter of the budget above what they reserve, or a
   * sixteenth once no grid is left (nothing to replay, so the rebuild is
   * cheap; one closed pane's ~5 MiB pool is not worth a rebuild) — is rebuilt
   * away instead of being held by the Worker until it restarts.
   */
  #reclaim(): void {
    if (this.#runtime.broken) return;
    const max = this.#maxMemoryBytes();
    const memory = this.#memoryBytes();
    const reserved = this.#reserved();
    const idle = memory - reserved;
    const noGrids = reserved === GHOSTTY_RUNTIME_BASE_BYTES;
    if (reserved <= max && (memory >= max || idle >= max / 4 || (noGrids && idle >= max / 16))) this.#recycle();
  }

  /**
   * Replace the instance with a fresh one of the same module and replay every
   * live grid into it (VT snapshot: content, styles, cursor, modes), so the
   * detector keeps the same screens while the old linear memory is freed.
   * Each grid's growth is re-measured in the fresh heap. ~26 ms for 32 grids
   * of 120×40 measured.
   */
  #recycle(): boolean {
    const previousBytes = this.#memoryBytes();
    let next: GhosttyRuntime;
    try {
      next = this.#runtime.respawn();
    } catch (error) {
      this.#report('memory-budget', `recycle-failed:${failureDetail(error)}`.slice(0, 64));
      return false;
    }
    const live = [...this.#sessions.values()].filter((state) => state.screen);
    const snapshots = live.map((state) => {
      try {
        return state.screen!.vtSnapshot();
      } catch {
        // The old instance is being discarded; an empty grid repaints on the next frame.
        return '';
      }
    });
    this.#runtime = next;
    this.#releases += 1;
    for (const [index, state] of live.entries()) {
      // The old terminal goes away with its instance; never call into it again.
      state.screen = null;
      state.rendered = null;
      const memoryBefore = this.#memoryBytes();
      try {
        state.screen = GhosttyScreen.create(next, state.cols, state.rows);
        state.screen.write(snapshots[index]);
      } catch (error) {
        this.#trap(error);
        return true;
      }
      state.grown = Math.max(0, this.#memoryBytes() - memoryBefore - ghosttyGridBytes(state.cols, state.rows));
    }
    this.#report('runtime-recycled', `grids=${live.length} bytes=${previousBytes}`);
    return true;
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
    this.#runtime.broken = true;
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
