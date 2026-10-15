import { z } from 'zod';
import {
  HOLD_TO_TALK_MAX_MS,
  HOLD_TO_TALK_MIN_MS,
  type JarvisBrainProviderId,
  type RealtimeProviderKey,
  type VoiceRouting,
  type VoiceSpeakMode,
} from './voice-config';

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
  /**
   * A short VAD sample used only to verify a passive wake word. This is a
   * bounded, latency-first path: it may prioritize a fast cloud provider and
   * never waits on a slow local model after the deadline.
   */
  purpose: z.enum(['passive-wake']).optional(),
  /** Name expected in a passive wake transcription; never persisted as audio text. */
  passiveWakeWord: z.string().min(1).max(48).optional(),
  /**
   * Vocabulary/style bias forwarded to Whisper-compatible APIs (`prompt` form
   * field) and local whisper.cpp (`--prompt`). English text — the translations
   * endpoint conditions on English prompts. Used by dictation "code mode".
   */
  prompt: z.string().min(1).max(600).optional(),
  /**
   * Ditado no modo CODE: depois da STT, o main reescreve a fala como prompt em
   * inglês para o agente (code-prompt-polish). Falha devolve o texto da STT.
   */
  polish: z.enum(['code-prompt']).optional(),
  /**
   * ITEM 7: total wall-clock budget (ms) for the STT chain on the WAKE path.
   * When set, at most one cloud attempt runs (on a tight deadline) before
   * jumping to keyless local whisper, so a hung cloud provider can't hold a
   * conversational turn ~16s.
   */
  budgetMs: z.number().int().positive().max(60_000).optional(),
});

export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;

export const speakRequestSchema = z.object({
  text: z.string().min(1).max(20_000),
  /** Override the configured speakMode for this utterance (optional). */
  speakMode: z.enum(['summary', 'full', 'off']).optional(),
  /**
   * false = não registrar na janela anti-eco. Para acks/fillers curtos
   * ("Sim?", "Deixa comigo.") — registrá-los censurava respostas legítimas
   * parecidas do usuário logo em seguida.
   */
  echoRecord: z.boolean().optional(),
});

export type SpeakRequest = z.infer<typeof speakRequestSchema>;

export const voiceLogSchema = z.object({
  level: z.enum(['info', 'warn', 'error']),
  event: z.string().min(1).max(64),
  msg: z.string().max(500).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type VoiceLogPayload = z.infer<typeof voiceLogSchema>;

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
  /** Toggle Jarvis Live: continuous session mode over the Classic fallback. */
  jarvisLiveEnabled: z.boolean().optional(),
  /** Transporte da sessão live: FSM batch (classic) ou áudio realtime. */
  jarvisLiveTransport: z
    .enum(['classic', 'openai-realtime', 'gemini-live', 'grok-realtime'])
    .optional(),
  /** OpenAI Realtime model override, e.g. gpt-realtime-2.1 or gpt-realtime-2.1-mini. */
  jarvisLiveOpenaiModel: z.string().min(1).max(128).optional(),
  /** OpenAI Realtime voice override. */
  jarvisLiveOpenaiVoice: z.string().min(1).max(64).optional(),
  /** Gemini Live prebuilt voice override (e.g. Charon, Fenrir). */
  jarvisLiveGeminiVoice: z.string().min(1).max(64).optional(),
  /** Voz da cabeça da cadeia TTS (OpenAI ou Gemini, conforme o provider). */
  ttsVoice: z.string().min(1).max(64).optional(),
  /** Modelo do Gemini TTS na cabeça (Flash-Lite ou Flash). Ignorado para outros providers. */
  ttsModel: z.enum(['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']).optional(),
  /** Preferred chat-model provider for the Jarvis brain. */
  jarvisBrainProvider: z.enum(['gemini', 'openai', 'groq']).optional(),
  /** Persona da voz: nome do assistente / do usuário / instruções custom. */
  personaAssistantName: z.string().min(1).max(48).optional(),
  personaUserName: z.string().max(48).optional(),
  personaCustomInstructions: z.string().max(2_000).optional(),
  /** Modo de saída do ditado: tradução EN otimizada p/ execução ou PT literal. */
  dictationOutputMode: z.enum(['english', 'portuguese']).optional(),
  /** Atraso para ditar segurando Space (ms). */
  holdToTalkMs: z
    .number()
    .int()
    .min(HOLD_TO_TALK_MIN_MS)
    .max(HOLD_TO_TALK_MAX_MS)
    .optional(),
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
  model?: string;
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
  /**
   * Main-owned runtime gate. False for release automation and for the explicit
   * dev-only capture kill-switch; it never mutates the persisted voice config.
   */
  captureAllowed?: boolean;
  routing: VoiceRouting;
  speakMode: VoiceSpeakMode;
  shortcut: string;
  pushToTalkKeyCode: string;
  hotkeyMode: HotkeyMode;
  /**
   * `window` = bare key (e.g. Space) handled in the focused renderer.
   * `global` = Electron `globalShortcut` (⌘⇧Space etc.).
   */
  hotkeyScope?: 'global' | 'window';
  /**
   * Whether the global accelerator actually registered with the OS (false =
   * conflict with another app or invalid combo). Optional: composed at the
   * IPC layer; pure builders may omit it. Window-scoped keys report armed
   * whenever capture is allowed (no OS registration needed).
   */
  hotkeyArmed?: boolean;
  /** Modo de saída do ditado (paridade ClockVoice): EN execução ou PT literal. */
  dictationOutputMode?: 'english' | 'portuguese';
  /** Atraso (ms) para o Space armar o ditado ao ser segurado. */
  holdToTalkMs?: number;
  /** Wake word ("Jarvis") toggle + whether its Picovoice key is present. */
  wakeWordEnabled: boolean;
  /**
   * PID de outra instância viva segurando o wake-lock. Quando presente, esta
   * janela NÃO processa "Hey Jarvis" para evitar duas instâncias respondendo.
   */
  wakeLockHolderPid?: number | null;
  /** Secret-free echo-cancellation capability/health for diagnostics. */
  aec?: {
    backend:
      | 'wasm-aec3'
      | 'coreaudio-process-tap'
      | 'wasapi-loopback'
      | 'pipewire-monitor'
      | 'pulseaudio-monitor'
      | 'chromium-aec';
    native: boolean;
    degraded: boolean;
    reason: string;
  };
  jarvisLive: {
    enabled: boolean;
    /** 'classic' = FSM batch; os demais = áudio realtime ('grok-realtime' é o
     *  padrão oficial da voz). */
    transport: 'classic' | 'openai-realtime' | 'gemini-live' | 'grok-realtime';
    /** Modelo de voz da xAI em uso (sem segredo), para diagnosticar a conexão. */
    grokModel?: string;
    openaiModel: string;
    openaiVoice: string;
    /** Gemini Live prebuilt voice (Charon, Fenrir, …). */
    voiceName: string;
    graceReuseMs: number;
    dormantAfterMs: number;
    maxWindowTurns: number;
  };
  /** Voice id on the head of the TTS chain (gemini/openai/piper/macos-say). */
  ttsVoice?: string;
  /** Provider e modelo na cabeça da cadeia TTS — o seletor de voz depende deles. */
  ttsProvider?: string;
  ttsModel?: string;
  persona: {
    assistantName: string;
    userName?: string;
    customInstructions?: string;
  };
  jarvisBrain: ResolvedChain;
  hasWakeKey: boolean;
  keys: VoiceApiKeyStatus[];
  stt: ResolvedChain;
  tts: ResolvedChain;
}

/** Project-scoped proactive work update. Origin metadata lets the renderer
 * fail closed when the user is looking at another mission/pane. */
export interface VoiceNarrationEvent {
  text: string;
  eventId?: string;
  missionId?: string;
  paneId?: string;
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
       * silêncio, como faz com as alucinações do Whisper. 'ambient' = o
       * Clef-omni ouviu TV/ambiente no clipe da ativação passiva (F-1161).
       */
      discarded?: 'echo' | 'ambient';
      /** ITEM 7: the wake-path budget forced an early jump to local (stt.stall). */
      stalled?: boolean;
      /** F-1392: modelo do provider que atendeu (log de uso do ditado). */
      model?: string;
      /** F-1392: a reescrita do modo CODE rodou? Só tamanhos, nunca o texto. */
      polish?: { ok: boolean; rawChars: number; reason?: string };
      attempts: SttAttempt[];
    }
  | {
      ok: false;
      error: string;
      needsKey: boolean;
      /** ITEM 7: the wake-path budget forced an early jump to local (stt.stall). */
      stalled?: boolean;
      attempts: SttAttempt[];
    };

// ── JARVIS (assistente conversacional) ───────────────────────────────────────

export interface JarvisContext {
  workspace: string | null;
  /** Nome/tratamento configurado para o usuário, ex.: "patrão". */
  userName?: string | null;
  /** Resumo determinístico do que o usuário está vendo agora. */
  screen?: string | null;
  /** Workspaces recentes (nomes) — para open_workspace. */
  recents: string[];
  squads: string[];
  panes: string[];
  focusedPane: string | null;
  focusedPaneKind?: 'shell' | 'cli-agent' | 'browser' | null;
  focusedPaneUrl?: string | null;
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
  /** Opens the saved-squad selection step without creating or launching one. */
  | { type: 'open_squad_picker' }
  | { type: 'open_workspace'; workspaceName: string }
  | { type: 'design_squad' }
  | { type: 'confirm_squad' }
  | { type: 'new_mission' }
  /** Opens Nova Missão directly at Modo Agêntico; an optional goal seeds its objective. */
  | { type: 'new_agentic_mission'; intent?: string }
  | { type: 'new_workspace' }
  | { type: 'open_terminal' }
  | { type: 'open_agent'; agentId: string; model?: string }
  | { type: 'close_pane' }
  | { type: 'open_board' }
  | { type: 'open_settings' }
  | { type: 'open_voice_settings' }
  | { type: 'open_browser'; url?: string }
  | { type: 'browser_back' }
  | { type: 'browser_forward' }
  | { type: 'browser_reload' }
  | { type: 'focus_next_pane' }
  | { type: 'focus_previous_pane' }
  | { type: 'focus_pane'; paneName: string }
  | { type: 'read_pane'; paneId?: string }
  /** Reads the visible Nexus view through local accessibility + OCR context. */
  | { type: 'read_current_view' }
  // NEW-B: paneId targets the ASKING pane for routed pending-question answers.
  // Absent for model-emitted delegation (falls back to orchestrator/focused pane).
  | { type: 'send_to_pane'; text: string; paneId?: string }
  /** Safely fast-forward the current branch from origin without creating a mission. */
  | { type: 'sync_repository' }
  | { type: 'run_command'; command: string }
  | { type: 'mcp_tool'; tool: string; args: Record<string, unknown> }
  | { type: 'restore_mission_panes'; alvo?: string }
  | { type: 'ask_pane'; pergunta: string; paneId?: string }
  /**
   * User-facing repo update via AI CLI pane (not ProcessGitRunner / nexus_git_*).
   * mode defaults to pull when omitted by older callers.
   */
  | {
      type: 'sync_repo_via_pane';
      mode?: 'pull' | 'status' | 'push';
      paneId?: string;
    };

export interface JarvisReply {
  say: string;
  /** O cérebro sinaliza que espera resposta → a escuta reabre sozinha. */
  expectReply?: boolean;
  action: JarvisAction;
}

export type JarvisBrainProviderChoice = JarvisBrainProviderId;

export const jarvisRequestSchema = z.object({
  transcript: z.string().min(1).max(4000),
  context: z.object({
    workspace: z.string().nullable(),
    userName: z.string().max(48).nullable().optional(),
    screen: z.string().max(1000).nullable().optional(),
    recents: z.array(z.string().max(128)).max(20).default([]),
    squads: z.array(z.string().max(128)).max(50),
    panes: z.array(z.string().max(128)).max(50),
    focusedPane: z.string().max(128).nullable(),
    focusedPaneKind: z.enum(['shell', 'cli-agent', 'browser']).nullable().optional(),
    focusedPaneUrl: z.string().max(4096).nullable().optional(),
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

/**
 * Settings diagnostics intentionally do not carry a workspace context. This
 * keeps the button useful before the first project is opened without turning
 * the project-scoped `voice:jarvis` route into an unscoped command channel.
 */
export const jarvisSmokeTestRequestSchema = z.object({
  transcript: z.string().min(1).max(4000),
});

export type JarvisSmokeTestRequest = z.infer<
  typeof jarvisSmokeTestRequestSchema
>;

export type SpeakResult =
  | { ok: true; provider: string; mode: 'played'; fallbackNote?: string }
  | {
      ok: true;
      provider: string;
      mode: 'audio';
      format: string;
      audioBase64: string;
      fallbackNote?: string;
    }
  | { ok: true; provider: string; mode: 'silent'; fallbackNote?: string }
  | { ok: false; error: string };

// ── JARVIS LIVE (continuous session mode) ───────────────────────────────────

export type JarvisLiveStatus =
  | 'off'
  | 'dormant'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'error';

export interface JarvisLiveState {
  enabled: boolean;
  sessionId: string | null;
  status: JarvisLiveStatus;
  /** True only after the realtime transport socket is connected and setup-complete. */
  realtimeReady: boolean;
  /**
   * Por que a rota realtime NÃO conectou. Categoria estável, nunca texto cru do
   * provedor: o operador precisa de um motivo acionável ("chave recusada",
   * "modelo inexistente"), e um erro de socket cru não é traduzível nem
   * seguro para log. Ausente = nada tentou ainda.
   */
  realtimeFailure?: RealtimeFailure | null;
  /** Rota realtime que conectou de fato — pode ser diferente da configurada. */
  realtimeProvider?: RealtimeProviderKey | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  turns: number;
  pendingMic: boolean;
  error?: string;
}

/**
 * Motivo de uma conexão realtime mal-sucedida. O conjunto é fechado de
 * propósito: cada categoria mapeia UMA ação para quem está olhando a tela.
 * `no_key`/`vault_unreadable` são decididos no Main antes de qualquer fetch
 * (nenhuma rota tinha credencial utilizável).
 */
export type RealtimeFailureCategory =
  | 'auth_rejected'
  | 'model_rejected'
  | 'timeout'
  | 'closed_before_setup'
  | 'network'
  | 'provider_error'
  | 'no_key'
  | 'vault_unreadable';

export interface RealtimeFailure {
  category: RealtimeFailureCategory;
  /** Rota que caiu (nunca a chave, nunca o id do modelo completo de credencial). */
  provider: RealtimeProviderKey | null;
  /** Modelo tentado, quando a rota tem um. Sem segredo: é id público. */
  model?: string;
  /** Status HTTP do handshake quando o provedor respondeu (ex.: 404). */
  status?: number;
  /** Quantas rotas caíram nesta tentativa (1 quando só havia uma). */
  attempts: number;
  at: number;
}

export interface JarvisLiveStartRequest {
  reason?: 'manual' | 'wake' | 'click' | 'ptt' | 'reply';
  /** Optional bounded provider greeting; main serializes it before any mic flush. */
  greeting?: string;
}

export interface JarvisLiveSmokeTestRequest {
  text: string;
}

/** One PCM delivery emitted by main and scheduled by the renderer WebAudio queue. */
export interface JarvisLiveAudioOutEvent {
  /** Main-generated correlation id; acknowledgements for unknown ids are ignored. */
  id: string;
  /** PCM16 little-endian, base64 encoded. */
  pcm16: string;
}

export type JarvisLiveAudioPlaybackOutcome = 'started' | 'failed' | 'cancelled';

/** Renderer evidence for the exact PCM delivery it received from main. */
export interface JarvisLiveAudioPlaybackEvent {
  id: string;
  outcome: JarvisLiveAudioPlaybackOutcome;
  /** Bounded diagnostic only; it never becomes user-facing provider output. */
  error?: string;
}

export type JarvisLiveSmokeFailureReason =
  | 'busy'
  | 'invalid_request'
  | 'realtime_unavailable'
  | 'provider_error'
  | 'response_timeout'
  | 'no_audio_response'
  | 'audio_playback_failed'
  | 'session_closed';

export type JarvisLiveSmokeTestResult =
  | {
      ok: true;
      evidence: 'audio';
      latencyMs: number;
      state: JarvisLiveState;
    }
  | {
      ok: false;
      evidence: 'none';
      latencyMs: null;
      reason: JarvisLiveSmokeFailureReason;
      state: JarvisLiveState;
    };

export interface JarvisLiveSayRequest {
  text: string;
}

export interface JarvisLiveRescueRequest {
  /** Renderer turn identity; retries with the same id are idempotent. */
  turnId: string;
  /** Locally transcribed and wake-filtered user utterance. */
  text: string;
}

export interface JarvisLiveRescueResult {
  accepted: boolean;
  turnId: string;
}

export interface JarvisLiveStatusPatch {
  status: Exclude<JarvisLiveStatus, 'off'>;
  pendingMic?: boolean;
  realtimeReady?: boolean;
  error?: string;
  /**
   * `undefined` PRESERVA a falha já registrada (um patch de status não pode
   * apagar o motivo de uma queda anterior); `null` limpa explicitamente, que é
   * o que o sucesso e o stop() fazem.
   */
  realtimeFailure?: RealtimeFailure | null;
  realtimeProvider?: RealtimeProviderKey | null;
}

export interface JarvisLiveTranscriptEvent {
  sessionId: string;
  /** Renderer turn identity; prevents late provider finals entering a new wait. */
  turnId?: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
  at: number;
}

export interface JarvisTranscriptAppendEvent {
  id: string;
  sessionId: string;
  sequence: number;
  projectId: string;
  checkoutId: string;
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  audio_url: string | null;
  final: boolean;
}

export interface JarvisLiveToolEvent {
  sessionId: string;
  tool: JarvisAction['type'];
  summary: string;
  source?: 'classic' | 'realtime';
  callId?: string;
  name?: string;
  args?: Record<string, unknown>;
  at: number;
}

export interface JarvisLiveToolResultEvent extends JarvisLiveToolEvent {
  ok: boolean;
  output?: unknown;
}

/** Provider turn completion correlated to a realtime tool result. */
export interface JarvisLiveToolTurnCompleteEvent {
  sessionId: string;
  /** Renderer turn id that issued the tool result. */
  turnId: string;
  callId: string;
  at: number;
}

export type JarvisLiveToolCancellationReason =
  | 'provider_cancelled'
  | 'timeout'
  | 'session_closed';

/** Main-owned cancellation of one Live function call. */
export interface JarvisLiveToolCancellationEvent {
  sessionId: string;
  callId: string;
  name?: string;
  tool?: JarvisAction['type'];
  reason: JarvisLiveToolCancellationReason;
  summary: string;
  at: number;
}

export interface JarvisLiveInterruptEvent {
  sessionId: string | null;
  reason: string;
  at: number;
}

export const jarvisLiveStartRequestSchema = z
  .object({
    reason: z.enum(['manual', 'wake', 'click', 'ptt', 'reply']).optional(),
    greeting: z.string().trim().min(1).max(400).optional(),
  })
  .default({});

export const jarvisLiveSmokeTestRequestSchema = z.object({
  text: z.string().min(1).max(1000),
});

export const jarvisLiveAudioPlaybackEventSchema = z
  .object({
    id: z.string().uuid(),
    outcome: z.enum(['started', 'failed', 'cancelled']),
    error: z.string().trim().min(1).max(280).optional(),
  })
  .strict();

export const jarvisLiveSayRequestSchema = z.object({
  text: z.string().min(1).max(1000),
});

export const jarvisLiveRescueRequestSchema = z.object({
  turnId: z.string().min(1).max(128),
  text: z.string().min(1).max(20_000),
});

/** Categoria fechada: o renderer traduz cada uma para UM motivo acionável. */
export const realtimeFailureCategorySchema = z.enum([
  'auth_rejected',
  'model_rejected',
  'timeout',
  'closed_before_setup',
  'network',
  'provider_error',
  'no_key',
  'vault_unreadable',
]);

export const realtimeFailureSchema = z.object({
  category: realtimeFailureCategorySchema,
  provider: z.enum(['grok', 'openai', 'gemini']).nullable(),
  // Id público de modelo; nunca a credencial. Limitado para não aceitar lerdeza.
  model: z.string().max(128).optional(),
  status: z.number().int().min(100).max(599).optional(),
  attempts: z.number().int().min(1).max(8),
  at: z.number().min(0),
});

export const jarvisLiveStatusPatchSchema = z.object({
  status: z.enum([
    'dormant',
    'listening',
    'thinking',
    'speaking',
    'interrupted',
    'error',
  ]),
  pendingMic: z.boolean().optional(),
  realtimeReady: z.boolean().optional(),
  error: z.string().max(500).optional(),
  realtimeFailure: realtimeFailureSchema.nullable().optional(),
  realtimeProvider: z.enum(['grok', 'openai', 'gemini']).nullable().optional(),
});

export const jarvisLiveTranscriptInputSchema = z.object({
  turnId: z.string().min(1).max(128).optional(),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(20_000),
  final: z.boolean().default(true),
});

export const jarvisLiveToolResultInputSchema = z.object({
  callId: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(128).optional(),
  source: z.enum(['classic', 'realtime']).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  tool: z.enum([
    'none',
    'open_squad',
    'open_squad_picker',
    'open_workspace',
    'design_squad',
    'confirm_squad',
    'new_mission',
    'new_agentic_mission',
    'new_workspace',
    'open_terminal',
    'close_pane',
    'open_board',
    'open_settings',
    'open_voice_settings',
    'open_browser',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'focus_next_pane',
    'focus_previous_pane',
    'focus_pane',
    'read_pane',
    'read_current_view',
    'send_to_pane',
    'run_command',
    'mcp_tool',
    'restore_mission_panes',
    'ask_pane',
    'sync_repository',
    'sync_repo_via_pane',
  ]),
  summary: z.string().max(1000),
  ok: z.boolean(),
  output: z.unknown().optional(),
});

export const jarvisLiveInterruptRequestSchema = z
  .object({
    reason: z.string().min(1).max(200).default('interrupted'),
  })
  .default({ reason: 'interrupted' });
