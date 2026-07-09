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
  speaking: 90_000, // > SPEAK_DEADLINE_MS_LOCAL (40s) + playback longo do Live
};

export function statusWatchdogAction(
  status: VoiceUiStatus,
  stuckMs: number,
): 'none' | 'force-idle' {
  const deadline = STATUS_STUCK_DEADLINES_MS[status];
  if (deadline === undefined) return 'none';
  return stuckMs >= deadline ? 'force-idle' : 'none';
}
