/**
 * Controle da reabertura automática do mic após a JARVIS falar (modo classic).
 *
 * CONTINUIDADE (paridade Overclock): a escuta fica QUENTE entre turnos — o
 * usuário conversa sem repetir "Hey Jarvis" a cada frase, até um teto de
 * MAX_AUTO_REPLY_LOOPS turnos ou até ficar em silêncio. Isso só é seguro por
 * causa das travas que já existem: o echo-guard (voice-echo-guard) descarta o
 * eco do próprio TTS ANTES de virar turno, capturas vazias se auto-encerram (não
 * reabrem), e a supressão de wake cobre a janela do TTS. Sem essas travas,
 * reabrir sempre causava o loop infinito (TTS → mic → "não entendi" → TTS → …).
 */

export const REPLY_LISTEN_DELAY_MS = 700;
export const MAX_AUTO_REPLY_LOOPS = 10;
export const MAX_CONFUSION_REPLY_REOPENS = 1;

let autoReplyLoopCount = 0;
let consecutiveConfusionReplyCount = 0;
export type JarvisCaptureReason = 'manual' | 'wake' | 'click' | 'ptt' | 'reply';

export function resetAutoReplyLoop(): void {
  autoReplyLoopCount = 0;
  consecutiveConfusionReplyCount = 0;
}

export function resetAutoReplyLoopForCapture(reason: JarvisCaptureReason): void {
  if (reason !== 'reply') resetAutoReplyLoop();
}

export function noteAutoReplyOpened(opts: { sayText?: string } = {}): void {
  autoReplyLoopCount += 1;
  if (opts.sayText && isConfusionReply(opts.sayText)) {
    consecutiveConfusionReplyCount += 1;
  } else {
    consecutiveConfusionReplyCount = 0;
  }
}

function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Respostas de confusão/eco: reabre só uma vez para o usuário corrigir. */
export function isConfusionReply(text: string): boolean {
  const n = norm(text);
  if (!n) return true;
  return (
    /\b(nao entendi|nao compreendi|nao ouvi|repita|pode repetir|desculpa nao)\b/.test(n) ||
    /\bnao entendi o pedido\b/.test(n)
  );
}

export function shouldReopenJarvisListening(opts: {
  expectReply: boolean;
  sayText: string;
  realtimeTurnActive: boolean;
  isRealtimeLive: boolean;
  captureReason?: JarvisCaptureReason;
}): boolean {
  // Live full-duplex already keeps the mic hot — Classic reply reopen would
  // race a second STT→brain→TTS path against the provider (self-talk / dual voice).
  if (opts.isRealtimeLive) return false;
  if (opts.realtimeTurnActive) return false;

  // Teto de continuidade: após MAX_AUTO_REPLY_LOOPS reaberturas automáticas sem
  // um novo "Hey Jarvis", exige re-wake (equivale à dormência de ~5min do
  // Overclock). O contador zera a cada wake/click/manual/ptt.
  if (autoReplyLoopCount >= MAX_AUTO_REPLY_LOOPS) {
    console.log('[voice] trava anti-loop: limite de reaberturas automáticas');
    return false;
  }

  // Confusão/eco: reabre só uma vez para o usuário corrigir; confusão repetida
  // seguida trava (senão a JARVIS fica pedindo "repita" em loop).
  if (isConfusionReply(opts.sayText)) {
    if (consecutiveConfusionReplyCount >= MAX_CONFUSION_REPLY_REOPENS) {
      console.log('[voice] trava anti-loop: confusão repetida, não reabrindo');
      return false;
    }
    return true;
  }

  // Continuidade: mantém a escuta quente entre turnos (inclusive reply→reply),
  // seguro pelo echo-guard + auto-encerramento de capturas vazias. `expectReply`
  // deixa de ser um portão — a conversa segue sem "Hey Jarvis" a cada frase.
  return true;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
