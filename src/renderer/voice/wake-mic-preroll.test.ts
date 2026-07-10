import { describe, expect, it, vi } from 'vitest';

import { WakeMic } from './wake-mic';

describe('WakeMic realtime pre-roll', () => {
  it('forwards seeded wake audio before subsequent live frames', () => {
    const mic = new WakeMic();
    const tap = vi.fn();
    const droppedWakePrefix = new Float32Array(4_000).fill(0.1);
    const firstTail = new Float32Array(4_000).fill(0.2);
    const secondTail = new Float32Array(4_000).fill(0.3);
    const commandOnset = new Float32Array(4_000).fill(0.4);
    (mic as unknown as { running: boolean }).running = true;
    mic.setUtteranceFrameTap(tap);

    mic.beginUtterance(undefined, 0, [
      droppedWakePrefix,
      firstTail,
      secondTail,
      commandOnset,
    ]);

    // Local WAV keeps the full seed; realtime receives only the final 750ms so
    // it preserves command onset without bursting 2.5s of wake/silence into VAD.
    expect(tap).toHaveBeenCalledTimes(3);
    expect(tap).toHaveBeenNthCalledWith(1, expect.any(Float32Array), 16_000);
    expect(tap.mock.calls[0][0]).toEqual(firstTail);
    expect(tap.mock.calls[1][0]).toEqual(secondTail);
    expect(tap.mock.calls[2][0]).toEqual(commandOnset);
    mic.cancelUtterance();
  });
});
