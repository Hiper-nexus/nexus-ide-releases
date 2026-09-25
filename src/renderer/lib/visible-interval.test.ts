/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setVisibleInterval } from './visible-interval';

let hidden = false;

function setHidden(next: boolean): void {
  hidden = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setVisibleInterval', () => {
  it('ticks on the interval while the window is visible', () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 1_000);
    vi.advanceTimersByTime(3_000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops waking up while hidden and refreshes once on return', () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 1_000);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    setHidden(false);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not arm while born hidden', () => {
    hidden = true;
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 1_000);
    vi.advanceTimersByTime(5_000);
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it('cleans up the timer and the listener', () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 1_000);
    stop();
    setHidden(true);
    setHidden(false);
    vi.advanceTimersByTime(5_000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
