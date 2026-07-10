/**
 * Mapeia RMS de mic (16 kHz mono, floats normalizados) para um nível
 * perceptual [0,1] — o que alimenta o orb do Jarvis como visualizador REAL de
 * amplitude, em vez de só variar a velocidade da animação por fase.
 */

const NOISE_FLOOR = 0.006; // abaixo disso é silêncio/ruído de fundo
const CEIL = 0.25; // fala alta satura aqui

export function rmsToLevel(rms: number): number {
  if (!Number.isFinite(rms)) return 0;
  const linear = (rms - NOISE_FLOOR) / (CEIL - NOISE_FLOOR);
  const clamped = Math.max(0, Math.min(1, linear));
  // Raiz quadrada: dá presença à fala baixa sem estourar o topo.
  return Math.sqrt(clamped);
}

/**
 * The wake mic stays hot even while the voice UI is idle. Publishing its level
 * on every AudioWorklet frame made Zustand and the paint-heavy orb wake up
 * continuously for information that is only visible during active listening.
 */
export function shouldPublishVoiceLevel(
  status: string,
  nextLevel: number,
  currentLevel: number,
): boolean {
  if (status === 'listening') return true;
  return nextLevel <= 0 && currentLevel > 0;
}
