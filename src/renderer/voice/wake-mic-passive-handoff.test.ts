import { describe, expect, it } from 'vitest';

import { trimTrailingFrames } from './wake-mic';

describe('WakeMic passive wake handoff', () => {
  it('removes endpoint silence so the Live pre-roll still ends in speech', () => {
    const speech = new Float32Array(1_600).fill(0.1);
    const silence = new Float32Array(1_600);

    const handoff = trimTrailingFrames([speech, speech, silence, silence], 16_000, 200);

    expect(handoff).toHaveLength(2);
    expect(handoff.at(-1)).toEqual(speech);
  });

  it('preserves only the spoken portion when endpoint silence cuts a frame', () => {
    const speech = new Float32Array(1_600).fill(0.1);
    const tail = new Float32Array(1_600).fill(0.1);

    const handoff = trimTrailingFrames([speech, tail], 16_000, 25);

    expect(handoff).toHaveLength(2);
    expect(handoff[1]).toHaveLength(1_200);
  });
});
