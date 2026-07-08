/**
 * FIX 1 (input hygiene): reter os frames de mic ANTES de streamarem ao socket
 * realtime enquanto QUALQUER áudio LOCAL é audível — ack do wake (playWakePrompt),
 * think-filler e TTS marin/clássico. Com AEC desligado o alto-falante volta cru
 * pro mic; se esses frames forem ao socket, o provider transcreve a PRÓPRIA fala
 * da JARVIS (ex.: "Pois não") como comando do usuário e responde a si mesma.
 *
 * O gate do main (`shouldWithholdLiveMicFrame`) só cobre o áudio do PRÓPRIO
 * provider (FSM 'speaking'); o ack/filler/clássico toca pelo caminho de playback
 * LOCAL e nunca registra lá. Este é o gate paralelo do lado do RENDER: a mesma
 * disciplina drain+cauda (`localAudioMicWithholdMs`) fecha essa lacuna.
 *
 * O áudio do provider NÃO passa por aqui (toca via LiveAudioPlayer), então o
 * barge-in do realtime segue preservado — só o áudio local retém o mic.
 *
 * Estado mínimo + relógio injetável = puro e testável.
 */

import { localAudioMicWithholdMs } from './voice-suppression-window';

let withholdUntil = 0;

/**
 * Marca que um áudio LOCAL começou a tocar agora: estende a janela de retenção
 * do mic para `now + duração + cauda`. Estende (max), nunca encurta — dois
 * playbacks encadeados (ack → filler) mantêm o mic retido pela cauda combinada.
 */
export function markLocalAudioPlaying(playbackMs: number, now: number): void {
  const until = now + localAudioMicWithholdMs(playbackMs);
  if (until > withholdUntil) withholdUntil = until;
}

/** True enquanto um áudio local ainda é audível (dentro da janela drain+cauda). */
export function isLocalAudioAudible(now: number): boolean {
  return now < withholdUntil;
}

/**
 * Zera a janela: chamado no barge-in (`stopAllPlayback`) — o áudio local foi
 * cortado, então o mic pode voltar a streamar imediatamente (o usuário está
 * falando por cima, é isso que queremos capturar).
 */
export function clearLocalAudioGate(): void {
  withholdUntil = 0;
}
