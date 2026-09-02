import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WarmPool, type WarmSession } from './warm-pool';

describe('WarmPool', () => {
  let pool: WarmPool;
  let spawnedSessions: WarmSession[];
  let destroyedSessions: string[];

  beforeEach(() => {
    spawnedSessions = [];
    destroyedSessions = [];
    pool = new WarmPool({
      spawnFn: async (cli) => {
        const session: WarmSession = {
          sessionId: `warm-${cli}-${spawnedSessions.length + 1}`,
          startKey: `sk-warm-${spawnedSessions.length + 1}`,
          cli,
          bornAtMs: Date.now(),
          cwd: '/mock/cwd',
        };
        spawnedSessions.push(session);
        return session;
      },
      destroyFn: (sessionId) => {
        destroyedSessions.push(sessionId);
      },
    });
  });

  it('pool size 0 = zero spawn extra and take is always a miss', () => {
    pool.setWarmPoolSize(0);
    const session = pool.take('claude');
    expect(session).toBeNull();
    expect(spawnedSessions).toHaveLength(0);

    const metrics = pool.getMetrics();
    expect(metrics.hits).toBe(0);
    expect(metrics.misses).toBe(1);
    expect(metrics.readyCount).toBe(0);
  });

  it('take with empty pool registers a miss and does not block', () => {
    pool.setWarmPoolSize(2);
    // Queue is empty initially
    const session = pool.take('claude');
    expect(session).toBeNull();

    const metrics = pool.getMetrics();
    expect(metrics.hits).toBe(0);
    expect(metrics.misses).toBe(1);
  });

  it('take hit returns available warm session without a new spawn', () => {
    pool.setWarmPoolSize(2);
    const warm1: WarmSession = {
      sessionId: 'warm-claude-pre',
      startKey: 'sk-pre-1',
      cli: 'claude',
      bornAtMs: Date.now(),
      cwd: '/mock/cwd',
    };
    pool.put(warm1);

    expect(pool.getMetrics().readyCount).toBe(1);

    // Take should hit
    const taken = pool.take('claude');
    expect(taken).toEqual(warm1);

    const metrics = pool.getMetrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(0);
    expect(metrics.readyCount).toBe(0);
  });

  it('evictStale discards expired sessions and does not return them', () => {
    pool.setWarmPoolSize(2);
    const now = 1_000_000;
    const stale: WarmSession = {
      sessionId: 'warm-stale-1',
      startKey: 'sk-stale-1',
      cli: 'claude',
      bornAtMs: now - 15 * 60_000, // 15 mins ago
      cwd: '/mock/cwd',
    };
    pool.put(stale);

    // Evict with current time = now
    const evicted = pool.evictStale(10 * 60_000, now);
    expect(evicted).toBe(1);
    expect(destroyedSessions).toEqual(['warm-stale-1']);

    // Take is now a miss
    const taken = pool.take('claude');
    expect(taken).toBeNull();
  });

  it('replenishment is delayed when CPU headroom is insufficient', async () => {
    pool.setWarmPoolSize(2);

    // Mock high load average (e.g. 4.0 on a 4-core machine -> 0% headroom)
    vi.spyOn(os, 'cpus').mockReturnValue([{} as any, {} as any, {} as any, {} as any]);
    vi.spyOn(os, 'loadavg').mockReturnValue([3.8, 3.5, 3.0]); // ~5% headroom, below 25%

    const replenished = await pool.replenish('claude');
    expect(replenished).toBe(false);

    const metrics = pool.getMetrics();
    expect(metrics.skippedByCpu).toBe(1);
    expect(metrics.readyCount).toBe(0);
    expect(spawnedSessions).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it('replenishment succeeds when CPU has sufficient headroom', async () => {
    pool.setWarmPoolSize(2);

    // Mock low load average (e.g. 0.5 on 4 cores -> 87.5% headroom)
    vi.spyOn(os, 'cpus').mockReturnValue([{} as any, {} as any, {} as any, {} as any]);
    vi.spyOn(os, 'loadavg').mockReturnValue([0.5, 0.5, 0.5]);

    const replenished = await pool.replenish('claude');
    expect(replenished).toBe(true);

    const metrics = pool.getMetrics();
    expect(metrics.skippedByCpu).toBe(0);
    expect(metrics.readyCount).toBe(1);
    expect(metrics.replenished).toBe(1);
    expect(spawnedSessions).toHaveLength(1);

    vi.restoreAllMocks();
  });
});
