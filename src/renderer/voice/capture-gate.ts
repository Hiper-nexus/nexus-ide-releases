export interface CaptureGateInput {
  wavBase64: string;
  durationSec: number;
  heardSpeech?: boolean;
  minSpeechSec: number;
}

export function hasUsableLocalSpeech(input: CaptureGateInput): boolean {
  if (!input.wavBase64) return false;
  if (input.durationSec < input.minSpeechSec) return false;
  if (input.heardSpeech === false) return false;
  return true;
}

export function shouldDiscardBeforeRealtime(
  input: CaptureGateInput,
  opts: { shouldTryRealtime: boolean; hasQueuedRealtimeTranscript: boolean },
): boolean {
  if (hasUsableLocalSpeech(input)) return false;
  return !opts.shouldTryRealtime && !opts.hasQueuedRealtimeTranscript;
}
