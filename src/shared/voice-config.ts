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
export type JarvisLiveTransport =
  | 'classic'
  | 'openai-realtime'
  | 'gemini-live'
  | 'grok-realtime';

/** Rota realtime concreta; a credencial de cada uma está no mapa abaixo. */
export type RealtimeProviderKey = 'grok' | 'openai' | 'gemini';

/** Credencial que cada rota realtime exige. */
export const REALTIME_PROVIDER_ENV_VAR: Record<RealtimeProviderKey, string> = {
  grok: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * Ordem de degradação de cada transporte. FONTE ÚNICA: o runtime (main,
 * `resolveRealtimeProviderIds`) e o diagnóstico da UI (renderer) leem daqui.
 *
 * O diagnóstico precisa da CADEIA, não do transporte escolhido: uma rota sem
 * credencial nem vira candidata, então `realtime_unavailable` significa que
 * TODAS falharam. Nomear só a chave do transporte configurado mandava o
 * operador conferir a credencial errada — a mesma classe de bug que o mapa
 * exaustivo em voice-settings-helpers já tinha corrigido um nível abaixo.
 */
export const REALTIME_FALLBACK_CHAIN: Record<
  Exclude<JarvisLiveTransport, 'classic'>,
  readonly RealtimeProviderKey[]
> = {
  'grok-realtime': ['grok', 'openai', 'gemini'],
  'openai-realtime': ['openai', 'gemini'],
  'gemini-live': ['gemini', 'openai'],
};

/**
 * True when any hop of the configured realtime chain has a credential.
 * Grok (XAI_API_KEY) is the official head — a gate that only looks at
 * OpenAI/Gemini treats a valid xAI key as "no realtime" and the Jarvis
 * box stays mute.
 */
export function realtimeFallbackHasCredential(
  transport: JarvisLiveTransport,
  hasKey: (envVar: string) => boolean,
): boolean {
  if (transport === 'classic') return false;
  return REALTIME_FALLBACK_CHAIN[transport].some((id) =>
    hasKey(REALTIME_PROVIDER_ENV_VAR[id]),
  );
}

/**
 * Grok Voice (xAI) — rota oficial da voz do Nexus. Versão explícita de
 * propósito: o alias `grok-voice-latest` migra sozinho no provedor e trocaria a
 * voz do produto sem ninguém decidir isso.
 */
export const DEFAULT_GROK_VOICE_MODEL = 'grok-voice-think-fast-2.0';
/** Voz interna masculina da xAI (as outras rotas também abrem em masculina). */
export const DEFAULT_GROK_VOICE = 'rex';

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
/** Voz masculina Gemini Live (padrão produto). */
export const DEFAULT_GEMINI_LIVE_VOICE = 'Charon';
/** Default anterior (feminino) — migrado para Charon na carga. */
export const LEGACY_GEMINI_LIVE_VOICE = 'Gacrux';
export const LEGACY_GEMINI_LIVE_MODEL =
  'gemini-2.5-flash-native-audio-preview-12-2025';

/** Vozes OpenAI Realtime suportadas (API atual). */
export const OPENAI_REALTIME_VOICE_OPTIONS = [
  { id: 'ash', label: 'Ash (masculina)', gender: 'male' },
  { id: 'echo', label: 'Echo (masculina)', gender: 'male' },
  { id: 'verse', label: 'Verse (masculina)', gender: 'male' },
  { id: 'cedar', label: 'Cedar (masculina)', gender: 'male' },
  { id: 'alloy', label: 'Alloy (neutra)', gender: 'neutral' },
  { id: 'ballad', label: 'Ballad (suave)', gender: 'neutral' },
  { id: 'coral', label: 'Coral (feminina)', gender: 'female' },
  { id: 'sage', label: 'Sage (feminina)', gender: 'female' },
  { id: 'shimmer', label: 'Shimmer (feminina)', gender: 'female' },
  { id: 'marin', label: 'Marin (feminina)', gender: 'female' },
] as const;

/** Vozes OpenAI TTS clássico (speech API). */
export const OPENAI_TTS_VOICE_OPTIONS = [
  { id: 'onyx', label: 'Onyx (masculina grave)', gender: 'male' },
  { id: 'ash', label: 'Ash (masculina)', gender: 'male' },
  { id: 'echo', label: 'Echo (masculina)', gender: 'male' },
  { id: 'alloy', label: 'Alloy (neutra)', gender: 'neutral' },
  { id: 'fable', label: 'Fable (narrativa)', gender: 'neutral' },
  { id: 'nova', label: 'Nova (feminina)', gender: 'female' },
  { id: 'shimmer', label: 'Shimmer (feminina)', gender: 'female' },
  { id: 'coral', label: 'Coral (feminina)', gender: 'female' },
  { id: 'sage', label: 'Sage (feminina)', gender: 'female' },
  { id: 'marin', label: 'Marin (feminina)', gender: 'female' },
] as const;

/** Vozes prebuilt Gemini Live. */
export const GEMINI_LIVE_VOICE_OPTIONS = [
  { id: 'Charon', label: 'Charon (masculina)', gender: 'male' },
  { id: 'Fenrir', label: 'Fenrir (masculina grave)', gender: 'male' },
  { id: 'Orus', label: 'Orus (masculina)', gender: 'male' },
  { id: 'Puck', label: 'Puck (leve)', gender: 'neutral' },
  { id: 'Aoede', label: 'Aoede (feminina)', gender: 'female' },
  { id: 'Kore', label: 'Kore (feminina)', gender: 'female' },
  { id: 'Leda', label: 'Leda (feminina)', gender: 'female' },
  { id: 'Gacrux', label: 'Gacrux (feminina)', gender: 'female' },
] as const;

/** Default OpenAI (Realtime + alinhamento TTS). Ash cobre realtime e TTS. */
export const DEFAULT_OPENAI_VOICE = 'ash';

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
      .enum(['classic', 'openai-realtime', 'gemini-live', 'grok-realtime'])
      .default('grok-realtime'),
    /** Modelo de voz da xAI (rota oficial). Versão explícita de propósito: o
     *  alias `grok-voice-latest` migra sozinho e trocaria a voz do Nexus sem
     *  decisão de ninguém. */
    grokModel: z.string().min(1).max(128).default(DEFAULT_GROK_VOICE_MODEL),
    /** Voz interna da xAI (masculina, como as outras rotas). */
    grokVoice: z.string().min(1).max(64).default(DEFAULT_GROK_VOICE),
    /** Modelo realtime OpenAI padrao. */
    openaiModel: z.string().min(1).max(128).default('gpt-realtime-2.1-mini'),
    /** Voz OpenAI Realtime padrao (masculina). */
    openaiVoice: z.string().min(1).max(64).default(DEFAULT_OPENAI_VOICE),
    /** Modelo realtime (audio nativo) usado pelo transporte gemini-live. */
    liveModel: z
      .string()
      .min(1)
      .max(128)
      .default(DEFAULT_GEMINI_LIVE_MODEL),
    /** Voz pre-construida do Gemini Live (masculina). */
    voiceName: z.string().min(1).max(64).default(DEFAULT_GEMINI_LIVE_VOICE),
    /** Keep the live session warm after a turn so follow-ups reuse context. */
    graceReuseMs: z.number().int().positive().max(10 * 60_000).default(90_000),
    /** Move from warm to dormant after no speech; wake/PTT reuses the session. */
    dormantAfterMs: z.number().int().positive().max(30 * 60_000).default(5 * 60_000),
    /** Soft cap for short-term live transcript context held in memory. */
    maxWindowTurns: z.number().int().positive().max(40).default(12),
  })
  .default({
    enabled: false,
    transport: 'grok-realtime',
    grokModel: DEFAULT_GROK_VOICE_MODEL,
    grokVoice: DEFAULT_GROK_VOICE,
    openaiModel: 'gpt-realtime-2.1-mini',
    openaiVoice: DEFAULT_OPENAI_VOICE,
    liveModel: DEFAULT_GEMINI_LIVE_MODEL,
    voiceName: DEFAULT_GEMINI_LIVE_VOICE,
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
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
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
 * Provedores de STT que só TRANSCREVEM: não têm como entregar PT→EN. O Gemini
 * deixou de ser transcription-only (0.76.24): o modo english do ditado usa a
 * rota generativa (generateContent) que traduz; o Interactions API verbatim
 * segue para o modo literal e como etapa de alta acurácia. O Grok Voice
 * Transcribe (xAI) SÓ transcreve — a API não tem endpoint de tradução — e a
 * UI marca o modo como CODE·PT quando ele atende.
 */
export const TRANSCRIPTION_ONLY_STT_PROVIDERS: ReadonlySet<string> = new Set([
  'xai',
]);

/** O provedor consegue entregar PT→EN, ou só transcreve literal? */
export function sttProviderTranslates(providerId: string): boolean {
  return !TRANSCRIPTION_ONLY_STT_PROVIDERS.has(providerId);
}

/**
 * Cadeia de STT compatível com Whisper: Groq → OpenAI → whisper.cpp local.
 *
 * Fica NOMEADA porque a migração legada (`migrateLegacyVoiceConfig`) e os
 * testes de fallback dependem do head SER o Groq. Quando o Gemini entrou na
 * cabeça de `DEFAULT_VOICE_CONFIG.stt`, as leituras de
 * `.provider/.endpoint/.model/.vad/.fallback` deixaram de significar "o
 * provedor Whisper padrão" — esta constante é essa âncora, e evita que a
 * migração passe a herdar endpoint e modelo do Google.
 */
export const DEFAULT_WHISPER_STT: VoicePlugin = {
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
};

/**
 * Gemini 3.8 Flash-Lite TTS (GA 22/09/2026): voz da Jarvis pela mesma
 * GEMINI_API_KEY do STT/brain. `POST /v1beta/interactions`, WAV 24 kHz mono
 * em `steps[].content[]` (type `audio`). O 3.8 Flash (`gemini-3.8-flash-tts`)
 * é a opção de qualidade no mesmo contrato.
 */
export const GEMINI_TTS_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/interactions';
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
export const GEMINI_TTS_QUALITY_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_GEMINI_TTS_VOICE = 'Charon';
/** Modelos do Gemini 3.8 TTS oferecidos no seletor da voz por etapas. */
export const GEMINI_TTS_MODEL_OPTIONS = [
  { id: DEFAULT_GEMINI_TTS_MODEL, label: 'Flash-Lite (rápida, padrão)' },
  { id: GEMINI_TTS_QUALITY_MODEL, label: 'Flash (qualidade)' },
] as const;

/** Vozes prontas do Gemini TTS, com o estilo que o Google descreve para cada uma. */
export const GEMINI_TTS_VOICE_OPTIONS = [
  { id: 'Charon', label: 'Charon (informativa)' },
  { id: 'Kore', label: 'Kore (firme)' },
  { id: 'Orus', label: 'Orus (firme)' },
  { id: 'Alnilam', label: 'Alnilam (firme)' },
  { id: 'Puck', label: 'Puck (animada)' },
  { id: 'Fenrir', label: 'Fenrir (empolgada)' },
  { id: 'Iapetus', label: 'Iapetus (clara)' },
  { id: 'Erinome', label: 'Erinome (clara)' },
  { id: 'Algieba', label: 'Algieba (suave)' },
  { id: 'Despina', label: 'Despina (suave)' },
  { id: 'Schedar', label: 'Schedar (equilibrada)' },
  { id: 'Achird', label: 'Achird (amigável)' },
  { id: 'Sulafat', label: 'Sulafat (calorosa)' },
  { id: 'Gacrux', label: 'Gacrux (madura)' },
  { id: 'Sadaltager', label: 'Sadaltager (conhecedora)' },
  { id: 'Algenib', label: 'Algenib (grave)' },
  { id: 'Zephyr', label: 'Zephyr (brilhante)' },
  { id: 'Aoede', label: 'Aoede (leve)' },
  { id: 'Leda', label: 'Leda (jovial)' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix (gentil)' },
] as const;

export const DEFAULT_GEMINI_TTS: VoicePlugin = {
  type: 'tts',
  provider: 'gemini',
  endpoint: GEMINI_TTS_ENDPOINT,
  auth: { type: 'api_key', envVar: 'GEMINI_API_KEY' },
  model: DEFAULT_GEMINI_TTS_MODEL,
  voice: DEFAULT_GEMINI_TTS_VOICE,
  format: 'wav',
};

/**
 * Grok Voice Transcribe 2.0 (xAI): batch STT barato e rápido (70–500 ms,
 * US$ 0,10/h), multipart em `POST /v1/stt` com `keyterm` como viés de
 * vocabulário (wake word / jargão CODE). SÓ transcreve — a API não tem
 * endpoint de tradução (`TRANSCRIPTION_ONLY_STT_PROVIDERS`). A chave é a
 * mesma `XAI_API_KEY` do Grok realtime.
 */
export const XAI_STT_ENDPOINT = 'https://api.x.ai/v1/stt';
export const DEFAULT_XAI_STT_MODEL = 'grok-voice-transcribe-2.0';
export const DEFAULT_XAI_STT: VoicePlugin = {
  type: 'stt',
  provider: 'xai',
  endpoint: XAI_STT_ENDPOINT,
  auth: { type: 'api_key', envVar: 'XAI_API_KEY' },
  model: DEFAULT_XAI_STT_MODEL,
  translate: false,
  streaming: false,
  language: 'pt',
  outputMode: 'english',
};

/**
 * The shipped default: Gemini 3.5 Transcribe (transcrição literal, usada quando
 * existe GEMINI_API_KEY) → Grok Voice Transcribe 2.0 (xAI) → cadeia Whisper
 * (Groq translate → OpenAI → whisper.cpp local); OpenAI TTS → Piper → macOS
 * `say`. macOS `say` is the always-available terminal fallback (no key, no
 * install), so the pipeline can always speak even with zero config.
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
  wakeWord: { enabled: true },
  persona: { assistantName: 'Jarvis' },
  jarvisLive: {
    enabled: false,
    transport: 'grok-realtime',
    grokModel: DEFAULT_GROK_VOICE_MODEL,
    grokVoice: DEFAULT_GROK_VOICE,
    openaiModel: 'gpt-realtime-2.1-mini',
    openaiVoice: DEFAULT_OPENAI_VOICE,
    liveModel: DEFAULT_GEMINI_LIVE_MODEL,
    voiceName: DEFAULT_GEMINI_LIVE_VOICE,
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
    // Gemini 3.5 Transcribe na cabeça: transcrição LITERAL de alta acurácia
    // (modo verbatim + custom_vocabulary do jargão técnico). Sem
    // GEMINI_API_KEY o `resolveChain` cai no Groq sozinho — a escolha é por
    // presença de chave, não por lógica de seleção nova (provider-select).
    //
    // Transcription-only: o Interactions API do Google não tem endpoint de
    // tradução, então `translate: false` é FATO do provedor, não preferência.
    // Quem quiser PT→EN no ditado escolhe um provedor Whisper.
    type: 'stt',
    provider: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    auth: { type: 'api_key', envVar: 'GEMINI_API_KEY' },
    model: 'gemini-3.5-transcribe',
    translate: false,
    language: 'pt',
    outputMode: 'english',
    // Grok Voice Transcribe logo abaixo do head: batch rápido/barato na mesma
    // XAI_API_KEY do realtime, antes da cadeia Whisper (Groq → OpenAI → local).
    fallback: {
      ...DEFAULT_XAI_STT,
      fallback: DEFAULT_WHISPER_STT,
    },
  },
  // Gemini 3.8 Flash-Lite na cabeça; OpenAI → Piper → say seguem de reserva.
  tts: {
    ...DEFAULT_GEMINI_TTS,
    fallback: {
      type: 'tts',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/audio/speech',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      model: 'gpt-4o-mini-tts',
      voice: DEFAULT_OPENAI_VOICE,
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
          voice: 'Felipe',
        },
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

/**
 * Env var por provider para a MIGRAÇÃO de `audio-config.json` legada.
 *
 * Sem `gemini` de propósito: aquele formato é sempre Whisper, e o builder desta
 * migração produz um plugin com forma Whisper (endpoint `/audio/transcriptions`,
 * `model` do Whisper). Um `provider: 'gemini'` vindo de lá casaria com
 * `isGeminiStt` e mandaria JSON do Interactions API com `x-goog-api-key` para a
 * URL da Groq — falha garantida e uma tentativa queimada na cadeia.
 */
const KNOWN_ENV_VAR: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
};

/**
 * Migrate a legacy `audio-config.json` into a full NexusIDE voice config.
 * The STT block is derived from the legacy fields; the TTS block and local
 * fallbacks come from {@link DEFAULT_VOICE_CONFIG}. Pure — no I/O.
 *
 * A âncora é {@link DEFAULT_WHISPER_STT}, NÃO `DEFAULT_VOICE_CONFIG.stt`: uma
 * `audio-config.json` legada é sempre Whisper (Groq/OpenAI/whisper.cpp), e o
 * head do default hoje é o Gemini — herdar dele daria endpoint e modelo do
 * Google a uma config que nunca pediu isso.
 */
export function migrateLegacyVoiceConfig(raw: LegacyVoiceConfig): VoiceConfig {
  const provider = raw.provider ?? DEFAULT_WHISPER_STT.provider;
  const baseUrl = raw.baseUrl?.replace(/\/$/, '');
  const endpoint = baseUrl
    ? `${baseUrl}/audio/transcriptions`
    : DEFAULT_WHISPER_STT.endpoint;
  const translate = (raw.outputMode ?? 'english') === 'english';

  const stt: VoicePlugin = {
    type: 'stt',
    provider,
    endpoint,
    auth: { type: 'api_key', envVar: KNOWN_ENV_VAR[provider] ?? 'GROQ_API_KEY' },
    model: raw.model ?? DEFAULT_WHISPER_STT.model,
    translate,
    translateFrom: raw.language ?? 'pt',
    translateTo: 'en',
    language: raw.language ?? 'pt',
    outputMode: raw.outputMode ?? 'english',
    chunkMs: raw.chunkMs,
    streaming: false,
    vad: DEFAULT_WHISPER_STT.vad,
    fallback: DEFAULT_WHISPER_STT.fallback,
  };

  // peer ADE NexusVoice used bare Space as an in-app hold key. Keep that
  // window-scoped semantics instead of rewriting it to ⌘⇧Space.
  const rawKey = raw.pushToTalkKey?.code;
  const shortcut = rawKey
    ? rawKey === 'Space' || isWindowScopedShortcut(rawKey)
      ? normalizeKeyCode(rawKey)
      : accelFromCode(rawKey)
    : DEFAULT_VOICE_CONFIG.input.shortcut;

  return {
    ...DEFAULT_VOICE_CONFIG,
    // Dictation into the focused pane (peer ADE interactionMode: coding).
    routing: 'focused-pane',
    speakMode: 'off',
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

const ACCEL_MODIFIERS = new Set([
  'CommandOrControl',
  'Command',
  'Cmd',
  'Control',
  'Ctrl',
  'Alt',
  'Option',
  'Shift',
  'Super',
  'Meta',
]);

/**
 * Accelerators without modifiers (e.g. bare `Space`) are window-scoped — the
 * renderer owns keydown/keyup while Nexus is focused. Global `globalShortcut`
 * must never register bare Space: it would steal typing from every OS app.
 * Mirrors ADE NexusVoice (hold Space → STT → pane ativo).
 */
export function isWindowScopedShortcut(shortcut: string): boolean {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => !ACCEL_MODIFIERS.has(part));
}

/**
 * NexusVoice-style dictation: hold Space, speak PT, inject English into the
 * focused pane, no spoken reply. Caller persists via `voice.setConfig`.
 */
export function dictationEnPresetPatch(): {
  routing: 'focused-pane';
  speakMode: 'off';
  shortcut: 'Space';
  pushToTalkKeyCode: 'Space';
  wakeWordEnabled: false;
  jarvisLiveEnabled: false;
  sttProvider: 'groq';
} {
  return {
    routing: 'focused-pane',
    speakMode: 'off',
    shortcut: 'Space',
    pushToTalkKeyCode: 'Space',
    wakeWordEnabled: false,
    jarvisLiveEnabled: false,
    sttProvider: 'groq',
  };
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
