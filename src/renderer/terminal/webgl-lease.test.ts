import { describe, expect, it, vi } from 'vitest';
import { WebglLeasePool, type WebglLeaseEntry } from './webgl-lease';

interface FakeEntry extends WebglLeaseEntry {
  activate: ReturnType<typeof vi.fn<() => boolean>>;
  deactivate: ReturnType<typeof vi.fn<() => void>>;
}

function makeEntry(activateResult = true): FakeEntry {
  return {
    activate: vi.fn(() => activateResult),
    deactivate: vi.fn(),
  };
}

function makePool(max: number): { pool: WebglLeasePool; tick: () => void } {
  let now = 0;
  return {
    pool: new WebglLeasePool(max, () => now),
    tick: () => {
      now += 1;
    },
  };
}

describe('WebglLeasePool', () => {
  it('grants leases on register while slots are free', () => {
    const { pool } = makePool(2);
    const a = makeEntry();
    const b = makeEntry();
    pool.register('a', a);
    pool.register('b', b);
    expect(a.activate).toHaveBeenCalledTimes(1);
    expect(b.activate).toHaveBeenCalledTimes(1);
    expect(pool.isActive('a')).toBe(true);
    expect(pool.isActive('b')).toBe(true);
    expect(pool.activeLeases).toBe(2);
  });

  it('does not grant a lease on register when the pool is full', () => {
    const { pool } = makePool(1);
    const a = makeEntry();
    const b = makeEntry();
    pool.register('a', a);
    pool.register('b', b);
    expect(b.activate).not.toHaveBeenCalled();
    expect(pool.isActive('b')).toBe(false);
    expect(pool.activeLeases).toBe(1);
  });

  it('touch steals the slot of the least-recently-touched holder', () => {
    const { pool, tick } = makePool(2);
    const a = makeEntry();
    const b = makeEntry();
    const c = makeEntry();
    pool.register('a', a);
    tick();
    pool.register('b', b);
    tick();
    pool.register('c', c);
    expect(pool.isActive('c')).toBe(false);

    tick();
    pool.touch('c');
    expect(a.deactivate).toHaveBeenCalledTimes(1);
    expect(b.deactivate).not.toHaveBeenCalled();
    expect(pool.isActive('a')).toBe(false);
    expect(pool.isActive('c')).toBe(true);
    expect(pool.activeLeases).toBe(2);
  });

  it('touch refreshes recency so an active holder can avoid eviction', () => {
    const { pool, tick } = makePool(2);
    const a = makeEntry();
    const b = makeEntry();
    const c = makeEntry();
    pool.register('a', a);
    tick();
    pool.register('b', b);
    tick();
    pool.register('c', c);

    // Re-focus "a" — now "b" is the LRU holder.
    tick();
    pool.touch('a');
    tick();
    pool.touch('c');
    expect(a.deactivate).not.toHaveBeenCalled();
    expect(b.deactivate).toHaveBeenCalledTimes(1);
    expect(pool.isActive('c')).toBe(true);
  });

  it('touch on an active holder only refreshes recency', () => {
    const { pool } = makePool(1);
    const a = makeEntry();
    pool.register('a', a);
    pool.touch('a');
    expect(a.activate).toHaveBeenCalledTimes(1);
    expect(a.deactivate).not.toHaveBeenCalled();
  });

  it('notifyLost frees the slot without calling deactivate', () => {
    const { pool, tick } = makePool(1);
    const a = makeEntry();
    const b = makeEntry();
    pool.register('a', a);
    tick();
    pool.register('b', b);
    pool.notifyLost('a');
    expect(a.deactivate).not.toHaveBeenCalled();
    expect(pool.activeLeases).toBe(0);

    tick();
    pool.touch('b');
    expect(pool.isActive('b')).toBe(true);
    expect(pool.activeLeases).toBe(1);
  });

  it('unregister deactivates the holder and frees the slot', () => {
    const { pool, tick } = makePool(1);
    const a = makeEntry();
    const b = makeEntry();
    pool.register('a', a);
    tick();
    pool.register('b', b);
    pool.unregister('a');
    expect(a.deactivate).toHaveBeenCalledTimes(1);
    expect(pool.activeLeases).toBe(0);

    tick();
    pool.touch('b');
    expect(pool.isActive('b')).toBe(true);
  });

  it('a failed activate consumes no slot and is retried on the next touch', () => {
    const { pool, tick } = makePool(1);
    const flaky = makeEntry(false);
    pool.register('flaky', flaky);
    expect(pool.isActive('flaky')).toBe(false);
    expect(pool.activeLeases).toBe(0);

    flaky.activate.mockReturnValue(true);
    tick();
    pool.touch('flaky');
    expect(pool.isActive('flaky')).toBe(true);
    expect(pool.activeLeases).toBe(1);
  });

  it('a failed steal leaves the freed slot available instead of leaking it', () => {
    const { pool, tick } = makePool(1);
    const a = makeEntry();
    const broken = makeEntry(false);
    pool.register('a', a);
    tick();
    pool.register('broken', broken);
    tick();
    pool.touch('broken');
    expect(a.deactivate).toHaveBeenCalledTimes(1);
    expect(pool.isActive('broken')).toBe(false);
    expect(pool.activeLeases).toBe(0);

    tick();
    pool.touch('a');
    expect(pool.isActive('a')).toBe(true);
    expect(pool.activeLeases).toBe(1);
  });

  it('ignores touch/notifyLost/unregister for unknown ids', () => {
    const { pool } = makePool(1);
    expect(() => {
      pool.touch('ghost');
      pool.notifyLost('ghost');
      pool.unregister('ghost');
    }).not.toThrow();
  });
});
