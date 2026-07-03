import { z } from 'zod';

/**
 * Declarative voice pipeline config (Jarvis mode). Superset of the Overclock
 * ClockVoice `audio-config.json` — the same base fields (provider, baseUrl,
 * model, language, outputMode, captureMode, pushToTalkKey, chunkMs) plus a
 * recursive `fallback` chain, a full `tts` block, VAD, and routing/speakMode.
 *
 * Shared between main (loads + validates JSON, resolves secrets) and renderer
 * (receives a trimmed, secret-free snapshot over IPC). Everything here is
 * JSON-serializable and free of node-only imports.
 */

// ── Provider plugin (recursive fallback) ─────────────────────────────────────

export type VoicePluginType = 'stt' | 'tts' | 'vad';

const authSchema = z.object({
  type: z.enum(['api_key', 'bearer', 'none']).default('api_key'),
  /** Name of the env var holding the key. Resolved in MAIN only, never sent to renderer. */
  envVar: z.string().min(1).max(128).optional(),
});

const vadSchema = z.object({
  engine: z.enum(['silero', 'webrtc', 'none']).default('silero'),
  threshold: z.number().min(0).max(1).default(0.5),
  minSpeechMs: z.number().int().nonnegative().default(300),
  maxSilenceMs: z.number().int().nonnegative().default(800),
  modelPath: z.string().max(4096).optional(),
});

export type VadConfig = z.infer<typeof vadSchema>;

/**
 * One STT/TTS provider with an optional nested `fallback` of the same shape.
 * The chain is walked head-first; the first *available* provider (key present
 * for cloud, binary present for local) is selected at runtime (see provider-select).
 */
export interface VoicePlugin {
  type: VoicePluginType;
  provider: string;
  endpoint?: string;
  auth?: z.infer<typeof authSchema>;
  model?: string;
  translate?: boolean;
  translateFrom?: string;
  translateTo?: string;
  streaming?: boolean;
  chunkMs?: number;
  /** ClockVoice parity fields. */
  language?: string;
  outputMode?: string;
  /** TTS-only. */
  voice?: string;
  speed?: number;
  format?: string;
  /** Local providers. */
  localBin?: string;
  modelPath?: string;
  vad?: VadConfig;
  fallback?: VoicePlugin;
}

export const voicePluginSchema: z.ZodType<VoicePlugin> = z.lazy(() =>
  z.object({
    type: z.enum(['stt', 'tts', 'vad']),
    provider: z.string().min(1).max(64),
    endpoint: z.string().url().max(2048).optional(),
    auth: authSchema.optional(),
    model: z.string().min(1).max(128).optional(),
    translate: z.boolean().optional(),
    translateFrom: z.string().max(16).optional(),
    translateTo: z.string().max(16).optional(),
    streaming: z.boolean().optional(),
    chunkMs: z.number().int().positive().max(60_000).optional(),
    language: z.string().max(16).optional(),
    outputMode: z.string().max(32).optional(),
    voice: z.string().max(64).optional(),
    speed: z.number().positive().max(4).optional(),
    format: z.string().max(16).optional(),
    localBin: z.string().max(4096).optional(),
    modelPath: z.string().max(4096).optional(),
    vad: vadSchema.optional(),
    fallback: voicePluginSchema.optional(),
  }),
);

// ── Top-level voice config ───────────────────────────────────────────────────

export type VoiceRouting = 'focused-pane' | 'orchestrator' | 'ask';
export type VoiceSpeakMode = 'summary' | 'full' | 'off';

const inputSchema = z.object({
  mode: z.enum(['push-to-talk']).default('push-to-talk'),
  /** Electron accelerator for keydown (globalShortcut). */
  shortcut: z.string().min(1).max(64).default('CommandOrControl+Shift+Space'),
  /** ClockVoice-style key code for the uiohook keyup match (e.g. "Space"). */
  pushToTalkKey: z.object({ code: z.string().max(32) }).optional(),
});

export const voiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  input: inputSchema.default({
    mode: 'push-to-talk',
    shortcut: 'CommandOrControl+Shift+Space',
  }),
  routing: z.enum(['focused-pane', 'orchestrator', 'ask']).default('focused-pane'),
  speakMode: z.enum(['summary', 'full', 'off']).default('summary'),
  stt: voicePluginSchema,
  tts: voicePluginSchema,
});

export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * The shipped default: Groq translate-STT → whisper.cpp local fallback; OpenAI
 * TTS → Piper → macOS `say`. macOS `say` is the always-available terminal fallback
 * (no key, no install), so the pipeline can always speak even with zero config.
 */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: true,
  input: {
    mode: 'push-to-talk',
    shortcut: 'CommandOrControl+Shift+Space',
    pushToTalkKey: { code: 'Space' },
  },
  routing: 'focused-pane',
  speakMode: 'summary',
  stt: {
    type: 'stt',
    provider: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    auth: { type: 'api_key', envVar: 'GROQ_API_KEY' },
    model: 'whisper-large-v3-turbo',
    translate: true,
    translateFrom: 'pt',
    translateTo: 'en',
    streaming: false,
    language: 'pt',
    outputMode: 'english',
    vad: { engine: 'silero', threshold: 0.5, minSpeechMs: 300, maxSilenceMs: 800 },
    // Chain: Groq (fast/cheap, but free-tier rate-limits) → OpenAI → keyless
    // local whisper.cpp. Any provider that is throttled/quota-limited/erroring
    // is skipped automatically (see stt-service), so a 429 never breaks voice.
    fallback: {
      type: 'stt',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      model: 'whisper-1',
      translate: true,
      translateFrom: 'pt',
      translateTo: 'en',
      fallback: {
        type: 'stt',
        provider: 'local-whisper',
        localBin: 'whisper-cli',
        model: 'base',
        translate: true,
      },
    },
  },
  tts: {
    type: 'tts',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1/audio/speech',
    auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
    model: 'tts-1',
    voice: 'onyx',
    speed: 1.0,
    streaming: true,
    format: 'mp3',
    fallback: {
      type: 'tts',
      provider: 'piper',
      localBin: 'piper',
      voice: 'pt_BR-faber-medium',
      fallback: {
        type: 'tts',
        provider: 'macos-say',
        localBin: '/usr/bin/say',
        voice: 'Luciana',
      },
    },
  },
};

// ── ClockVoice migration ─────────────────────────────────────────────────────

/** The Overclock ClockVoice `audio-config.json` shape (subset we consume). */
export const clockVoiceConfigSchema = z.object({
  provider: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  language: z.string().optional(),
  outputMode: z.string().optional(),
  captureMode: z.string().optional(),
  pushToTalkKey: z.object({ code: z.string() }).optional(),
  interactionMode: z.string().optional(),
  targetWpm: z.number().optional(),
  chunkMs: z.number().optional(),
});

export type ClockVoiceConfig = z.infer<typeof clockVoiceConfigSchema>;

const KNOWN_ENV_VAR: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
};

/**
 * Migrate a ClockVoice `audio-config.json` into a full NexusIDE voice config.
 * The STT block is derived from the ClockVoice fields; the TTS block and local
 * fallbacks come from {@link DEFAULT_VOICE_CONFIG}. Pure — no I/O.
 */
export function migrateClockVoiceConfig(raw: ClockVoiceConfig): VoiceConfig {
  const provider = raw.provider ?? DEFAULT_VOICE_CONFIG.stt.provider;
  const baseUrl = raw.baseUrl?.replace(/\/$/, '');
  const endpoint = baseUrl
    ? `${baseUrl}/audio/transcriptions`
    : DEFAULT_VOICE_CONFIG.stt.endpoint;
  const translate = (raw.outputMode ?? 'english') === 'english';

  const stt: VoicePlugin = {
    type: 'stt',
    provider,
    endpoint,
    auth: { type: 'api_key', envVar: KNOWN_ENV_VAR[provider] ?? 'GROQ_API_KEY' },
    model: raw.model ?? DEFAULT_VOICE_CONFIG.stt.model,
    translate,
    translateFrom: raw.language ?? 'pt',
    translateTo: 'en',
    language: raw.language ?? 'pt',
    outputMode: raw.outputMode ?? 'english',
    chunkMs: raw.chunkMs,
    streaming: false,
    vad: DEFAULT_VOICE_CONFIG.stt.vad,
    fallback: DEFAULT_VOICE_CONFIG.stt.fallback,
  };

  const shortcut = raw.pushToTalkKey?.code
    ? accelFromCode(raw.pushToTalkKey.code)
    : DEFAULT_VOICE_CONFIG.input.shortcut;

  return {
    ...DEFAULT_VOICE_CONFIG,
    input: {
      mode: 'push-to-talk',
      shortcut,
      pushToTalkKey: raw.pushToTalkKey ?? DEFAULT_VOICE_CONFIG.input.pushToTalkKey,
    },
    stt,
  };
}

/**
 * Turn a bare ClockVoice key code (e.g. "Space") into an Electron accelerator,
 * defaulting the modifier so a global hotkey doesn't collide with plain typing.
 */
export function accelFromCode(code: string): string {
  const key = code === 'Space' ? 'Space' : code;
  return `CommandOrControl+Shift+${key}`;
}

export function keyCodeFromAccelerator(accelerator: string): string {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  return normalizeKeyCode(parts[parts.length - 1] ?? 'Space');
}

export function normalizeKeyCode(code: string): string {
  const clean = code.trim();
  if (!clean) return 'Space';
  const lower = clean.toLowerCase();
  if (lower === 'space' || lower === 'spacebar') return 'Space';
  if (/^f\d{1,2}$/i.test(clean)) return clean.toUpperCase();
  if (/^[a-z]$/i.test(clean)) return clean.toUpperCase();
  return clean.length === 1 ? clean.toUpperCase() : clean;
}
