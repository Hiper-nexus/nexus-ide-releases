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
  /** Override the plugin's translate flag (Jarvis mode wants raw PT, not EN). */
  translate: z.boolean().optional(),
  /** Hint the spoken language when not translating (e.g. 'pt'). */
  language: z.string().min(2).max(8).optional(),
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
  routing: z.enum(['jarvis', 'focused-pane', 'orchestrator', 'ask']).optional(),
  speakMode: z.enum(['summary', 'full', 'off']).optional(),
  shortcut: z.string().min(1).max(64).optional(),
  /** Bare trigger key used for keyup detection, e.g. Space, F8, J. */
  pushToTalkKeyCode: z.string().min(1).max(32).optional(),
  /** Force a specific provider id to the head of the STT chain. */
  sttProvider: z.string().min(1).max(64).optional(),
  /** Force a specific provider id to the head of the TTS chain. */
  ttsProvider: z.string().min(1).max(64).optional(),
  /** Toggle the "Jarvis" wake word (Porcupine local detection). */
  wakeWordEnabled: z.boolean().optional(),
});

export type SetConfigRequest = z.infer<typeof setConfigRequestSchema>;

export const setVoiceKeyRequestSchema = z.object({
  envVar: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  /** Empty string clears the stored key. */
  key: z.string().max(4096),
});

export type SetVoiceKeyRequest = z.infer<typeof setVoiceKeyRequestSchema>;

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

export interface VoiceApiKeyStatus {
  envVar: string;
  providers: string[];
  hasEnv: boolean;
  hasStoredKey: boolean;
  keyMasked: string | null;
  secureStorageAvailable: boolean;
}

/** Secret-free runtime snapshot the renderer renders from. Never carries keys. */
export interface VoiceRuntimeInfo {
  enabled: boolean;
  routing: VoiceRouting;
  speakMode: VoiceSpeakMode;
  shortcut: string;
  pushToTalkKeyCode: string;
  hotkeyMode: HotkeyMode;
  /**
   * Whether the global accelerator actually registered with the OS (false =
   * conflict with another app or invalid combo). Optional: composed at the
   * IPC layer; pure builders may omit it.
   */
  hotkeyArmed?: boolean;
  /** Wake word ("Jarvis") toggle + whether its Picovoice key is present. */
  wakeWordEnabled: boolean;
  hasWakeKey: boolean;
  keys: VoiceApiKeyStatus[];
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
      /**
       * Transcrição válida porém descartável: 'echo' = é o próprio TTS vazando
       * do alto-falante para o mic (echo-suppress). O renderer deve ignorar em
       * silêncio, como faz com as alucinações do Whisper.
       */
      discarded?: 'echo';
      attempts: SttAttempt[];
    }
  | { ok: false; error: string; needsKey: boolean; attempts: SttAttempt[] };

// ── JARVIS (assistente conversacional) ───────────────────────────────────────

export interface JarvisContext {
  workspace: string | null;
  /** Workspaces recentes (nomes) — para open_workspace. */
  recents: string[];
  squads: string[];
  panes: string[];
  focusedPane: string | null;
  /** Título do pane do ORQUESTRADOR ativo (null = nenhum squad rodando). */
  orchestrator: string | null;
  /** Missões ativas (nomes/status). */
  missions: string[];
}

export interface JarvisTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type JarvisAction =
  | { type: 'none' }
  | { type: 'open_squad'; squadName: string }
  | { type: 'open_workspace'; workspaceName: string }
  | { type: 'design_squad' }
  | { type: 'new_mission' }
  | { type: 'send_to_pane'; text: string }
  | { type: 'run_command'; command: string };

export interface JarvisReply {
  say: string;
  /** O cérebro sinaliza que espera resposta → a escuta reabre sozinha. */
  expectReply?: boolean;
  action: JarvisAction;
}

export const jarvisRequestSchema = z.object({
  transcript: z.string().min(1).max(4000),
  context: z.object({
    workspace: z.string().nullable(),
    recents: z.array(z.string().max(128)).max(20).default([]),
    squads: z.array(z.string().max(128)).max(50),
    panes: z.array(z.string().max(128)).max(50),
    focusedPane: z.string().max(128).nullable(),
    orchestrator: z.string().max(128).nullable().default(null),
    missions: z.array(z.string().max(160)).max(20).default([]),
  }),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(2000),
      }),
    )
    .max(12)
    .default([]),
});

export type JarvisRequest = z.infer<typeof jarvisRequestSchema>;

export type SpeakResult =
  | { ok: true; provider: string; mode: 'played' }
  | { ok: true; provider: string; mode: 'audio'; format: string; audioBase64: string }
  | { ok: true; provider: string; mode: 'silent' }
  | { ok: false; error: string };
