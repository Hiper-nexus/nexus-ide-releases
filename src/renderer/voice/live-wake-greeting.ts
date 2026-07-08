import type { JarvisCaptureReason } from './jarvis-reply-loop';

export function shouldSendLiveWakeGreeting(
  reason: JarvisCaptureReason,
  skipClassicAck: boolean,
): boolean {
  return skipClassicAck && (reason === 'wake' || reason === 'click');
}

/**
 * Overclock JarvisService wake inject: "diga exatamente Olá[, nome]." — short,
 * one RTT. Longer local copy ("Estou ouvindo") added ~1s of perceived lag.
 */
export function liveWakeGreetingText(userName?: string | null): string {
  const who = userName?.trim();
  return `Olá${who ? `, ${who}` : ''}.`;
}

export function hasRealtimeProviderAudioAnswer(opts: {
  heldChunks: number;
  playedChunks: number;
}): boolean {
  return opts.heldChunks > 0 || opts.playedChunks > 0;
}

/** Overclock-style wake prompt injected as clientContent (turnComplete). */
export function liveWakeInjectPrompt(userName?: string | null): string {
  const who = userName?.trim();
  return `[wake] O usuário te chamou. Responda AGORA em voz: diga exatamente "Olá${who ? `, ${who}` : ''}."`;
}
