/**
 * DEFECT 1 (per-SESSION ownership). Enquanto a sessão live DONA a conversa
 * (engajada + socket saudável = `isRealtimeLive`), o caminho Classic
 * STT→cérebro→TTS fica DESLIGADO — ele é o fallback de DEGRADAÇÃO, não um
 * racer paralelo.
 *
 * Sem esta trava, a posse era por-turno: cada re-wake (ou auto-wake na própria
 * voz) abria um turno NOVO que o Classic vencia (transcript+cérebro+TTS
 * próprios) enquanto o realtime ainda respondia o utterance anterior → duas
 * vozes na mesma fala. A posse correta é por SESSÃO: com o realtime vivo,
 * NENHUM captureReason produz classicTranscript/brainReply; o Classic só
 * assume quando o realtime NÃO está vivo (sem key / socket em erro / não pronto).
 *
 * Paridade peer ADE (P1): wake/click/reply/manual/ptt — todos suprimidos
 * enquanto Live está dono. Puro/testável.
 */
import type { JarvisCaptureReason } from './jarvis-reply-loop';

export function classicSuppressedByRealtimeOwner(opts: {
  captureReason: JarvisCaptureReason;
  isRealtimeLive: boolean;
}): boolean {
  if (!opts.isRealtimeLive) return false;
  // Live owns the whole session — every capture reason is suppressed.
  void opts.captureReason;
  return true;
}

/**
 * A muted explicit capture is a failed realtime turn and must degrade. An
 * automatic reply capture may only contain room noise/echo, so idling avoids
 * reopening the Classic self-talk loop.
 */
export function shouldFallbackClassicAfterRealtimeMute(
  captureReason: JarvisCaptureReason,
): boolean {
  return captureReason !== 'reply';
}
