// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: headless subset of
// apps/web/src/terminal/ghostty/core.ts (create/write/reset/resize/dispose)
// with no renderer, keyboard, mouse, selection, theme or PTY replies; adds a
// plain-text snapshot through Ghostty's formatter (formatter.h).
//
// One GhosttyScreen is the rendered cell grid of one PTY session: wraps are
// rejoined (unwrap), cursor-addressed redraws land in place, the alternate
// screen replaces the primary one while active — what Herdr's manifests read.

import type { GhosttyRuntime } from './ghostty-runtime';

const GHOSTTY_SUCCESS = 0;
const GHOSTTY_OUT_OF_SPACE = -3;
/** GHOSTTY_FORMATTER_FORMAT_PLAIN (types.h). */
const GHOSTTY_FORMATTER_FORMAT_PLAIN = 0;
/** GHOSTTY_FORMATTER_FORMAT_VT (types.h). */
const GHOSTTY_FORMATTER_FORMAT_VT = 1;
/** GHOSTTY_TERMINAL_DATA_CURSOR_X / _Y (terminal.h), uint16_t out. */
const GHOSTTY_TERMINAL_DATA_CURSOR_X = 3;
const GHOSTTY_TERMINAL_DATA_CURSOR_Y = 4;
/** GHOSTTY_MODE_ORIGIN = ghostty_mode_new(6, false) (modes.h): DEC private 6. */
const GHOSTTY_MODE_ORIGIN = 6;
/**
 * `max_scrollback` is a byte budget rounded to Ghostty pages, not a row
 * count: 200 kept 400+ rows in measurement. 0 keeps exactly the visible
 * grid, which is the screen Herdr evaluates; history the program scrolled
 * away is no longer part of the detector's input.
 */
export const GHOSTTY_SCREEN_SCROLLBACK = 0;
/** Clamp like the upstream core: Ghostty sizes are u16. */
const MAX_DIMENSION = 65_535;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function dimension(value: number): number {
  return Math.max(1, Math.min(MAX_DIMENSION, Math.floor(value) || 1));
}

export class GhosttyScreen {
  private readonly runtime: GhosttyRuntime;
  private terminalSlot = 0;
  private terminal = 0;
  private formatterSlot = 0;
  private formatter = 0;
  private written = 0;
  private disposed = false;

  private constructor(runtime: GhosttyRuntime) {
    this.runtime = runtime;
  }

  static create(runtime: GhosttyRuntime, cols: number, rows: number): GhosttyScreen {
    const screen = new GhosttyScreen(runtime);
    try {
      screen.initialize(cols, rows);
      return screen;
    } catch (error) {
      screen.dispose();
      throw error;
    }
  }

  private initialize(cols: number, rows: number): void {
    const optionsSize = this.runtime.layout('GhosttyTerminalOptions').size;
    const options = this.runtime.alloc(optionsSize);
    this.runtime.setField(options, 'GhosttyTerminalOptions', 'cols', dimension(cols));
    this.runtime.setField(options, 'GhosttyTerminalOptions', 'rows', dimension(rows));
    this.runtime.setField(options, 'GhosttyTerminalOptions', 'max_scrollback', GHOSTTY_SCREEN_SCROLLBACK);
    this.terminalSlot = this.runtime.allocOpaque();
    const terminalResult = this.runtime.call('ghostty_terminal_new', 0, this.terminalSlot, options);
    this.runtime.free(options, optionsSize);
    this.assertSuccess('ghostty_terminal_new', terminalResult);
    this.terminal = this.runtime.readPointer(this.terminalSlot);
    this.runtime.liveTerminals += 1;

    this.formatterSlot = this.runtime.allocOpaque();
    this.formatter = this.newFormatter(this.formatterSlot, GHOSTTY_FORMATTER_FORMAT_PLAIN);
    this.written = this.runtime.call('ghostty_wasm_alloc_usize');
    if (this.written === 0) throw new Error('libghostty-vt failed to allocate a usize');
  }

  /**
   * Formatter over this terminal's active screen. VT output carries the state
   * a replay needs to land the next redraw in the same place: cursor, pen,
   * hyperlink, charsets, modes and margins. Not tabstops: the formatter emits
   * them after its cursor CUP with CHA moves, which strands the cursor.
   */
  private newFormatter(slot: number, emit: number): number {
    // GhosttyFormatterTerminalOptions is passed by value; the wasm32 C ABI
    // lowers a by-value struct to a pointer to a caller-owned copy.
    const formatLayout = this.runtime.layout('GhosttyFormatterTerminalOptions');
    const extraLayout = this.runtime.layout('GhosttyFormatterTerminalExtra');
    const screenExtraLayout = this.runtime.layout('GhosttyFormatterScreenExtra');
    const format = this.runtime.alloc(formatLayout.size);
    const extra = format + formatLayout.fields.extra!.offset;
    const screenExtra = extra + extraLayout.fields.screen!.offset;
    this.runtime.setField(format, 'GhosttyFormatterTerminalOptions', 'size', formatLayout.size);
    this.runtime.setField(format, 'GhosttyFormatterTerminalOptions', 'emit', emit);
    this.runtime.setField(format, 'GhosttyFormatterTerminalOptions', 'unwrap', 1);
    this.runtime.setField(format, 'GhosttyFormatterTerminalOptions', 'trim', 1);
    this.runtime.setField(extra, 'GhosttyFormatterTerminalExtra', 'size', extraLayout.size);
    this.runtime.setField(screenExtra, 'GhosttyFormatterScreenExtra', 'size', screenExtraLayout.size);
    if (emit === GHOSTTY_FORMATTER_FORMAT_VT) {
      for (const field of ['modes', 'scrolling_region', 'keyboard']) {
        this.runtime.setField(extra, 'GhosttyFormatterTerminalExtra', field, 1);
      }
      for (const field of ['cursor', 'style', 'hyperlink', 'protection', 'kitty_keyboard', 'charsets']) {
        this.runtime.setField(screenExtra, 'GhosttyFormatterScreenExtra', field, 1);
      }
    }
    // selection stays NULL: the whole active screen is formatted.
    const result = this.runtime.call('ghostty_formatter_terminal_new', 0, slot, this.terminal, format);
    this.runtime.free(format, formatLayout.size);
    this.assertSuccess('ghostty_formatter_terminal_new', result);
    return this.runtime.readPointer(slot);
  }

  write(data: string | Uint8Array): void {
    this.ensureActive();
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (bytes.length === 0) return;
    const pointer = this.runtime.alloc(bytes.length);
    this.runtime.bytes(pointer, bytes.length).set(bytes);
    this.runtime.call('ghostty_terminal_vt_write', this.terminal, pointer, bytes.length);
    this.runtime.free(pointer, bytes.length);
  }

  /** RIS: the grid empties and modes return to defaults. */
  reset(): void {
    this.ensureActive();
    this.runtime.call('ghostty_terminal_reset', this.terminal);
  }

  resize(cols: number, rows: number): void {
    this.ensureActive();
    // Headless: cell pixel sizes only feed pixel-size reports, never layout.
    this.assertSuccess(
      'ghostty_terminal_resize',
      this.runtime.call('ghostty_terminal_resize', this.terminal, dimension(cols), dimension(rows), 1, 1),
    );
  }

  /** Active screen as plain text: wraps rejoined, trailing blanks trimmed. */
  plainText(): string {
    this.ensureActive();
    return this.format(this.formatter);
  }

  /**
   * Active screen as VT sequences that rebuild it in a fresh terminal of the
   * same size: content with styles, then cursor, pen and modes. Moving a live
   * session to a new wasm instance replays this instead of an empty grid.
   * The primary screen behind an active alternate screen is not carried.
   */
  vtSnapshot(): string {
    this.ensureActive();
    const slot = this.runtime.allocOpaque();
    let body: string;
    try {
      const formatter = this.newFormatter(slot, GHOSTTY_FORMATTER_FORMAT_VT);
      try {
        body = this.format(formatter);
      } finally {
        this.runtime.call('ghostty_formatter_free', formatter);
      }
    } finally {
      this.runtime.freeOpaque(slot);
    }
    // DECSTBM, emitted after the formatter's CUP, homes the cursor: land it
    // last. Under origin mode a CUP is margin-relative, so the formatter's
    // own placement stands.
    if (this.modeSet(GHOSTTY_MODE_ORIGIN)) return body;
    const { x, y } = this.cursor();
    return `${body}\x1b[${y + 1};${x + 1}H`;
  }

  /** Cursor cell in the active area, 0-based. */
  cursor(): { x: number; y: number } {
    this.ensureActive();
    const out = this.runtime.alloc(2);
    try {
      const read = (data: number): number => {
        this.assertSuccess('ghostty_terminal_get', this.runtime.call('ghostty_terminal_get', this.terminal, data, out));
        return this.runtime.view(out, 2).getUint16(0, true);
      };
      return { x: read(GHOSTTY_TERMINAL_DATA_CURSOR_X), y: read(GHOSTTY_TERMINAL_DATA_CURSOR_Y) };
    } finally {
      this.runtime.free(out, 2);
    }
  }

  private modeSet(mode: number): boolean {
    const out = this.runtime.alloc(1);
    try {
      this.assertSuccess('ghostty_terminal_mode_get', this.runtime.call('ghostty_terminal_mode_get', this.terminal, mode, out));
      return this.runtime.bytes(out, 1)[0] !== 0;
    } finally {
      this.runtime.free(out, 1);
    }
  }

  private format(formatter: number): string {
    const sizeResult = this.runtime.call('ghostty_formatter_format_buf', formatter, 0, 0, this.written);
    const outputSize = this.runtime.view(this.written, 4).getUint32(0, true);
    if (outputSize === 0) return '';
    if (sizeResult !== GHOSTTY_OUT_OF_SPACE && sizeResult !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty_formatter_format_buf failed with result ${sizeResult}`);
    }
    const output = this.runtime.alloc(outputSize);
    try {
      this.assertSuccess(
        'ghostty_formatter_format_buf',
        this.runtime.call('ghostty_formatter_format_buf', formatter, output, outputSize, this.written),
      );
      const length = this.runtime.view(this.written, 4).getUint32(0, true);
      return decoder.decode(this.runtime.bytes(output, Math.min(length, outputSize)));
    } finally {
      this.runtime.free(output, outputSize);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The formatter borrows the terminal, so it goes first.
    if (this.formatter) this.runtime.call('ghostty_formatter_free', this.formatter);
    if (this.terminal) {
      this.runtime.call('ghostty_terminal_free', this.terminal);
      this.runtime.liveTerminals -= 1;
    }
    if (this.written) this.runtime.call('ghostty_wasm_free_usize', this.written);
    this.runtime.freeOpaque(this.formatterSlot);
    this.runtime.freeOpaque(this.terminalSlot);
  }

  private assertSuccess(operation: string, result: number): void {
    if (result !== GHOSTTY_SUCCESS) throw new Error(`${operation} failed with result ${result}`);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('libghostty-vt terminal has been disposed');
  }
}
