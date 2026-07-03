/**
 * Pure pipe-forwarding logic — no electron / node-pty imports, so it can be
 * unit-tested directly under vitest. pane-pipe.ts wires these helpers to the
 * live PTY taps.
 */

/** Marker prefixed to onIdle deliveries; lines carrying it are never re-forwarded. */
export const PIPE_MARKER = '[nexus pipe]';

export interface LineExtraction {
  /** Complete lines (without the trailing newline / carriage return). */
  lines: string[];
  /** Trailing partial line, to be carried into the next chunk. */
  rest: string;
}

/** Longest partial line kept while waiting for a newline. */
export const MAX_PENDING_LINE = 16_384;

/**
 * Append a chunk to the pending partial line and extract every complete
 * line. Splits on `\n` only — escape sequences never contain `\n`, so a raw
 * split can't cut one in half even when it spans chunk boundaries; trailing
 * `\r` (from `\r\n` endings) is dropped. A pathological session that never
 * emits a newline has its pending tail capped at MAX_PENDING_LINE.
 */
export function extractCompleteLines(
  pending: string,
  chunk: string,
): LineExtraction {
  const combined = pending + chunk;
  const segments = combined.split('\n');
  let rest = segments.pop() ?? '';
  if (rest.length > MAX_PENDING_LINE) {
    rest = rest.slice(rest.length - MAX_PENDING_LINE);
  }
  const lines = segments.map((line) =>
    line.endsWith('\r') ? line.slice(0, -1) : line,
  );
  return { lines, rest };
}

/**
 * Anti-loop guard: a pipe may never feed a pane back into itself. (Reverse
 * pipes A→B + B→A are allowed — echo suppression below breaks that cycle.)
 */
export function canForward(sourcePaneId: string, targetPaneId: string): boolean {
  return (
    sourcePaneId.length > 0 &&
    targetPaneId.length > 0 &&
    sourcePaneId !== targetPaneId
  );
}

interface InjectedEntry {
  count: number;
  expiresAt: number;
}

/**
 * Echo suppression. Everything we inject into a session comes straight back
 * as that session's PTY output (terminal echo). If that session is itself the
 * SOURCE of another pipe, the echo would be forwarded again — with a reverse
 * pipe that is an infinite loop. Injections are recorded here per session and
 * matching output lines are swallowed once (entries expire after `ttlMs`).
 */
export class InjectionGuard {
  private bySession = new Map<string, Map<string, InjectedEntry>>();

  constructor(
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  private normalize(line: string): string {
    return line.trim();
  }

  markInjected(sessionId: string, line: string): void {
    const key = this.normalize(line);
    if (key.length === 0) return;
    let entries = this.bySession.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.bySession.set(sessionId, entries);
    }
    const existing = entries.get(key);
    entries.set(key, {
      count: (existing?.count ?? 0) + 1,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /**
   * Whether an output line from `sessionId` is (or contains) the echo of a
   * recent injection into it. A hit consumes one recorded injection.
   * Containment is checked both ways because TUIs redraw injected input with
   * prompt decoration ("> …") or wrap it.
   */
  isEcho(sessionId: string, line: string): boolean {
    const entries = this.bySession.get(sessionId);
    if (!entries) return false;
    const candidate = this.normalize(line);
    if (candidate.length === 0) return false;
    const timestamp = this.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt < timestamp) {
        entries.delete(key);
        continue;
      }
      if (candidate === key || candidate.includes(key) || key.includes(candidate)) {
        if (entry.count <= 1) entries.delete(key);
        else entries.set(key, { ...entry, count: entry.count - 1 });
        if (entries.size === 0) this.bySession.delete(sessionId);
        return true;
      }
    }
    return false;
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

// Injected text reaches a terminal as if typed: raw CR/LF or control bytes
// would forge extra input lines / auto-submit in the target (terminal
// injection) — same defense as idle-delivery's sanitizer.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** Collapse newlines to spaces and strip control chars before injection. */
export function sanitizeForInjection(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(CONTROL_CHARS, '').trim();
}
