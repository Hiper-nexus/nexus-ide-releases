import { z } from 'zod';
import type { VoiceRouting, VoiceSpeakMode } from './voice-config';

/**
 * Zod schemas + transport types for the voice IPC surface. The main process
 * treats every renderer payload as untrusted and parses it here before doing
 * any network/subprocess work.
 */

// ── renderer → main payloads ─────────────────────────────────────────────────

export const transcribeRequestSchema = z.object({
  /** Base64-encoded audio (WAV or raw PCM16 depending on `mime`). */
  audioBase64: z.string().min(1).max(50_000_000),
  mime: z.enum(['audio/wav', 'audio/pcm', 'audio/webm']).default('audio/wav'),
  sampleRate: z.number().int().positive().max(192_000).default(16_000),
});

export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;

export const speakRequestSchema = z.object({
  text: z.string().min(1).max(20_000),
  /** Override the configured speakMode for this utterance (optional). */
  speakMode: z.enum(['summary', 'full', 'off']).optional(),
});

export type SpeakRequest = z.infer<typeof speakRequestSchema>;

export const setConfigRequestSchema = z.object({
  enabled: z.boolean().optional(),
  routing: z.enum(['focused-pane', 'orchestrator', 'ask']).optional(),
  speakMode: z.enum(['summary', 'full', 'off']).optional(),
  shortcut: z.string().min(1).max(64).optional(),
  /** Force a specific provider id to the head of the STT chain. */
  sttProvider: z.string().min(1).max(64).optional(),
  /** Force a specific provider id to the head of the TTS chain. */
  ttsProvider: z.string().min(1).max(64).optional(),
});

export type SetConfigRequest = z.infer<typeof setConfigRequestSchema>;

// ── main → renderer results ──────────────────────────────────────────────────

export type ProviderKind = 'cloud' | 'local' | 'system';

/** One resolved link in a provider fallback chain (secret-free). */
export interface ResolvedProvider {
  provider: string;
  kind: ProviderKind;
  available: boolean;
  /** Why it is (un)available, e.g. "GROQ_API_KEY not set" or "ready". */
  reason: string;
}

export interface ResolvedChain {
  /** The active provider (first available), or null when nothing is available. */
  active: ResolvedProvider | null;
  chain: ResolvedProvider[];
}

/** Whether the PTT hotkey does true hold (uiohook keyup) or press-to-toggle. */
export type HotkeyMode = 'hold' | 'toggle';

/** Secret-free runtime snapshot the renderer renders from. Never carries keys. */
export interface VoiceRuntimeInfo {
  enabled: boolean;
  routing: VoiceRouting;
  speakMode: VoiceSpeakMode;
  shortcut: string;
  hotkeyMode: HotkeyMode;
  stt: ResolvedChain;
  tts: ResolvedChain;
}

/** One provider's outcome while walking the STT fallback chain. */
export interface SttAttempt {
  provider: string;
  reason: string;
}

export type TranscribeResult =
  | {
      ok: true;
      text: string;
      provider: string;
      /** Set when earlier providers were skipped, e.g. "groq throttled (429) → openai". */
      fallbackNote?: string;
      attempts: SttAttempt[];
    }
  | { ok: false; error: string; needsKey: boolean; attempts: SttAttempt[] };

export type SpeakResult =
  | { ok: true; provider: string; mode: 'played' }
  | { ok: true; provider: string; mode: 'audio'; format: string; audioBase64: string }
  | { ok: true; provider: string; mode: 'silent' }
  | { ok: false; error: string };
