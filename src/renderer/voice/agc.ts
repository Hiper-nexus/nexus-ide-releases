/**
 * AGC próprio do pipeline de voz (PURO, testável no vitest).
 *
 * Por que existe: o APM do Chromium (autoGainControl) achatava o sinal do
 * fifine e corrompia as features do openWakeWord — foi desligado (897ce56).
 * Só que sem ELE o PCM cru chega fraco (fala ≈ −33dB RMS) e ganho FIXO não
 * acompanha distância/postura do usuário: perto satura, longe some.
 *
 * Este AGC é o meio-termo: mira a FALA em um RMS alvo com ganho suave,
 * e não adapta sobre ruído de fundo (senão amplificaria o silêncio até o
 * alvo). Subida lenta (não bombeia), descida rápida (não satura).
 */

/** RMS alvo para fala normalizada (≈ −20dB FS). */
export const AGC_TARGET_RMS = 0.1;
/** Ganho máximo: +27.6dB — acima disso é só chiado amplificado. */
export const AGC_MAX_GAIN = 24;
/** Ganho mínimo: nunca atenua abaixo do sinal cru. */
export const AGC_MIN_GAIN = 1;
/** Só adapta quando o frame parece FALA: RMS cru acima deste piso
 * (ambiente medido no fifine ≈ 0.0045; fala fraca ≈ 0.02). */
export const AGC_SPEECH_FLOOR = 0.01;
/** Subida por frame de 80ms (~0.5dB) — chega ao alvo em ~2s de fala. */
const AGC_UP_RATE = 1.06;
/** Descida por frame (~1.4dB) — reage rápido a saturação. */
const AGC_DOWN_RATE = 0.85;

export class SoftAgc {
  private gain: number;

  constructor(initialGain = 12) {
    this.gain = clampGain(initialGain);
  }

  currentGain(): number {
    return this.gain;
  }

  /**
   * Processa um frame IN-PLACE: adapta o ganho pela energia do frame cru e
   * aplica com clamp ±1. Retorna o RMS cru (útil para telemetria).
   */
  process(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    const rawRms = Math.sqrt(sum / (frame.length || 1));

    if (rawRms >= AGC_SPEECH_FLOOR) {
      const ideal = AGC_TARGET_RMS / rawRms;
      if (ideal < this.gain) {
        // Sinal forte demais para o ganho atual: desce rápido até o ideal.
        this.gain = Math.max(ideal, this.gain * AGC_DOWN_RATE, AGC_MIN_GAIN);
      } else {
        // Sinal fraco: sobe devagar, sem passar do ideal nem do teto.
        this.gain = Math.min(this.gain * AGC_UP_RATE, ideal, AGC_MAX_GAIN);
      }
    }

    for (let i = 0; i < frame.length; i += 1) {
      const amplified = frame[i] * this.gain;
      frame[i] = amplified > 1 ? 1 : amplified < -1 ? -1 : amplified;
    }
    return rawRms;
  }
}

function clampGain(g: number): number {
  return Math.min(Math.max(g, AGC_MIN_GAIN), AGC_MAX_GAIN);
}
