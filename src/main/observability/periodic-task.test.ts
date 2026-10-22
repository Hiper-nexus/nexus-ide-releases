import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  configurePeriodicTaskSlowSink, periodicTaskSnapshot, runPeriodicTask, SLOW_REPORT_MIN_INTERVAL_MS, stopPeriodicTask,
} from './periodic-task';

afterEach(() => vi.useRealTimers());

describe('periodic task physical flights', () => {
  it('owns every registered wait when Promise.all rejects before a sibling settles', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let runs = 0;
    const first = runPeriodicTask('test-siblings', async (context) => {
      runs++;
      await Promise.all([context.wait(Promise.reject(new Error('failed sibling'))), context.wait(pending)]);
    });
    const result = first.catch((error) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const duplicate = runPeriodicTask('test-siblings', () => { runs++; });
    void duplicate.catch(() => undefined);
    expect(duplicate).toBe(first);
    expect(runs).toBe(1);
    finish();
    expect((await result).message).toBe('failed sibling');
    await stopPeriodicTask('test-siblings');
  });
  it('holds admission through timeout until the original IO physically settles', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const io = new Promise<void>((resolve) => { finish = resolve; });
    let runs = 0;
    const first = runPeriodicTask('test-timeout', async (context) => {
      runs++;
      await context.wait(io);
    }, { timeoutMs: 10 });
    const outcome = first.catch((error) => error);
    await vi.advanceTimersByTimeAsync(11);
    const second = runPeriodicTask('test-timeout', () => { runs++; });
    void second.catch(() => undefined);
    expect(second).toBe(first);
    expect(runs).toBe(1);
    finish();
    expect((await outcome).name).toBe('TimeoutError');
    await stopPeriodicTask('test-timeout');
  });

  it('yields to an unrelated event-loop unit and resumes in original order', async () => {
    const events: number[] = [];
    const heartbeat = new Promise<void>((resolve) => setImmediate(() => { events.push(99); resolve(); }));
    await runPeriodicTask('test-yield', async (context) => {
      for (let i = 0; i < 4; i++) {
        events.push(i);
        await context.checkpoint();
      }
    }, { sliceMs: 0 });
    await heartbeat;
    expect(events).toEqual([0, 99, 1, 2, 3]);
    await stopPeriodicTask('test-yield');
  });

  it('stop aborts effects but waits for pending IO before removing the instance', async () => {
    let finish!: () => void;
    const io = new Promise<void>((resolve) => { finish = resolve; });
    let mutated = false;
    const task = runPeriodicTask('test-stop', async (context) => {
      await context.wait(io);
      mutated = true;
    });
    void task.catch(() => undefined);
    let settled = false;
    const stop = stopPeriodicTask('test-stop').then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await stop;
    expect(mutated).toBe(false);
    expect(periodicTaskSnapshot().tasks.some((task) => task.name === 'test-stop')).toBe(false);
  });

  it('reports bounded sanitized names without opaque instance keys or text', async () => {
    await runPeriodicTask('test-snapshot:secret@example.com /private/path', () => undefined);
    const snapshot = periodicTaskSnapshot();
    const task = snapshot.tasks.find((task) => task.name === 'test-snapshot');
    expect(task?.lastCompletedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(snapshot)).not.toContain('secret@example.com');
    expect(JSON.stringify(snapshot)).not.toContain('/private/path');
    await stopPeriodicTask('test-snapshot:secret@example.com /private/path');
  });

  it('a real slow child process leaves the Main heartbeat running', async () => {
    let beats = 0;
    const timer = setInterval(() => { beats++; }, 5);
    try {
      await runPeriodicTask('test-process', async (context) => {
        await context.wait(promisify(execFile)(process.execPath, ['-e', 'setTimeout(() => {}, 80)']));
      });
      expect(beats).toBeGreaterThan(5);
    } finally {
      clearInterval(timer);
      await stopPeriodicTask('test-process');
    }
  });
});

describe('periodic task slow report', () => {
  const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };

  it('emits one report per task name per window and counts the suppressed runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const reports: Array<{ name: string; suppressed: number; suppressedMaxSliceMs: number }> = [];
    configurePeriodicTaskSlowSink((diagnostic) => { reports.push(diagnostic); });
    try {
      // Seven instances of one name started in the same tick (one per worker shim).
      await Promise.all(Array.from({ length: 7 }, (_, i) =>
        runPeriodicTask(`slow-dedupe:${i}`, () => busy(3), { sliceMs: 1 })));
      expect(reports.map((r) => r.name)).toEqual(['slow-dedupe']);
      expect(reports[0]).toMatchObject({ suppressed: 0 });

      await runPeriodicTask('slow-dedupe:next', () => busy(3), { sliceMs: 1 });
      expect(reports).toHaveLength(1);

      vi.setSystemTime(Date.now() + SLOW_REPORT_MIN_INTERVAL_MS + 1);
      await runPeriodicTask('slow-dedupe:later', () => busy(3), { sliceMs: 1 });
      expect(reports).toHaveLength(2);
      // 6 siblings + 1 follow-up were folded into the second report, with their worst slice.
      expect(reports[1].suppressed).toBe(7);
      expect(reports[1].suppressedMaxSliceMs).toBeGreaterThan(1);
    } finally {
      configurePeriodicTaskSlowSink(null);
    }
  });

  it('keeps reporting distinct task names independently', async () => {
    const names: string[] = [];
    configurePeriodicTaskSlowSink((diagnostic) => { names.push(diagnostic.name); });
    try {
      await runPeriodicTask('slow-name-a', () => busy(3), { sliceMs: 1 });
      await runPeriodicTask('slow-name-b', () => busy(3), { sliceMs: 1 });
      expect(names).toEqual(['slow-name-a', 'slow-name-b']);
    } finally {
      configurePeriodicTaskSlowSink(null);
    }
  });

  it('a bare await on I/O (outside wait) is waiting, not CPU', async () => {
    const names: string[] = [];
    configurePeriodicTaskSlowSink((diagnostic) => { names.push(diagnostic.name); });
    try {
      await runPeriodicTask('slow-bare-await', async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
      }, { sliceMs: 20 });
      expect(names).toEqual([]);
      expect(periodicTaskSnapshot().tasks.find((task) => task.name === 'slow-bare-await')?.sliceMsMax).toBeLessThan(20);
    } finally {
      configurePeriodicTaskSlowSink(null);
      await stopPeriodicTask('slow-bare-await');
    }
  });

  it('CPU spent before a bare await is still reported', async () => {
    const names: string[] = [];
    configurePeriodicTaskSlowSink((diagnostic) => { names.push(diagnostic.name); });
    try {
      await runPeriodicTask('slow-before-await', async () => {
        busy(30);
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
      }, { sliceMs: 20 });
      expect(names).toEqual(['slow-before-await']);
    } finally {
      configurePeriodicTaskSlowSink(null);
      await stopPeriodicTask('slow-before-await');
    }
  });

  it('the report window is a minute per task name', () => {
    expect(SLOW_REPORT_MIN_INTERVAL_MS).toBe(60_000);
  });

  it('does not report a run that stayed inside its CPU slice', async () => {
    const names: string[] = [];
    configurePeriodicTaskSlowSink((diagnostic) => { names.push(diagnostic.name); });
    try {
      await runPeriodicTask('slow-quiet', () => undefined, { sliceMs: 50 });
      expect(names).toEqual([]);
    } finally {
      configurePeriodicTaskSlowSink(null);
    }
  });
});
