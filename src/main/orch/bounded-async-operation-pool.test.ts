import { describe, expect, it, vi } from 'vitest';
import {
  AsyncOperationCapacityError,
  BoundedAsyncOperationPool,
} from './bounded-async-operation-pool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('BoundedAsyncOperationPool', () => {
  it('joins the same key while rejecting a distinct operation above the global cap', async () => {
    const pool = new BoundedAsyncOperationPool<string>({
      maxConcurrent: 1,
      maxCacheEntries: 0,
      ttlMs: 0,
    });
    const pending = deferred<string>();
    const task = vi.fn(() => pending.promise);

    const first = pool.run('same', task);
    const joined = pool.run('same', task);

    await expect(
      pool.run('different', async () => 'must not run'),
    ).rejects.toBeInstanceOf(AsyncOperationCapacityError);
    expect(task).toHaveBeenCalledTimes(1);

    pending.resolve('done');
    await expect(Promise.all([first, joined])).resolves.toEqual(['done', 'done']);
  });

  it('bounds successful cache entries with LRU eviction', async () => {
    const pool = new BoundedAsyncOperationPool<string>({
      maxConcurrent: 1,
      maxCacheEntries: 2,
      ttlMs: 60_000,
    });
    const task = vi.fn(async (value: string) => value);

    await pool.run('a', () => task('a-1'));
    await pool.run('b', () => task('b-1'));
    await expect(pool.run('a', () => task('a-2'))).resolves.toBe('a-1');
    await pool.run('c', () => task('c-1'));
    await expect(pool.run('b', () => task('b-2'))).resolves.toBe('b-2');

    expect(task).toHaveBeenCalledTimes(4);
  });

  it('expires cache entries and never caches a rejected operation', async () => {
    let now = 1_000;
    const pool = new BoundedAsyncOperationPool<string>({
      maxConcurrent: 1,
      maxCacheEntries: 2,
      ttlMs: 100,
      now: () => now,
    });
    const failed = vi.fn(async () => {
      throw new Error('revoked');
    });

    await expect(pool.run('x', failed)).rejects.toThrow('revoked');
    await expect(pool.run('x', async () => 'fresh')).resolves.toBe('fresh');
    now += 101;
    await expect(pool.run('x', async () => 'new')).resolves.toBe('new');
  });
});
