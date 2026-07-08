/**
 * Playback / queue of Live provider PCM chunks in the renderer.
 */
import { useVoiceStore } from './voice-store';
import { realtimeChunkSuppressionMs } from './voice-suppression-window';
import { logVoiceEvent } from './voice-live-ipc';
import {
  ensureLivePlayer,
  pushPendingRealtimeAudioOut,
  realtimeAudioPlayedCounter,
  realtimeAudioSuppressedCounter,
  realtimeTurnActive,
  resetPendingRealtimeAudioOut,
  setSuppressRealtimeAudioOut,
  suppressRealtimeAudioOut,
  takePendingRealtimeAudioOut,
  wakeMic,
} from './voice-session-state';

export { resetPendingRealtimeAudioOut };

export function playRealtimeAudioOut(b64: string): void {
  const tick = realtimeAudioPlayedCounter.tick(Date.now());
  if (tick.fire) {
    logVoiceEvent('info', 'live.audioPlayed', 'chunk realtime tocado', {
      chunks: tick.count,
    });
  }
  useVoiceStore.getState().setStatus('speaking');
  const chunkMs = ensureLivePlayer().play(b64);
  wakeMic.suppressWakeDetection(realtimeChunkSuppressionMs(chunkMs));
}

export function flushPendingRealtimeAudioOut(): void {
  if (suppressRealtimeAudioOut) return;
  const chunks = takePendingRealtimeAudioOut();
  for (const chunk of chunks) playRealtimeAudioOut(chunk);
}

/**
 * Open the Live audio gate and drain any chunks held while muted.
 * Call on EVERY Live-owned exit path — a stuck suppress=true is total mute.
 */
export function openLiveAudioGate(): void {
  setSuppressRealtimeAudioOut(false);
  flushPendingRealtimeAudioOut();
}

export function queuePendingRealtimeAudioOut(b64: string): void {
  if (!realtimeTurnActive) return;
  const tick = realtimeAudioSuppressedCounter.tick(Date.now());
  if (tick.fire) {
    logVoiceEvent('warn', 'live.audioSuppressed', 'chunk realtime retido (suppress on)', {
      chunks: tick.count,
    });
  }
  pushPendingRealtimeAudioOut(b64);
}
