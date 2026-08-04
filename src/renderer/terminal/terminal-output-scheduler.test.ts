// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: tests target adapted
// scheduler API (stable write sink, no xterm _core / scroll-intent mocks).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BACKGROUND_QUEUE_CHARS,
  MAX_UNPARSED_WRITE_CHARS,
  discardTerminalOutput,
  flushTerminalOutput,
  getPendingParseChars,
  getQueuedChars,
  getTerminalOutputRuntimeSnapshot,
  pauseTerminalOutput,
  getTerminalOutputSchedulerDebugSnapshot,
  removeTransientCursorShowSequences,
  resumeTerminalOutput,
  resetTerminalOutputSchedulerForTests,
  safeOutputSplitIndex,
  setTerminalOutputSchedulerDebug,
  writeTerminalOutput,
  type TerminalOutputSink,
} from './terminal-output-scheduler';

function createTerminal(): TerminalOutputSink & {
  write: ReturnType<typeof vi.fn>;
  written: string[];
} {
  const written: string[] = [];
  const write = vi.fn((data: string, callback?: () => void) => {
    written.push(data);
    callback?.();
  });
  return { write, written };
}

describe('terminal output scheduler', () => {
  beforeEach(() => {
    resetTerminalOutputSchedulerForTests();
    setTerminalOutputSchedulerDebug(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTerminalOutputSchedulerForTests();
    setTerminalOutputSchedulerDebug(false);
  });

  it('writes foreground output immediately', () => {
    const terminal = createTerminal();
    writeTerminalOutput(terminal, 'foreground', { foreground: true });
    expect(terminal.write).toHaveBeenCalledWith('foreground');
    expect(terminal.written).toEqual(['foreground']);
  });

  it('runs parsed callbacks after immediate foreground output parses', () => {
    const terminal = createTerminal();
    let parseCallback: (() => void) | undefined;
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      parseCallback = callback;
    });
    const onParsed = vi.fn();

    writeTerminalOutput(terminal, 'foreground', {
      foreground: true,
      onParsed,
    });

    expect(onParsed).not.toHaveBeenCalled();
    parseCallback?.();
    expect(onParsed).toHaveBeenCalledTimes(1);
  });

  it('routes foreground output through the bounded queue when unparsed writes exceed the budget', () => {
    vi.useFakeTimers();
    const written: string[] = [];
    const parseCallbacks: Array<() => void> = [];
    // Sink that never finishes parsing until the test says so.
    const terminal: TerminalOutputSink = {
      write: vi.fn((data: string, callback?: () => void) => {
        written.push(data);
        if (callback) parseCallbacks.push(callback);
      }),
    };

    const big = 'x'.repeat(MAX_UNPARSED_WRITE_CHARS);
    writeTerminalOutput(terminal, big, { foreground: true, onParsed: () => {} });
    expect(getPendingParseChars(terminal)).toBe(big.length);

    // Parse backlog is over budget: the next foreground chunk must NOT reach
    // write() directly — it routes through the bounded queue instead.
    writeTerminalOutput(terminal, 'tail', { foreground: true, onParsed: () => {} });
    expect(written).toEqual([big]);
    expect(getQueuedChars(terminal)).toBe(4);

    // Drains stay parked while the sink is parse-blocked.
    vi.advanceTimersByTime(1000);
    expect(written).toEqual([big]);

    // Parse catches up → the queued output drains in order.
    parseCallbacks.splice(0).forEach((cb) => cb());
    expect(getPendingParseChars(terminal)).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(written.join('')).toBe(big + 'tail');
  });

  it('does not track unparsed chars for writes without a parse callback', () => {
    const terminal = createTerminal();
    writeTerminalOutput(terminal, 'plain', { foreground: true });
    expect(getPendingParseChars(terminal)).toBe(0);
    expect(terminal.written).toEqual(['plain']);
  });

  it('coalesces background output until the shared drain runs', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    writeTerminalOutput(terminal, 'a', { foreground: false });
    writeTerminalOutput(terminal, 'b', { foreground: false });
    expect(terminal.write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    // Drain may write in one or more chunks; order must be preserved.
    const joined = terminal.written.join('');
    expect(joined).toBe('ab');
  });

  it('preserves emission order across multipane concurrent background drains', () => {
    vi.useFakeTimers();
    const a = createTerminal();
    const b = createTerminal();

    writeTerminalOutput(a, 'A1', { foreground: false });
    writeTerminalOutput(b, 'B1', { foreground: false });
    writeTerminalOutput(a, 'A2', { foreground: false });
    writeTerminalOutput(b, 'B2', { foreground: false });

    // Drain cooperatively until empty.
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(16);
    }

    expect(a.written.join('')).toBe('A1A2');
    expect(b.written.join('')).toBe('B1B2');
  });

  it('bounds background backlog and emits drop warning once', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    const onDrop = vi.fn();
    const chunk = 'x'.repeat(256 * 1024);

    // Exceed 2 MB backlog (9 × 256 KiB = 2.25 MiB).
    for (let i = 0; i < 9; i++) {
      writeTerminalOutput(terminal, chunk, {
        foreground: false,
        onBackgroundBacklogDropped: onDrop,
      });
    }

    expect(onDrop).toHaveBeenCalledTimes(1);
    // Bound is enforced: never keep multi-MB after a drop (warning replaces queue;
    // a subsequent enqueue may add one chunk, still << unbounded growth).
    expect(getQueuedChars(terminal)).toBeLessThanOrEqual(
      MAX_BACKGROUND_QUEUE_CHARS,
    );
    expect(getQueuedChars(terminal)).toBeLessThan(512 * 1024);

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(16);
    }
    const joined = terminal.written.join('');
    expect(joined).toContain('Nexus skipped hidden terminal output');
    // CAN + SGR reset at start of warning keeps ANSI integrity after drop.
    expect(joined.includes('\x18\x1b[0m')).toBe(true);

    const snap = getTerminalOutputSchedulerDebugSnapshot();
    expect(snap.droppedBacklogCount).toBeGreaterThanOrEqual(1);
    expect(snap.peakQueuedCharsByTerminal).toBeGreaterThan(MAX_BACKGROUND_QUEUE_CHARS);
  });

  it('keeps ANSI escape sequences intact when chunking large background output', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    // Color CSI that must not be split mid-sequence across our logical writes
    // incorrectly — we join all written data and verify sequences round-trip.
    const color = '\x1b[31mRED\x1b[0m';
    const payload = color.repeat(2000); // ~22 KB > BACKGROUND_CHUNK_CHARS portions

    writeTerminalOutput(terminal, payload, { foreground: false });
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(16);
    }

    const joined = terminal.written.join('');
    expect(joined).toBe(payload);
    // No orphan half-sequence: every ESC[ ends with a letter terminator in payload.
    expect((joined.match(/\x1b\[31m/g) ?? []).length).toBe(2000);
    expect((joined.match(/\x1b\[0m/g) ?? []).length).toBe(2000);
  });

  it('queues large foreground floods when latencySensitive is false', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    writeTerminalOutput(terminal, 'flood', {
      foreground: true,
      latencySensitive: false,
    });
    expect(terminal.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(terminal.written.join('')).toBe('flood');
  });

  it('coalesces focused agent fragments into one short render batch', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    writeTerminalOutput(terminal, 'frame-a', {
      foreground: true,
      latencySensitive: true,
      coalesceForeground: true,
    });
    writeTerminalOutput(terminal, 'frame-b', {
      foreground: true,
      latencySensitive: true,
      coalesceForeground: true,
    });

    expect(terminal.write).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(terminal.written.join('')).toBe('frame-aframe-b');
    expect(terminal.write).toHaveBeenCalledTimes(1);
  });

  it('does not postpone a focused render batch under continuous fragments', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    writeTerminalOutput(terminal, 'a', {
      foreground: true,
      latencySensitive: true,
      coalesceForeground: true,
    });
    vi.advanceTimersByTime(4);
    writeTerminalOutput(terminal, 'b', {
      foreground: true,
      latencySensitive: true,
      coalesceForeground: true,
    });
    vi.advanceTimersByTime(4);
    vi.runOnlyPendingTimers();

    expect(terminal.written.join('')).toBe('ab');
  });

  it('parks hidden adaptive output until the pane becomes visible', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    writeTerminalOutput(terminal, 'hidden', {
      foreground: false,
      holdBackground: true,
    });
    vi.runAllTimers();
    expect(terminal.write).not.toHaveBeenCalled();
    expect(getQueuedChars(terminal)).toBe(6);

    resumeTerminalOutput(terminal);
    vi.runAllTimers();
    expect(terminal.written.join('')).toBe('hidden');
  });

  it('parks a queue that was already scheduled before the pane went hidden', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    writeTerminalOutput(terminal, 'already-queued', { foreground: false });
    pauseTerminalOutput(terminal);
    vi.runAllTimers();
    expect(terminal.write).not.toHaveBeenCalled();

    resumeTerminalOutput(terminal);
    vi.runAllTimers();
    expect(terminal.written.join('')).toBe('already-queued');
  });

  it('keeps parked hidden output bounded and reports runtime pressure', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    const chunk = 'x'.repeat(256 * 1024);

    for (let i = 0; i < 9; i++) {
      writeTerminalOutput(terminal, chunk, {
        foreground: false,
        holdBackground: true,
      });
    }

    const snapshot = getTerminalOutputRuntimeSnapshot();
    expect(snapshot.queuedTerminalCount).toBe(1);
    expect(snapshot.queuedChars).toBeLessThan(512 * 1024);
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('flushTerminalOutput drains remaining backlog for a sink', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    writeTerminalOutput(terminal, 'pending', { foreground: false });
    expect(terminal.write).not.toHaveBeenCalled();
    flushTerminalOutput(terminal);
    expect(terminal.written.join('')).toBe('pending');
  });

  it('discardTerminalOutput drops queue without writing', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    writeTerminalOutput(terminal, 'gone', { foreground: false });
    discardTerminalOutput(terminal);
    vi.advanceTimersByTime(100);
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('removeTransientCursorShowSequences keeps ANSI integrity', () => {
    const hide = '\x1b[?25l';
    const show = '\x1b[?25h';
    const place = '\x1b[10;5H';
    // show then place then hide: transient show is dropped
    const data = `hello${show}${place}${hide}world`;
    const out = removeTransientCursorShowSequences(data);
    expect(out).toContain('hello');
    expect(out).toContain('world');
    // Still well-formed CSI sequences (no truncated ESC[)
    expect(out.includes('\x1b[')).toBe(true);
  });

  it('foreground input path stays responsive while background panes queue', () => {
    vi.useFakeTimers();
    const fg = createTerminal();
    const bg = createTerminal();
    const flood = 'B'.repeat(64 * 1024);

    for (let i = 0; i < 8; i++) {
      writeTerminalOutput(bg, flood, { foreground: false });
    }
    // Foreground keystroke must write immediately, not wait for background.
    writeTerminalOutput(fg, 'key', { foreground: true, latencySensitive: true });
    expect(fg.written).toEqual(['key']);
    expect(bg.write).not.toHaveBeenCalled();
  });

  it('flushTerminalOutput drains background backlog (focus promotion path)', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    writeTerminalOutput(terminal, 'hidden-a', { foreground: false });
    writeTerminalOutput(terminal, 'hidden-b', { foreground: false });
    expect(terminal.write).not.toHaveBeenCalled();
    // focusHost / scrollPaneToBottom call flush before focus.
    flushTerminalOutput(terminal);
    expect(terminal.written.join('')).toBe('hidden-ahidden-b');
    expect(getQueuedChars(terminal)).toBe(0);
  });

  it('safeOutputSplitIndex avoids cutting mid CSI sequence', () => {
    const data = 'abc\x1b[31mRED\x1b[0m';
    // Limit falls inside "\x1b[31m" (starts at index 3).
    const idx = safeOutputSplitIndex(data, 5);
    expect(idx).toBe(3); // cut before ESC
    expect(data.slice(0, idx)).toBe('abc');
    // Complete sequences can be cut after the final byte.
    const complete = '\x1b[31m';
    expect(safeOutputSplitIndex(complete + 'x', complete.length)).toBe(
      complete.length,
    );
  });

  it('chunking never splits a CSI mid-sequence in drained output', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    // Many color spans; chunk size is 16 KiB — force multi-chunk drain.
    const unit = '\x1b[31mX\x1b[0m';
    const payload = unit.repeat(3000);
    writeTerminalOutput(terminal, payload, { foreground: false });
    for (let i = 0; i < 80; i++) {
      vi.advanceTimersByTime(16);
    }
    const joined = terminal.written.join('');
    expect(joined).toBe(payload);
    // No write ended with a bare ESC or open CSI (would corrupt next chunk).
    for (const piece of terminal.written) {
      expect(piece.endsWith('\x1b')).toBe(false);
      expect(/\x1b\[[0-9;]*$/.test(piece)).toBe(false);
    }
  });
});
