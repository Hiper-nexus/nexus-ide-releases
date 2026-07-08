import { describe, expect, it, vi } from 'vitest';
import { SCREEN_UPDATE_DEBOUNCE_MS, ScreenCoalescer } from './screen-coalescer';

function harness() {
  const flushed: string[] = [];
  const coalescer = new ScreenCoalescer({
    flush: (t) => flushed.push(t),
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  });
  return { coalescer, flushed };
}

describe('ScreenCoalescer', () => {
  it('flushes only the last state within the debounce window', async () => {
    vi.useFakeTimers();
    const { coalescer, flushed } = harness();
    coalescer.push('step 1');
    coalescer.push('step 2');
    coalescer.push('step 3 settled');
    expect(flushed).toEqual([]);
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS);
    expect(flushed).toEqual(['step 3 settled']);
    vi.useRealTimers();
  });

  it('drops a settled state identical to the last one sent (accent/case-insensitive)', async () => {
    vi.useFakeTimers();
    const { coalescer, flushed } = harness();
    coalescer.push('Missão aberta');
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS);
    expect(flushed).toEqual(['Missão aberta']);

    // second burst settling to the same normalized state → dropped.
    coalescer.push('missao aberta');
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS);
    expect(flushed).toEqual(['Missão aberta']);
    vi.useRealTimers();
  });

  it('flushes a genuinely new state after a prior one', async () => {
    vi.useFakeTimers();
    const { coalescer, flushed } = harness();
    coalescer.push('screen A');
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS);
    coalescer.push('screen B');
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS);
    expect(flushed).toEqual(['screen A', 'screen B']);
    vi.useRealTimers();
  });

  it('clear() drops a pending debounce so it never flushes', async () => {
    vi.useFakeTimers();
    const { coalescer, flushed } = harness();
    coalescer.push('stale');
    coalescer.clear();
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS * 2);
    expect(flushed).toEqual([]);
    vi.useRealTimers();
  });

  it('resetBaseline lets an identical state flush again on a fresh socket', async () => {
    vi.useFakeTimers();
    const { coalescer, flushed } = harness();
    coalescer.push('same');
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS);
    coalescer.resetBaseline();
    coalescer.push('same');
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS);
    expect(flushed).toEqual(['same', 'same']);
    vi.useRealTimers();
  });

  it('flushNow emits the pending state immediately', () => {
    const { coalescer, flushed } = harness();
    coalescer.push('now');
    coalescer.flushNow();
    expect(flushed).toEqual(['now']);
  });
});
