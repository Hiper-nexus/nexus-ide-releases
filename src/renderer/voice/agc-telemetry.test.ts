import { describe, expect, it } from 'vitest';
import { measureAgcFrame } from './agc-telemetry';

describe('measureAgcFrame', () => {
  it('measures raw and processed RMS plus the effective gain', () => {
    const telemetry = measureAgcFrame(
      new Float32Array([0.1, -0.1, 0.1, -0.1]),
      new Float32Array([0.2, -0.2, 0.2, -0.2]),
    );

    expect(telemetry.rawRms).toBeCloseTo(0.1, 8);
    expect(telemetry.processedRms).toBeCloseTo(0.2, 8);
    expect(telemetry.appliedGain).toBeCloseTo(2, 8);
    expect(telemetry.clippedSampleRatio).toBe(0);
  });

  it('reports clipping and the effective output gain after clamping', () => {
    const telemetry = measureAgcFrame(
      new Float32Array([0.75, -0.25]),
      new Float32Array([1, -0.5]),
    );

    expect(telemetry.rawRms).toBeCloseTo(Math.sqrt(0.3125), 8);
    expect(telemetry.processedRms).toBeCloseTo(Math.sqrt(0.625), 8);
    expect(telemetry.appliedGain).toBeCloseTo(Math.sqrt(2), 8);
    expect(telemetry.clippedSampleRatio).toBe(0.5);
  });

  it('keeps a silent frame finite', () => {
    expect(measureAgcFrame(new Float32Array(4), new Float32Array(4))).toEqual({
      rawRms: 0,
      processedRms: 0,
      appliedGain: 0,
      clippedSampleRatio: 0,
    });
  });

  it('rejects unequal frame lengths', () => {
    expect(() => measureAgcFrame(new Float32Array(2), new Float32Array(3))).toThrow(
      RangeError,
    );
  });
});
