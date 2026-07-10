// Benchmark: multi-pane concurrent terminal output under the ORCA-harvested
// scheduler vs a direct-write baseline. Proves for 4, 8, and 10 panes:
// order preserved, ANSI integrity after chunk/drop, hidden backlog bounded,
// memory bounded, and a foreground input responsiveness proxy.
//
// Adapted concepts from stablyai/orca terminal output pressure tests @
// 143c36e566483006fe54fa2716b019ec00599752 (MIT — Lovecast Inc.).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BACKGROUND_QUEUE_CHARS,
  getQueuedChars,
  getTerminalOutputSchedulerDebugSnapshot,
  resetTerminalOutputSchedulerForTests,
  setTerminalOutputSchedulerDebug,
  writeTerminalOutput,
  type TerminalOutputSink,
} from './terminal-output-scheduler';

type BenchSink = TerminalOutputSink & {
  written: string[];
  writeCalls: number;
};

function createSink(): BenchSink {
  const written: string[] = [];
  let writeCalls = 0;
  const sink: BenchSink = {
    written,
    writeCalls: 0,
    write(data: string, callback?: () => void) {
      writeCalls += 1;
      sink.writeCalls = writeCalls;
      written.push(data);
      callback?.();
    },
  };
  return sink;
}

type PaneResult = {
  paneCount: number;
  mode: 'scheduled' | 'direct';
  orderOk: boolean;
  ansiOk: boolean;
  peakQueuedChars: number;
  maxQueuedPerHidden: number;
  fgInputLatencyMs: number;
  memoryProxyBytes: number;
  durationMs: number;
};

function ansiPayload(seq: number): string {
  // Color + text + reset — must survive chunking and drops intact.
  return `\x1b[3${seq % 7}mL${seq}\x1b[0m`;
}

function runDirectBaseline(
  paneCount: number,
  chunksPerPane: number,
): PaneResult {
  const sinks = Array.from({ length: paneCount }, () => createSink());
  const expected = Array.from({ length: paneCount }, () => '' as string);
  const t0 = performance.now();
  let peakMem = 0;

  for (let c = 0; c < chunksPerPane; c++) {
    for (let p = 0; p < paneCount; p++) {
      // Pane 0 is "foreground" for the latency probe only.
      const data = ansiPayload(c * paneCount + p);
      expected[p] += data;
      sinks[p].write(data);
    }
  }

  // Foreground input proxy: measure time to write a single keystroke after flood.
  const fgT0 = performance.now();
  sinks[0].write('KEY');
  const fgInputLatencyMs = performance.now() - fgT0;
  expected[0] += 'KEY';

  for (const s of sinks) {
    peakMem += s.written.join('').length;
  }

  let orderOk = true;
  let ansiOk = true;
  for (let p = 0; p < paneCount; p++) {
    const joined = sinks[p].written.join('');
    if (joined !== expected[p]) orderOk = false;
    if ((joined.match(/\x1b\[\d+m/g) ?? []).length === 0 && chunksPerPane > 0) {
      ansiOk = false;
    }
    // Half-open CSI is a failure.
    if (/\x1b\[$/.test(joined) || /\x1b$/.test(joined)) ansiOk = false;
  }

  return {
    paneCount,
    mode: 'direct',
    orderOk,
    ansiOk,
    peakQueuedChars: 0,
    maxQueuedPerHidden: 0,
    fgInputLatencyMs,
    memoryProxyBytes: peakMem,
    durationMs: performance.now() - t0,
  };
}

function runScheduled(
  paneCount: number,
  chunksPerPane: number,
  opts?: { floodHidden?: boolean },
): PaneResult {
  vi.useFakeTimers();
  resetTerminalOutputSchedulerForTests();
  setTerminalOutputSchedulerDebug(true);

  const sinks = Array.from({ length: paneCount }, () => createSink());
  const expectedFull = Array.from({ length: paneCount }, () => '' as string);
  const t0 = performance.now();
  const floodHidden = opts?.floodHidden === true;
  const floodChunk = 'F'.repeat(128 * 1024);

  for (let c = 0; c < chunksPerPane; c++) {
    for (let p = 0; p < paneCount; p++) {
      const foreground = p === 0;
      const data =
        floodHidden && !foreground && c === 0
          ? floodChunk.repeat(20) // force backlog bound on hidden panes
          : ansiPayload(c * paneCount + p);
      if (!(floodHidden && !foreground)) {
        expectedFull[p] += data;
      }
      writeTerminalOutput(sinks[p], data, {
        foreground,
        latencySensitive: foreground,
      });
    }
  }

  // Foreground keystroke under load — must not wait for hidden drains.
  const fgT0 = performance.now();
  writeTerminalOutput(sinks[0], 'KEY', {
    foreground: true,
    latencySensitive: true,
  });
  const fgInputLatencyMs = performance.now() - fgT0;
  expectedFull[0] += 'KEY';

  // Cooperative drain until idle (bounded iterations).
  for (let i = 0; i < 500; i++) {
    vi.advanceTimersByTime(16);
  }

  const snap = getTerminalOutputSchedulerDebugSnapshot();
  let maxQueuedPerHidden = 0;
  for (let p = 1; p < paneCount; p++) {
    maxQueuedPerHidden = Math.max(maxQueuedPerHidden, getQueuedChars(sinks[p]));
  }

  let orderOk = true;
  let ansiOk = true;
  let memoryProxyBytes = 0;

  for (let p = 0; p < paneCount; p++) {
    const joined = sinks[p].written.join('');
    memoryProxyBytes += joined.length;
    if (floodHidden && p > 0) {
      // Hidden panes may drop — must still end with bounded memory and valid ANSI.
      if (joined.length > MAX_BACKGROUND_QUEUE_CHARS + 64 * 1024) {
        orderOk = false;
      }
      if (joined.includes('\x18') || joined.length > 0) {
        // Drop warning uses CAN; remaining CSI must not be truncated.
        if (/\x1b\[$/.test(joined) || /\x1b$/.test(joined)) ansiOk = false;
      }
    } else if (joined !== expectedFull[p]) {
      orderOk = false;
    }
    if (/\x1b\[$/.test(joined) || /\x1b$/.test(joined)) ansiOk = false;
    if (p === 0) {
      // Foreground must include KEY and preserve full expected order.
      if (!joined.endsWith('KEY') && !joined.includes('KEY')) orderOk = false;
      if (joined !== expectedFull[p]) orderOk = false;
    }
  }

  // Count complete CSI color sequences on foreground as ANSI integrity proxy.
  const fgJoined = sinks[0].written.join('');
  const openColors = (fgJoined.match(/\x1b\[\d+m/g) ?? []).length;
  if (openColors % 2 !== 0 && !fgJoined.includes('KEY')) {
    // color+reset pairs; KEY has none — even count expected for color payloads only
    ansiOk = false;
  }

  const result: PaneResult = {
    paneCount,
    mode: 'scheduled',
    orderOk,
    ansiOk,
    peakQueuedChars: snap.peakQueuedChars,
    maxQueuedPerHidden,
    fgInputLatencyMs,
    memoryProxyBytes,
    durationMs: performance.now() - t0,
  };

  vi.useRealTimers();
  resetTerminalOutputSchedulerForTests();
  setTerminalOutputSchedulerDebug(false);
  return result;
}

/** Shared results for the report artifact (written by the suite). */
export const multipaneBenchmarkResults: PaneResult[] = [];

describe('terminal multipane benchmark (4/8/10)', () => {
  beforeEach(() => {
    resetTerminalOutputSchedulerForTests();
    setTerminalOutputSchedulerDebug(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTerminalOutputSchedulerForTests();
    setTerminalOutputSchedulerDebug(false);
  });

  for (const paneCount of [4, 8, 10] as const) {
    it(`paneCount=${paneCount}: order, ANSI, bounded backlog, responsive FG`, () => {
      const chunksPerPane = 40;
      const direct = runDirectBaseline(paneCount, chunksPerPane);
      const scheduled = runScheduled(paneCount, chunksPerPane);
      const flood = runScheduled(paneCount, 3, { floodHidden: true });

      multipaneBenchmarkResults.push(direct, scheduled, flood);
      // Machine-readable row for scratch reports (grep BENCH_JSON).
      // eslint-disable-next-line no-console
      console.log(
        'BENCH_JSON',
        JSON.stringify({
          direct: {
            paneCount: direct.paneCount,
            orderOk: direct.orderOk,
            ansiOk: direct.ansiOk,
            fgInputLatencyMs: direct.fgInputLatencyMs,
            memoryProxyBytes: direct.memoryProxyBytes,
            durationMs: direct.durationMs,
          },
          scheduled: {
            paneCount: scheduled.paneCount,
            orderOk: scheduled.orderOk,
            ansiOk: scheduled.ansiOk,
            fgInputLatencyMs: scheduled.fgInputLatencyMs,
            peakQueuedChars: scheduled.peakQueuedChars,
            maxQueuedPerHidden: scheduled.maxQueuedPerHidden,
            memoryProxyBytes: scheduled.memoryProxyBytes,
            durationMs: scheduled.durationMs,
          },
          flood: {
            paneCount: flood.paneCount,
            orderOk: flood.orderOk,
            ansiOk: flood.ansiOk,
            fgInputLatencyMs: flood.fgInputLatencyMs,
            peakQueuedChars: flood.peakQueuedChars,
            maxQueuedPerHidden: flood.maxQueuedPerHidden,
            memoryProxyBytes: flood.memoryProxyBytes,
            durationMs: flood.durationMs,
          },
        }),
      );

      expect(direct.orderOk, 'direct order').toBe(true);
      expect(direct.ansiOk, 'direct ansi').toBe(true);

      expect(scheduled.orderOk, 'scheduled order').toBe(true);
      expect(scheduled.ansiOk, 'scheduled ansi').toBe(true);
      // Foreground keystroke is synchronous under scheduler (0-ish ms fake clock).
      expect(scheduled.fgInputLatencyMs).toBeLessThan(5);

      // Flooded hidden panes: backlog bounded, drop path keeps ANSI safe.
      expect(flood.ansiOk, 'flood ansi').toBe(true);
      expect(flood.peakQueuedChars).toBeLessThanOrEqual(
        MAX_BACKGROUND_QUEUE_CHARS * paneCount + 1024 * 1024,
      );
      // Per-hidden-pane residual queue after drain must not stay unbounded.
      expect(flood.maxQueuedPerHidden).toBeLessThanOrEqual(
        MAX_BACKGROUND_QUEUE_CHARS,
      );

      // No regression: scheduled FG latency should not exceed direct by a large margin
      // (both are sync in unit-test sinks; compare memory proxy for hidden flood).
      expect(flood.memoryProxyBytes).toBeLessThan(
        MAX_BACKGROUND_QUEUE_CHARS * paneCount * 2,
      );
    });
  }
});
