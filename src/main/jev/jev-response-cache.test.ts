import { describe, expect, it, vi } from 'vitest';
import { JevResponseCache } from './jev-response-cache';

describe('JevResponseCache', () => {
  it('coalesces identical concurrent requests, then reuses only within TTL and the same owner/state', async () => {
    let now = 0;
    const cache = new JevResponseCache<number>(15, () => now);
    const owner = {};
    let finish!: (value: number) => void;
    const compute = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const first = cache.get(owner, 'a', compute, () => true);
    const second = cache.get(owner, 'a', compute, () => true);
    await Promise.resolve(); finish(42);
    expect(await first).toEqual({ value: 42, reused: false });
    expect(await second).toEqual({ value: 42, reused: true });
    expect(compute).toHaveBeenCalledOnce();
    const next = vi.fn(async () => 43);
    expect((await cache.get(owner, 'a', next, () => true)).value).toBe(42);
    now = 16;
    expect((await cache.get(owner, 'a', next, () => true)).reused).toBe(false);
    expect((await cache.get(owner, 'b', next, () => true)).reused).toBe(false);
    expect((await cache.get({}, 'b', next, () => true)).reused).toBe(false);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('does not retain failures or unavailable answers', async () => {
    const cache = new JevResponseCache<number | null>();
    const owner = {};
    const compute = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null).mockResolvedValue(1);
    await expect(cache.get(owner, 'a', compute, v => v !== null)).rejects.toThrow('offline');
    expect((await cache.get(owner, 'a', compute, v => v !== null)).value).toBeNull();
    expect((await cache.get(owner, 'a', compute, v => v !== null)).value).toBe(1);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('late completion of old state cannot replace the newer state', async () => {
    const cache = new JevResponseCache<number>();
    const owner = {};
    let finish!: (value: number) => void;
    const old = cache.get(owner, 'old', () => new Promise<number>(r => { finish = r; }), () => true);
    await Promise.resolve();
    await cache.get(owner, 'new', async () => 2, () => true);
    finish(1); await old;
    const compute = vi.fn(async () => 3);
    expect(await cache.get(owner, 'new', compute, () => true)).toEqual({ value: 2, reused: true });
    expect(compute).not.toHaveBeenCalled();
  });
});
