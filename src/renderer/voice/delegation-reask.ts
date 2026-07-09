/**
 * C3 Fase 1 (fix real do follow-up 4a): captura wake/click que stripa pra
 * VAZIO com uma missão aguardando "Confirmo?" não pode morrer muda — o usuário
 * quase certamente re-acordou a JARVIS só pra responder. Em vez do descarte
 * silencioso: renova o TTL, re-pergunta e reabre UMA escuta de reply — o
 * caminho reply não passa pelo stripper de ack, então até "sim" seco funciona.
 *
 * PERIGO C3 preservado: este módulo nunca despacha — não escreve no pane do
 * squad; só o "sim" do usuário em runJarvisTurn despacha. O eco do próprio
 * re-ask classifica como 'other' (pin em delegation-confirm.test.ts) e é
 * registrado via recordEcho antes da escuta reabrir.
 */
import type React from 'react';
import { useVoiceStore } from './voice-store';
import {
  livePlayer,
  setSuppressRealtimeAudioOut,
  turnExecution,
  wakeMic,
} from './voice-session-state';
import { logVoiceEvent } from './voice-live-ipc';
import { speakAndPlayPipelined } from './voice-speak-pipeline';
import { delay, noteAutoReplyOpened } from './jarvis-reply-loop';
import { buildReplyAutoStop, REPLY_MIN_LISTEN_MS } from './voice-echo-guard';
import {
  estimatedSpeechMs,
  playbackWakeSuppressionMs,
  replyReopenDelayMs,
  TTS_TAIL_GUARD_MS,
} from './voice-suppression-window';
import { PENDING_REASK_PROMPT, refreshPendingDelegation } from './delegation-confirm';
import type { RunJarvisTurnDeps } from './voice-run-jarvis-turn';
import type { VoiceCapture } from './voice-capture';

/**
 * true = turno tratado (o chamador retorna); false = não havia pendência viva
 * (o chamador segue com o descarte normal).
 */
export async function reaskPendingDelegation(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
  turnToken: number,
  deps: RunJarvisTurnDeps,
): Promise<boolean> {
  const refreshed = refreshPendingDelegation(Date.now());
  if (!refreshed) return false;
  const store = useVoiceStore.getState();
  const isTurnCurrent = (): boolean => turnExecution.currentToken === turnToken;

  logVoiceEvent(
    'info',
    'jarvis.delegationReask',
    're-wake vazio com pendência viva — re-perguntando',
    { chars: refreshed.text.length },
  );
  // Mesma higiene do speak de confirmação em runJarvisTurn: Classic fala, Live cala.
  setSuppressRealtimeAudioOut(true);
  livePlayer?.stop();
  void window.nexus.voice.liveInterrupt('classic-tts').catch(() => {});
  store.setStatus('speaking');
  const spoken = await speakAndPlayPipelined(PENDING_REASK_PROMPT, isTurnCurrent);
  if (!spoken.ok) {
    store.setError(spoken.error);
    return true;
  }
  if (spoken.cancelled) return true;
  store.setSpoken(PENDING_REASK_PROMPT);
  void window.nexus.voice.recordEcho(PENDING_REASK_PROMPT).catch(() => {});
  wakeMic.suppressWakeDetection(
    spoken.playedMs > 0
      ? TTS_TAIL_GUARD_MS
      : playbackWakeSuppressionMs(estimatedSpeechMs(PENDING_REASK_PROMPT.length)),
  );
  store.setStatus('idle');

  busy.current = false;
  const reopenDelay = replyReopenDelayMs();
  wakeMic.suppressWakeDetection(reopenDelay + REPLY_MIN_LISTEN_MS);
  await delay(reopenDelay);
  noteAutoReplyOpened({ sayText: PENDING_REASK_PROMPT });
  void deps.beginListening(
    capture,
    buildReplyAutoStop(() => {
      if (deps.isListening(capture)) void deps.finishAndProcess(capture, busy);
    }),
    'reply',
    undefined,
    busy,
  );
  return true;
}
