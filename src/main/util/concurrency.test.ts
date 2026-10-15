import { describe, expect, it } from 'vitest';
import { forEachWithConcurrency } from './concurrency';

describe('forEachWithConcurrency', () => {
  it('visits every item once with at most `limit` tasks in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachWithConcurrency([...Array(50).keys()], 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(item);
      inFlight -= 1;
    });
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(50).keys()]);
  });

  it('handles an empty list', async () => {
    await expect(forEachWithConcurrency([], 8, async () => undefined)).resolves.toBeUndefined();
  });
});
