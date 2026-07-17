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
  setRealtimeTurnActive,
  setSuppressRealtimeAudioOut,
  turnExecution,
} from './voice-session-state';
import { logVoiceEvent } from './voice-live-ipc';

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
 * Power off: cut audio, cancel follow-ups, tear down Live ownership.
 * Wake word / PTT stay available so the user can wake her again.
 */
export async function powerOffJarvis(): Promise<void> {
  // Invalida TODO token de turno em voo ANTES do teardown: os caminhos de
  // continuidade (releaseAfterLiveProviderAnswer / follow-ups) checam o token
  // via canReopen — sem isto, um turno terminando logo após o clique reabria
  // a escuta e a Jarvis "não desligava".
  turnExecution.beginTurn();
  stopJarvisSpeech();
  cancelLiveFollowUp();
  setRealtimeTurnActive(false);
  resetPendingRealtimeAudioOut();
  setSuppressRealtimeAudioOut(false);
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

  useVoiceStore.getState().setStatus('idle');
  useVoiceStore
    .getState()
    .setNote(stopped ? 'Jarvis desligada' : 'Áudio parado');
  logVoiceEvent('info', 'voice.powerOff', stopped ? 'live stopped' : 'audio only');
}
