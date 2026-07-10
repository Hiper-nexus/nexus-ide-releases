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

/**
 * Short, barge-in-safe wake prompt injected as clientContent (turnComplete).
 * If speech is already arriving, the provider yields instead of talking over it.
 */
export function liveWakeInjectPrompt(userName?: string | null): string {
  const who = userName?.trim();
  return `[wake] Diga apenas "Olá${who ? `, ${who}` : ''}." Se o usuário já estiver falando, pule o cumprimento e escute.`;
}

/** Minimum capture floor while the non-blocking Live greeting may start. */
export const LIVE_GREETING_MIN_LISTEN_MS = 1_500;

export function wakeCaptureMinListenMs(
  baseMs: number,
  opts: { liveGreetingInFlight: boolean },
): number {
  if (!opts.liveGreetingInFlight) return baseMs;
  return Math.max(baseMs, LIVE_GREETING_MIN_LISTEN_MS);
}
