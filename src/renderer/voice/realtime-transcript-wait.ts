import type { JarvisCaptureReason } from './jarvis-reply-loop';

export const REALTIME_TRANSCRIPT_WAIT_MS = 1_800;
export const LOCAL_SPEECH_REALTIME_TRANSCRIPT_WAIT_MS = 1_200;
export const WAKE_REALTIME_TRANSCRIPT_WAIT_MS = 4_800;
export const CLICK_REALTIME_TRANSCRIPT_WAIT_MS = 6_500;
/** Follow-up reply: wait longer before replyMuteIdle (user mid-sentence). */
export const REPLY_REALTIME_TRANSCRIPT_WAIT_MS = 9_000;

export interface RealtimeTranscriptWaitOptions {
  localSpeechUsable?: boolean;
  /**
   * MUTE FIX: true quando o realtime é o DONO da sessão (Classic suprimido por
   * per-SESSION ownership). O atalho de 1,2s abaixo existia para largar RÁPIDO
   * para o Classic STT quando havia fala local usável — mas com o Classic
   * desligado (DEFECT 1) esse atalho só GARANTIA o timeout para o silêncio (o
   * transcript realtime — Gemini finaliza no 1º áudio, OpenAI via whisper — não
   * chega em 1,2s). Sendo dono, esperamos o orçamento CHEIO do wake/click; o
   * áudio já enfileirado toca assim que o transcript finaliza (~1–2,5s), então
   * não há silêncio extra no caminho feliz.
   */
  realtimeIsOwner?: boolean;
}

export function realtimeTranscriptWaitMs(
  reason: JarvisCaptureReason,
  opts: RealtimeTranscriptWaitOptions = {},
): number {
  if (
    !opts.realtimeIsOwner &&
    opts.localSpeechUsable &&
    (reason === 'wake' || reason === 'click')
  ) {
    return LOCAL_SPEECH_REALTIME_TRANSCRIPT_WAIT_MS;
  }
  if (reason === 'click') return CLICK_REALTIME_TRANSCRIPT_WAIT_MS;
  if (reason === 'wake') return WAKE_REALTIME_TRANSCRIPT_WAIT_MS;
  if (reason === 'reply' && opts.realtimeIsOwner) return REPLY_REALTIME_TRANSCRIPT_WAIT_MS;
  if (reason === 'reply') return REPLY_REALTIME_TRANSCRIPT_WAIT_MS;
  return REALTIME_TRANSCRIPT_WAIT_MS;
}
