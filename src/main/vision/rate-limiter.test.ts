import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3_000);
    vi.useFakeTimers();
  });

  it('allows first capture immediately', () => {
    expect(limiter.canCapture()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('blocks capture within the interval', () => {
    limiter.tryAcquire();
    expect(limiter.canCapture()).toBe(false);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('allows capture after the interval', () => {
    limiter.tryAcquire();
    vi.advanceTimersByTime(3_000);
    expect(limiter.canCapture()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('reports correct wait time', () => {
    limiter.tryAcquire();
    vi.advanceTimersByTime(1_500);
    expect(limiter.nextAvailableIn()).toBe(1_500);
    expect(limiter.canCapture()).toBe(false);
  });

  it('nextAvailableIn returns 0 when ready', () => {
    limiter.tryAcquire();
    vi.advanceTimersByTime(5_000);
    expect(limiter.nextAvailableIn()).toBe(0);
  });

  it('lastCapturedAt returns timestamp', () => {
    const now = Date.now();
    limiter.tryAcquire();
    expect(limiter.lastCapturedAt()).toBe(now);
  });

  it('custom interval works', () => {
    const fast = new RateLimiter(1_000);
    fast.tryAcquire();
    expect(fast.canCapture()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(fast.canCapture()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(fast.canCapture()).toBe(true);
  });

  it('respects the limit under a concurrent burst', async () => {
    const burstLimiter = new RateLimiter(3_000, 2);
    const capture = async (): Promise<boolean> => {
      if (!burstLimiter.tryAcquire()) return false;
      await Promise.resolve();
      return true;
    };

    const results = await Promise.all([
      capture(),
      capture(),
      capture(),
      capture(),
    ]);

    expect(results.filter(Boolean)).toHaveLength(2);
  });
});
