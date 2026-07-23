import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationReconciler } from './orchestration-reconciler';

afterEach(() => {
  vi.useRealTimers();
});

describe('orchestration reconciler', () => {
  it('runs every participant from one adaptive timer at its own cadence', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const fast = vi.fn(async () => { order.push('fast'); });
    const slow = vi.fn(async () => { order.push('slow'); });
    const reconciler = createOrchestrationReconciler([
      { id: 'fast', cadenceMs: 5_000, run: fast },
      { id: 'slow', cadenceMs: 15_000, run: slow },
    ]);

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fast).toHaveBeenCalledTimes(1);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['fast', 'slow']);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fast).toHaveBeenCalledTimes(2);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await reconciler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces event wakes and performs one trailing pass after an in-flight run', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const run = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const reconciler = createOrchestrationReconciler([
      { id: 'driver', cadenceMs: 30_000, run },
    ]);

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    reconciler.request('driver');
    reconciler.request('driver');
    reconciler.request('driver');
    expect(run).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    release?.();
    await Promise.resolve();
    await reconciler.stop();
  });

  it('isolates participant failures and keeps the coordinator alive', async () => {
    vi.useFakeTimers();
    const warn = vi.fn(() => { throw new Error('logger failed'); });
    const healthy = vi.fn(async () => undefined);
    const reconciler = createOrchestrationReconciler(
      [
        { id: 'broken', cadenceMs: 5_000, run: async () => { throw new Error('boom'); } },
        { id: 'healthy', cadenceMs: 5_000, run: healthy },
      ],
      { warn },
    );

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('broken'),
      expect.any(Error),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(healthy).toHaveBeenCalledTimes(2);
    await reconciler.stop();
  });

  it('starts independent due participants without waiting for a slow sibling', async () => {
    vi.useFakeTimers();
    let releaseSlow: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSlow = resolve;
        }),
    );
    const healthy = vi.fn(async () => undefined);
    const reconciler = createOrchestrationReconciler([
      { id: 'slow', cadenceMs: 30_000, timeoutMs: 60_000, run: slow },
      { id: 'healthy', cadenceMs: 30_000, run: healthy },
    ]);

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(slow).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();

    releaseSlow?.();
    await Promise.resolve();
    await reconciler.stop();
  });

  it('times out one stuck participant without starving the cadence of the others', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let releaseStuck: (() => void) | undefined;
    const stuck = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStuck = resolve;
        }),
    );
    const healthy = vi.fn(async () => undefined);
    const reconciler = createOrchestrationReconciler(
      [
        { id: 'stuck', cadenceMs: 500, timeoutMs: 1_000, run: stuck },
        { id: 'healthy', cadenceMs: 1_000, run: healthy },
      ],
      { warn },
    );

    reconciler.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(stuck).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('stuck'),
      expect.objectContaining({ name: 'TimeoutError' }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stuck).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledTimes(2);

    releaseStuck?.();
    await Promise.resolve();
    await reconciler.stop();
  });

  it('stop fails closed when a participant ignores abort until its physical effect settles', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const first = vi.fn((_now: number, signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const second = vi.fn(async () => undefined);
    const reconciler = createOrchestrationReconciler(
      [
        { id: 'first', cadenceMs: 5_000, timeoutMs: 60_000, run: first },
        { id: 'second', cadenceMs: 5_000, run: second },
      ],
      { shutdownSettlementTimeoutMs: 1_000 },
    );

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    const stopped = reconciler.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(stopped).rejects.toMatchObject({
      name: 'ShutdownTimeoutError',
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => reconciler.start()).toThrow(/previous epoch/i);

    release?.();
    await Promise.resolve();
    await Promise.resolve();
    await reconciler.stop();
  });

  it.each(['resolve', 'reject'] as const)(
    'a late %s from a stopped epoch is observed but cannot corrupt the next epoch',
    async (settlement) => {
      vi.useFakeTimers();
      const warn = vi.fn();
      let settleOld: (() => void) | undefined;
      let rejectOld: ((error: Error) => void) | undefined;
      const run = vi.fn(() => {
        if (run.mock.calls.length === 1) {
          return new Promise<void>((resolve, reject) => {
            settleOld = resolve;
            rejectOld = reject;
          });
        }
        return Promise.resolve();
      });
      const reconciler = createOrchestrationReconciler(
        [{ id: 'driver', cadenceMs: 5_000, timeoutMs: 60_000, run }],
        { warn },
      );

      reconciler.start();
      await vi.advanceTimersByTimeAsync(0);
      const stopped = reconciler.stop();
      expect(() => reconciler.start()).toThrow(/previous epoch/i);

      if (settlement === 'resolve') settleOld?.();
      else rejectOld?.(new Error('late failure'));
      await Promise.resolve();
      await Promise.resolve();
      await stopped;

      // A fresh epoch starts only after the old effect has physically settled.
      reconciler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(warn).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(2);
      await reconciler.stop();
    },
  );
});
