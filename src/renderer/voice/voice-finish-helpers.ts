import { isLikelyNoiseTranscript } from '../../shared/voice-noise';
import {
  isDiscardableTranscript,
  isWakeAckOnlyTranscript,
  stripWakeAckEcho,
} from './transcript-filter';
import {
  shouldDiscardSpokenEcho,
  transcriptInConversation,
} from './voice-echo-guard';
import {
  activeCaptureReason,
  jarvisHistory,
  jarvisLastTurnAt,
  lastRealtimeNativeToolAt,
  realtimeNativeToolInFlight,
} from './voice-session-state';
import { personaUserName } from './jarvis-screen-context';
import type { JarvisCaptureReason } from './jarvis-reply-loop';

export const TRANSCRIBE_DEADLINE_MS_LOCAL = 60_000;
export const SPEAK_DEADLINE_MS_LOCAL = 40_000;
export const LIVE_START_SETTLE_MS_LOCAL = 3_000;
export const JARVIS_MEMORY_MS_LOCAL = 300_000;
export const WAKE_STT_BUDGET_MS = 8_000;
export const MIN_SPEECH_SEC = 0.25;

export function isAckGatedCapture(
  reason: JarvisCaptureReason = activeCaptureReason,
): boolean {
  return reason === 'wake' || reason === 'click';
}

export function hasRealtimeNativeToolSince(since: number): boolean {
  return realtimeNativeToolInFlight > 0 || lastRealtimeNativeToolAt >= since;
}

export function filteredLiveRescueTranscript(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  if (isAckGatedCapture() && isWakeAckOnlyTranscript(raw, personaUserName())) {
    return null;
  }
  const transcript = isAckGatedCapture()
    ? stripWakeAckEcho(raw, personaUserName())
    : raw;
  if (!transcript || shouldDiscardSpokenEcho(transcript, activeCaptureReason)) {
    return null;
  }
  const inConversation = transcriptInConversation(
    activeCaptureReason,
    jarvisHistory.length,
    jarvisLastTurnAt,
    JARVIS_MEMORY_MS_LOCAL,
  );
  if (isDiscardableTranscript(transcript, { inConversation })) return null;
  if (activeCaptureReason === 'reply' && isLikelyNoiseTranscript(transcript)) return null;
  return transcript;
}
