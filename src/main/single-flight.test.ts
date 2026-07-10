import { describe, expect, it, vi } from 'vitest';

import { createSingleFlight } from './single-flight';

describe('createSingleFlight', () => {
  it('shares an in-flight operation and starts a fresh one after it settles', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const operation = vi.fn(async () => await pending);
    const run = createSingleFlight(operation);

    const first = run();
    const second = run();

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledOnce();

    resolve();
    await first;
    await run();

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight operation after a failure so callers can retry', async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    const run = createSingleFlight(operation);

    await expect(run()).rejects.toThrow('temporary failure');
    await expect(run()).resolves.toBeUndefined();

    expect(operation).toHaveBeenCalledTimes(2);
  });
});
