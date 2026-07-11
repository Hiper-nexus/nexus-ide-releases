import { describe, expect, it } from 'vitest';
import { framesToResume, shouldFullSnapshot } from './remote-reconnect';

describe('remote-reconnect', () => {
  it('resumes contiguous frames after client last seq', () => {
    const buf = new Map<number, Uint8Array>([
      [1, new Uint8Array([1])],
      [2, new Uint8Array([2])],
      [3, new Uint8Array([3])],
      [5, new Uint8Array([5])],
    ]);
    const frames = framesToResume(buf, 1);
    expect(frames).toHaveLength(2);
    expect(frames[0]![0]).toBe(2);
    expect(frames[1]![0]).toBe(3);
  });

  it('requests full snapshot when client is behind buffer', () => {
    expect(shouldFullSnapshot(0, 10)).toBe(true);
    expect(shouldFullSnapshot(9, 10)).toBe(false);
  });
});
