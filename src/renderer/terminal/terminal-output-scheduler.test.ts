// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// (resynced from 143c36e566483006fe54fa2716b019ec00599752)
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: tests target adapted
// scheduler API (stable write sink, no xterm _core / scroll-intent mocks).
// Resync (2026-09-11): regression coverage for the three ported fixes
// (orca#8754 hold/coalesce release deadline, orca#13402 retained-slice
// flattening, linear chunk assembly) written against Nexus's public API,
// not copied from a single upstream test file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BACKGROUND_QUEUE_CHARS,
  MAX_UNPARSED_WRITE_CHARS,
  discardTerminalOutput,
  flattenRetainedSlice,
  flushTerminalOutput,
  getPendingParseChars,
  getQueuedChars,
  getQueuedRetainedChars,
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
    expect(joined).toContain('Nexus skipped hidden output');
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

describe('resync pós-drop de backlog (garble do voo real 19/08)', () => {
  beforeEach(() => {
    resetTerminalOutputSchedulerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetTerminalOutputSchedulerForTests();
  });

  it('descarta o rabo da linha cortada e retoma no próximo newline', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    const chunk = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 9; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false });
    }
    // Pós-drop: chunk começa no MEIO de uma sequência cortada (charset "(B",
    // SGR "1;2m" e payload Kitty do grok viravam texto na tela).
    writeTerminalOutput(terminal, '(B1;2mGa=d,d=i,i=1,q=2 sem newline', {
      foreground: false,
    });
    writeTerminalOutput(terminal, 'ainda rabo\nlinha limpa pós-resync', {
      foreground: false,
    });
    for (let i = 0; i < 30; i++) vi.advanceTimersByTime(16);

    const joined = terminal.written.join('');
    expect(joined).toContain('Nexus skipped hidden output');
    expect(joined).not.toContain('Ga=d,d=i');
    expect(joined).not.toContain('ainda rabo');
    expect(joined).toContain('linha limpa pós-resync');
  });

  it('TUI sem newline retoma no próximo ESC (pane não fica em branco)', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    const chunk = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 9; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false });
    }
    // Alternate screen (Claude/Grok/Codex): o repaint reposiciona cursor com
    // CSI, SEM newline. Esperar '\n' descartava o frame inteiro e o pane
    // abria em branco (voo real 19/08, pane "Implementar int…").
    writeTerminalOutput(
      terminal,
      'rabo-cortado-sem-esc\x1b[2J\x1b[Hframe TUI redesenhado',
      { foreground: false },
    );
    for (let i = 0; i < 30; i++) vi.advanceTimersByTime(16);

    const joined = terminal.written.join('');
    expect(joined).not.toContain('rabo-cortado-sem-esc');
    expect(joined).toContain('\x1b[2J\x1b[Hframe TUI redesenhado');
  });
});

describe('flattenRetainedSlice', () => {
  it('preserves content exactly, including empty and multi-byte input', () => {
    expect(flattenRetainedSlice('')).toBe('');
    expect(flattenRetainedSlice('a')).toBe('a');
    const source = 'hello world, 漢字, \x1b[31mred\x1b[0m, 🎉';
    expect(flattenRetainedSlice(source)).toBe(source);
    expect(flattenRetainedSlice(source.slice(3))).toBe(source.slice(3));
  });
});

describe('foreground hold/coalesce livelock (orca#8754)', () => {
  beforeEach(() => {
    resetTerminalOutputSchedulerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetTerminalOutputSchedulerForTests();
  });

  it('keeps repainting when synchronized frames alternate hold and coalesce chunks', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    // Mirrors a continuously repainting TUI: the frame-open chunk holds
    // (waits for the frame-close chunk), the frame-close chunk coalesces
    // (waits briefly for more foreground output). Each write lands 5ms
    // after the previous one — shorter than BOTH the latency-sensitive
    // coalesce delay (8ms) and hold-safety delay (32ms) — so before the fix
    // every write cancels the other side's fallback timer before it can
    // fire, and the entry never becomes drainable no matter how long the
    // stream continues.
    const writeFrameOpen = (frame: number): void => {
      writeTerminalOutput(terminal, `\x1b[?2026h\x1b[10;5HWorking ${frame}`, {
        foreground: true,
        latencySensitive: true,
        holdForeground: true,
      });
    };
    const writeFrameClose = (): void => {
      writeTerminalOutput(terminal, '\x1b[10;8H\x1b[?2026l', {
        foreground: true,
        latencySensitive: true,
        coalesceForeground: true,
      });
    };

    writeFrameOpen(0);
    for (let frame = 1; frame < 40; frame += 1) {
      vi.advanceTimersByTime(5);
      writeFrameClose();
      vi.advanceTimersByTime(5);
      writeFrameOpen(frame);
    }

    // The shared release deadline caps one non-drainable episode regardless
    // of how the mode keeps flipping, so at least one write must have
    // escaped despite 200ms of continuous alternation.
    expect(terminal.write).toHaveBeenCalled();
  });

  it('honours the full coalesce delay when the shared deadline is not binding', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    // t=0: hold arms a 32ms deadline. t=10: coalesce asks for 8ms, so the
    // shared deadline becomes min(32, 18) = 18. The entry must be released
    // at t=18 exactly: not early (the coalesce window is honoured) and not
    // stretched to the hold budget.
    writeTerminalOutput(terminal, 'open', {
      foreground: true,
      latencySensitive: true,
      holdForeground: true,
    });
    vi.advanceTimersByTime(10);
    writeTerminalOutput(terminal, 'close', {
      foreground: true,
      latencySensitive: true,
      coalesceForeground: true,
    });
    vi.advanceTimersByTime(7);
    expect(terminal.write).not.toHaveBeenCalled();

    // The release at t=18 hands off to a 0ms drain timer. Fake timers put a
    // zero-delay timer created inside a tick on the next tick, so the write
    // itself lands at t=19.
    vi.advanceTimersByTime(2);
    expect(terminal.written.join('')).toBe('openclose');
    expect(terminal.write).toHaveBeenCalledTimes(1);
  });
});

describe('takeQueuedChunk linear assembly', () => {
  beforeEach(() => {
    resetTerminalOutputSchedulerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetTerminalOutputSchedulerForTests();
  });

  it('assembles many small queued chunks in order with no gaps or duplicates', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    const parts = Array.from({ length: 200 }, (_, index) => `${index}:`);

    for (const part of parts) {
      writeTerminalOutput(terminal, part, { foreground: false });
    }
    flushTerminalOutput(terminal);

    expect(terminal.written.join('')).toBe(parts.join(''));
    expect(getQueuedChars(terminal)).toBe(0);
  });

  it('preserves exact content across many partial takes of one large chunk (retainedChars bookkeeping)', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    // Unique per-record markers: any misalignment from the geometric
    // flatten/no-flatten bookkeeping would show up as a content mismatch,
    // not just a length mismatch.
    const records = Array.from({ length: 20_000 }, (_, index) =>
      String(index).padStart(7, '0'),
    );
    const payload = records.join(':') + ':';

    writeTerminalOutput(terminal, payload, { foreground: false });
    for (let i = 0; i < 200 && getQueuedChars(terminal) > 0; i += 1) {
      vi.advanceTimersByTime(16);
      // orca#13402 bound: a partial take either re-flattens (retained ==
      // residual) or leaves residual*2 > retained, so the pinned backing
      // store can never exceed twice what is still queued. Reverting the
      // geometric flatten keeps the original ~160K pinned while queued
      // shrinks, and this trips once queued drops below 80K.
      expect(getQueuedRetainedChars(terminal)).toBeLessThanOrEqual(
        2 * getQueuedChars(terminal),
      );
    }

    expect(terminal.written.join('')).toBe(payload);
    expect(getQueuedChars(terminal)).toBe(0);
    expect(getQueuedRetainedChars(terminal)).toBe(0);
  });

  it('releases the backing store of fully consumed slots before the 64-slot compaction', () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    // 100 x 1 KiB chunks: each 16 KiB take consumes 16 whole slots, so after
    // one drain tick (2 writes) 32 consumed slots sit below the compaction
    // threshold. With the fix they hold nothing; without it each still pins
    // its 1 KiB and retained exceeds what is queued.
    const chunk = 'y'.repeat(1024);
    for (let i = 0; i < 100; i += 1) {
      writeTerminalOutput(terminal, chunk, { foreground: false });
    }
    expect(getQueuedRetainedChars(terminal)).toBe(getQueuedChars(terminal));

    vi.advanceTimersByTime(50);
    expect(getQueuedChars(terminal)).toBeLessThan(100 * 1024);
    expect(getQueuedChars(terminal)).toBeGreaterThan(0);
    expect(getQueuedRetainedChars(terminal)).toBe(getQueuedChars(terminal));
  });
});
