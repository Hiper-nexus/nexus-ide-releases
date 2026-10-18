/**
 * Watchdog PURO de status preso (C1b / WAKE-BROKEN-001 Rank 3): cada etapa do
 * pipeline já tem deadline próprio (STT 60s, cérebro 35s, TTS 40s), então um
 * status parado ALÉM do deadline da etapa é, por definição, um travamento —
 * ex.: STT que falha deixa 'transcribing' preso e o HUD mente para o usuário.
 * A saída forçada para 'idle' garante que nenhuma fase segure o pipeline para
 * sempre (prévia da propriedade "nunca trava" do coordenador da Fase 1).
 */
import type { VoiceUiStatus } from './voice-store';

export const STATUS_WATCHDOG_POLL_MS = 5_000;

/** Margem sobre o deadline da etapa que o status representa. */
export const STATUS_STUCK_DEADLINES_MS: Partial<Record<VoiceUiStatus, number>> = {
  transcribing: 75_000, // > TRANSCRIBE_DEADLINE_MS_LOCAL (60s)
  routing: 50_000, // > BRAIN_DEADLINE_MS_LOCAL (35s)
  // Audio progress resets this clock continuously. Once the player is empty,
  // waiting 90s for a missing Gemini responseDone made passive wake unusable.
  speaking: 6_000,
};

export function statusWatchdogAction(
  status: VoiceUiStatus,
  stuckMs: number,
): 'none' | 'force-idle' {
  const deadline = STATUS_STUCK_DEADLINES_MS[status];
  if (deadline === undefined) return 'none';
  return stuckMs >= deadline ? 'force-idle' : 'none';
}

export interface SpeakingProgressSignals {
  /** Áudio Live restante no player (ms). */
  liveRemainingMs: number;
  /** Chunks Live retidos aguardando o gate. */
  pendingLiveChunks: number;
  /** TTS/ack CLÁSSICO ainda audível (janela do live-local-audio-gate). */
  localAudioAudible: boolean;
  /**
   * Relato de handoff sintetizando: `speaking` sem áudio audível ainda (a TTS
   * local leva 14-28 s). A síntese tem deadline próprio (SPEAK_DEADLINE_MS), então
   * o sinal nunca segura o status para sempre.
   */
  narrationSynthesizing?: boolean;
}

/**
 * Follow-up 5: fala longa é progresso, não travamento — e isso vale para o
 * playback CLÁSSICO também, não só o Live. Um TTS clássico >90s não pode ser
 * force-idled no meio da frase. A SÍNTESE de um relato conta igual: forçar
 * `idle` no meio dela derrubava o relato e o fazia voltar à fila em laço.
 */
export function speakingHasAudioProgress(signals: SpeakingProgressSignals): boolean {
  return (
    signals.liveRemainingMs > 0 ||
    signals.pendingLiveChunks > 0 ||
    signals.localAudioAudible ||
    signals.narrationSynthesizing === true
  );
}
