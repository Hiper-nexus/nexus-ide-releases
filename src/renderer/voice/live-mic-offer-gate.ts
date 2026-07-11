const PLAYBACK_DRAIN_THRESHOLD_MS = 80;

/**
 * Decide se um frame do mic deve ir ao transporte Live.
 *
 * Full-duplex (produto Gemini Live): o mic fica aberto enquanto ELA fala —
 * o provider faz barge-in (START_OF_ACTIVITY_INTERRUPTS). Só bloqueamos
 * áudio LOCAL (ack/TTS clássico) e quando o turno realtime não está ativo.
 *
 * Half-duplex (fallback): retém frames durante speaking/playback do provider
 * para evitar eco quando não há AEC confiável.
 */
export function shouldOfferLiveMicFrame(input: {
  readonly realtimeActive: boolean;
  readonly localAudioAudible: boolean;
  readonly providerPlaybackRemainingMs: number;
  readonly status: string;
  /** Produto: full-duplex = true (duplexModePolicy().keepHalfDuplexMicGate === false). */
  readonly fullDuplex?: boolean;
}): boolean {
  if (!input.realtimeActive) return false;
  // Classic TTS/ack tocando no device — nunca misturar com o mic Live.
  if (input.localAudioAudible) return false;
  if (input.fullDuplex) return true;
  // Half-duplex: silencia o mic enquanto o provider/local fala.
  if (input.status === 'speaking') return false;
  return input.providerPlaybackRemainingMs <= PLAYBACK_DRAIN_THRESHOLD_MS;
}
