import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { periodicTaskSnapshot, runPeriodicTask, stopPeriodicTask } from './periodic-task';

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
