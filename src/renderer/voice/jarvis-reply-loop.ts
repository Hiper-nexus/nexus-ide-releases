/**
 * Controle da reabertura automática do mic após a JARVIS falar (modo classic).
 * jarvisLive.enabled no painel NÃO significa full-duplex: só o transporte realtime
 * com ponte de ações mantém escuta contínua. Reabrir sempre causava loop infinito
 * (TTS → mic → "não entendi" → TTS → …).
 */

export const REPLY_LISTEN_DELAY_MS = 1_200;
export const MAX_AUTO_REPLY_LOOPS = 2;
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

/** Pergunta explícita — evita reabrir mic em monólogo com expectReply genérico. */
export function asksUserDirectly(text: string): boolean {
  return text.trim().includes('?');
}

export function shouldReopenJarvisListening(opts: {
  expectReply: boolean;
  sayText: string;
  realtimeTurnActive: boolean;
  isRealtimeLive: boolean;
  captureReason?: JarvisCaptureReason;
}): boolean {
  if (opts.realtimeTurnActive && opts.isRealtimeLive) return true;

  // Reply automático nunca reabre — TTS ecoando no mic virava monólogo infinito.
  if (opts.captureReason === 'reply') {
    console.log('[voice] não reabre após reply automático — diga Hey Jarvis de novo');
    return false;
  }

  if (autoReplyLoopCount >= MAX_AUTO_REPLY_LOOPS) {
    console.log('[voice] trava anti-loop: limite de reaberturas automáticas');
    return false;
  }

  if (isConfusionReply(opts.sayText)) {
    if (consecutiveConfusionReplyCount >= MAX_CONFUSION_REPLY_REOPENS) {
      console.log('[voice] trava anti-loop: confusão repetida, não reabrindo');
      return false;
    }
    return true;
  }

  if (!opts.expectReply) return false;
  if (!asksUserDirectly(opts.sayText)) return false;
  return true;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
