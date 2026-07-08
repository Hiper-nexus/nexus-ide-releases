/**
 * Gates that decide whether the Live (realtime) path owns mic streaming / replies.
 */
import { useVoiceStore } from './voice-store';
import type { VoiceRuntimeInfo } from '../../shared/voice-ipc';
import {
  REALTIME_ACTION_BRIDGE_ENABLED,
  REALTIME_PROVIDER_AUDIO_ENABLED,
  livePlayer,
  pendingRealtimeAudioOut,
  realtimeTurnActive,
  suppressRealtimeAudioOut,
} from './voice-session-state';

export function isJarvisLiveEnabled(): boolean {
  const info = useVoiceStore.getState().info;
  return Boolean(info?.jarvisLive.enabled && info.routing === 'jarvis');
}

/** Transporte realtime (áudio full-duplex OpenAI/Gemini) ligado? */
export function isRealtimeLive(): boolean {
  const info = useVoiceStore.getState().info;
  const liveState = useVoiceStore.getState().liveState;
  return Boolean(
    isJarvisLiveEnabled() &&
      info?.jarvisLive.transport !== 'classic' &&
      liveState?.realtimeReady === true &&
      liveState.status !== 'error',
  );
}

export function hasCredential(
  info: VoiceRuntimeInfo | null | undefined,
  envVar: string,
): boolean {
  return Boolean(
    info?.keys.some((key) => key.envVar === envVar && (key.hasEnv || key.hasStoredKey)),
  );
}

export function canAttemptRealtime(info: VoiceRuntimeInfo | null | undefined): boolean {
  if (!info?.jarvisLive.enabled || info.jarvisLive.transport === 'classic') return false;
  // Realtime engages with EITHER key regardless of the configured transport.
  return hasCredential(info, 'OPENAI_API_KEY') || hasCredential(info, 'GEMINI_API_KEY');
}

/**
 * Stream mic frames to the Live socket while a turn is engaged.
 * Includes `reply` (follow-up after Live speaks) so the second utterance reaches
 * Gemini without requiring another "Hey Jarvis".
 */
export function shouldStreamToRealtime(): boolean {
  if (!REALTIME_PROVIDER_AUDIO_ENABLED || !REALTIME_ACTION_BRIDGE_ENABLED) return false;
  const info = useVoiceStore.getState().info;
  const liveState = useVoiceStore.getState().liveState;
  return Boolean(
    realtimeTurnActive &&
      isJarvisLiveEnabled() &&
      info?.jarvisLive.transport !== 'classic' &&
      canAttemptRealtime(info) &&
      liveState?.status !== 'error',
  );
}

/** True when wake should stay silent — Live owns the voice (one voice). */
export function shouldSkipClassicWakeAck(): boolean {
  const info = useVoiceStore.getState().info;
  return canAttemptRealtime(info);
}

/**
 * True when a voice re-wake must be ignored because Live is mid-reply.
 * Without this, a second "Hey Jarvis" (or self-wake on her own voice) during
 * the gap between liveProviderAnswer and the first audible chunk sets
 * suppressRealtimeAudioOut, queues dozens of PCM chunks, then flushes them
 * in one burst → stutter + ambient follow-up ("obras").
 *
 * Only `listening` (command / follow-up window) accepts a voice re-wake while
 * the Live turn is still active.
 */
export function shouldIgnoreLiveReWake(opts?: {
  status?: string;
  remainingMs?: number;
  pendingChunks?: number;
  suppressAudioOut?: boolean;
  realtimeTurnActive?: boolean;
}): boolean {
  const status = opts?.status ?? useVoiceStore.getState().status;
  const remainingMs = opts?.remainingMs ?? livePlayer?.remainingMs() ?? 0;
  const pendingChunks = opts?.pendingChunks ?? pendingRealtimeAudioOut.length;
  const suppress = opts?.suppressAudioOut ?? suppressRealtimeAudioOut;
  const turnActive = opts?.realtimeTurnActive ?? realtimeTurnActive;
  if (!turnActive && !isRealtimeLive()) return false;
  if (status === 'listening') return false;
  if (status === 'speaking' || status === 'routing') {
    return true;
  }
  // Mute-stuck transcribing (no audio draining) must allow barge-in — otherwise
  // a second "Hey Jarvis" is ignored while Live never speaks (user hears silence).
  if (status === 'transcribing') {
    if (remainingMs > 80 || pendingChunks > 0) return true;
    return false;
  }
  if (remainingMs > 80) return true;
  if (suppress && pendingChunks > 0) return true;
  // FIX BARGE-IN: the old blanket `turnActive && idle → block` prevented
  // re-wake when the greeting inject never produced audio (user hears silence
  // and retries "Hey Jarvis" but it's ignored). Allow re-wake at idle when
  // nothing is playing/pending — the follow-up arming handles the brief gap
  // after liveProviderAnswer on its own (busy flag + reopenLiveFollowUpListening).
  return false;
}
