/**
 * Gate de entrada do mic no transporte realtime (paridade com a disciplina de
 * input do Overclock, GeminiLiveSession isEcho). Com AEC desligado o
 * alto-falante volta cru pro mic; se esses frames forem streamados ao socket, a
 * JARVIS responde a si mesma. Retém os frames ENQUANTO um TTS/ack LOCAL toca
 * (status 'speaking' que NÃO veio do áudio do próprio provider) — durante a
 * fala do provider seguimos streamando para preservar o barge-in do realtime.
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
  return opts.status === 'speaking' && !opts.providerSpeaking;
}
