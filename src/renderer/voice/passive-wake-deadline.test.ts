import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassiveWakeDeadline } from './passive-wake-deadline';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PassiveWakeDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases the checking gate at the renderer deadline even when IPC never settles', async () => {
    vi.useFakeTimers();
    const request = deferred<string>();
    const deadline = new PassiveWakeDeadline(3_500, 0);

    const resultPromise = deadline.run(() => request.promise);
    expect(deadline.isChecking()).toBe(true);

    await vi.advanceTimersByTimeAsync(3_500);

    await expect(resultPromise).resolves.toEqual({ kind: 'timeout' });
    expect(deadline.isChecking()).toBe(false);
  });

  it('allows a new check after timeout and discards the late result from the old generation', async () => {
    vi.useFakeTimers();
    const stale = deferred<string>();
    const deadline = new PassiveWakeDeadline(100, 0);

    const staleResult = deadline.run(() => stale.promise);
    await vi.advanceTimersByTimeAsync(100);
    await expect(staleResult).resolves.toEqual({ kind: 'timeout' });

    await expect(deadline.run(async () => 'fresh')).resolves.toEqual({
      kind: 'completed',
      value: 'fresh',
    });
    stale.resolve('must-not-resurface');
    await Promise.resolve();

    expect(deadline.isChecking()).toBe(false);
  });

  it('invalidates an active generation during controller cleanup', async () => {
    const request = deferred<string>();
    const deadline = new PassiveWakeDeadline(1_000);
    const resultPromise = deadline.run(() => request.promise);

    deadline.invalidate();
    request.resolve('late');

    await expect(resultPromise).resolves.toEqual({ kind: 'discarded' });
    expect(deadline.isChecking()).toBe(false);
  });

  it('rejects overlapping checks without replacing the active generation', async () => {
    const request = deferred<string>();
    const deadline = new PassiveWakeDeadline(1_000);
    const active = deadline.run(() => request.promise);

    await expect(deadline.run(async () => 'overlap')).resolves.toEqual({
      kind: 'busy',
    });
    request.resolve('active');

    await expect(active).resolves.toEqual({ kind: 'completed', value: 'active' });
  });

  it('opens a circuit-breaker cooldown after timeout to prevent an STT request storm', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const deadline = new PassiveWakeDeadline(100, 15_000);

    const timedOut = deadline.run(() => first.promise);
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOut).resolves.toEqual({ kind: 'timeout' });

    expect(deadline.isChecking()).toBe(true);
    await expect(deadline.run(async () => 'must-not-run')).resolves.toEqual({
      kind: 'busy',
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(deadline.isChecking()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.isChecking()).toBe(false);
    await expect(deadline.run(async () => 'recovered')).resolves.toEqual({
      kind: 'completed',
      value: 'recovered',
    });
  });
});
