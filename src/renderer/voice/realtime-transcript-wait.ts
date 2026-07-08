import type { JarvisCaptureReason } from './jarvis-reply-loop';

export const REALTIME_TRANSCRIPT_WAIT_MS = 1_800;
export const LOCAL_SPEECH_REALTIME_TRANSCRIPT_WAIT_MS = 1_200;
export const WAKE_REALTIME_TRANSCRIPT_WAIT_MS = 4_800;
export const CLICK_REALTIME_TRANSCRIPT_WAIT_MS = 6_500;

export interface RealtimeTranscriptWaitOptions {
  localSpeechUsable?: boolean;
}

export function realtimeTranscriptWaitMs(
  reason: JarvisCaptureReason,
  opts: RealtimeTranscriptWaitOptions = {},
): number {
  if (opts.localSpeechUsable && (reason === 'wake' || reason === 'click')) {
    return LOCAL_SPEECH_REALTIME_TRANSCRIPT_WAIT_MS;
  }
  if (reason === 'click') return CLICK_REALTIME_TRANSCRIPT_WAIT_MS;
  if (reason === 'wake') return WAKE_REALTIME_TRANSCRIPT_WAIT_MS;
  return REALTIME_TRANSCRIPT_WAIT_MS;
}
