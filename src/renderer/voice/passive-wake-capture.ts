/**
 * VAD-gated phrase capture for the text fallback wake path. It never decides
 * whether a phrase is a wake word, it only returns a small bounded sample for
 * STT after real speech has ended.
 */

export interface PassiveWakeCaptureOptions {
  rawSpeechRms: number;
  minSpeechMs: number;
  silenceMs: number;
  maxMs: number;
  cooldownMs: number;
}

export interface PassiveWakeSample {
  frames: Float32Array[];
  speechMs: number;
  durationMs: number;
  /** Audio after the last speech frame; useful to trim VAD endpoint silence. */
  trailingSilenceMs: number;
  maxRawRms: number;
}

export interface PassiveWakeFrame {
  frame: Float32Array;
  rawRms: number;
  now: number;
  sampleRate: number;
  preRoll: readonly Float32Array[];
}

const DEFAULT_OPTIONS: PassiveWakeCaptureOptions = {
  // Caller passa RMS pós-AGC; 0.01 ≈ fala fraca após SoftAgc.
  rawSpeechRms: 0.01,
  // "Ei … Jarvis" com pausa — silêncio curto cortava em "e ja" (logs reais).
  minSpeechMs: 180,
  silenceMs: 1_350,
  maxMs: 7_000,
  // Retry rápido quando o STT erra o nome.
  cooldownMs: 600,
};

export class PassiveWakeCapture {
  private readonly options: PassiveWakeCaptureOptions;
  private active = false;
  private frames: Float32Array[] = [];
  private startedAt = 0;
  private lastSpeechAt = 0;
  private speechMs = 0;
  private maxRawRms = 0;
  private cooldownUntil = 0;

  constructor(options: Partial<PassiveWakeCaptureOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  isActive(): boolean {
    return this.active;
  }

  cancel(): void {
    this.active = false;
    this.frames = [];
    this.speechMs = 0;
    this.maxRawRms = 0;
  }

  offer(input: PassiveWakeFrame): PassiveWakeSample | null {
    if (input.now < this.cooldownUntil) return null;
    const frameMs = (input.frame.length / Math.max(1, input.sampleRate)) * 1_000;
    const isSpeech = input.rawRms >= this.options.rawSpeechRms;

    if (!this.active) {
      if (!isSpeech) return null;
      this.active = true;
      this.frames = input.preRoll.map((frame) => Float32Array.from(frame));
      this.startedAt = input.now;
      this.lastSpeechAt = input.now;
      this.speechMs = frameMs;
      this.maxRawRms = input.rawRms;
      this.frames.push(Float32Array.from(input.frame));
      return null;
    }

    this.frames.push(Float32Array.from(input.frame));
    this.maxRawRms = Math.max(this.maxRawRms, input.rawRms);
    if (isSpeech) {
      this.speechMs += frameMs;
      this.lastSpeechAt = input.now;
    }

    const durationMs = input.now - this.startedAt + frameMs;
    const speechFinished =
      this.speechMs >= this.options.minSpeechMs &&
      input.now - this.lastSpeechAt >= this.options.silenceMs;
    const reachedMaxDuration = durationMs >= this.options.maxMs;
    if (!speechFinished && !reachedMaxDuration) return null;
    // A VAD that never observes the endpoint is continuous room energy, not a
    // bounded wake phrase. Sending the arbitrary max-sized window to cloud STT
    // creates a Groq loop while the acoustic wake detector is still healthy.
    if (reachedMaxDuration && !speechFinished) {
      this.cancel();
      this.cooldownUntil = input.now + this.options.cooldownMs;
      return null;
    }
    // A brief click/noise can start the VAD but must never turn into a full
    // cloud request merely because the hard capture timer elapsed.
    if (this.speechMs < this.options.minSpeechMs) {
      this.cancel();
      this.cooldownUntil = input.now + this.options.cooldownMs;
      return null;
    }

    const result: PassiveWakeSample = {
      frames: this.frames,
      speechMs: this.speechMs,
      durationMs,
      trailingSilenceMs: Math.max(0, input.now - this.lastSpeechAt),
      maxRawRms: this.maxRawRms,
    };
    this.cancel();
    this.cooldownUntil = input.now + this.options.cooldownMs;
    return result;
  }
}
