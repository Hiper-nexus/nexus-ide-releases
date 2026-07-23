import { describe, expect, it } from 'vitest';
import {
  framesToResume,
  resolveTerminalResume,
  shouldFullSnapshot,
} from './remote-reconnect';

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

  it('never presents a partial replay as lossless when the buffer has a gap', () => {
    const buffered = new Map<number, Uint8Array>([
      [2, new Uint8Array([2])],
      [4, new Uint8Array([4])],
    ]);
    expect(resolveTerminalResume(buffered, 1, 4)).toEqual({
      snapshotRequired: true,
      frames: [],
      oldestAvailableSeq: 2,
      latestSeq: 4,
    });
  });
});
