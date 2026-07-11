/**
 * VAD-gated phrase capture for the text fallback wake path. It never decides
 * whether a phrase is a wake word, it only returns a small bounded sample for
 * STT after real speech has ended (or max window with enough energy).
 */

export interface PassiveWakeCaptureOptions {
  rawSpeechRms: number;
  /**
   * Hangover floor: after speech starts, energy must fall below this to count
   * as silence. Defaults to rawSpeechRms * 0.55 so SoftAgc ambient doesn't
   * hold the capture open forever (logs: zero passiveSample while user said
   * Jarvis).
   */
  speechHangoverRms?: number;
  minSpeechMs: number;
  silenceMs: number;
  maxMs: number;
  cooldownMs: number;
  /**
   * At maxMs without silence, still emit if max peak energy reached this
   * (real speech). Below = continuous ambient — discard to avoid STT storms.
   */
  forceEmitMinPeakRms?: number;
}

export interface PassiveWakeSample {
  frames: Float32Array[];
  speechMs: number;
  durationMs: number;
  /** Audio after the last speech frame; useful to trim VAD endpoint silence. */
  trailingSilenceMs: number;
  maxRawRms: number;
  /** True when we closed on max window instead of silence (force-emit). */
  forcedByMax?: boolean;
}

export interface PassiveWakeFrame {
  frame: Float32Array;
  rawRms: number;
  now: number;
  sampleRate: number;
  preRoll: readonly Float32Array[];
}

const DEFAULT_OPTIONS: PassiveWakeCaptureOptions = {
  // Caller passa RMS pós-AGC; 0.012 ≈ fala fraca (raw 0.004 era baixo demais
  // pro onset e alto demais pro hangover do ambient).
  rawSpeechRms: 0.012,
  minSpeechMs: 160,
  // 900ms: "Jarvis" curto; 1350ms fazia o user desistir antes do STT.
  silenceMs: 900,
  maxMs: 4_500,
  cooldownMs: 500,
  forceEmitMinPeakRms: 0.04,
};

export class PassiveWakeCapture {
  private readonly options: Required<
    Pick<
      PassiveWakeCaptureOptions,
      | 'rawSpeechRms'
      | 'minSpeechMs'
      | 'silenceMs'
      | 'maxMs'
      | 'cooldownMs'
      | 'forceEmitMinPeakRms'
    >
  > & { speechHangoverRms: number };
  private active = false;
  private frames: Float32Array[] = [];
  private startedAt = 0;
  private lastSpeechAt = 0;
  private speechMs = 0;
  private maxRawRms = 0;
  private cooldownUntil = 0;

  constructor(options: Partial<PassiveWakeCaptureOptions> = {}) {
    const rawSpeechRms = options.rawSpeechRms ?? DEFAULT_OPTIONS.rawSpeechRms;
    this.options = {
      rawSpeechRms,
      speechHangoverRms:
        options.speechHangoverRms ?? Math.max(0.004, rawSpeechRms * 0.55),
      minSpeechMs: options.minSpeechMs ?? DEFAULT_OPTIONS.minSpeechMs,
      silenceMs: options.silenceMs ?? DEFAULT_OPTIONS.silenceMs,
      maxMs: options.maxMs ?? DEFAULT_OPTIONS.maxMs,
      cooldownMs: options.cooldownMs ?? DEFAULT_OPTIONS.cooldownMs,
      forceEmitMinPeakRms:
        options.forceEmitMinPeakRms ?? DEFAULT_OPTIONS.forceEmitMinPeakRms!,
    };
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
    // Hysteresis: open on rawSpeechRms, stay "speech" until hangover floor.
    const speechFloor = this.active
      ? this.options.speechHangoverRms
      : this.options.rawSpeechRms;
    const isSpeech = input.rawRms >= speechFloor;

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

    // Hard limit with enough peak energy = force STT (user said "Jarvis" without
    // a clean silence gap, or ambient AGC never drops). Without this, logs show
    // peakRms 0.7 and ZERO passiveSample forever.
    if (reachedMaxDuration && !speechFinished) {
      if (
        this.speechMs >= this.options.minSpeechMs &&
        this.maxRawRms >= this.options.forceEmitMinPeakRms
      ) {
        return this.finish(input.now, durationMs, true);
      }
      this.cancel();
      this.cooldownUntil = input.now + this.options.cooldownMs;
      return null;
    }

    if (this.speechMs < this.options.minSpeechMs) {
      this.cancel();
      this.cooldownUntil = input.now + this.options.cooldownMs;
      return null;
    }

    return this.finish(input.now, durationMs, false);
  }

  private finish(
    now: number,
    durationMs: number,
    forcedByMax: boolean,
  ): PassiveWakeSample {
    const result: PassiveWakeSample = {
      frames: this.frames,
      speechMs: this.speechMs,
      durationMs,
      trailingSilenceMs: Math.max(0, now - this.lastSpeechAt),
      maxRawRms: this.maxRawRms,
      forcedByMax,
    };
    this.cancel();
    this.cooldownUntil = now + this.options.cooldownMs;
    return result;
  }
}
