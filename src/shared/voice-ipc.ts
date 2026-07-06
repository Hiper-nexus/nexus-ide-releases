import { z } from 'zod';
import type {
  JarvisBrainProviderId,
  VoiceRouting,
  VoiceSpeakMode,
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
  jarvisLiveTransport: z.enum(['classic', 'gemini-live']).optional(),
  /** Preferred chat-model provider for the Jarvis brain. */
  jarvisBrainProvider: z.enum(['gemini', 'openai', 'groq']).optional(),
  /** Persona da voz: nome do assistente / do usuário / instruções custom. */
  personaAssistantName: z.string().min(1).max(48).optional(),
  personaUserName: z.string().max(48).optional(),
  personaCustomInstructions: z.string().max(2_000).optional(),
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
  /**
   * PID de outra instância viva segurando o wake-lock. Quando presente, esta
   * janela NÃO processa "Hey Jarvis" para evitar duas instâncias respondendo.
   */
  wakeLockHolderPid?: number | null;
  jarvisLive: {
    enabled: boolean;
    /** 'classic' = FSM sobre pipeline batch; 'gemini-live' = áudio realtime. */
    transport: 'classic' | 'gemini-live';
    graceReuseMs: number;
    dormantAfterMs: number;
    maxWindowTurns: number;
  };
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
  /** Resumo determinístico do que o usuário está vendo agora. */
  screen?: string | null;
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
  | { type: 'open_terminal' }
  | { type: 'close_pane' }
  | { type: 'open_board' }
  | { type: 'send_to_pane'; text: string }
  | { type: 'run_command'; command: string };

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
    screen: z.string().max(500).nullable().optional(),
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
  startedAt: number | null;
  lastActiveAt: number | null;
  turns: number;
  pendingMic: boolean;
  error?: string;
}

export interface JarvisLiveStartRequest {
  reason?: 'manual' | 'wake' | 'ptt' | 'reply';
}

export interface JarvisLiveStatusPatch {
  status: Exclude<JarvisLiveStatus, 'off'>;
  pendingMic?: boolean;
  realtimeReady?: boolean;
  error?: string;
}

export interface JarvisLiveTranscriptEvent {
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
  at: number;
}

export interface JarvisLiveToolEvent {
  sessionId: string;
  tool: JarvisAction['type'];
  summary: string;
  at: number;
}

export interface JarvisLiveToolResultEvent extends JarvisLiveToolEvent {
  ok: boolean;
}

export interface JarvisLiveInterruptEvent {
  sessionId: string | null;
  reason: string;
  at: number;
}

export const jarvisLiveStartRequestSchema = z
  .object({
    reason: z.enum(['manual', 'wake', 'ptt', 'reply']).optional(),
  })
  .default({});

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
});

export const jarvisLiveTranscriptInputSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().max(20_000),
  final: z.boolean().default(true),
});

export const jarvisLiveToolResultInputSchema = z.object({
  tool: z.enum([
    'none',
    'open_squad',
    'open_workspace',
    'design_squad',
    'new_mission',
    'open_terminal',
    'close_pane',
    'open_board',
    'send_to_pane',
    'run_command',
  ]),
  summary: z.string().max(1000),
  ok: z.boolean(),
});

export const jarvisLiveInterruptRequestSchema = z
  .object({
    reason: z.string().min(1).max(200).default('interrupted'),
  })
  .default({ reason: 'interrupted' });
