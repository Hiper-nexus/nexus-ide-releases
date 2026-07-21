export interface PassiveWakeAdmissionSample {
  rawSpeechMs: number;
  rawMaxRms: number;
  /**
   * Clip fechado por estouro da janela (fala/áudio contínuo), não por
   * silêncio. Uma sequência longa desses clips é assinatura de TV/ambiente:
   * fala humana dirigida ao assistente tem pausas naturais e fecha por
   * silêncio.
   */
  forcedByMax?: boolean;
}

export type PassiveWakeAdmissionRejection =
  | 'backoff'
  | 'weak-speech'
  | 'low-peak'
  | 'continuous-ambient';

export interface PassiveWakeAdmissionVerdict {
  admit: boolean;
  reason?: PassiveWakeAdmissionRejection;
  backoffRemainingMs?: number;
}

const MIN_PASSIVE_SPEECH_MS = 320;
const MIN_PASSIVE_PEAK_RMS = 0.035;
// Escada longa: evidência de log (.nexus/logs/voice.log) mostra TV sustentada
// por horas; com teto de 10 s o custo estabilizava em 1 STT pago a cada 10 s
// para sempre. O detector acústico segue ativo em paralelo (wakes reais
// pontuam 0.2–0.64 vs 0.002–0.011 da TV, threshold 0.012), então o trilho
// textual pode ficar surdo por até 60 s sem perder "Jarvis" real.
const REJECT_BACKOFF_MS = [3_000, 6_000, 10_000, 20_000, 40_000, 60_000] as const;
// Precisa exceder o teto do backoff, senão o streak nunca escala além dele.
const STREAK_RESET_AFTER_MS = 150_000;
// 3+ clips consecutivos fechados por max = ~5,4 s de áudio ininterrupto:
// assinatura de ambiente contínuo, não de tentativa de wake.
const CONTINUOUS_AMBIENT_MIN_STREAK = 3;

/**
 * Local admission gate before paid/cloud STT. The acoustic wake detector keeps
 * running in parallel, so throttling repeated ambient phrases does not disable
 * Hey Jarvis. A bounded adaptive backoff plus a continuous-ambient signature
 * cuts TV/noise STT traffic to ~zero during sustained noise without creating
 * a permanent deaf period for the textual fallback.
 */
export class PassiveWakeAdmission {
  private backoffUntil = 0;
  private rejectStreak = 0;
  private lastRejectAt = 0;
  private continuousStreak = 0;

  admit(sample: PassiveWakeAdmissionSample, now: number): PassiveWakeAdmissionVerdict {
    this.continuousStreak = sample.forcedByMax ? this.continuousStreak + 1 : 0;
    if (now < this.backoffUntil) {
      return {
        admit: false,
        reason: 'backoff',
        backoffRemainingMs: this.backoffUntil - now,
      };
    }
    if (sample.rawSpeechMs < MIN_PASSIVE_SPEECH_MS) {
      return { admit: false, reason: 'weak-speech' };
    }
    if (sample.rawMaxRms < MIN_PASSIVE_PEAK_RMS) {
      return { admit: false, reason: 'low-peak' };
    }
    if (this.continuousStreak >= CONTINUOUS_AMBIENT_MIN_STREAK) {
      // Realimenta o backoff: durante TV sustentada o estado estacionário é
      // uma decisão local por minuto e nenhuma chamada de STT.
      this.reject(now);
      return {
        admit: false,
        reason: 'continuous-ambient',
        backoffRemainingMs: this.backoffUntil - now,
      };
    }
    return { admit: true };
  }

  reject(now: number): void {
    if (this.lastRejectAt === 0 || now - this.lastRejectAt > STREAK_RESET_AFTER_MS) {
      this.rejectStreak = 0;
    }
    this.rejectStreak = Math.min(this.rejectStreak + 1, REJECT_BACKOFF_MS.length);
    this.lastRejectAt = now;
    const delay = REJECT_BACKOFF_MS[this.rejectStreak - 1] ?? REJECT_BACKOFF_MS.at(-1)!;
    this.backoffUntil = Math.max(this.backoffUntil, now + delay);
  }

  accept(): void {
    this.reset();
  }

  reset(): void {
    this.backoffUntil = 0;
    this.rejectStreak = 0;
    this.lastRejectAt = 0;
    this.continuousStreak = 0;
  }
}
