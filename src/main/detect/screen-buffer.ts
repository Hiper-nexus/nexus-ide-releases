// Per-session stripped-text screen snapshot for the detection engine.
//
// There is no terminal emulator in the main process, and adding one is out of
// scope, so the "screen" here is a rolling tail of ANSI-stripped PTY output
// (stripAnsi from src/main/orch/pane-session-output.ts, reused read-only).
// Herdr instead reads a rendered cell grid: soft-wrapped physical rows and
// cursor-addressed redraws are resolved before slicing. Here, cursor movement
// is flattened to a text append stream, so a TUI repaint appends a fresh copy
// of the redrawn region instead of replacing the old one — the bottom of the
// tail still holds the latest frame, which is what every region heuristic
// keys on. See detector.ts for the consequences.

import { stripAnsi } from '../orch/pane-session-output';

/** Retained stripped characters per session (~256 KB of recent output). */
const MAX_BUFFER_CHARS = 262_144;
/** Held escape fragments longer than this come from a broken writer; strip. */
const MAX_HELD_ESCAPE = 4096;

const CSI_PREFIX = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
const OSC_TERMINATOR = /\x07|\x1b\\/;

interface ScreenBufferState {
  text: string;
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

export class SessionScreenBuffer {
  private readonly sessions = new Map<string, ScreenBufferState>();

  /** Feed one raw PTY chunk; bumps contentSeq when visible text results. */
  append(sessionId: string, rawData: string): number {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { text: '', pendingRaw: '', contentSeq: 0 };
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
    if (stripped.length === 0) return state.contentSeq;
    state.text =
      state.text.length + stripped.length > MAX_BUFFER_CHARS
        ? (state.text + stripped).slice(-MAX_BUFFER_CHARS)
        : state.text + stripped;
    state.contentSeq += 1;
    return state.contentSeq;
  }

  /** Current stripped tail for the session (never null). */
  text(sessionId: string): string {
    return this.sessions.get(sessionId)?.text ?? '';
  }

  contentSeq(sessionId: string): number {
    return this.sessions.get(sessionId)?.contentSeq ?? 0;
  }

  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
