import { isLikelySpokenEcho } from '../../shared/voice-echo-match';
import type { JarvisCaptureReason } from './jarvis-reply-loop';
import { useVoiceStore } from './voice-store';

export function isReplyCapture(reason: JarvisCaptureReason): boolean {
  return reason === 'reply';
}

/** Reply pós-TTS usa filtro de lixo mais agressivo — eco vira "e aí"/"obrigado". */
export function transcriptInConversation(
  reason: JarvisCaptureReason,
  jarvisHistoryLen: number,
  jarvisLastTurnAt: number,
  memoryMs: number,
): boolean {
  if (reason === 'wake' || reason === 'click' || reason === 'reply') return false;
  return jarvisHistoryLen > 0 && Date.now() - jarvisLastTurnAt <= memoryMs;
}

export function shouldDiscardSpokenEcho(
  transcript: string,
  reason: JarvisCaptureReason,
): boolean {
  // Só o reply reabre o mic imediatamente após o TTS — é aí que a própria fala
  // volta pelo alto-falante como "comando". Wake/click/manual já têm a janela de
  // supressão + o echo-suppress do main; aplicar aqui arriscaria descartar um
  // comando legítimo que por acaso repete a última resposta.
  if (reason !== 'reply') return false;
  const lastSpoken = useVoiceStore.getState().lastSpoken?.trim() ?? '';
  if (!lastSpoken) return false;
  return isLikelySpokenEcho(transcript, lastSpoken);
}

export type EchoDiscardHooks = {
  log: (source: 'realtime' | 'classic', transcript: string, reason: JarvisCaptureReason) => void;
  endTurn: () => void;
};

export function discardSpokenEchoIfNeeded(
  transcript: string,
  reason: JarvisCaptureReason,
  hooks: EchoDiscardHooks,
  source: 'realtime' | 'classic',
): boolean {
  if (!shouldDiscardSpokenEcho(transcript, reason)) return false;
  hooks.log(source, transcript, reason);
  useVoiceStore.getState().setStatus('idle');
  hooks.endTurn();
  return true;
}

/** Auto-stop da única escuta automática pós-pergunta (não encadeia reply→reply). */
export const REPLY_SILENCE_MS = 1_200;
export const REPLY_MIN_LISTEN_MS = 1_800;
export const REPLY_MAX_MS = 12_000;

export function buildReplyAutoStop(onAutoStop: () => void) {
  return {
    silenceMs: REPLY_SILENCE_MS,
    minListenMs: REPLY_MIN_LISTEN_MS,
    maxMs: REPLY_MAX_MS,
    onAutoStop,
  };
}
