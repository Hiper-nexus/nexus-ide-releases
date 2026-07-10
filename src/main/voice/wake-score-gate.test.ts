import { describe, expect, it } from 'vitest';
import {
  CUSTOM_WAKE_SCORE_THRESHOLD,
  OFFICIAL_WAKE_SCORE_THRESHOLD,
  resolveWakeDetection,
  shouldDetectWakeScore,
  shouldDetectWakeScores,
  WAKE_SCORE_THRESHOLD,
} from './wake-score-gate';

describe('wake score gate', () => {
  it('accepts the observed compact wake scores that the old 0.48 cut missed', () => {
    expect(shouldDetectWakeScore(0.4556)).toBe(true);
    expect(shouldDetectWakeScore(0.4464)).toBe(true);
  });

  it('keeps the observed non-wake ceiling below the detection cut', () => {
    expect(0.3933).toBeLessThan(WAKE_SCORE_THRESHOLD);
    expect(shouldDetectWakeScore(0.3933)).toBe(false);
  });

  it('rejects invalid scores', () => {
    expect(shouldDetectWakeScore(Number.NaN)).toBe(false);
    expect(shouldDetectWakeScore(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('keeps the embedded model active while allowing a validated PT-BR candidate to help', () => {
    expect(shouldDetectWakeScores({ embedded: 0.43, custom: 0.01 })).toBe(true);
    expect(
      shouldDetectWakeScores({
        embedded: 0.2,
        custom: CUSTOM_WAKE_SCORE_THRESHOLD + 0.01,
      }),
    ).toBe(true);
    expect(
      shouldDetectWakeScores({
        embedded: 0.2,
        custom: CUSTOM_WAKE_SCORE_THRESHOLD - 0.01,
      }),
    ).toBe(false);
  });

  it('allows the verified open-source Hey Jarvis head to improve recall without replacing base', () => {
    expect(
      shouldDetectWakeScores({
        embedded: 0.2,
        official: OFFICIAL_WAKE_SCORE_THRESHOLD + 0.01,
      }),
    ).toBe(true);
    expect(
      shouldDetectWakeScores({
        embedded: 0.2,
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
