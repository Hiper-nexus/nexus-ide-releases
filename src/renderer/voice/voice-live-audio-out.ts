/**
 * Playback / queue of Live provider PCM chunks in the renderer.
 */
import { useVoiceStore } from './voice-store';
import type { JarvisLiveAudioOutEvent } from '../../shared/voice-ipc';
import { realtimeChunkSuppressionMs } from './voice-suppression-window';
import { logVoiceEvent } from './voice-live-ipc';
import { isResponseMuted } from './response-output-gate';
import {
  dropRealtimeAudioOut,
  ensureLivePlayer,
  pushPendingRealtimeAudioOut,
  realtimeAudioPlayedCounter,
  realtimeAudioSuppressedCounter,
  realtimeTurnActive,
  resetPendingRealtimeAudioOut,
  setDropRealtimeAudioOut,
  setSuppressRealtimeAudioOut,
  suppressRealtimeAudioOut,
  takePendingRealtimeAudioOut,
  turnExecution,
  wakeMic,
} from './voice-session-state';
import { resetLiveMuteRescues } from './live-mute-rescue';
import { logVoiceTurnMilestone } from './voice-turn-telemetry';

export { resetPendingRealtimeAudioOut };

function playbackErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 280) || 'falha desconhecida ao iniciar WebAudio';
}

function reportPlayback(
  event: JarvisLiveAudioOutEvent,
  outcome: 'started' | 'failed' | 'cancelled',
  error?: string,
): void {
  window.nexus.voice.liveAudioPlayback({ id: event.id, outcome, error });
}

/**
 * A Live delivery becomes evidence only after its exact WebAudio source was
 * scheduled. Provider PCM alone never advances the realtime diagnostic.
 */
export function playRealtimeAudioOut(event: JarvisLiveAudioOutEvent): void {
  // User mute: suppress speaker audio but ACK as started so smoke diagnostics
  // (and provider delivery accounting) do not treat intentional mute as failure.
  if (isResponseMuted()) {
    reportPlayback(event, 'started');
    return;
  }
  // Hard drop after local tool-TTS fallback — never play stale Live PCM.
  if (dropRealtimeAudioOut) {
    reportPlayback(event, 'cancelled');
    return;
  }
  void Promise.resolve()
    .then(() => ensureLivePlayer().play(event.pcm16))
    .then((chunkMs) => {
      if (chunkMs <= 0) {
        reportPlayback(event, 'cancelled');
        return;
      }
      try {
        logVoiceTurnMilestone(String(turnExecution.currentToken), 'first_audio', {
          path: 'realtime',
          chunkMs,
        });
      } catch {
        // Observabilidade nunca transforma áudio agendado em playback falho.
      }
      resetLiveMuteRescues();
      const tick = realtimeAudioPlayedCounter.tick(Date.now());
      if (tick.fire) {
        logVoiceEvent('info', 'live.audioPlayed', 'chunk realtime iniciado', {
          chunks: tick.count,
        });
      }
      useVoiceStore.getState().setStatus('speaking');
      wakeMic.suppressWakeDetection(realtimeChunkSuppressionMs(chunkMs));
      reportPlayback(event, 'started');
    })
    .catch((error) => {
      const message = playbackErrorMessage(error);
      logVoiceEvent('error', 'live.audioPlaybackFailed', 'falha ao tocar áudio realtime', {
        error: message,
      });
      reportPlayback(event, 'failed', message);
    });
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
  // Drop any chunks held while hard-muted (local TTS fallback) so a gate open
  // cannot replay Gemini audio from the previous tool turn.
  if (dropRealtimeAudioOut) {
    resetPendingRealtimeAudioOut();
  }
  setDropRealtimeAudioOut(false);
  setSuppressRealtimeAudioOut(false);
  flushPendingRealtimeAudioOut();
}

export function queuePendingRealtimeAudioOut(event: JarvisLiveAudioOutEvent): void {
  if (isResponseMuted()) {
    reportPlayback(event, 'started');
    return;
  }
  if (dropRealtimeAudioOut) {
    reportPlayback(event, 'cancelled');
    return;
  }
  if (!realtimeTurnActive) {
    reportPlayback(event, 'cancelled');
    return;
  }
  const tick = realtimeAudioSuppressedCounter.tick(Date.now());
  if (tick.fire) {
    logVoiceEvent('warn', 'live.audioSuppressed', 'chunk realtime retido (suppress on)', {
      chunks: tick.count,
    });
  }
  pushPendingRealtimeAudioOut(event);
}
