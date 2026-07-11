import { describe, expect, it, vi } from 'vitest';
import { waitForActionEvidence } from './action-evidence';

describe('waitForActionEvidence', () => {
  it('confirms only after the observable post-condition becomes true', async () => {
    vi.useFakeTimers();
    let screen = 'home';
    const result = waitForActionEvidence({
      read: () => screen,
      accepts: (value) => value === 'grid',
      timeoutMs: 500,
      pollMs: 25,
    });
    setTimeout(() => { screen = 'grid'; }, 75);
    await vi.advanceTimersByTimeAsync(75);
    await expect(result).resolves.toMatchObject({ status: 'committed', value: 'grid' });
    vi.useRealTimers();
  });

  it('returns uncertain rather than claiming success when state never changes', async () => {
    vi.useFakeTimers();
    const result = waitForActionEvidence({
      read: () => 'home',
      accepts: (value) => value === 'grid',
      timeoutMs: 100,
      pollMs: 20,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toMatchObject({ status: 'uncertain', value: 'home' });
    vi.useRealTimers();
  });

  it('stops on cancellation', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(waitForActionEvidence({
      read: () => false,
      accepts: Boolean,
      signal: abort.signal,
    })).resolves.toMatchObject({ status: 'cancelled' });
  });
});
