import { describe, expect, it } from 'vitest';
import { PIPE_ACTIVITY_MOTION_MS, isPipeRecentlyActive } from './pipe-motion';

describe('pipe edge motion', () => {
  it('animates only for a short window after a real delivery', () => {
    expect(isPipeRecentlyActive(undefined, 10_000)).toBe(false);
    expect(isPipeRecentlyActive(9_500, 10_000)).toBe(true);
    expect(
      isPipeRecentlyActive(10_000 - PIPE_ACTIVITY_MOTION_MS, 10_000),
    ).toBe(true);
    expect(
      isPipeRecentlyActive(10_000 - PIPE_ACTIVITY_MOTION_MS - 1, 10_000),
    ).toBe(false);
  });

  it('never animates for invalid or future timestamps', () => {
    expect(isPipeRecentlyActive(Number.NaN, 10_000)).toBe(false);
    expect(isPipeRecentlyActive(10_001, 10_000)).toBe(false);
  });
});
