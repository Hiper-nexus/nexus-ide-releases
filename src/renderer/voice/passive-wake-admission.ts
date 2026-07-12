export interface PassiveWakeAdmissionSample {
  rawSpeechMs: number;
  rawMaxRms: number;
}

const MIN_PASSIVE_SPEECH_MS = 320;
const MIN_PASSIVE_PEAK_RMS = 0.035;
const REJECT_BACKOFF_MS = [3_000, 6_000, 10_000] as const;
const STREAK_RESET_AFTER_MS = 30_000;

/**
 * Local admission gate before paid/cloud STT. The acoustic wake detector keeps
 * running in parallel, so throttling repeated ambient phrases does not disable
 * Hey Jarvis. A short bounded backoff halves TV/noise traffic without creating
 * a long deaf period for the textual fallback.
 */
export class PassiveWakeAdmission {
  private backoffUntil = 0;
  private rejectStreak = 0;
  private lastRejectAt = 0;

  shouldTranscribe(sample: PassiveWakeAdmissionSample, now: number): boolean {
    return now >= this.backoffUntil &&
      sample.rawSpeechMs >= MIN_PASSIVE_SPEECH_MS &&
      sample.rawMaxRms >= MIN_PASSIVE_PEAK_RMS;
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
  }
}
