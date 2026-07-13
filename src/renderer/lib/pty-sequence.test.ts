import { describe, expect, it } from 'vitest';

/**
 * Mirrors preload contiguous delivery rules so reordering cannot permanently
 * drop gap chunks (review bug: high-water past a hole).
 */
function deliverContiguous(
  previous: number,
  pending: Map<number, string>,
  sequence: number,
  data: string,
): { previous: number; emitted: Array<{ sequence: number; data: string }> } {
  const emitted: Array<{ sequence: number; data: string }> = [];
  const expected = previous + 1;
  if (sequence <= previous) return { previous, emitted };
  if (sequence > expected) {
    pending.set(sequence, data);
    return { previous, emitted };
  }
  let nextPrev = sequence;
  emitted.push({ sequence, data });
  let n = sequence + 1;
  while (pending.has(n)) {
    emitted.push({ sequence: n, data: pending.get(n)! });
    pending.delete(n);
    nextPrev = n;
    n += 1;
  }
  return { previous: nextPrev, emitted };
}

describe('PTY contiguous sequence delivery', () => {
  it('buffers reordered chunks and emits when gap fills', () => {
    const pending = new Map<number, string>();
    let previous = 0;

    let r = deliverContiguous(previous, pending, 2, 'b');
    previous = r.previous;
    expect(r.emitted).toEqual([]);
    expect(pending.get(2)).toBe('b');

    r = deliverContiguous(previous, pending, 1, 'a');
    previous = r.previous;
    expect(r.emitted.map((e) => e.data)).toEqual(['a', 'b']);
    expect(previous).toBe(2);
    expect(pending.size).toBe(0);

    r = deliverContiguous(previous, pending, 3, 'c');
    expect(r.emitted.map((e) => e.data)).toEqual(['c']);
    expect(r.previous).toBe(3);
  });

  it('drops duplicates at or below high-water', () => {
    const pending = new Map<number, string>();
    const r = deliverContiguous(2, pending, 2, 'dup');
    expect(r.emitted).toEqual([]);
    expect(r.previous).toBe(2);
  });
});
