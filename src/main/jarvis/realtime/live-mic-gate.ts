/**
 * Gate de entrada do mic no transporte realtime.
 *
 * Half-duplex (default legado): com AEC desligado o alto-falante volta cru pro
 * mic — reter frames durante fala evita a Jarvis cancelar a própria resposta.
 *
 * Full-duplex: Gemini Live usa `START_OF_ACTIVITY_INTERRUPTS` e o mic do wake
 * pede `echoCancellation: true`. Frames continuam indo ao socket enquanto ela
 * fala; o provider interrompe e prepara o próximo comando (barge-in real).
 */

export type LiveFsmStatus =
  | 'off'
  | 'dormant'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'error';

export function shouldWithholdLiveMicFrame(opts: {
  status: LiveFsmStatus;
  providerSpeaking: boolean;
  /** Quando true, o mic fica aberto também durante a fala dela (barge-in). */
  fullDuplex?: boolean;
}): boolean {
  if (opts.fullDuplex) return false;
  return opts.status === 'speaking' || opts.providerSpeaking;
}
