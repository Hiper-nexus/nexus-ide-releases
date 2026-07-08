import type { JarvisCaptureReason } from './jarvis-reply-loop';

export const REALTIME_TRANSCRIPT_WAIT_MS = 1_800;
export const WAKE_REALTIME_TRANSCRIPT_WAIT_MS = 4_800;
export const CLICK_REALTIME_TRANSCRIPT_WAIT_MS = 6_500;

export function realtimeTranscriptWaitMs(reason: JarvisCaptureReason): number {
  if (reason === 'click') return CLICK_REALTIME_TRANSCRIPT_WAIT_MS;
  if (reason === 'wake') return WAKE_REALTIME_TRANSCRIPT_WAIT_MS;
  return REALTIME_TRANSCRIPT_WAIT_MS;
}
