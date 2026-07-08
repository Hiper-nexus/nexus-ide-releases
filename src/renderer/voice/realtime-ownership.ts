/**
 * DEFECT 1 (per-SESSION ownership). Enquanto a sessão live DONA a conversa
 * (engajada + socket saudável = `isRealtimeLive`), o caminho Classic
 * STT→cérebro→TTS fica DESLIGADO para um turno de wake/click — ele é o fallback
 * de DEGRADAÇÃO, não um racer paralelo.
 *
 * Sem esta trava, a posse era por-turno: cada re-wake (ou auto-wake na própria
 * voz) abria um turno NOVO que o Classic vencia (transcript+cérebro+TTS
 * próprios) enquanto o realtime ainda respondia o utterance anterior → duas
 * vozes na mesma fala. A posse correta é por SESSÃO: com o realtime vivo, um
 * wake/click NUNCA produz classicTranscript/brainReply; o Classic só assume
 * quando o realtime NÃO está vivo (sem key / socket em erro / não pronto).
 *
 * O `reply` (follow-on da escuta quente entre turnos) é Classic-owned por
 * design e não é suprimido aqui — só os turnos de posse (wake/click).
 * Puro/testável.
 */
import type { JarvisCaptureReason } from './jarvis-reply-loop';

export function classicSuppressedByRealtimeOwner(opts: {
  captureReason: JarvisCaptureReason;
  isRealtimeLive: boolean;
}): boolean {
  const ackGated =
    opts.captureReason === 'wake' || opts.captureReason === 'click';
  return ackGated && opts.isRealtimeLive;
}
