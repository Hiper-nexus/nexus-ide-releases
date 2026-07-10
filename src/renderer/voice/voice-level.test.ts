import { describe, expect, test } from 'vitest';
import { rmsToLevel, shouldPublishVoiceLevel } from './voice-level';

describe('rmsToLevel', () => {
  test('silence maps to 0', () => {
    expect(rmsToLevel(0)).toBe(0);
  });

  test('at or below the noise floor maps to 0', () => {
    expect(rmsToLevel(0.006)).toBe(0);
    expect(rmsToLevel(0.001)).toBe(0);
  });

  test('loud audio saturates at 1', () => {
    expect(rmsToLevel(0.25)).toBe(1);
    expect(rmsToLevel(5)).toBe(1);
  });

  test('is monotonic increasing across the speech range', () => {
    const a = rmsToLevel(0.02);
    const b = rmsToLevel(0.08);
    const c = rmsToLevel(0.18);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  test('always returns a finite value within [0, 1]', () => {
    for (const rms of [-1, 0, 0.01, 0.1, 1, Number.NaN]) {
      const level = rmsToLevel(rms);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  test('perceptual curve lifts quiet speech above the linear value', () => {
    // 25% into the [floor, ceil] range: sqrt(0.25) = 0.5 > 0.25 linear.
    const quarter = 0.006 + 0.25 * (0.25 - 0.006);
    expect(rmsToLevel(quarter)).toBeCloseTo(0.5, 1);
  });
});

describe('shouldPublishVoiceLevel', () => {
  test('does not churn UI state for the always-on wake mic while idle', () => {
    expect(shouldPublishVoiceLevel('idle', 0.42, 0)).toBe(false);
    expect(shouldPublishVoiceLevel('speaking', 0.75, 0)).toBe(false);
  });

  test('publishes live levels only while listening and settles a stale level to zero', () => {
    expect(shouldPublishVoiceLevel('listening', 0.42, 0)).toBe(true);
    expect(shouldPublishVoiceLevel('transcribing', 0, 0.42)).toBe(true);
    expect(shouldPublishVoiceLevel('idle', 0, 0)).toBe(false);
  });
});
