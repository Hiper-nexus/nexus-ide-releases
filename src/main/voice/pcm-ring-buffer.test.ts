import { describe, expect, it } from 'vitest';
import { PcmRingBuffer } from './pcm-ring-buffer';

describe('PcmRingBuffer', () => {
  it('preserves FIFO order across the physical wrap boundary', () => {
    const queue = new PcmRingBuffer(6);
    queue.push(new Float32Array([1, 2, 3, 4]));
    expect([...queue.shift(3)!]).toEqual([1, 2, 3]);
    queue.push(new Float32Array([5, 6, 7, 8]));

    expect([...queue.shift(5)!]).toEqual([4, 5, 6, 7, 8]);
    expect(queue.length).toBe(0);
  });

  it('drops the oldest samples when producers outrun inference', () => {
    const queue = new PcmRingBuffer(4);
    queue.push(new Float32Array([1, 2, 3]));

    expect(queue.push(new Float32Array([4, 5, 6]))).toBe(2);
    expect([...queue.shift(4)!]).toEqual([3, 4, 5, 6]);
  });

  it('keeps only the newest capacity when one frame is oversized', () => {
    const queue = new PcmRingBuffer(3);
    queue.push(new Float32Array([1, 2]));

    expect(queue.push(new Float32Array([3, 4, 5, 6]))).toBe(3);
    expect([...queue.shift(3)!]).toEqual([4, 5, 6]);
  });
});
