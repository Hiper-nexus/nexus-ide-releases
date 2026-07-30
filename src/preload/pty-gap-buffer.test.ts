import { describe, expect, it } from 'vitest';
import {
  PTY_GAP_NOTICE,
  PTY_PENDING_MAX_CHARS,
  PTY_PENDING_MAX_CHUNKS,
  PtyGapBuffer,
} from './pty-gap-buffer';

describe('PtyGapBuffer', () => {
  it('delivers contiguous chunks immediately and in order', () => {
    const buf = new PtyGapBuffer();
    expect(buf.push(1, 'a').chunks).toEqual([{ sequence: 1, data: 'a' }]);
    expect(buf.push(2, 'b').chunks).toEqual([{ sequence: 2, data: 'b' }]);
    expect(buf.highWater).toBe(2);
  });

  it('buffers reordered chunks and flushes when the gap fills', () => {
    const buf = new PtyGapBuffer();
    expect(buf.push(2, 'b').chunks).toEqual([]);
    expect(buf.push(3, 'c').chunks).toEqual([]);
    const r = buf.push(1, 'a');
    expect(r.gapHealed).toBe(false);
    expect(r.chunks).toEqual([
      { sequence: 1, data: 'a' },
      { sequence: 2, data: 'b' },
      { sequence: 3, data: 'c' },
    ]);
    expect(buf.highWater).toBe(3);
    expect(buf.pendingCount).toBe(0);
  });

  it('drops duplicates at or below the high-water mark', () => {
    const buf = new PtyGapBuffer();
    buf.push(1, 'a');
    expect(buf.push(1, 'dup').chunks).toEqual([]);
    expect(buf.push(2, 'b').chunks).toEqual([{ sequence: 2, data: 'b' }]);
  });

  it('heals when a recover response starts past the expected sequence', () => {
    const buf = new PtyGapBuffer();
    buf.push(1, 'a');
    // Hole at 2: chunk 3 is buffered, recover can only offer 5+ (2..4 evicted).
    expect(buf.push(3, 'c').chunks).toEqual([]);
    const flushed = buf.acceptHole(5);
    expect(flushed).toEqual([]); // 3 still sits behind the (smaller) hole at 4
    expect(buf.highWater).toBe(4);
    // The recover events now deliver contiguously from 5.
    expect(buf.push(5, 'e').chunks).toEqual([{ sequence: 5, data: 'e' }]);
    expect(buf.highWater).toBe(5);
  });

  it('acceptHole flushes buffered successors of the resume sequence', () => {
    const buf = new PtyGapBuffer();
    buf.push(1, 'a');
    buf.push(5, 'e');
    buf.push(6, 'f');
    const flushed = buf.acceptHole(5);
    expect(flushed).toEqual([
      { sequence: 5, data: 'e' },
      { sequence: 6, data: 'f' },
    ]);
    expect(buf.highWater).toBe(6);
    expect(buf.pendingCount).toBe(0);
  });

  it('acceptHole is a no-op when the resume sequence is already reachable', () => {
    const buf = new PtyGapBuffer();
    buf.push(1, 'a');
    buf.push(3, 'c');
    expect(buf.acceptHole(2)).toEqual([]);
    expect(buf.highWater).toBe(1);
    expect(buf.pendingCount).toBe(1);
  });

  it('cap overflow accepts the hole, jumps to the oldest chunk and stops growing', () => {
    const buf = new PtyGapBuffer();
    buf.push(1, 'a');
    const big = 'x'.repeat(PTY_PENDING_MAX_CHARS);
    // First out-of-order chunk fills the budget exactly; the second exceeds it.
    expect(buf.push(3, big).gapHealed).toBe(false);
    const r = buf.push(4, 'd');
    expect(r.gapHealed).toBe(true);
    expect(r.chunks).toEqual([
      { sequence: 3, data: big },
      { sequence: 4, data: 'd' },
    ]);
    expect(buf.highWater).toBe(4);
    expect(buf.pendingCount).toBe(0);
    // Delivery continues normally after the heal — no permanent wedge.
    expect(buf.push(5, 'e').chunks).toEqual([{ sequence: 5, data: 'e' }]);
  });

  it('chunk-count cap heals even when bytes stay small', () => {
    const buf = new PtyGapBuffer();
    buf.push(1, 'a');
    let healed: boolean | null = null;
    for (let i = 0; i < PTY_PENDING_MAX_CHUNKS + 1; i += 1) {
      const r = buf.push(3 + i, 'x');
      if (r.gapHealed) {
        healed = true;
        expect(r.chunks.length).toBe(PTY_PENDING_MAX_CHUNKS + 1);
        expect(r.chunks[0].sequence).toBe(3);
        break;
      }
    }
    expect(healed).toBe(true);
    expect(buf.pendingCount).toBe(0);
  });

  it('hole acceptance keeps later holes buffered within budget', () => {
    const buf = new PtyGapBuffer();
    buf.push(1, 'a');
    buf.push(PTY_PENDING_MAX_CHUNKS + 10, 'z');
    // Force cap overflow: oldest pending is far ahead; after the jump the
    // buffer is empty and ready for the next gap.
    const r = buf.push(PTY_PENDING_MAX_CHUNKS + 11, 'y');
    expect(r.gapHealed).toBe(false); // 2 chunks, under both caps
    // Overflow via count instead.
    for (let i = 0; i < PTY_PENDING_MAX_CHUNKS; i += 1) {
      buf.push(PTY_PENDING_MAX_CHUNKS + 12 + i, 'q');
    }
    expect(buf.pendingCount).toBeLessThanOrEqual(PTY_PENDING_MAX_CHUNKS + 1);
  });

  it('notice text matches the terminal warning pattern (CAN + reset + one line)', () => {
    expect(PTY_GAP_NOTICE.startsWith('\x18\x1b[0m\r\n')).toBe(true);
    expect(PTY_GAP_NOTICE.endsWith('\r\n')).toBe(true);
  });
});
