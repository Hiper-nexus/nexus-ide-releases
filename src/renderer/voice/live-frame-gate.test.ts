import { describe, expect, it } from 'vitest';
import { LiveFrameGate } from './live-frame-gate';

function frame(value: number): Float32Array {
  return Float32Array.from([value, value]);
}

describe('LiveFrameGate', () => {
  it('does not send silence before local speech is detected', () => {
    const gate = new LiveFrameGate(6);

    expect(gate.offer(frame(1), false)).toEqual([]);
    expect(gate.offer(frame(2), false)).toEqual([]);
    expect(gate.isOpen()).toBe(false);
  });

  it('flushes a bounded pre-roll in order when speech begins', () => {
    const gate = new LiveFrameGate(4);

    gate.offer(frame(1), false);
    gate.offer(frame(2), false);
    gate.offer(frame(3), false);

    const sent = gate.offer(frame(4), true);

    expect(sent.map((chunk) => chunk[0])).toEqual([2, 3, 4]);
    expect(gate.isOpen()).toBe(true);
  });

  it('keeps forwarding the trailing silence after a real utterance begins', () => {
    const gate = new LiveFrameGate(4);

    gate.offer(frame(1), false);
    gate.offer(frame(2), true);

    expect(gate.offer(frame(3), false).map((chunk) => chunk[0])).toEqual([3]);
  });

  it('closes and clears buffered audio on reset', () => {
    const gate = new LiveFrameGate(4);

    gate.offer(frame(1), true);
    gate.reset();

    expect(gate.isOpen()).toBe(false);
    expect(gate.offer(frame(2), false)).toEqual([]);
  });
});
