import { describe, expect, it } from 'vitest';
import {
  CUSTOM_WAKE_MIN_RMS,
  CUSTOM_WAKE_SCORE_THRESHOLD,
  EMBEDDED_WAKE_MIN_RMS,
  OFFICIAL_WAKE_SCORE_THRESHOLD,
  resolveWakeDetection,
  shouldDetectWakeScore,
  shouldDetectWakeScores,
  WAKE_SCORE_THRESHOLD,
} from './wake-score-gate';

describe('wake score gate', () => {
  it('accepts compact wake scores and PT-accent mid scores', () => {
    expect(shouldDetectWakeScore(0.4556)).toBe(true);
    expect(shouldDetectWakeScore(0.08)).toBe(true);
    expect(shouldDetectWakeScore(WAKE_SCORE_THRESHOLD)).toBe(true);
  });

  it('rejects ambient-floor scores below the PT-calibrated cut', () => {
    expect(shouldDetectWakeScore(0.01)).toBe(false);
    expect(shouldDetectWakeScore(0.03)).toBe(false);
  });

  it('rejects invalid scores', () => {
    expect(shouldDetectWakeScore(Number.NaN)).toBe(false);
    expect(shouldDetectWakeScore(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('keeps the embedded model active while allowing a validated PT-BR candidate to help', () => {
    expect(shouldDetectWakeScores({ embedded: 0.43, custom: 0.01 })).toBe(true);
    expect(
      shouldDetectWakeScores({
        embedded: 0.02,
        custom: CUSTOM_WAKE_SCORE_THRESHOLD + 0.01,
      }),
    ).toBe(true);
    expect(
      shouldDetectWakeScores({
        embedded: 0.02,
        custom: CUSTOM_WAKE_SCORE_THRESHOLD - 0.01,
      }),
    ).toBe(false);
  });

  it('rejects PT head when acoustic energy is below the FP floor', () => {
    expect(
      resolveWakeDetection(
        {
          embedded: 0.1,
          custom: 1,
        },
        { peakRms: CUSTOM_WAKE_MIN_RMS - 0.01, preferCustom: true },
      ),
    ).toBeNull();
    expect(
      resolveWakeDetection(
        {
          embedded: 0.1,
          custom: 1,
        },
        { peakRms: CUSTOM_WAKE_MIN_RMS + 0.02, preferCustom: true },
      ),
    ).toEqual({
      source: 'custom',
      score: 1,
      threshold: CUSTOM_WAKE_SCORE_THRESHOLD,
    });
  });

  it('rejects embedded wake when RMS is below the speech floor', () => {
    expect(
      resolveWakeDetection(
        { embedded: 0.2 },
        { peakRms: EMBEDDED_WAKE_MIN_RMS - 0.01 },
      ),
    ).toBeNull();
    expect(
      resolveWakeDetection(
        { embedded: 0.2 },
        { peakRms: EMBEDDED_WAKE_MIN_RMS + 0.01 },
      ),
    ).toEqual({
      source: 'embedded',
      score: 0.2,
      threshold: WAKE_SCORE_THRESHOLD,
    });
  });

  it('with preferCustom + PT loaded, does not fire on EN alone', () => {
    expect(
      resolveWakeDetection(
        { embedded: 0.99, custom: 0.1 },
        { preferCustom: true, peakRms: 0.5 },
      ),
    ).toBeNull();
  });

  it('allows the verified open-source Hey Jarvis head to improve recall without replacing base', () => {
    expect(
      shouldDetectWakeScores({
        embedded: 0.02,
        official: OFFICIAL_WAKE_SCORE_THRESHOLD + 0.01,
      }),
    ).toBe(true);
    expect(
      shouldDetectWakeScores({
        embedded: 0.02,
        official: OFFICIAL_WAKE_SCORE_THRESHOLD - 0.01,
      }),
    ).toBe(false);
  });

  it('attributes a wake to the candidate that actually crossed its own threshold', () => {
    expect(
      resolveWakeDetection({
        embedded: WAKE_SCORE_THRESHOLD + 0.01,
        official: OFFICIAL_WAKE_SCORE_THRESHOLD - 0.001,
      }),
    ).toEqual({
      source: 'embedded',
      score: WAKE_SCORE_THRESHOLD + 0.01,
      threshold: WAKE_SCORE_THRESHOLD,
    });
  });
});
