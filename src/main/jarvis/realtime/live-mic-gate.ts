/**
 * Gate de entrada do mic no transporte realtime. Com AEC desligado o
 * alto-falante volta cru pro mic; se esses frames forem streamados ao socket, a
 * JARVIS responde a si mesma. Até existir um stream com referência acústica
 * real (AEC), retém os frames durante QUALQUER fala. Isto troca barge-in por um
 * half-duplex confiável e impede o provider de cancelar a própria resposta.
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
}): boolean {
  return opts.status === 'speaking' || opts.providerSpeaking;
}
