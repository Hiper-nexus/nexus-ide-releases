/**
 * Acoustic wake calibration for the Fifine path.
 *
 * Live samples showed a fast, continuous "Hey Jarvis" peaking at 0.4464 and
 * 0.4556, while the known non-wake ceiling was 0.3933. Keep a deliberate
 * margin above that ceiling so a compact wake is accepted without reopening
 * the false-positive window that the old 0.48 cut avoided.
 */
export const WAKE_SCORE_THRESHOLD = 0.42;

/**
 * A synthetic PT-BR candidate joins the embedded model as a second detector,
 * never as a replacement. Keep its initial cut conservative until the offline
 * evaluation harness has a user-specific ROC curve.
 */
export const CUSTOM_WAKE_SCORE_THRESHOLD = 0.65;

/**
 * Threshold published with the verified Apache-2.0 SpeechKit `hey_jarvis`
 * OpenWakeWord head. It is intentionally independent from our lower embedded
 * threshold: this model is an extra vote, never a replacement for base.
 */
export const OFFICIAL_WAKE_SCORE_THRESHOLD = 0.45;

export type WakeScoreSource = 'embedded' | 'custom' | 'official';

export interface WakeDetection {
  source: WakeScoreSource;
  score: number;
  threshold: number;
}

export function shouldDetectWakeScore(score: number): boolean {
  return Number.isFinite(score) && score >= WAKE_SCORE_THRESHOLD;
}

export function resolveWakeDetection(scores: {
  embedded: number;
  custom?: number;
  official?: number;
}): WakeDetection | null {
  const allCandidates: WakeDetection[] = [
    {
      source: 'embedded',
      score: scores.embedded,
      threshold: WAKE_SCORE_THRESHOLD,
    },
    {
      source: 'custom',
      score: scores.custom ?? Number.NEGATIVE_INFINITY,
      threshold: CUSTOM_WAKE_SCORE_THRESHOLD,
    },
    {
      source: 'official',
      score: scores.official ?? Number.NEGATIVE_INFINITY,
      threshold: OFFICIAL_WAKE_SCORE_THRESHOLD,
    },
  ];
  const candidates = allCandidates.filter((candidate) =>
    Number.isFinite(candidate.score) && candidate.score >= candidate.threshold,
  );

  return candidates.reduce<WakeDetection | null>(
    (best, candidate) => (!best || candidate.score > best.score ? candidate : best),
    null,
  );
}

export function shouldDetectWakeScores(scores: {
  embedded: number;
  custom?: number;
  official?: number;
}): boolean {
  return resolveWakeDetection(scores) !== null;
}
