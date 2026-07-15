import { describe, expect, it } from 'vitest';
import {
  createDraftHydrationBarrier,
  hasAuthoredList,
  hasAuthoredText,
} from './ui-overlay-policy';

describe('createDraftHydrationBarrier', () => {
  it('skips exactly one persist after markHydrating', () => {
    const barrier = createDraftHydrationBarrier();
    barrier.markHydrating();
    expect(barrier.shouldSkipPersist()).toBe(true);
    expect(barrier.shouldSkipPersist()).toBe(false);
  });

  it('does not skip when never marked', () => {
    const barrier = createDraftHydrationBarrier();
    expect(barrier.shouldSkipPersist()).toBe(false);
  });

  it('clears pending via microtask if persist never consumes it', async () => {
    const barrier = createDraftHydrationBarrier();
    barrier.markHydrating();
    await Promise.resolve(); // flush queueMicrotask
    expect(barrier.shouldSkipPersist()).toBe(false);
  });
});

describe('authorship helpers', () => {
  it('detects authored text and lists', () => {
    expect(hasAuthoredText('', '  ', null)).toBe(false);
    expect(hasAuthoredText('  objetivo  ')).toBe(true);
    expect(hasAuthoredList([])).toBe(false);
    expect(hasAuthoredList([{ id: '1' }])).toBe(true);
  });
});
