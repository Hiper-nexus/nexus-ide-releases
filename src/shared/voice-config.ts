import { z } from 'zod';

/**
 * Declarative voice pipeline config (Jarvis mode). Superset of a legacy
 * voice `audio-config.json` — the same base fields (provider, baseUrl,
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
  /** Legacy audio-config compatibility fields. */
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

export type VoiceRouting = 'jarvis' | 'focused-pane' | 'orchestrator' | 'ask';
export type VoiceSpeakMode = 'summary' | 'full' | 'off';
export type JarvisBrainProviderId = 'gemini' | 'openai' | 'groq';
export type JarvisLiveTransport = 'classic' | 'openai-realtime' | 'gemini-live';

const inputSchema = z.object({
  mode: z.enum(['push-to-talk']).default('push-to-talk'),
  /** Electron accelerator for keydown (globalShortcut). */
  shortcut: z.string().min(1).max(64).default('CommandOrControl+Shift+Space'),
  /** Bare key code for the uiohook keyup match (e.g. "Space"). */
  pushToTalkKey: z.object({ code: z.string().max(32) }).optional(),
});

export const jarvisLiveConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Transporte da sessao live: 'classic' = FSM sobre pipeline batch;
     * 'openai-realtime' = OpenAI Realtime via WSS; 'gemini-live' = transporte
     * realtime full-duplex nativo (padrão). A hibernação de 2026-07-06 (default
     * 'classic') foi revertida pela Decisão aprovada 2026-07-08 — realtime é o
     * default COM degradação automática: sem key / setup falho / reconexão
     * esgotada, o Classic (agora muito melhor) segue valendo mid-session.
     */
    transport: z
      .enum(['classic', 'openai-realtime', 'gemini-live'])
      .default('gemini-live'),
    /** Modelo realtime OpenAI padrao. */
    openaiModel: z.string().min(1).max(128).default('gpt-realtime-2.1-mini'),
    /** Voz OpenAI Realtime padrao. */
    openaiVoice: z.string().min(1).max(64).default('marin'),
    /** Modelo realtime (audio nativo) usado pelo transporte gemini-live. */
    liveModel: z
      .string()
      .min(1)
      .max(128)
      .default('gemini-2.5-flash-native-audio-preview-12-2025'),
    /** Voz pre-construida do Gemini Live. */
    voiceName: z.string().min(1).max(64).default('Charon'),
    /** Keep the live session warm after a turn so follow-ups reuse context. */
    graceReuseMs: z.number().int().positive().max(10 * 60_000).default(90_000),
    /** Move from warm to dormant after no speech; wake/PTT reuses the session. */
    dormantAfterMs: z.number().int().positive().max(30 * 60_000).default(5 * 60_000),
    /** Soft cap for short-term live transcript context held in memory. */
    maxWindowTurns: z.number().int().positive().max(40).default(12),
  })
  .default({
    enabled: false,
    transport: 'gemini-live',
    openaiModel: 'gpt-realtime-2.1-mini',
    openaiVoice: 'marin',
    liveModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
    voiceName: 'Charon',
    graceReuseMs: 90_000,
    dormantAfterMs: 5 * 60_000,
    maxWindowTurns: 12,
  });

/** Persona da voz: como o assistente se identifica e trata o usuário. */
export const voicePersonaSchema = z
  .object({
    assistantName: z.string().min(1).max(48).default('Jarvis'),
    userName: z.string().max(48).optional(),
    customInstructions: z.string().max(2_000).optional(),
  })
  .default({ assistantName: 'Jarvis' });

export type VoicePersona = z.infer<typeof voicePersonaSchema>;

export type JarvisLiveConfig = z.infer<typeof jarvisLiveConfigSchema>;

export interface JarvisBrainProvider {
  provider: JarvisBrainProviderId;
  endpoint: string;
  auth: z.infer<typeof authSchema>;
  model: string;
  /** Some OpenAI-compatible providers reject JSON mode; the prompt still asks for strict JSON. */
  jsonMode?: boolean;
  fallback?: JarvisBrainProvider;
}

export const jarvisBrainProviderSchema: z.ZodType<JarvisBrainProvider> = z.lazy(() =>
  z.object({
    provider: z.enum(['gemini', 'openai', 'groq']),
    endpoint: z.string().url().max(2048),
    auth: authSchema,
    model: z.string().min(1).max(128),
    jsonMode: z.boolean().optional(),
    fallback: jarvisBrainProviderSchema.optional(),
  }),
);

export function flattenJarvisBrainProviders(
  head: JarvisBrainProvider,
): JarvisBrainProvider[] {
  const out: JarvisBrainProvider[] = [];
  let node: JarvisBrainProvider | undefined = head;
  let guard = 0;
  while (node && guard < 16) {
    out.push(node);
    node = node.fallback;
    guard += 1;
  }
  return out;
}

export function relinkJarvisBrainProviders(
  providers: JarvisBrainProvider[],
): JarvisBrainProvider {
  return providers.reduceRight<JarvisBrainProvider | undefined>((fallback, provider) => {
    const { fallback: _drop, ...rest } = provider;
    return { ...rest, ...(fallback ? { fallback } : {}) };
  }, undefined) as JarvisBrainProvider;
}

export function promoteJarvisBrainProvider(
  head: JarvisBrainProvider,
  providerId: JarvisBrainProviderId,
): JarvisBrainProvider {
  const providers = flattenJarvisBrainProviders(head);
  const idx = providers.findIndex((p) => p.provider === providerId);
  if (idx <= 0) return head;
  return relinkJarvisBrainProviders([
    providers[idx],
    ...providers.filter((_, i) => i !== idx),
  ]);
}

/**
 * ITEM 4: guarantee a REAL cascade. A persisted config that was reduced to a
 * single brain provider (e.g. groq-only) fails empty the moment that one
 * provider errors. This appends any of the canonical providers (gemini / openai
 * / groq, with their strong default tiers) that the user's chain is missing —
 * WITHOUT reordering or re-modeling the providers the user already chose. So the
 * head stays the user's preference and the tail gains the other two as
 * fallbacks: "no empty replies while any provider has a valid key."
 */
export function ensureFullBrainCascade(
  head: JarvisBrainProvider,
  canonical: JarvisBrainProvider[] = flattenJarvisBrainProviders(
    DEFAULT_VOICE_CONFIG.jarvisBrain,
  ),
): JarvisBrainProvider {
  const chain = flattenJarvisBrainProviders(head);
  const present = new Set(chain.map((p) => p.provider));
  const missing = canonical.filter((p) => !present.has(p.provider));
  if (missing.length === 0) return head;
  return relinkJarvisBrainProviders([...chain, ...missing]);
}

/**
 * ITEM 4/6: which brain provider + model will actually answer, given a key
 * resolver — the first link in the (full) cascade whose key resolves. Pure so
 * the engage/boot log can name it verbatim. Returns null when no key resolves.
 */
export function resolveActiveJarvisBrain(
  head: JarvisBrainProvider,
  hasKey: (envVar: string) => boolean,
): { provider: JarvisBrainProviderId; model: string } | null {
  for (const p of flattenJarvisBrainProviders(ensureFullBrainCascade(head))) {
    const envVar = p.auth.envVar;
    const resolves = p.auth.type === 'none' || (envVar ? hasKey(envVar) : false);
    if (resolves) return { provider: p.provider, model: p.model };
  }
  return null;
}

export const voiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  input: inputSchema.default({
    mode: 'push-to-talk',
    shortcut: 'CommandOrControl+Shift+Space',
  }),
  routing: z.enum(['jarvis', 'focused-pane', 'orchestrator', 'ask']).default('jarvis'),
  speakMode: z.enum(['summary', 'full', 'off']).default('summary'),
  /** Wake word ("Jarvis") — always-on local detection via Porcupine. */
  wakeWord: z
    .object({ enabled: z.boolean().default(false) })
    .default({ enabled: false }),
  persona: voicePersonaSchema,
  jarvisLive: jarvisLiveConfigSchema,
  jarvisBrain: jarvisBrainProviderSchema.default({
    provider: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    auth: { type: 'api_key', envVar: 'GEMINI_API_KEY' },
    model: 'gemini-3.5-flash',
    jsonMode: false,
    fallback: {
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      model: 'gpt-4o-mini',
      jsonMode: true,
      fallback: {
        provider: 'groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        auth: { type: 'api_key', envVar: 'GROQ_API_KEY' },
        model: 'llama-3.3-70b-versatile',
        jsonMode: true,
      },
    },
  }),
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
  routing: 'jarvis',
  speakMode: 'summary',
  wakeWord: { enabled: false },
  persona: { assistantName: 'Jarvis' },
  jarvisLive: {
    enabled: false,
    transport: 'gemini-live',
    openaiModel: 'gpt-realtime-2.1-mini',
    openaiVoice: 'marin',
    liveModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
    voiceName: 'Charon',
    graceReuseMs: 90_000,
    dormantAfterMs: 5 * 60_000,
    maxWindowTurns: 12,
  },
  jarvisBrain: {
    provider: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    auth: { type: 'api_key', envVar: 'GEMINI_API_KEY' },
    model: 'gemini-3.5-flash',
    jsonMode: false,
    fallback: {
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      model: 'gpt-4o-mini',
      jsonMode: true,
      fallback: {
        provider: 'groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        auth: { type: 'api_key', envVar: 'GROQ_API_KEY' },
        model: 'llama-3.3-70b-versatile',
        jsonMode: true,
      },
    },
  },
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
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
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

// ── Legacy audio-config migration ─────────────────────────────────────────────────────

/** The legacy `audio-config.json` shape (subset we consume). */
export const legacyVoiceConfigSchema = z.object({
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

export type LegacyVoiceConfig = z.infer<typeof legacyVoiceConfigSchema>;

const KNOWN_ENV_VAR: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
};

/**
 * Migrate a legacy `audio-config.json` into a full NexusIDE voice config.
 * The STT block is derived from the legacy fields; the TTS block and local
 * fallbacks come from {@link DEFAULT_VOICE_CONFIG}. Pure — no I/O.
 */
export function migrateLegacyVoiceConfig(raw: LegacyVoiceConfig): VoiceConfig {
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
 * Turn a bare key code (e.g. "Space") into an Electron accelerator,
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
