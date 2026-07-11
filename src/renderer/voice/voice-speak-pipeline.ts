/**
 * TTS / speak pipeline helpers extracted from voice-controller for size budget.
 */
import { splitForPipelinedSpeech } from './speech-segments';
import { playSpeakResult } from './voice-playback';
import { isResponseMuted } from './response-output-gate';
import { useVoiceStore } from './voice-store';
import type { SpeakResult } from '../../shared/voice-ipc';

export const SPEAK_DEADLINE_MS = 40_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} demorou demais (${Math.round(ms / 1000)}s)`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function speakSegment(text: string, label: string): Promise<SpeakResult> {
  return withTimeout(
    window.nexus.voice.speak({ text, speakMode: 'full' }),
    SPEAK_DEADLINE_MS,
    label,
  );
}

export async function speakAndPlayPipelined(
  text: string,
  isCurrent?: () => boolean,
): Promise<
  | { ok: true; playedMs: number; cancelled?: boolean }
  | { ok: false; error: string }
> {
  // Mute = no TTS audio; tools/commands still ran before this call.
  if (isResponseMuted()) return { ok: true, playedMs: 0, cancelled: true };
  const { first, rest } = splitForPipelinedSpeech(text);
  if (!first) return { ok: true, playedMs: 0 };
  const firstSpoken = await speakSegment(first, 'TTS');
  if (!firstSpoken.ok) return { ok: false, error: firstSpoken.error };
  surfaceTtsFallback(firstSpoken);

  if (isCurrent && !isCurrent()) {
    return { ok: true, playedMs: 0, cancelled: true };
  }

  const restPromise =
    rest && firstSpoken.mode === 'audio' ? speakSegment(rest, 'TTS continuação') : null;
  let playedMs = await playSpeakResult(firstSpoken);

  if (!rest) return { ok: true, playedMs };
  const restSpoken = restPromise
    ? await restPromise
    : await speakSegment(rest, 'TTS continuação');
  if (!restSpoken.ok) return { ok: false, error: restSpoken.error };
  surfaceTtsFallback(restSpoken);
  if (isCurrent && !isCurrent()) {
    return { ok: true, playedMs, cancelled: true };
  }
  playedMs += await playSpeakResult(restSpoken);
  return { ok: true, playedMs };
}

export function surfaceTtsFallback(result: Extract<SpeakResult, { ok: true }>): void {
  if (result.fallbackNote) useVoiceStore.getState().setNote(result.fallbackNote);
}
