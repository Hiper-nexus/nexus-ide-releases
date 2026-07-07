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
  });

  it('blocks capture within the interval', () => {
    limiter.markCaptured();
    expect(limiter.canCapture()).toBe(false);
  });

  it('allows capture after the interval', () => {
    limiter.markCaptured();
    vi.advanceTimersByTime(3_000);
    expect(limiter.canCapture()).toBe(true);
  });

  it('reports correct wait time', () => {
    limiter.markCaptured();
    vi.advanceTimersByTime(1_500);
    expect(limiter.nextAvailableIn()).toBe(1_500);
    expect(limiter.canCapture()).toBe(false);
  });

  it('nextAvailableIn returns 0 when ready', () => {
    limiter.markCaptured();
    vi.advanceTimersByTime(5_000);
    expect(limiter.nextAvailableIn()).toBe(0);
  });

  it('lastCapturedAt returns timestamp', () => {
    const now = Date.now();
    limiter.markCaptured();
    expect(limiter.lastCapturedAt()).toBe(now);
  });

  it('custom interval works', () => {
    const fast = new RateLimiter(1_000);
    fast.markCaptured();
    expect(fast.canCapture()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(fast.canCapture()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(fast.canCapture()).toBe(true);
  });
});