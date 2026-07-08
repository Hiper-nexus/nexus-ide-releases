export interface CaptureGateInput {
  wavBase64: string;
  durationSec: number;
  heardSpeech?: boolean;
  minSpeechSec: number;
  maxRms?: number;
  maxPeak?: number;
}

export interface CaptureGateOptions {
  allowWeakSpeech?: boolean;
}

const WEAK_SPEECH_RMS = 0.006;
const WEAK_SPEECH_PEAK = 0.024;

function hasCapturedAudio(input: CaptureGateInput): boolean {
  if (!input.wavBase64) return false;
  if (input.durationSec < input.minSpeechSec) return false;
  return true;
}

function looksLikeWeakSpeech(input: CaptureGateInput): boolean {
  return (input.maxRms ?? 0) >= WEAK_SPEECH_RMS || (input.maxPeak ?? 0) >= WEAK_SPEECH_PEAK;
}

export function hasUsableLocalSpeech(
  input: CaptureGateInput,
  opts: CaptureGateOptions = {},
): boolean {
  if (!hasCapturedAudio(input)) return false;
  if (input.heardSpeech === false) {
    return opts.allowWeakSpeech === true && looksLikeWeakSpeech(input);
  }
  if (input.heardSpeech === undefined && opts.allowWeakSpeech) {
    return looksLikeWeakSpeech(input);
  }
  return true;
}

export function hasRecoverableWeakSpeech(input: CaptureGateInput): boolean {
  if (!hasCapturedAudio(input)) return false;
  if (input.heardSpeech === true) return true;
  return looksLikeWeakSpeech(input);
}

export function shouldDiscardBeforeRealtime(
  input: CaptureGateInput,
  opts: {
    shouldTryRealtime: boolean;
    hasQueuedRealtimeTranscript: boolean;
    allowWeakSpeech?: boolean;
  },
): boolean {
  if (hasUsableLocalSpeech(input)) return false;
  if (opts.allowWeakSpeech && hasRecoverableWeakSpeech(input)) return false;
  return !opts.shouldTryRealtime && !opts.hasQueuedRealtimeTranscript;
}
