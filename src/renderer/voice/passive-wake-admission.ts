export interface PassiveWakeAdmissionSample {
  rawSpeechMs: number;
  rawMaxRms: number;
}

const MIN_PASSIVE_SPEECH_MS = 320;
const MIN_PASSIVE_PEAK_RMS = 0.035;
const REJECT_BACKOFF_MS = 3_000;

/**
 * Local admission gate before paid/cloud STT. The acoustic wake detector keeps
 * running in parallel, so throttling repeated ambient phrases does not disable
 * Hey Jarvis. A short bounded backoff halves TV/noise traffic without creating
 * a long deaf period for the textual fallback.
 */
export class PassiveWakeAdmission {
  private backoffUntil = 0;

  shouldTranscribe(sample: PassiveWakeAdmissionSample, now: number): boolean {
    return now >= this.backoffUntil &&
      sample.rawSpeechMs >= MIN_PASSIVE_SPEECH_MS &&
      sample.rawMaxRms >= MIN_PASSIVE_PEAK_RMS;
  }

  reject(now: number): void {
    this.backoffUntil = Math.max(this.backoffUntil, now + REJECT_BACKOFF_MS);
  }

  accept(): void {
    this.backoffUntil = 0;
  }

  reset(): void {
    this.backoffUntil = 0;
  }
}

