import { describe, expect, it } from 'vitest';
import { downmixChannelsToMono, frameRms } from './voice-capture';

describe('downmixChannelsToMono', () => {
  it('usa só o canal com sinal quando o outro está mudo', () => {
    const left = new Float32Array([0, 0, 0]);
    const right = new Float32Array([0.2, 0.4, 0.6]);
    const mono = downmixChannelsToMono([left, right]);
    expect(frameRms(mono)).toBeGreaterThan(0.1);
    expect(mono[2]).toBeCloseTo(0.3, 5);
  });

  it('média quando ambos os canais têm sinal', () => {
    const left = new Float32Array([0.2, 0.4]);
    const right = new Float32Array([0.4, 0.6]);
    const mono = downmixChannelsToMono([left, right]);
    expect(mono[0]).toBeCloseTo(0.3, 5);
    expect(mono[1]).toBeCloseTo(0.5, 5);
  });
});
