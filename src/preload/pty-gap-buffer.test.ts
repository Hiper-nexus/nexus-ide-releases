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

describe('PtyGapBuffer com faixas coalescidas (#17)', () => {
  it('entrega uma faixa contígua como um chunk que avança o high-water até o fim dela', () => {
    const buf = new PtyGapBuffer();
    expect(buf.push(1, 'a').chunks).toEqual([{ sequence: 1, data: 'a' }]);
    expect(buf.push(5, 'bcde', 2).chunks).toEqual([{ sequence: 5, data: 'bcde' }]);
    expect(buf.highWater).toBe(5);
    expect(buf.push(6, 'f').chunks).toEqual([{ sequence: 6, data: 'f' }]);
  });

  it('segura uma faixa atrás de um buraco e a solta quando o buraco fecha', () => {
    const buf = new PtyGapBuffer();
    expect(buf.push(6, 'cdef', 3).chunks).toEqual([]);
    expect(buf.pendingCount).toBe(1);
    expect(buf.push(7, 'g').chunks).toEqual([]);
    const healed = buf.push(2, 'ab', 1);
    expect(healed.chunks).toEqual([
      { sequence: 2, data: 'ab' },
      { sequence: 6, data: 'cdef' },
      { sequence: 7, data: 'g' },
    ]);
    expect(buf.highWater).toBe(7);
    expect(buf.pendingBytes).toBe(0);
  });

  it('faixa já entregue (inclusive pelo recover) é duplicata e some', () => {
    const buf = new PtyGapBuffer();
    for (let sequence = 1; sequence <= 5; sequence += 1) buf.push(sequence, String(sequence));
    expect(buf.push(4, 'xx', 3)).toEqual({ chunks: [], gapHealed: false });
    expect(buf.highWater).toBe(5);
  });

  it('faixa que sobrepõe o já entregue não é entregue inteira: o recover busca só o resto', () => {
    const buf = new PtyGapBuffer();
    for (let sequence = 1; sequence <= 3; sequence += 1) buf.push(sequence, String(sequence));
    // 2..5 traz 2 e 3 de novo: sem os tamanhos por chunk não dá para fatiar.
    const result = buf.push(5, 'DUP', 2);
    expect(result).toEqual({ chunks: [], gapHealed: false });
    expect(buf.highWater).toBe(3);
    expect(buf.pendingCount).toBe(0);
    // O recover devolve 4 e 5 individualmente e o fluxo segue.
    expect(buf.push(4, '4').chunks).toEqual([{ sequence: 4, data: '4' }]);
    expect(buf.push(5, '5').chunks).toEqual([{ sequence: 5, data: '5' }]);
  });

  it('buraco aceito descarta faixas pendentes inteiras abaixo do ponto de retomada', () => {
    const buf = new PtyGapBuffer();
    buf.push(9, 'old', 7);
    const chunks = buf.acceptHole(10);
    expect(chunks).toEqual([]);
    expect(buf.highWater).toBe(9);
    expect(buf.pendingCount).toBe(0);
  });
});
