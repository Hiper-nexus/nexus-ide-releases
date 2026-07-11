/**
 * Acoustic wake calibration for the Fifine path.
 *
 * Live samples showed a fast, continuous "Hey Jarvis" peaking at 0.4464 and
 * 0.4556, while the known non-wake ceiling was 0.3933. Keep a deliberate
 * margin above that ceiling so a compact wake is accepted without reopening
 * the false-positive window that the old 0.48 cut avoided.
 */
// 0.42 calibrado EN Fifine. Logs reais PT-BR MacBook Air (2026-07-11):
//   fala "Jarvis": peakScore 0.05–0.08, peakRms 0.3–0.8
//   ruído/ambiente: peakScore ≤ 0.01, peakRms ~0.05–0.15
// 0.22 ainda era alto demais — o EN head quase nunca dispara em PT.
// 0.045 + piso de RMS (abaixo) deixa o acústico como voto secundário;
// o path principal continua VAD→STT→matchWakeWord (Overclock).
export const WAKE_SCORE_THRESHOLD = 0.045;

/** Energia mínima para aceitar o head EN embutido (corta FPs de silêncio). */
export const EMBEDDED_WAKE_MIN_RMS = 0.12;

/**
 * PT-BR head ("Ei Jarvis") — threshold conservador. O treino sintético local
 * (2026-07) satura score≈1 em silêncio; por isso o gate também exige RMS
 * mínimo e (no engine) pode desativar o head se o probe de ruído falhar.
 */
export const CUSTOM_WAKE_SCORE_THRESHOLD = 0.65;

/**
 * Piso de energia acústica cru para aceitar o head PT. Logs reais: FPs com
 * peakRms 0.007–0.04; fala "Ei Jarvis" tipicamente ≥0.15. 0.09 corta silêncio
 * e eco fraco sem matar o wake falado perto do mic.
 */
export const CUSTOM_WAKE_MIN_RMS = 0.09;

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

export interface ResolveWakeDetectionOptions {
  /** Peak RMS da janela atual (0..1). Obrigatório para aceitar o head PT. */
  peakRms?: number;
  /**
   * Quando o head PT está carregado, o EN embutido não dispara sozinho
   * (produto PT-BR: "Ei Jarvis", não "Hey Jarvis").
   * `custom` no scores deve ser `number` (mesmo 0) para sinalizar "PT ativo".
   */
  preferCustom?: boolean;
}

export function shouldDetectWakeScore(score: number): boolean {
  return Number.isFinite(score) && score >= WAKE_SCORE_THRESHOLD;
}

export function resolveWakeDetection(
  scores: {
    embedded: number;
    custom?: number;
    official?: number;
  },
  opts: ResolveWakeDetectionOptions = {},
): WakeDetection | null {
  // Sem peakRms explícito, não bloqueamos por energia (testes / paths legados).
  const peakRms = opts.peakRms;
  const customLoaded = scores.custom !== undefined;
  const energyOk =
    peakRms === undefined ||
    (Number.isFinite(peakRms) && peakRms >= CUSTOM_WAKE_MIN_RMS);
  const customOk =
    customLoaded &&
    Number.isFinite(scores.custom) &&
    (scores.custom as number) >= CUSTOM_WAKE_SCORE_THRESHOLD &&
    energyOk;

  const candidates: WakeDetection[] = [];

  if (customOk) {
    candidates.push({
      source: 'custom',
      score: scores.custom as number,
      threshold: CUSTOM_WAKE_SCORE_THRESHOLD,
    });
  }

  // PT preferido + head carregado → EN não é caminho de wake.
  const allowEmbedded = !(opts.preferCustom && customLoaded);
  const embeddedEnergyOk =
    peakRms === undefined ||
    (Number.isFinite(peakRms) && peakRms >= EMBEDDED_WAKE_MIN_RMS);
  if (allowEmbedded && embeddedEnergyOk) {
    candidates.push({
      source: 'embedded',
      score: scores.embedded,
      threshold: WAKE_SCORE_THRESHOLD,
    });
  }

  candidates.push({
    source: 'official',
    score: scores.official ?? Number.NEGATIVE_INFINITY,
    threshold: OFFICIAL_WAKE_SCORE_THRESHOLD,
  });

  const accepted = candidates.filter(
    (candidate) =>
      Number.isFinite(candidate.score) && candidate.score >= candidate.threshold,
  );

  return accepted.reduce<WakeDetection | null>(
    (best, candidate) => (!best || candidate.score > best.score ? candidate : best),
    null,
  );
}

export function shouldDetectWakeScores(
  scores: {
    embedded: number;
    custom?: number;
    official?: number;
  },
  opts?: ResolveWakeDetectionOptions,
): boolean {
  return resolveWakeDetection(scores, opts) !== null;
}
