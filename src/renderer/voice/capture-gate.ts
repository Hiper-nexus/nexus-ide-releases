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

/** Ditado com menos que isto de tecla baixa útil não carrega fala. */
export const DICTATION_MIN_DURATION_SEC = 0.3;
/** Fala mínima (quadros acima do piso de ruído) para valer um ditado. */
export const DICTATION_MIN_SPEECH_SEC = 0.2;
/** Abaixo disto (RMS e pico) o microfone está praticamente mudo. */
const NEAR_MUTE_RMS = 0.003;
const NEAR_MUTE_PEAK = 0.012;

export interface DictationCaptureGateInput {
  durationSec: number;
  heardSpeech?: boolean;
  maxRms?: number;
  maxPeak?: number;
  quality?: { speechSec: number };
}

/**
 * Ditado: true = não mandar ao STT. Whisper alucina frases fixas ("The
 * following is a presentation of...") sobre silêncio/ruído; sem fala medida
 * não há o que transcrever. Medidas ausentes nunca bloqueiam (só a duração).
 */
export function shouldDiscardDictationCapture(
  input: DictationCaptureGateInput,
): boolean {
  if (input.durationSec < DICTATION_MIN_DURATION_SEC) return true;
  if (
    input.maxRms !== undefined &&
    input.maxPeak !== undefined &&
    input.maxRms < NEAR_MUTE_RMS &&
    input.maxPeak < NEAR_MUTE_PEAK
  ) {
    return true;
  }
  return input.quality !== undefined && input.quality.speechSec < DICTATION_MIN_SPEECH_SEC;
}
