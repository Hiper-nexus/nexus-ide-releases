/**
 * User controls for Jarvis output:
 *  - responseMuted: hear nothing, still run commands/tools
 *  - stopJarvisSpeech: cut current audio immediately
 *  - powerOffJarvis: end live session + silence + idle
 *
 * Mute is a local UI preference (localStorage), independent of TTS speakMode
 * and of the temporary suppressRealtimeAudioOut barge-in gate.
 */
import { useVoiceStore } from './voice-store';
import { stopAllPlayback } from './voice-playback';
import { cancelLiveFollowUp } from './live-followup';
import { clearLocalAudioGate } from './live-local-audio-gate';
import {
  livePlayer,
  resetPendingRealtimeAudioOut,
  setDropRealtimeAudioOut,
  setRealtimeTurnActive,
  setSuppressRealtimeAudioOut,
  turnExecution,
  wakeMic,
} from './voice-session-state';
import { logVoiceEvent } from './voice-live-ipc';
import { haltJarvisNarration } from './narration-control';
import { powerOffJarvisInput } from './jarvis-power-authority';

export function isResponseMuted(): boolean {
  return useVoiceStore.getState().responseMuted;
}

/** Persist + store. When enabling mute, cuts any audio already playing. */
export function setResponseMuted(muted: boolean): void {
  // Store setter owns localStorage persistence (single source of truth).
  useVoiceStore.getState().setResponseMuted(muted);
  if (muted) {
    stopJarvisSpeech();
    useVoiceStore.getState().setNote('Respostas em silêncio (comandos ativos)');
  } else {
    useVoiceStore.getState().setNote(null);
  }
  logVoiceEvent('info', 'voice.responseMute', muted ? 'mute on' : 'mute off');
}

/** Stop speech / live audio now — does not end the session. */
export function stopJarvisSpeech(): void {
  stopAllPlayback('ui-stop');
  livePlayer?.stop();
  void window.nexus.voice.liveInterrupt('ui-stop').catch(() => {});
  const status = useVoiceStore.getState().status;
  if (status === 'speaking' || status === 'routing') {
    useVoiceStore.getState().setStatus('idle');
  }
}

/**
 * Power off: cut audio, stop every mic/capture path and tear down Live.
 * Only an explicit HUD/voice-button/PTT gesture may reactivate input.
 */
export async function powerOffJarvis(): Promise<void> {
  // Publish the fail-closed authority before any asynchronous teardown. This
  // synchronously stops the controller-owned capture and makes late wake/live
  // callbacks inert even if main no longer has a Live owner.
  powerOffJarvisInput();
  wakeMic.cancelPassiveWake();
  wakeMic.cancelUtterance();
  wakeMic.stop();

  // Invalida TODO token de turno em voo ANTES do teardown: os caminhos de
  // continuidade (releaseAfterLiveProviderAnswer / follow-ups) checam o token
  // via canReopen — sem isto, um turno terminando logo após o clique reabria
  // a escuta e a Jarvis "não desligava".
  turnExecution.beginTurn();
  // Halt work-narration BEFORE status→idle: the narration queue kicks on idle
  // and was the root cause of "desliguei e ela continua falando".
  haltJarvisNarration();
  stopJarvisSpeech();
  cancelLiveFollowUp();
  setRealtimeTurnActive(false);
  resetPendingRealtimeAudioOut();
  // Keep Live PCM suppressed through teardown so late chunks cannot speak.
  setSuppressRealtimeAudioOut(true);
  setDropRealtimeAudioOut(true);
  clearLocalAudioGate();
  livePlayer?.stop();

  let stopped = false;
  try {
    const state = await window.nexus.voice.liveStop();
    useVoiceStore.getState().setLiveState(state);
    stopped = true;
  } catch {
    try {
      const state = await window.nexus.voice.liveHardTeardown();
      useVoiceStore.getState().setLiveState(state);
      stopped = true;
    } catch {
      // No live owner — classic path only.
    }
  }

  // Final cut after async stop — in-flight TTS may have landed mid-teardown.
  stopJarvisSpeech();
  livePlayer?.stop();
  resetPendingRealtimeAudioOut();

  useVoiceStore.getState().setStatus('idle');
  useVoiceStore.getState().setNote('Jarvis desligada');
  logVoiceEvent(
    stopped ? 'info' : 'warn',
    'voice.powerOff',
    stopped ? 'wake, capture e live desligados' : 'wake e capture desligados; live sem confirmação',
  );
}
