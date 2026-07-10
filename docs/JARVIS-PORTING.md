# JARVIS Voice System — Porting Guide

Guia de referência para reimplementar o sistema de voz JARVIS do nexus-ide em outro app Electron (ou stack equivalente com main/renderer/preload). Cada seção cita `arquivo:linha` real do código de produção — os contratos, guardrails e passos abaixo são o que **precisa** existir para paridade, não uma descrição idealizada. Trate os fragmentos de código como verdade de campo: eles refletem decisões tomadas ao vivo (calibração de ganho, deadlines, mutexes cross-instância) que só fazem sentido depois de um bug real.

## Índice

- [1. Visão geral e filosofia](#1-visão-geral-e-filosofia)
- [2. Arquitetura macro](#2-arquitetura-macro)
- [3. Contratos travados (`src/shared/voice-*.ts` + preload bridge)](#3-contratos-travados-srcsharedvoice-ts--preload-bridge)
- [4. Os 11 passos do turno Classic](#4-os-11-passos-do-turno-classic)
- [5. Os 14 guardrails](#5-os-14-guardrails)
- [6. Subsistemas por lane](#6-subsistemas-por-lane)
  - [6.1 Wake / anti-echo](#61-wake--anti-echo)
  - [6.2 Captura + AGC](#62-captura--agc)
  - [6.3 STT](#63-stt)
  - [6.4 TTS](#64-tts)
  - [6.5 Brain + fastpath + tool-catalog + memory](#65-brain--fastpath--tool-catalog--memory)
  - [6.6 Prefs / HUD](#66-prefs--hud)
- [7. Modo gemini-live hibernado](#7-modo-gemini-live-hibernado)
- [8. Guia de reimplementação passo a passo](#8-guia-de-reimplementação-passo-a-passo)

---

## 1. Visão geral e filosofia

O JARVIS tem **dois executores de turno** que compartilham o mesmo cérebro (`jarvisThink`) e o mesmo executor de ações (`executeJarvisAction`):

- **Classic** — o executor de **produção**. Turno determinístico e discreto: captura → wake → STT → brain → ação → TTS → (talvez) reabre escuta. Cada etapa é um passo com deadline próprio; nada fica pendurado para sempre. É o caminho que roda em toda instalação.
- **gemini-live / openai-realtime** — executores **realtime** full-duplex. O código está compilado, testado e integrado, mas o `transport` padrão é `'classic'`, então **nenhum socket realtime é aberto em produção**. O gemini-live em particular está **hibernado de propósito** (ver §7): a plumbing existe para reativação por env var ou config, mas a decisão de engenharia é que o Classic é o caminho suportado.

**Por que Classic é a produção — a filosofia:**

1. **Determinismo sobre latência.** Um turno realtime é mais fluido, mas o Classic é *observável e interrompível a cada fronteira*. Cada passo (STT, brain, TTS) tem um `withTimeout` no renderer **e** um `AbortSignal`/deadline no main. Quando algo trava — socket pendurado, LLM lento, chave inválida — o turno morre num limite conhecido e o pipeline se libera, em vez de deixar a JARVIS "surda para sempre" (o bug que motivou o barge-in total, `voice-controller.ts:422-430`).

2. **Fallback que nunca perde a intenção.** Toda cadeia é `error-driven` e degrada para um provider keyless: STT cai para whisper.cpp local, TTS cai para `macos-say` (sempre disponível), o brain cai de Gemini → OpenAI → Groq. Mesmo sem nenhuma API key, um turno Classic **completa**. O realtime, por contraste, ou conecta o socket ou cai de volta no Classic — nunca há um estado meio-conectado que engole a fala.

3. **Segurança na fronteira do processo.** O cérebro e a memória vivem no **main**; segredos (`process.env`, secure storage) nunca cruzam para o renderer. Ações destrutivas exigem um `dialog.showMessageBox` nativo que o renderer não pode forjar (guardrail #14). Prompt-injection no transcrito não vira `rm -rf` sem um OK humano explícito.

4. **Um cérebro, dois transportes.** Os live turns roteiam pelo **mesmo** `jarvisThink`/`executeJarvisAction` que o Classic — não há um path paralelo de decisão. O `LiveTransportController` só carrega áudio e transcrição; a decisão de ação continua sendo do `jarvis-brain`. Isso é o que torna o realtime reativável sem duplicar lógica: ele pluga no mesmo executor.

O resto deste documento descreve o turno **Classic** em detalhe (é o que você porta primeiro) e trata o realtime como uma camada opcional que se encaixa nas mesmas costuras.

---

## 2. Arquitetura macro

### 2.1 Fluxo de um turno Classic

```
┌─────────────────────────────────────── RENDERER ───────────────────────────────────────┐
│                                                                                          │
│   [1] Captura quente (WakeMic, stream always-on 16kHz, APM off)                          │
│        │  chunks de 1280 samples Float32                                                 │
│        ▼  IPC send  voice:wakeAudio (ArrayBuffer)                                        │
└────────┼─────────────────────────────────────────────────────────────────────────────┘
         ▼
┌─────── MAIN ───────────────────────────────────────────────────────────────────────────┐
│   [2] Wake detection (WakeEngine, ONNX mel→emb→wake, wake-lock mutex)                    │
│        │  broadcast  voice:wake.detected                                                 │
└────────┼─────────────────────────────────────────────────────────────────────────────┘
         ▼
┌─────── RENDERER (voice-controller) ────────────────────────────────────────────────────┐
│   [3] Barge-in / gate  →  stopAllPlayback, cancelUtterance, capture.stop                 │
│   [4] Wake ACK ("Pois não, patrão?")  +  suppressWakeDetection(8s)                       │
│   [5] Utterance capture  (beginUtterance sobre o stream quente, pre-roll 2.5s)           │
│   [6] Auto-stop  →  finishUtterance()  →  WAV 16kHz base64                               │
│        │  IPC invoke  voice:transcribe (TranscribeRequest)                               │
└────────┼─────────────────────────────────────────────────────────────────────────────┘
         ▼
┌─────── MAIN ───────────────────────────────────────────────────────────────────────────┐
│   [7] STT (stt-service, chain groq→openai→whisper.cpp)  +  echoSuppressor.isEcho()       │
│        │  TranscribeResult { text | discarded:'echo' }                                   │
└────────┼─────────────────────────────────────────────────────────────────────────────┘
         ▼
┌─────── RENDERER ───────────────────────────────────────────────────────────────────────┐
│   [8] Filtro de transcrição (echo / wake-ack / Whisper ghosts)                           │
│        │  IPC invoke  voice:jarvis (JarvisRequest)                                       │
└────────┼─────────────────────────────────────────────────────────────────────────────┘
         ▼
┌─────── MAIN (jarvis-brain) ────────────────────────────────────────────────────────────┐
│   [9] Brain  →  action fastpath → state fastpath → LLM chain (AbortSignal 15s)           │
│        │  applyMemoryOps → parseReply  →  JarvisReply { say, action, expectReply }       │
└────────┼─────────────────────────────────────────────────────────────────────────────┘
         ▼
┌─────── RENDERER (jarvis-action-executor) ──────────────────────────────────────────────┐
│  [10] Execução da ação  →  MCP-first (invoke→confirm→invoke) ou UI-path (Zustand)        │
│        │  (run_command / write / push exigem dialog nativo no MAIN — guardrail #14)      │
│  [11] TTS (speak, pipelined por sentença)  →  playSpeakResult                            │
│        │  recordEcho + suppressWakeDetection(dinâmico)                                   │
│        ▼  shouldReopenJarvisListening?                                                   │
│        ├── sim → volta ao passo [5] (captureReason='reply', guard anti-loop MAX=5)       │
│        └── não → liveEndTurn() → fim do turno                                            │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Split de processos e quem vive onde

O sistema é dividido em quatro superfícies. O contrato entre elas (§3) é a fronteira que o porte precisa preservar bit a bit.

| Processo | Papel | Lanes / módulos principais |
|---|---|---|
| **shared** | Tipos e schemas Zod compartilhados; nomes de canais IPC. Sem lógica de runtime. | `voice-channels.ts` (nomes dos canais), `voice-ipc.ts` (schemas de request + tipos de result/event), `voice-config.ts` (shape `VoiceConfig` + defaults) |
| **preload** | Ponte `contextBridge` — expõe `window.nexus.voice.*` ao renderer com `contextIsolation`. Nenhum segredo, só `ipcRenderer.invoke/send/on` embrulhados. | `preload.ts:366-411` (superfície `voice`) |
| **main** (Node/Electron) | Tudo que toca rede, disco, segredos, modelos nativos e diálogos do SO. É onde vive o **cérebro** e a **inferência de wake**. | Wake ONNX (`wake-engine.ts`, `wake-models.ts`, `wake-lock.ts`), STT (`stt-service.ts`, `provider-select.ts`, `voice-secrets.ts`), TTS (`tts-service.ts`, `jarvis-narrator.ts`), Brain (`jarvis-brain.ts`, `jarvis-fastpath.ts`, `jarvis-action-fastpath.ts`, `jarvis-tool-catalog.ts`, `jarvis-memory.ts`), Live FSM/transporte (`jarvis-live.ts`, `live-transport-controller.ts`, `jarvis/realtime/*`), governança (`jarvis/guardrails.ts`, `permissions.ts`, `confirmation-tokens.ts`, `transcript-store.ts`, `mcp-ipc.ts`), orquestração IPC (`voice-ipc.ts`, `voice-hotkey.ts`) |
| **renderer** (Chromium) | Captura de áudio (getUserMedia/AudioWorklet), reprodução, filtro de transcrição, executor de ação na UI, store Zustand e o HUD. É onde a **mídia** e a **UI** vivem. | Captura (`wake-mic.ts`, `voice-capture.ts`, `agc.ts`), playback (`voice-playback.ts`), controle de turno (`voice-controller.ts`, `jarvis-reply-loop.ts`), filtros (`transcript-filter.ts`, `response-echo.ts`, `wake-health.ts`, `wake-rearm.ts`, `voice-wake-ack.ts`, `manual-wake.ts`), executor UI (`jarvis-action-executor.ts`, `mcp-bridge.ts`), estado/HUD (`voice-store.ts`, `hud-prefs.ts`, `VoiceHud.tsx`, `VoiceSettings.tsx`, `VoiceButton.tsx`) |

**Como os processos se ligam (IPC):** o renderer nunca fala com rede/disco diretamente. Toda operação privilegiada passa pela ponte preload → canal IPC → handler no main. O catálogo completo de canais (invoke/send/event), seus payloads e onde cada handler é registrado está travado em **§3.1**. O ciclo de vida (`registerVoiceIpc()` / `closeVoiceIpc()`) e as duas "costuras quentes" (singleton `liveSession`, stream `wakeAudio`) estão em **§3.4–3.6**. Os 11 passos do turno, com o `arquivo:linha` de cada handoff renderer↔main, estão em **§4**.

**Regra de ouro do split:** segredos e decisões destrutivas ficam no main; mídia e UI ficam no renderer; o shared só carrega forma (tipos/schemas), nunca comportamento. Qualquer porte que vaze uma API key para o renderer ou deixe o renderer executar um comando sem o diálogo nativo do main quebrou o modelo de segurança — não é mais o JARVIS.

---

## 3. Contratos travados (`src/shared/voice-*.ts` + preload bridge)

### 3.1 Catálogo de canais IPC

Todos os nomes vêm de `src/shared/voice-channels.ts` (`VOICE_CHANNELS` as const, linha 6).

| Canal | Direção | Payload (tipo real) | Onde registra (file:line) |
|---|---|---|---|
| `voice:getInfo` | invoke renderer→main | _(sem payload)_ → `VoiceRuntimeInfo` | `src/main/voice/voice-ipc.ts:120` |
| `voice:setConfig` | invoke renderer→main | `SetConfigRequest` → `VoiceRuntimeInfo` | `src/main/voice/voice-ipc.ts:122` |
| `voice:setKey` | invoke renderer→main | `SetVoiceKeyRequest` → `{ok:boolean; error?:string}` | `src/main/voice/voice-ipc.ts:142` |
| `voice:transcribe` | invoke renderer→main | `TranscribeRequest` → `TranscribeResult` | `src/main/voice/voice-ipc.ts:151` |
| `voice:speak` | invoke renderer→main | `SpeakRequest` → `SpeakResult` | `src/main/voice/voice-ipc.ts:278` |
| `voice:speak.stop` | invoke renderer→main | _(sem payload)_ | `src/main/voice/voice-ipc.ts:297` |
| `voice:recordEcho` | invoke renderer→main | `{text: string}` → `{ok: true}` | `src/main/voice/voice-ipc.ts:289` |
| `voice:jarvis` | invoke renderer→main | `JarvisRequest` → `JarvisReply` | `src/main/voice/voice-ipc.ts:255` |
| `voice:confirmCommand` | invoke renderer→main | `string` (comando) → `boolean` | `src/main/voice/voice-ipc.ts:305` |
| `voice:live.start` | invoke renderer→main | `JarvisLiveStartRequest` → `JarvisLiveState` | `src/main/voice/voice-ipc.ts:329` |
| `voice:live.stop` | invoke renderer→main | _(sem payload)_ → `JarvisLiveState` | `src/main/voice/voice-ipc.ts:341` |
| `voice:live.endTurn` | invoke renderer→main | _(sem payload)_ → `JarvisLiveState` | `src/main/voice/voice-ipc.ts:345` |
| `voice:live.smokeTest` | invoke renderer→main | `JarvisLiveSmokeTestRequest` → `JarvisLiveState` | `src/main/voice/voice-ipc.ts:349` |
| `voice:live.status` | invoke renderer→main | `JarvisLiveStatusPatch` → `JarvisLiveState` | `src/main/voice/voice-ipc.ts:365` |
| `voice:live.interrupt` | invoke renderer→main | `{reason: string}` → `JarvisLiveState` | `src/main/voice/voice-ipc.ts:384` |
| `voice:wakeAudio` | send renderer→main | `ArrayBuffer` (PCM Float32 16 kHz frames) | `src/main/voice/voice-ipc.ts:179` |
| `voice:live.mic.in` | send renderer→main | `string` (base64 PCM 16 kHz) | `src/main/voice/voice-ipc.ts:356` |
| `voice:live.context.in` | send renderer→main | `string` (texto de contexto de tela) | `src/main/voice/voice-ipc.ts:361` |
| `voice:live.transcript.in` | send renderer→main | `JarvisLiveTranscriptEvent` (via zod `jarvisLiveTranscriptInputSchema`) | `src/main/voice/voice-ipc.ts:371` |
| `voice:live.tool.result.in` | send renderer→main | `JarvisLiveToolResultEvent` (via `jarvisLiveToolResultInputSchema`) | `src/main/voice/voice-ipc.ts:377` |
| `voice:log` | send renderer→main | `VoiceLogPayload` | `src/main/voice/voice-ipc.ts:237` |
| `voice:openMicSettings` | send renderer→main | _(sem payload)_ | `src/main/voice/voice-ipc.ts:246` |
| `voice:openSoundSettings` | send renderer→main | _(sem payload)_ | `src/main/voice/voice-ipc.ts:250` |
| `voice:wake.detected` | event main→renderer | _(sem payload)_ | `src/main/voice/voice-ipc.ts:219` (via `broadcast`) |
| `voice:ptt.start` | event main→renderer | _(sem payload)_ | `src/main/voice/voice-ipc.ts:96` (via `broadcast`) |
| `voice:ptt.stop` | event main→renderer | _(sem payload)_ | `src/main/voice/voice-ipc.ts:97` (via `broadcast`) |
| `voice:ptt.toggle` | event main→renderer | _(sem payload)_ | `src/main/voice/voice-ipc.ts:98` (via `broadcast`) |
| `voice:info.changed` | event main→renderer | `VoiceRuntimeInfo` | `src/main/voice/voice-ipc.ts:138` (via `broadcast`) |
| `voice:narrate` | event main→renderer | `{text: string}` | `src/main/voice/voice-ipc.ts:117` (via `initJarvisNarrator`) |
| `voice:live.state` | event main→renderer | `JarvisLiveState` | emitido por `JarvisLiveSession` via `broadcast` |
| `voice:live.transcript` | event main→renderer | `JarvisLiveTranscriptEvent` | emitido por `JarvisLiveSession` via `broadcast` |
| `jarvis:transcript-append` | event main→renderer | `JarvisTranscriptAppendEvent` | `src/main/voice/voice-ipc.ts:82` (via `broadcast`) |
| `voice:live.audio.out` | event main→renderer | `string` (base64 PCM 24 kHz TTS) | emitido por `LiveTransportController` via `broadcast` |
| `voice:live.tool.call` | event main→renderer | `JarvisLiveToolEvent` | emitido por `JarvisLiveSession` via `broadcast` |
| `voice:live.tool.result` | event main→renderer | `JarvisLiveToolResultEvent` | emitido por `JarvisLiveSession` via `broadcast` |
| `voice:live.interrupted` | event main→renderer | `JarvisLiveInterruptEvent` | emitido por `JarvisLiveSession`/`LiveTransportController` via `broadcast` |

---

### 3.2 Tipos de payload (`src/shared/voice-ipc.ts`)

#### Renderer → Main (request schemas validados com Zod)

```ts
// src/shared/voice-ipc.ts:16-27
export const transcribeRequestSchema = z.object({
  audioBase64: z.string().min(1).max(50_000_000),
  mime: z.enum(['audio/wav', 'audio/pcm', 'audio/webm']).default('audio/wav'),
  sampleRate: z.number().int().positive().max(192_000).default(16_000),
  translate: z.boolean().optional(),
  language: z.string().min(2).max(8).optional(),
});
export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;

// src/shared/voice-ipc.ts:29-41
export const speakRequestSchema = z.object({
  text: z.string().min(1).max(20_000),
  speakMode: z.enum(['summary', 'full', 'off']).optional(),
  echoRecord: z.boolean().optional(),
});
export type SpeakRequest = z.infer<typeof speakRequestSchema>;

// src/shared/voice-ipc.ts:43-50
export const voiceLogSchema = z.object({
  level: z.enum(['info', 'warn', 'error']),
  event: z.string().min(1).max(64),
  msg: z.string().max(500).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type VoiceLogPayload = z.infer<typeof voiceLogSchema>;

// src/shared/voice-ipc.ts:52-77
export const setConfigRequestSchema = z.object({
  enabled: z.boolean().optional(),
  routing: z.enum(['jarvis', 'focused-pane', 'orchestrator', 'ask']).optional(),
  speakMode: z.enum(['summary', 'full', 'off']).optional(),
  shortcut: z.string().min(1).max(64).optional(),
  pushToTalkKeyCode: z.string().min(1).max(32).optional(),
  sttProvider: z.string().min(1).max(64).optional(),
  ttsProvider: z.string().min(1).max(64).optional(),
  wakeWordEnabled: z.boolean().optional(),
  jarvisLiveEnabled: z.boolean().optional(),
  jarvisLiveTransport: z.enum(['classic', 'openai-realtime', 'gemini-live']).optional(),
  jarvisBrainProvider: z.enum(['gemini', 'openai', 'groq']).optional(),
  personaAssistantName: z.string().min(1).max(48).optional(),
  personaUserName: z.string().max(48).optional(),
  personaCustomInstructions: z.string().max(2_000).optional(),
});
export type SetConfigRequest = z.infer<typeof setConfigRequestSchema>;

// src/shared/voice-ipc.ts:79-89
export const setVoiceKeyRequestSchema = z.object({
  envVar: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/),
  key: z.string().max(4096),   // string vazia limpa a chave armazenada
});
export type SetVoiceKeyRequest = z.infer<typeof setVoiceKeyRequestSchema>;

// src/shared/voice-ipc.ts:236-262
export const jarvisRequestSchema = z.object({
  transcript: z.string().min(1).max(4000),
  context: z.object({
    workspace: z.string().nullable(),
    userName: z.string().max(48).nullable().optional(),
    screen: z.string().max(500).nullable().optional(),
    recents: z.array(z.string().max(128)).max(20).default([]),
    squads: z.array(z.string().max(128)).max(50),
    panes: z.array(z.string().max(128)).max(50),
    focusedPane: z.string().max(128).nullable(),
    focusedPaneKind: z.enum(['shell', 'cli-agent', 'browser']).nullable().optional(),
    focusedPaneUrl: z.string().max(4096).nullable().optional(),
    orchestrator: z.string().max(128).nullable().default(null),
    missions: z.array(z.string().max(160)).max(20).default([]),
  }),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(2000),
  })).max(12).default([]),
});
export type JarvisRequest = z.infer<typeof jarvisRequestSchema>;
```

#### Main → Renderer (result types e event payloads)

```ts
// src/shared/voice-ipc.ts:93-162
export type ProviderKind = 'cloud' | 'local' | 'system';

export interface ResolvedProvider {
  provider: string;
  kind: ProviderKind;
  available: boolean;
  model?: string;
  reason: string;
}

export interface ResolvedChain {
  active: ResolvedProvider | null;
  chain: ResolvedProvider[];
}

export type HotkeyMode = 'hold' | 'toggle';

export interface VoiceApiKeyStatus {
  envVar: string;
  providers: string[];
  hasEnv: boolean;
  hasStoredKey: boolean;
  keyMasked: string | null;
  secureStorageAvailable: boolean;
}

/** Snapshot sem segredos — nunca carrega chaves. */
export interface VoiceRuntimeInfo {
  enabled: boolean;
  routing: VoiceRouting;
  speakMode: VoiceSpeakMode;
  shortcut: string;
  pushToTalkKeyCode: string;
  hotkeyMode: HotkeyMode;
  hotkeyArmed?: boolean;
  wakeWordEnabled: boolean;
  wakeLockHolderPid?: number | null;
  jarvisLive: {
    enabled: boolean;
    transport: 'classic' | 'openai-realtime' | 'gemini-live';
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

// src/shared/voice-ipc.ts:170-185
export type TranscribeResult =
  | {
      ok: true;
      text: string;
      provider: string;
      fallbackNote?: string;
      discarded?: 'echo';       // eco do TTS → renderer descarta em silêncio
      attempts: SttAttempt[];
    }
  | { ok: false; error: string; needsKey: boolean; attempts: SttAttempt[] };

// src/shared/voice-ipc.ts:264-275
export type SpeakResult =
  | { ok: true; provider: string; mode: 'played'; fallbackNote?: string }
  | { ok: true; provider: string; mode: 'audio'; format: string; audioBase64: string; fallbackNote?: string }
  | { ok: true; provider: string; mode: 'silent'; fallbackNote?: string }
  | { ok: false; error: string };

// src/shared/voice-ipc.ts:213-225
export type JarvisAction =
  | { type: 'none' }
  | { type: 'open_squad'; squadName: string }
  | { type: 'open_workspace'; workspaceName: string }
  | { type: 'design_squad' }
  | { type: 'new_mission' }
  | { type: 'new_workspace' }
  | { type: 'open_terminal' }
  | { type: 'close_pane' }
  | { type: 'open_board' }
  | { type: 'send_to_pane'; text: string }
  | { type: 'run_command'; command: string }
  | { type: 'mcp_tool'; tool: string; args: Record<string, unknown> };

// src/shared/voice-ipc.ts:227-232
export interface JarvisReply {
  say: string;
  expectReply?: boolean;    // true → renderer reabre escuta automaticamente
  action: JarvisAction;
}
```

#### Jarvis Live — tipos de estado e eventos

```ts
// src/shared/voice-ipc.ts:279-298
export type JarvisLiveStatus =
  | 'off' | 'dormant' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error';

export interface JarvisLiveState {
  enabled: boolean;
  sessionId: string | null;
  status: JarvisLiveStatus;
  realtimeReady: boolean;       // true somente após socket conectado e setup-complete
  startedAt: number | null;
  lastActiveAt: number | null;
  turns: number;
  pendingMic: boolean;
  error?: string;
}

// src/shared/voice-ipc.ts:301-314
export interface JarvisLiveStartRequest   { reason?: 'manual' | 'wake' | 'ptt' | 'reply'; }
export interface JarvisLiveSmokeTestRequest { text: string; }
export interface JarvisLiveStatusPatch {
  status: Exclude<JarvisLiveStatus, 'off'>;
  pendingMic?: boolean;
  realtimeReady?: boolean;
  error?: string;
}

// src/shared/voice-ipc.ts:316-349
export interface JarvisLiveTranscriptEvent {
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
  at: number;
}

export interface JarvisTranscriptAppendEvent {
  sessionId: string;
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
  at: number;
}

export interface JarvisLiveToolResultEvent extends JarvisLiveToolEvent { ok: boolean; }

export interface JarvisLiveInterruptEvent {
  sessionId: string | null;
  reason: string;
  at: number;
}
```

---

### 3.3 Preload bridge (`src/preload/preload.ts:366-411`)

A superfície `window.nexus.voice` exposta via `contextBridge.exposeInMainWorld`. O outro JARVIS deve reimplementar cada método com o mesmo nome e assinatura.

```ts
// src/preload/preload.ts:366-411
voice: {
  // ── invokes (Promise) ──────────────────────────────────────────────
  getInfo:        () => ipcRenderer.invoke(VOICE_CHANNELS.getInfo),
  setConfig:      (patch) => ipcRenderer.invoke(VOICE_CHANNELS.setConfig, patch),
  setKey:         (req) => ipcRenderer.invoke(VOICE_CHANNELS.setKey, req),
  transcribe:     (req) => ipcRenderer.invoke(VOICE_CHANNELS.transcribe, req),
  speak:          (req) => ipcRenderer.invoke(VOICE_CHANNELS.speak, req),
  recordEcho:     (text: string) => ipcRenderer.invoke(VOICE_CHANNELS.recordEcho, { text }),
  stopSpeak:      () => ipcRenderer.invoke(VOICE_CHANNELS.speakStop),
  jarvis:         (req) => ipcRenderer.invoke(VOICE_CHANNELS.jarvis, req),
  confirmCommand: (command: string) => ipcRenderer.invoke(VOICE_CHANNELS.confirmCommand, command),
  liveStart:      (req) => ipcRenderer.invoke(VOICE_CHANNELS.liveStart, req ?? {}),
  liveStop:       () => ipcRenderer.invoke(VOICE_CHANNELS.liveStop),
  liveEndTurn:    () => ipcRenderer.invoke(VOICE_CHANNELS.liveEndTurn),
  liveSmokeTest:  (req) => ipcRenderer.invoke(VOICE_CHANNELS.liveSmokeTest, req),
  liveStatus:     (patch) => ipcRenderer.invoke(VOICE_CHANNELS.liveStatus, patch),
  liveInterrupt:  (reason) => ipcRenderer.invoke(VOICE_CHANNELS.liveInterrupt, { reason }),

  // ── fire-and-forget sends ──────────────────────────────────────────
  sendWakeAudio:    (chunk: ArrayBuffer) => ipcRenderer.send(VOICE_CHANNELS.wakeAudio, chunk),
  logVoice:         (payload) => ipcRenderer.send(VOICE_CHANNELS.logEvent, payload),
  openMicSettings:  () => ipcRenderer.send(VOICE_CHANNELS.openMicSettings),
  openSoundSettings:() => ipcRenderer.send(VOICE_CHANNELS.openSoundSettings),
  liveTranscript:   (event) => ipcRenderer.send(VOICE_CHANNELS.liveTranscriptIn, event),
  liveToolResult:   (event) => ipcRenderer.send(VOICE_CHANNELS.liveToolResultIn, event),
  liveMicIn:        (b64: string) => ipcRenderer.send(VOICE_CHANNELS.liveMicIn, b64),
  liveContextIn:    (text: string) => ipcRenderer.send(VOICE_CHANNELS.liveContextIn, text),

  // ── event subscriptions (main → renderer) ─────────────────────────
  onLiveAudioOut:     (cb: (b64: string) => void) => addListener(liveAudioOutListeners, cb),
  onPttToggle:        (cb: () => void) => addListener(pttToggleListeners, cb),
  onWakeDetected:     (cb: () => void) => addListener(wakeDetectedListeners, cb),
  onPttStart:         (cb) => addListener(pttStartListeners, cb),
  onPttStop:          (cb) => addListener(pttStopListeners, cb),
  onInfoChanged:      (cb) => addListener(voiceInfoListeners, cb),
  onNarrate:          (cb: (event: { text: string }) => void) => addListener(narrateListeners, cb),
  onLiveState:        (cb) => addListener(liveStateListeners, cb),
  onLiveTranscript:   (cb) => addListener(liveTranscriptListeners, cb),
  onTranscriptAppend: (cb) => addListener(transcriptAppendListeners, cb),
  onLiveToolCall:     (cb) => addListener(liveToolCallListeners, cb),
  onLiveToolResult:   (cb) => addListener(liveToolResultListeners, cb),
  onLiveInterrupted:  (cb) => addListener(liveInterruptedListeners, cb),
},
```

> **Nota de implementação:** todos os métodos `on*` usam um helper local `addListener(listenerSet, cb)` que grava o callback numa lista e retorna um unsubscribe. O `ipcRenderer.on` real é instalado uma única vez por canal no momento do `contextBridge.exposeInMainWorld` (não dentro do método `on*`). O outro JARVIS deve replicar essa injeção única de listener, não um listener por chamada de `on*`.

---

### 3.4 Ciclo de registro: `registerVoiceIpc()` / `closeVoiceIpc()`

#### Ponto de entrada — `src/main/main.ts`

```ts
// src/main/main.ts:47
import { registerVoiceIpc, closeVoiceIpc } from './voice/voice-ipc';

// src/main/main.ts:144  (dentro de bootstrap(), chamada em app.whenReady())
registerVoiceIpc();

// src/main/main.ts:249  (dentro de app.on('before-quit'))
closeVoiceIpc();
```

`bootstrap()` é chamado por `app.whenReady().then(bootstrap)` (linha 199). `closeVoiceIpc()` corre no handler `'before-quit'` (linha 243), garantindo que a voz seja desmontada antes do processo sair.

#### `registerVoiceIpc()` — `src/main/voice/voice-ipc.ts:112`

```ts
// src/main/voice/voice-ipc.ts:112
export function registerVoiceIpc(): void {
  loadVoiceConfig();          // lê + valida voice-config.json do disco
  wireHotkey();               // registra globalShortcut PTT + uiohook keyup
  initJarvisNarrator(broadcast); // narração proativa (handoff/travamento)
  liveSession.setEnabled(getVoiceConfig().jarvisLive.enabled);
  // ... todos os ipcMain.handle / ipcMain.on instalados aqui
}
```

#### `closeVoiceIpc()` — `src/main/voice/voice-ipc.ts:392`

```ts
// src/main/voice/voice-ipc.ts:392
export function closeVoiceIpc(): void {
  disposeVoiceHotkey();        // remove globalShortcut + uiohook listener
  shutdownJarvisNarrator();
  stopSystemSpeech();          // mata o processo `say` do macOS se rodando
  void wakeEngine?.dispose();  // libera sessões ONNX (memória nativa)
  wakeEngine = null;
  releaseWakeLock();           // libera o mutex de wake entre instâncias
}
```

> **Atenção:** `closeVoiceIpc()` **não** chama `ipcMain.removeHandler()`. Os handlers de IPC são removidos implicitamente quando o processo termina. O outro JARVIS não precisa desfazer os `handle`/`on`, mas deve garantir que `wakeEngine?.dispose()` e `releaseWakeLock()` rodem em `before-quit`.

---

### 3.5 Costura quente 1 — Singleton `liveSession` (voice-ipc.ts:73–87)

```ts
// src/main/voice/voice-ipc.ts:73-87
const liveSession = new JarvisLiveSession(broadcast, Date.now, (sessionId, line) => {
  jarvisLatencyTracker.markTranscript(sessionId, line.final);
  const record = transcriptStore.append(sessionId, {
    role: line.role,
    text: line.text,
    final: line.final,
    audio_url: null,
  });
  if (!record) return;
  broadcast(VOICE_CHANNELS.jarvisTranscriptAppend, {
    sessionId,
    ...record,
  });
});
const liveTransport = new LiveTransportController(broadcast, liveSession);
```

`liveSession` e `liveTransport` são **singletons de módulo** — instanciados uma vez no carregamento do módulo, antes de qualquer `app.whenReady()`. Todos os handlers de `voice:live.*` fecham sobre estas mesmas instâncias. O outro JARVIS deve:

1. Instanciar `JarvisLiveSession` passando `broadcast`, `Date.now`, e o callback de transcript (que persiste no `transcriptStore` e emite `jarvis:transcript-append`).
2. Instanciar `LiveTransportController` com as mesmas referências.
3. Manter ambos no escopo de módulo — NÃO dentro de `registerVoiceIpc()`.

---

### 3.6 Costura quente 2 — `wakePcmStream` (`voice:wakeAudio`, voice-ipc.ts:179)

```ts
// src/main/voice/voice-ipc.ts:179-233
ipcMain.on(VOICE_CHANNELS.wakeAudio, (_event, raw: unknown) => {
  if (!getVoiceConfig().wakeWord.enabled) return;
  // Mutex entre instâncias: só a dona do wake-lock processa frames.
  if (!acquireWakeLock()) { /* log + broadcast infoChanged + return */ return; }
  // Normaliza ArrayBuffer / ArrayBufferView (respeitando byteOffset/length).
  let frame: Float32Array | null = null;
  if (raw instanceof ArrayBuffer) {
    frame = new Float32Array(raw);
  } else if (ArrayBuffer.isView(raw)) {
    const v = raw as ArrayBufferView;
    frame = new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  }
  if (!frame || frame.length === 0 || frame.length > 16_384) return;
  // Lazy-init do WakeEngine (ONNX): cria na primeira entrega de frame.
  if (!wakeEngine) {
    wakeEngine = new WakeEngine(() => {
      broadcast(VOICE_CHANNELS.wakeDetected);
    });
    void wakeEngine.init().catch(...);
    // NÃO retorna: primeiro lote também é enfileirado.
  }
  wakeEngine.feed(frame);
});
```

**Contratos críticos para o porte:**

- O renderer envia `ArrayBuffer` (não string/base64). O main **deve** normalizar tanto `ArrayBuffer` quanto `ArrayBufferView` respeitando `byteOffset`/`byteLength`.
- O wake engine é inicializado **lazily** na primeira chegada de frame; frames chegando durante a init são enfileirados (`wakeEngine.feed()` não retorna antes da init completar).
- **Somente a instância que detém o `wakeLock`** processa frames — caso contrário, duas janelas abertas responderiam ao mesmo "Hey Jarvis".
- Ao detectar wake, o broadcast é para `VOICE_CHANNELS.wakeDetected` (`'voice:wake.detected'`) sem payload.

---

### 3.7 Shape de configuração (`src/shared/voice-config.ts`)

O shape que os workers dependem é `VoiceConfig` (linha 252). Os campos abaixo são o que o porte deve suportar ler/escrever:

```ts
// src/shared/voice-config.ts:90-93
export type VoiceRouting        = 'jarvis' | 'focused-pane' | 'orchestrator' | 'ask';
export type VoiceSpeakMode      = 'summary' | 'full' | 'off';
export type JarvisBrainProviderId = 'gemini' | 'openai' | 'groq';
export type JarvisLiveTransport = 'classic' | 'openai-realtime' | 'gemini-live';

// src/shared/voice-config.ts:213-252
export const voiceConfigSchema = z.object({
  enabled:    z.boolean().default(true),
  input: z.object({
    mode:           z.enum(['push-to-talk']).default('push-to-talk'),
    shortcut:       z.string().min(1).max(64).default('CommandOrControl+Shift+Space'),
    pushToTalkKey:  z.object({ code: z.string().max(32) }).optional(),
  }),
  routing:    z.enum(['jarvis', 'focused-pane', 'orchestrator', 'ask']).default('jarvis'),
  speakMode:  z.enum(['summary', 'full', 'off']).default('summary'),
  wakeWord:   z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  persona:    voicePersonaSchema,       // { assistantName, userName?, customInstructions? }
  jarvisLive: jarvisLiveConfigSchema,   // { enabled, transport, graceReuseMs, dormantAfterMs, maxWindowTurns, ... }
  jarvisBrain: jarvisBrainProviderSchema, // cadeia recursiva gemini→openai→groq
  stt: voicePluginSchema,               // cadeia recursiva groq→openai→local-whisper
  tts: voicePluginSchema,               // cadeia recursiva openai→piper→macos-say
});
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
```

#### `JarvisLiveConfig` (sub-shape de `jarvisLive`)

```ts
// src/shared/voice-config.ts:103-141
export const jarvisLiveConfigSchema = z.object({
  enabled:        z.boolean().default(false),
  transport:      z.enum(['classic', 'openai-realtime', 'gemini-live']).default('classic'),
  openaiModel:    z.string().default('gpt-realtime-2.1'),
  openaiVoice:    z.string().default('alloy'),
  liveModel:      z.string().default('gemini-2.5-flash-native-audio-preview-12-2025'),
  voiceName:      z.string().default('Charon'),
  graceReuseMs:   z.number().int().positive().max(600_000).default(90_000),
  dormantAfterMs: z.number().int().positive().max(1_800_000).default(300_000),
  maxWindowTurns: z.number().int().positive().max(40).default(12),
});
export type JarvisLiveConfig = z.infer<typeof jarvisLiveConfigSchema>;
```

#### `VoicePlugin` (provider com fallback recursivo)

```ts
// src/shared/voice-config.ts:39-62
export interface VoicePlugin {
  type:          VoicePluginType;   // 'stt' | 'tts' | 'vad'
  provider:      string;
  endpoint?:     string;
  auth?:         { type: 'api_key' | 'bearer' | 'none'; envVar?: string };
  model?:        string;
  translate?:    boolean;
  translateFrom?: string;
  translateTo?:  string;
  streaming?:    boolean;
  chunkMs?:      number;
  language?:     string;
  outputMode?:   string;
  voice?:        string;
  speed?:        number;
  format?:       string;
  localBin?:     string;
  modelPath?:    string;
  vad?:          VadConfig;
  fallback?:     VoicePlugin;       // cadeia recursiva
}
```

> `auth.envVar` é resolvido **somente no main process** via `process.env`. Nunca é enviado ao renderer. O renderer recebe apenas `VoiceRuntimeInfo` (secret-free), com o estado de disponibilidade via `ResolvedChain`.

#### Defaults de produção (`DEFAULT_VOICE_CONFIG`, voice-config.ts:261)

A cadeia padrão de STT é `groq (whisper-large-v3-turbo, translate pt→en) → openai (whisper-1) → local-whisper (base)`.  
A cadeia padrão de TTS é `openai (gpt-4o-mini-tts, nova) → piper → macos-say (Luciana)`.  
O cérebro Jarvis padrão é `gemini (gemini-3.5-flash) → openai (gpt-4o-mini) → groq (llama-3.3-70b-versatile)`.
## 4. Os 11 passos do turno Classic

Fluxo completo: captura quente → wake detection → barge-in → ACK → utterance → STT → filtro → brain → action → TTS → reopen.

---

### Passo 1 — Captura quente (stream always-on)

**Papel:** abre e mantém um stream de mic 16 kHz mono, fatia PCM em chunks de 1280 amostras (~80 ms) e os encaminha ao detector de wake word no processo main.

**Arquivo(s):** `src/renderer/voice/wake-mic.ts`, `src/main/voice/voice-ipc.ts`

**Assinatura-chave:** `WakeMic.start(): Promise<void>` e a função interna `openGraph()`.

```ts
// wake-mic.ts:300–315 — abre stream com APM desligado (openWakeWord quer PCM limpo)
private async openGraph(): Promise<void> {
  this.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: TARGET_SAMPLE_RATE,
      echoCancellation: false,  // APM off: KWS precisa do sinal cru
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  // ...
}
```

```ts
// wake-mic.ts:366–371 — cada chunk de 1280 amostras é enviado via IPC ao main
for (let i = 0; i < frame.length; i += 1) this.pending.push(frame[i]);
while (this.pending.length >= CHUNK) {
  const chunk = Float32Array.from(this.pending.splice(0, CHUNK));
  window.nexus.voice.sendWakeAudio(chunk.buffer);  // → IPC → WakeEngine
}
```

**Handoff para passo 2:** `ArrayBuffer` com 1280 amostras Float32 viaja por IPC até `voice-ipc.ts` (canal `VOICE_CHANNELS.wakeAudio`), que alimenta `WakeEngine.feed(frame)`.

---

### Passo 2 — Wake detection (onnxruntime, processo main)

**Papel:** `WakeEngine` (ONNX, sem conta) avalia os frames PCM. Quando a pontuação cruza o limiar, faz broadcast do evento `wakeDetected` para todos os renderers.

**Arquivo(s):** `src/main/voice/voice-ipc.ts`, `src/main/voice/wake-engine.ts`

**Assinatura-chave:** `WakeEngine` (construtor recebe callback) + `ipcMain.on(VOICE_CHANNELS.wakeAudio, ...)`.

```ts
// voice-ipc.ts:179–232 — recebe frames, aplica wake-lock, alimenta WakeEngine
ipcMain.on(VOICE_CHANNELS.wakeAudio, (_event, raw: unknown) => {
  if (!getVoiceConfig().wakeWord.enabled) return;
  if (!acquireWakeLock()) {          // guardrail #1 — mutex cross-instance
    // ... ignora frames em silêncio
    return;
  }
  // ...
  wakeEngine.feed(frame);            // → ONNX scoring
});

// Callback passado ao WakeEngine:
new WakeEngine(() => {
  logVoice('info', 'wake.detected', '"Hey Jarvis"');
  broadcast(VOICE_CHANNELS.wakeDetected);   // → todos os renderers
});
```

**Handoff para passo 3:** IPC broadcast `wakeDetected` chega ao renderer via `window.nexus.voice.onWakeDetected(() => onWake('voice'))` em `voice-controller.ts:633`.

---

### Passo 3 — Barge-in / gate

**Papel:** `onWake` verifica se o pipeline está ocupado em estado não-interrompível; `handleWake` cancela qualquer captura ativa, para todo playback e libera o mic para o novo turno.

**Arquivo(s):** `src/renderer/voice/voice-controller.ts`

**Assinatura-chave:** `handleWake(source: WakeSource): Promise<void>`

```ts
// voice-controller.ts:422–430 — barge-in total: novo "Hey Jarvis" sempre retoma
// BARGE-IN total: turno preso deixava a JARVIS surda para sempre.
stopAllPlayback();
if (wakeMic.isUtteranceActive()) wakeMic.cancelUtterance();
if (capture.current?.isCapturing()) {
  try {
    await capture.current.stop();
  } catch {
    // segue — o wake mic quente é o caminho principal
  }
}
busy.current = true;
```

**Handoff para passo 4:** estado limpo, `busy = true`, `wakeOpenInProgress = true`. Pipeline pronto para ACK.

---

### Passo 4 — Wake ACK (resposta ao chamado)

**Papel:** fala o cumprimento ("Pois não, patrão?") antes de abrir o mic — garante que o STT do passo 7 não transcreva o próprio ACK como comando. Aplica janela de supressão de wake em torno do TTS.

**Arquivo(s):** `src/renderer/voice/voice-controller.ts`, `src/renderer/voice/voice-wake-ack.ts`

**Assinatura-chave:** `playWakePrompt(ack: string): Promise<void>`, `playCachedWakeAck(userName: string): Promise<void>`

```ts
// voice-controller.ts:444–448
wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);  // 8 000 ms — guardrail #11
await playWakePrompt(ack).catch(() => playCachedWakeAck(personaUserName()));
wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);  // renova após o play
```

**Handoff para passo 5:** ACK tocado, janela de supressão ativa. Chama `beginListening`.

---

### Passo 5 — Utterance capture (stream quente, sem novo getUserMedia)

**Papel:** `wakeMic.beginUtterance()` começa a acumular PCM imediatamente sobre o stream já aberto — sem latência de `getUserMedia`. Usa pre-roll de 2,5 s para não perder a fala emendada ao wake.

**Arquivo(s):** `src/renderer/voice/wake-mic.ts`, `src/renderer/voice/voice-controller.ts`

**Assinatura-chave:** `WakeMic.beginUtterance(autoStop?: AutoStopOptions, preRollMs: number, preRollSeed?: Float32Array[]): void`

```ts
// wake-mic.ts:162–189 — abre captura sobre o stream quente com deadline duro
beginUtterance(
  autoStop?: AutoStopOptions,
  preRollMs = 0,
  preRollSeed?: Float32Array[],
): void {
  // ...
  this.uttChunks = seeded;   // pre-roll semeado (WAKE_PREROLL_MS = 2 500 ms)
  this.uttActive = true;
  this.uttStartedAt = Date.now();
  // Deadline DURO por timer — guardrail #3
  if (autoStop) {
    this.uttDeadline = setTimeout(() => {
      if (this.uttActive && !this.uttFired) {
        this.uttFired = true;
        autoStop.onAutoStop();
      }
    }, autoStop.maxMs + UTTERANCE_DEADLINE_SLACK_MS);  // maxMs=15 000 + 1 000
  }
}
```

```ts
// voice-controller.ts:387–399 — parâmetros de auto-stop do turno wake
function wakeAutoStop(capture, busy): AutoStopOptions {
  return {
    silenceMs:    WAKE_SILENCE_MS,      // 1 200 ms
    minListenMs:  WAKE_MIN_LISTEN_MS,   // 3 200 ms
    maxMs:        WAKE_MAX_MS,          // 15 000 ms
    onAutoStop: () => {
      if (isListening(capture)) void finishAndProcess(capture, busy);
    },
  };
}
```

**Handoff para passo 6:** `onAutoStop` dispara `finishAndProcess`.

---

### Passo 6 — Auto-stop → coleta do WAV

**Papel:** `trackUtterance` monitora RMS frame a frame. Quando silêncio ≥ 1 200 ms (após mín. 3 200 ms) ou `maxMs`, dispara `onAutoStop`. `finishUtterance()` mescla chunks, downsamples para 16 kHz e codifica WAV base64.

**Arquivo(s):** `src/renderer/voice/wake-mic.ts`, `src/renderer/voice/voice-controller.ts`

**Assinatura-chave:** `WakeMic.finishUtterance(): CaptureResult`

```ts
// wake-mic.ts:193–209 — encerra captura e devolve o WAV
finishUtterance(): CaptureResult {
  this.uttActive = false;
  if (this.uttDeadline) { clearTimeout(this.uttDeadline); this.uttDeadline = null; }
  const pcm = mergeChunks(this.uttChunks);
  this.uttChunks = [];
  const rate = this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE;
  const down = downsample(pcm, rate, TARGET_SAMPLE_RATE);
  return {
    wavBase64: bytesToBase64(encodeWav(down, TARGET_SAMPLE_RATE)),
    sampleRate: TARGET_SAMPLE_RATE,
    durationSec: down.length / TARGET_SAMPLE_RATE,
    heardSpeech: this.uttHeardSpeech,
  };
}
```

```ts
// voice-controller.ts:760–778 — gate de duração mínima e silêncio real
const result = wakeMic.isUtteranceActive()
  ? wakeMic.finishUtterance()
  : await capture.stop();
if ((!result.wavBase64 || result.durationSec < MIN_SPEECH_SEC || result.heardSpeech === false)
    && !realtimeTranscriptReady) {
  store.setStatus('idle');   // descarta sem virar turno
  liveEndTurn();
  return;
}
```

**Handoff para passo 7:** `CaptureResult { wavBase64, sampleRate, durationSec, heardSpeech }` chega a `finishAndProcess`.

---

### Passo 7 — STT (transcrição, processo main)

**Papel:** `withTimeout` envolve a chamada IPC `transcribe` com deadline de 60 s. No main, `stt-service` chama o provedor (Whisper/Groq/etc.). `echoSuppressor.isEcho()` descarta transcrições que são eco do próprio TTS (terceira camada anti-eco).

**Arquivo(s):** `src/renderer/voice/voice-controller.ts`, `src/main/voice/voice-ipc.ts`, `src/main/voice/echo-suppress.ts`

**Assinatura-chave:** `withTimeout(window.nexus.voice.transcribe({...}), TRANSCRIBE_DEADLINE_MS, 'transcrição')`

```ts
// voice-controller.ts:867–877 — chamada STT com deadline de 60 s (guardrail #4)
const stt = await withTimeout(
  window.nexus.voice.transcribe({
    audioBase64: result.wavBase64,
    mime: 'audio/wav',
    sampleRate: result.sampleRate,
    ...(routing === 'jarvis' ? { translate: false, language: 'pt' } : {}),
  }),
  TRANSCRIBE_DEADLINE_MS,   // 60 000 ms
  'transcrição',
);
```

```ts
// voice-ipc.ts:159–165 — terceira camada anti-eco no main (guardrail #8)
const res = await transcribe(parsed.data, getVoiceConfig(), currentProbes());
if (res.ok && echoSuppressor.isEcho(res.text)) {
  console.log(`[voice] eco do TTS descartado: "${res.text.slice(0, 80)}"`);
  return { ...res, discarded: 'echo' };
}
```

**Handoff para passo 8:** `stt.text` (string bruta) ou `stt.discarded = 'echo'` (descarte silencioso).

---

### Passo 8 — Filtro de transcrição

**Papel:** camadas de descarte no renderer: (a) eco do TTS pelo campo `discarded`; (b) só eco do wake/ACK (`isWakeAckOnlyTranscript`); (c) strip do prefixo "Hey Jarvis / pois não" (`stripWakeAckEcho`); (d) fantasmas do Whisper (`isDiscardableTranscript`).

**Arquivo(s):** `src/renderer/voice/voice-controller.ts`, `src/renderer/voice/transcript-filter.ts`

**Assinatura-chave:** `isDiscardableTranscript(text, { inConversation })`, `stripWakeAckEcho(text, userName)`

```ts
// voice-controller.ts:885–925 — sequência de descartes pós-STT
if (stt.discarded === 'echo') {           // eco já detectado no main
  store.setStatus('idle'); return;
}
if (activeCaptureReason === 'wake' && isWakeAckOnlyTranscript(stt.text, personaUserName())) {
  store.setStatus('idle'); return;         // só eco do ACK — nada a fazer
}
const transcript =
  activeCaptureReason === 'wake'
    ? stripWakeAckEcho(stt.text, personaUserName())   // remove "Hey Jarvis / pois não..."
    : stt.text.trim();
// ...
if (isDiscardableTranscript(transcript, { inConversation })) {
  store.setStatus('idle'); return;         // fantasma do Whisper — descarta
}
```

**Handoff para passo 9:** `transcript` limpo chama `runJarvisTurn(transcript, capture, busy)`.

---

### Passo 9 — Brain (jarvisThink, processo main)

**Papel:** `withTimeout` (35 s, renderer) envolve a IPC `jarvis`. No main, `jarvisThink` monta o prompt com contexto de tela/workspace/panes e chama o LLM com `AbortSignal.timeout(15 s)`. Retorna `JarvisReply { say, action, expectReply }`. Histórico da conversa é atualizado.

**Arquivo(s):** `src/renderer/voice/voice-controller.ts`, `src/main/voice/voice-ipc.ts`, `src/main/voice/jarvis-brain.ts`

**Assinatura-chave:** `withTimeout(window.nexus.voice.jarvis({transcript, context, history}), BRAIN_DEADLINE_MS, 'cérebro')`

```ts
// voice-controller.ts:1027–1035 — deadline 35 s no renderer (guardrail #5)
const reply = await withTimeout(
  window.nexus.voice.jarvis({
    transcript,
    context,          // workspace, panes, missões, focusedPane...
    history: jarvisHistory,
  }),
  BRAIN_DEADLINE_MS,  // 35 000 ms
  'cérebro',
);
```

```ts
// jarvis-brain.ts:312 + 340 — AbortSignal de 15 s dentro do main (guardrail #5)
export const BRAIN_TIMEOUT_MS = 15_000;
// ...
signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),   // mata a fetch se o LLM travar
```

**Handoff para passo 10:** `reply.say` (fala), `reply.action` (tipo de ação), `reply.expectReply` (bool). Histórico empurrado em `jarvisHistory`.

---

### Passo 10 — Execução da ação (action executor)

**Papel:** `executeJarvisAction(reply, context)` despacha a ação do brain para o app (abrir pane, escrever no terminal, executar comando com diálogo nativo, etc.). Retorna `exec.sayText` (pode sobrescrever `reply.say`) e `exec.toolResult`.

**Arquivo(s):** `src/renderer/voice/jarvis-action-executor.ts`, `src/main/voice/voice-ipc.ts`

**Assinatura-chave:** `executeJarvisAction(reply: JarvisReply, context): Promise<ActionExecResult>`

```ts
// voice-controller.ts:1052–1068 — executa e propaga resultado
const exec = await executeJarvisAction(reply, context);
let sayText = exec.sayText;
if (exec.expectReply !== undefined) reply.expectReply = exec.expectReply;
const toolResult = exec.toolResult;
// ...
if (toolResult && isJarvisLiveEnabled()) {
  window.nexus.voice.liveToolResult(toolResult);   // espelha ao transporte live
}
```

```ts
// voice-ipc.ts:305–327 — diálogo nativo anti-injeção (guardrail #14)
ipcMain.handle(VOICE_CHANNELS.confirmCommand, async (_event, raw): Promise<boolean> => {
  // ...
  const opts = { type: 'warning', buttons: ['Cancelar', 'Executar'], defaultId: 0, ... };
  const result = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return result.response === 1;   // só Executar (index 1) retorna true
});
```

**Handoff para passo 11:** `sayText` pronto; se vazio → `store.setStatus('idle')` e fim. Se preenchido → TTS.

---

### Passo 11 — TTS + reopen

**Papel:** sintetiza a resposta com deadline de 40 s. Pipelining por sentença (primeira sintetizada enquanto o resto é enviado). Após playback: suprime wake dinamicamente e decide se reabre escuta (`shouldReopenJarvisListening`).

**Arquivo(s):** `src/renderer/voice/voice-controller.ts`, `src/renderer/voice/jarvis-reply-loop.ts`

**Assinatura-chave:** `withTimeout(window.nexus.voice.speak({text, speakMode:'full'}), SPEAK_DEADLINE_MS, 'TTS')`

```ts
// voice-controller.ts:1094–1122 — TTS pipelined com deadline 40 s (guardrail #6)
const split = sayText.length > 120
  ? splitFirstSentence(sayText)
  : { first: sayText, rest: '' };
const first = await withTimeout(
  window.nexus.voice.speak({ text: split.first, speakMode: 'full' }),
  SPEAK_DEADLINE_MS,   // 40 000 ms
  'TTS',
);
// ...
await playSpeakResult(first);                     // toca 1ª frase
// rest sintetiza em paralelo enquanto 1ª toca
```

```ts
// voice-controller.ts:1125–1148 — supressão pós-TTS e decisão de reabrir
void window.nexus.voice.recordEcho(sayText);   // registra no EchoSuppressor (main)
wakeMic.suppressWakeDetection(
  Math.min(12_000, Math.max(3_500, sayText.length * 70 + 2_000)),
);
const wantsReply = shouldReopenJarvisListening({ expectReply, sayText, ... });
if (wantsReply) {
  await delay(REPLY_LISTEN_DELAY_MS);    // 700 ms
  noteAutoReplyOpened();                 // incrementa contador anti-loop
  void beginListening(capture, wakeAutoStop(capture, busy), 'reply', ...);
} else {
  liveEndTurn();
}
```

**Handoff de volta ao passo 5** (se `wantsReply`) ou **fim do turno** (`liveEndTurn`).

---

## 5. Os 14 guardrails

| # | Guardrail | Valor/Threshold | file:line | Por que existe |
|---|-----------|-----------------|-----------|----------------|
| 1 | Wake-lock cross-instance | Lockfile `~/.nexus/jarvis-wake.lock` com PID; PID morto (ESRCH) = órfão roubável; EPERM = vivo | `wake-lock.ts:71` (`acquireWakeLock`) + `voice-ipc.ts:183` (`if (!acquireWakeLock())`) | Dev + app empacotado abertos juntos respondem ao mesmo "Hey Jarvis" sem o mutex — duas vozes, dois turnos, mic disputado |
| 2 | Watchdog stream death | Poll a cada `WATCHDOG_INTERVAL_MS = 4 000 ms`; se `lastFrameAt` parado há > `FRAME_STALL_MS = 8 000 ms` → `handleStreamDeath` | `wake-mic.ts:48–49` (constantes) + `wake-mic.ts:392–397` (`startWatchdog`) | macOS mata streams em silêncio (troca de AirPods, sleep/wake); `isRunning()` continua `true` → wake surdo para sempre sem este watchdog |
| 3 | Utterance deadline watchdog | Timer duro: `autoStop.maxMs + UTTERANCE_DEADLINE_SLACK_MS` (1 000 ms); dispara `onAutoStop` mesmo sem frames chegando | `wake-mic.ts:183` (`this.uttDeadline = setTimeout`) + `voice-capture.ts:120` (`this.autoStopDeadline = setTimeout`) | Se o mic morrer no meio da fala, nenhum frame chega → `trackUtterance` nunca fecha → `busy` travado para sempre |
| 4 | `TRANSCRIBE_DEADLINE_MS` | `60 000 ms` | `voice-controller.ts:84` | STT pendurado (rede caída, Whisper lento) segurava `status = 'transcribing'` indefinidamente sem este `withTimeout` |
| 5 | `BRAIN_DEADLINE_MS` + `AbortSignal` | `35 000 ms` (renderer `withTimeout`) + `BRAIN_TIMEOUT_MS = 15 000 ms` (`AbortSignal.timeout` na fetch do LLM, main) | `voice-controller.ts:85` + `jarvis-brain.ts:312` + `jarvis-brain.ts:340` | Dois níveis: o AbortSignal mata a fetch HTTP em 15 s; o `withTimeout` do renderer garante que mesmo se o main não propagar o erro, o turno morre em 35 s |
| 6 | `SPEAK_DEADLINE_MS` | `40 000 ms` | `voice-controller.ts:86` | TTS bloqueado (OpenAI lento, chave inválida) deixava `status = 'speaking'` e `busy = true` presos; o `withTimeout` derruba e libera o pipeline |
| 7 | AEC (Acoustic Echo Cancellation) | `echoCancellation: true` + `noiseSuppression: true` no stream de **utterance** (`VoiceCapture`) | `voice-capture.ts:82` | Primeira camada anti-eco: APM do Chromium suprime o áudio do alto-falante antes do PCM chegar ao STT |
| 8 | `EchoSuppressor` (eco por transcript) | Janela deslizante de 300 chars (`ECHO_WINDOW_CHARS`) + TTL 60 s (`ECHO_TTL_MS`); eco quando substring contígua OU ≥ 80 % das palavras significativas presentes | `echo-suppress.ts:49` (`isEcho`) + `voice-ipc.ts:163` (`echoSuppressor.isEcho(res.text)`) | Terceira camada: AEC remove o eco no áudio, mas vazamentos do alto-falante que passam pelo Whisper voltam como transcrição; o suppressor descarta pelo texto |
| 9 | Filtro de transcrição (Whisper ghosts) | `COLD_GHOSTS` (fora de conversa) + `HARD_GHOSTS` (sempre) + `JARVIS_SELF_ECHO`; context-aware via flag `inConversation` | `transcript-filter.ts:15–37` + `voice-controller.ts:885–925` | Whisper alucina frases fixas ("you", "obrigado por assistir") em silêncio/ruído; sem filtro a JARVIS conversa sozinha em loop |
| 10 | `stripPromptEcho` | Remove ANSI + encontra o eco do prompt injetado no PTY com regex de palavras flexíveis (cursor/spinner intercalado ainda casa) | `response-echo.ts:23` (`stripPromptEcho`) + uso em `voice-controller.ts:1219` | Após injetar o transcrito no pane, o PTY ecoa o próprio comando; sem strip, o "talk back" fala o comando do usuário em vez da resposta do agente |
| 11 | Janela de supressão de wake | Dinâmica pós-TTS: `min(12 000, max(3 500, sayText.length × 70 + 2 000)) ms`; fixa no ACK: `WAKE_ACK_SUPPRESS_MS = 8 000 ms` | `voice-controller.ts:1130` (pós-TTS) + `voice-controller.ts:444–448` (ACK) + `wake-mic.ts:144` (`suppressWakeDetection`) | Sem supressão, o próprio TTS da JARVIS dispara novo wake ("Pois não" → detecção → novo turno → …); loop infinito de self-wake |
| 12 | Barge-in | Novo "Hey Jarvis" chama `stopAllPlayback()`, `wakeMic.cancelUtterance()`, `capture.stop()` antes de abrir novo turno | `voice-controller.ts:422–430` (dentro de `handleWake`) | Turno preso (fetch pendurado, TTS longo) deixava a JARVIS surda para sempre; o barge-in força reset total independente do estado interno |
| 13 | Auto-reply loop guard (`MAX = 5`) | `MAX_AUTO_REPLY_LOOPS = 5`; `autoReplyLoopCount` incrementado a cada reopen; check em `shouldReopenJarvisListening`; reset no primeiro turno não-`reply` | `jarvis-reply-loop.ts:9` (constante) + `jarvis-reply-loop.ts:47` (`shouldReopenJarvisListening`) + `:54` (check) | Sem limite, `expectReply = true` em loop de confusão → TTS → mic → "não entendi" → TTS → … até esgotar o contexto ou travar o host |
| 14 | `runCommand` native dialog | `dialog.showMessageBox` do Electron (processo main); renderer não pode forjar; default `Cancel` (index 0); rejeita string vazia ou > 4 096 chars | `voice-ipc.ts:305–327` (`ipcMain.handle(VOICE_CHANNELS.confirmCommand, ...)`) | Transcript envenenado / prompt-injection pode emitir `run_command`; o diálogo nativo — que o renderer não pode falsificar — exige OK humano explícito antes de qualquer exec |

---

**Nota sobre dois guardrails de prefs não tabelados:**

- **`hudPrefs` (localStorage):** persistência das preferências do HUD de voz (posição, tamanho, visibilidade). Não é um guardrail de segurança/resiliência, mas afeta o estado inicial da UI de voz em cada sessão. Detalhes de renderização e leitura da pref → §6.6.

- **Mic health monitor:** `setInterval(checkMicHealth, MIC_HEALTH_CHECK_MS = 5 000)` em `voice-controller.ts:524`; combina `wakeMic.checkPermission()` (Permissions API) com `wakeMic.getSilentMs()` vs. `MIC_SILENT_THRESHOLD_MS = 12 000 ms` para classificar a saúde do mic (`classifyMicHealth` de `wake-health.ts`). Não derruba o pipeline — emite banner acionável na UI. Detalhes de cada classificação e UX do banner → §6.6.

---

## 6. Subsistemas por lane

As subseções abaixo detalham cada lane do pipeline com suas assinaturas, constantes e `arquivo:linha` reais — a referência de implementação por trás dos 11 passos (§4) e dos 14 guardrails (§5).

### 6.1 Wake / anti-echo

#### Arquivos

| Camada | Arquivo |
|--------|---------|
| Main (ONNX inference) | `src/main/voice/wake-engine.ts` |
| Main (modelos embutidos) | `src/main/voice/wake-models.ts` |
| Main (supressor de eco TTS) | `src/main/voice/echo-suppress.ts` |
| Renderer (mic sempre-ligado) | `src/renderer/voice/wake-mic.ts` |
| Renderer (política de rearme) | `src/renderer/voice/wake-rearm.ts` |
| Renderer (saúde do mic) | `src/renderer/voice/wake-health.ts` |
| Renderer (acks de wake) | `src/renderer/voice/voice-wake-ack.ts` |
| Renderer (wake manual) | `src/renderer/voice/manual-wake.ts` |
| Renderer (eco do prompt PTY) | `src/renderer/voice/response-echo.ts` |
| Renderer (filtro de transcrição) | `src/renderer/voice/transcript-filter.ts` |

---

#### Wake engine + modelos (`wake-engine.ts` / `wake-models.ts`)

**Dependência externa:** pipeline ONNX pinado do repositório
`Soulcreek2/speechkit-wakeword-models` (Apache-2.0), bundled como base64 em
`wake-models.ts`. O head `hey_jarvis` é o modelo SpeechKit permissivo; o modelo
de frase openWakeWord v0.5.1, licenciado CC BY-NC-SA, não é distribuído.

`wake-models.ts` exporta três constantes base64 — cada uma é um arquivo `.onnx` completo carregado em memória:

```ts
// wake-models.ts (grep "^export const")
export const MELSPEC_ONNX_B64 =   // melspectrogram.onnx
export const EMBEDDING_ONNX_B64 = // embedding_model.onnx
export const HEY_JARVIS_ONNX_B64 = // SpeechKit hey_jarvis.onnx
```

Pipeline de inferência — port fiel do `openwakeword/utils.py` oficial, rodando em `onnxruntime-node` no processo main. Três modelos em cascata:

1. **melspectrogram.onnx** — entrada: `[1, CTX+CHUNK]` float32 em escala int16. CTX = 480 samples de contexto do chunk anterior (sem isso saem ~5 frames em vez de ~8, desalinhando os scores).
2. **embedding_model.onnx** — janela de 76 mel frames → embedding de 96 dims.
3. **SpeechKit hey_jarvis.onnx** — últimos 16 embeddings → score float32.

Parâmetros fixos:

```ts
// wake-engine.ts:40-48
const CHUNK = 1280;        // 80 ms @ 16 kHz
const CTX = 480;           // contexto de janela mel
const MEL_WINDOW = 76;
const EMB_WINDOW = 16;
const THRESHOLD = 0.48;    // 0.39 foi falso positivo real; fala real ~0.97
const DEBOUNCE_MS = 2_500;
```

**Assinaturas-chave:**

```ts
// wake-engine.ts:82-99
export class WakeEngine {
  constructor(private readonly onDetected: () => void) {}
  async init(): Promise<void>
  feed(frame: Float32Array): void   // PCM mono 16 kHz normalizado [-1,1]
  reset(): void
  async dispose(): Promise<void>
}
```

`feed()` enfileira samples (cap: 50×CHUNK amostras); `drain()` consome em loop assíncrono enquanto `!busy`:

```ts
// wake-engine.ts:237-257
feed(frame: Float32Array): void {
  if (this.disposed) return;
  for (let i = 0; i < frame.length; i += 1) this.pcmQueue.push(frame[i]);
  const excess = this.pcmQueue.length - PCM_QUEUE_MAX;
  if (excess > 0) {
    this.pcmQueue.splice(0, excess);  // descarta ANTIGOS, não novos
    ...
  }
  if (!this.ready || this.busy) return;
  void this.drain();
}
```

`processChunk` escala para int16 antes do mel, mantém contexto de 480 amostras, e dispara `onDetected()` ao cruzar o threshold:

```ts
// wake-engine.ts:274-277
const chunk = Float32Array.from(samples, (v) => v * 32768);
const withCtx = new Float32Array(this.rawTail.length + chunk.length);
withCtx.set(this.rawTail, 0);
withCtx.set(chunk, this.rawTail.length);
this.rawTail = chunk.slice(chunk.length - CTX);
```

**Modelo custom opcional:** `~/.nexus/models/wake/custom.onnx` substitui `hey_jarvis` se passar validações de tamanho (1 KB–500 MB) e cabeçalho protobuf (`bytes[0] === 0x08`). Qualquer falha cai silenciosamente no embutido:

```ts
// wake-engine.ts:125-147
private async loadWakeModel(opts): Promise<ort.InferenceSession> {
  const rejected = checkCustomWakeModel();
  if (rejected === null) {
    try {
      const bytes = new Uint8Array(fs.readFileSync(CUSTOM_WAKE_MODEL));
      if (bytes[0] !== 0x08) throw new Error('cabeçalho não parece um ONNX/protobuf');
      return await ort.InferenceSession.create(bytes, opts);
    } catch (err) { ... }
  }
  return ort.InferenceSession.create(fromB64(HEY_JARVIS_ONNX_B64), opts);
}
```

**O essencial para reimplementar:** importar os três ONNX bundled → instanciar via `onnxruntime-node` no processo main → pipeline mel→emb→wake por chunk de 1280 samples → manter contexto de 480 samples entre chunks → debounce 2,5 s → disparar callback.

---

#### Mic sempre-ligado + rearme/saúde/ack (`wake-mic.ts`, `wake-rearm.ts`, `wake-health.ts`, `voice-wake-ack.ts`)

`WakeMic` vive no renderer. Abre um `getUserMedia` **sem APM** (echoCancellation/noiseSuppression/autoGainControl todos `false`) a 16 kHz mono e o mantém quente permanentemente. Isso serve dois propósitos: alimentar o `WakeEngine` via IPC com chunks de 1280 samples **e** gravar utterances de comando imediatamente (sem novo `getUserMedia`).

```ts
// wake-mic.ts:300-315
this.stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    sampleRate: TARGET_SAMPLE_RATE,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,   // APM desligado: WakeEngine quer PCM limpo
  },
});
```

O grafo de áudio preferencia `AudioWorkletNode` (`nexus-pcm-processor`) e cai em `ScriptProcessorNode(4096)` como fallback:

```ts
// wake-mic.ts:374-387
try {
  await this.ctx.audioWorklet.addModule(pcmWorkletUrl);
  const node = new AudioWorkletNode(this.ctx, 'nexus-pcm-processor');
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
  ...
} catch {
  const node = this.ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0).slice(0));
  ...
}
```

`onFrame` aplica AGC, acumula o preRoll e, quando não está em utterance nem suprimido, monta chunks de exatamente 1280 samples e envia ao main:

```ts
// wake-mic.ts:341-372
const onFrame = (frame: Float32Array) => {
  ...
  const rawRms = this.agc.process(frame);
  this.silentSince = frameIsSilent(frameRms(frame)) ? this.silentSince || Date.now() : 0;
  this.rememberPreRoll(frame);
  if (this.uttActive) { this.trackUtterance(frame, rawRms); return; }
  if (Date.now() < this.wakeSuppressedUntil) return;
  for (let i = 0; i < frame.length; i += 1) this.pending.push(frame[i]);
  while (this.pending.length >= CHUNK) {
    const chunk = Float32Array.from(this.pending.splice(0, CHUNK));
    window.nexus.voice.sendWakeAudio(chunk.buffer);
  }
};
```

**Utterance sobre stream quente:**

```ts
// wake-mic.ts:162-209
beginUtterance(autoStop?: AutoStopOptions, preRollMs = 0, preRollSeed?: Float32Array[]): void
finishUtterance(): CaptureResult   // devolve WAV 16 kHz PCM16 base64
cancelUtterance(): void            // barge-in
suppressWakeDetection(ms: number): void  // pausa o detector enquanto TTS fala
```

**Resiliência — três defesas contra morte silenciosa do stream (macOS mata streams sem erro):**

```ts
// wake-mic.ts:390-397 (watchdog)
private startWatchdog(): void {
  this.watchdog = setInterval(() => {
    if (!this.running || this.restarting) return;
    if (Date.now() - this.lastFrameAt > FRAME_STALL_MS) {  // FRAME_STALL_MS = 8s
      this.handleStreamDeath(`sem frames do mic há ${FRAME_STALL_MS / 1000}s`);
    }
  }, WATCHDOG_INTERVAL_MS);  // WATCHDOG_INTERVAL_MS = 4s
}
```

1. `track.addEventListener('ended', ...)` → reconstrução imediata.
2. Watchdog 4 s: sem frames por 8 s → `handleStreamDeath`.
3. `AudioContext.onstatechange`: suspensão por sleep/wake → `ctx.resume()`.

**Política de rearme (`wake-rearm.ts`):**

```ts
// wake-rearm.ts:11-21
export const RESTART_BACKOFF_MS = [1_000, 3_000, 8_000] as const;
export const REARM_SLOW_MS = 30_000;

export function nextRearmDelay(attempt: number): number {
  return attempt < RESTART_BACKOFF_MS.length ? RESTART_BACKOFF_MS[attempt] : REARM_SLOW_MS;
}
```

Esgotado o backoff rápido (1 s/3 s/8 s): `onDied` avisa a UI **e** entra em rearme lento infinito a 30 s — o mic nunca fica morto permanentemente.

**Saúde do mic (`wake-health.ts`):**

```ts
// wake-health.ts:10-39
export type MicHealth = 'ok' | 'needsPermission' | 'silent';
export const MIC_NOISE_FLOOR = 0.006;

export function frameIsSilent(rms: number, noiseFloor = MIC_NOISE_FLOOR): boolean
export function classifyMicHealth(
  permission: MicPermissionState,
  silentMs: number,
  silentThresholdMs: number,
): MicHealth
```

`denied/prompt` → `needsPermission`; `granted` + silêncio além do limiar → `silent`; demais → `ok`.

**Acks de wake (`voice-wake-ack.ts`):**

Cache de áudio TTS pré-aquecido por persona. No momento da detecção, o som já está em RAM:

```ts
// voice-wake-ack.ts:61-76
export function warmAckCache(userName: string): void {
  for (const text of [...buildWakeAckTexts(userName), ...THINK_FILLERS]) {
    if (warmedAckTexts.has(text)) continue;
    warmedAckTexts.add(text);
    void window.nexus.voice.speak({ text, speakMode: 'full', echoRecord: false })
      .then((r) => { if (r.ok && r.mode === 'audio') ackCache.set(text, ...); });
  }
}

export async function playWakePrompt(text: string): Promise<void>    // com cache-miss fallback
export async function playCachedWakeAck(userName: string): Promise<void>
export function invalidateAckCacheIfPersonaChanged(info: VoiceRuntimeInfo): void
```

Textos base (PT-BR): `['Pois não?', 'Sim?', 'Às ordens.', 'Diga.']`. Com nome: `'Pois não, {user}?'` etc.

**Wake manual (`manual-wake.ts`):**

```ts
// manual-wake.ts:1-11
const JARVIS_WAKE_EVENT = 'nexus:jarvis-wake-request';

export function requestJarvisWake(): void {
  window.dispatchEvent(new CustomEvent(JARVIS_WAKE_EVENT));
}
export function onJarvisWakeRequest(cb: () => void): () => void
```

Bypass de hardware: dispara o mesmo caminho do wake word via `CustomEvent` na `window`.

---

#### Echo suppression — três camadas

**Camada 1 — supressão por transcript (`echo-suppress.ts` — main):**

`EchoSuppressor` mantém janela deslizante (300 chars, TTL 60 s) do que o TTS acabou de falar e descarta transcrições do mic que sejam eco disso:

```ts
// echo-suppress.ts:35-64
export class EchoSuppressor {
  record(text: string): void      // chamado ao sucesso do TTS speak
  isEcho(transcript: string): boolean  // true = eco, descartar
  reset(): void
}
export const echoSuppressor = new EchoSuppressor();  // singleton do main
```

`isEcho` usa dois critérios: substring contígua **ou** ≥ 80% de palavras significativas (> 2 chars) presentes na janela:

```ts
// echo-suppress.ts:49-63
isEcho(transcript: string): boolean {
  const norm = normEcho(transcript);
  if (norm.length < ECHO_MIN_CHARS) return false;  // ECHO_MIN_CHARS = 6
  const window = this.window();
  if (!window) return false;
  if (window.includes(norm)) return true;
  const words = norm.split(' ').filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const spoken = new Set(window.split(' '));
  const hits = words.filter((w) => spoken.has(w)).length;
  return hits / words.length >= WORD_OVERLAP_THRESHOLD;  // 0.8
}
```

**Camada 2 — stripping do echo do prompt PTY (`response-echo.ts` — renderer):**

Remove do buffer de saída do agente o eco do prompt injetado (cursor/spinner intercalados):

```ts
// response-echo.ts:23-31
export function stripPromptEcho(raw: string, promptEcho: string): string {
  const clean = raw.replace(ECHO_ANSI_RE, '');
  const words = promptEcho.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return clean.trim();
  const pattern = words.map(escapeRegExp).join('\\s+');
  const match = new RegExp(pattern, 'i').exec(clean);
  if (!match) return clean.trim();
  return clean.slice(match.index + match[0].length).trim();
}
```

**Camada 3 — filtro de transcrição (`transcript-filter.ts` — renderer):**

Descarta alucinações clássicas do Whisper em silêncio/ruído, com contexto de conversa ativa:

```ts
// transcript-filter.ts:159-167
export function isDiscardableTranscript(
  text: string,
  opts: { inConversation: boolean },
): boolean {
  const clean = normalize(text);
  if (clean.length === 0) return true;
  if (JARVIS_SELF_ECHO.has(clean)) return true;
  return opts.inConversation ? HARD_GHOSTS.has(clean) : COLD_GHOSTS.has(clean);
}
```

Em conversa ativa, apenas `HARD_GHOSTS` (artefatos que nunca são fala real) são descartados; fora de conversa, `COLD_GHOSTS` (lista mais ampla incluindo "oi", "valeu", "tchau").

Wake-echo do ack na transcrição também é stripped:

```ts
// transcript-filter.ts:134-146
export function stripWakeAckEcho(text: string, userName: string): string
export function isWakeAckOnlyTranscript(text: string, userName: string): boolean
```

**O essencial para reimplementar:** (1) `WakeEngine` no main recebe PCM via IPC, roda os três ONNX em cascata, dispara callback; (2) `WakeMic` no renderer abre stream sem APM permanentemente, serve utterances sem novo getUserMedia, tem watchdog + backoff + rearme lento; (3) acks pré-aquecidos em cache de áudio; (4) três camadas de anti-eco — `EchoSuppressor` (transcript vs TTS), `stripPromptEcho` (PTY), `isDiscardableTranscript` (Whisper ghosts).

---

### 6.2 Captura + AGC

#### Arquivos

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/renderer/voice/voice-capture.ts` | PTT capture pipeline (VoiceCapture) + helpers PCM puros |
| `src/renderer/voice/agc.ts` | AGC adaptativo (SoftAgc) |

---

#### Pipeline de captura (`voice-capture.ts`)

`VoiceCapture` é o caminho PTT (push-to-talk): abre stream **com** AEC/NS ligados (contrário do wake mic), acumula PCM Float32, e ao parar devolve WAV 16 kHz PCM16 base64.

**Constraints do getUserMedia — AEC ativo:**

```ts
// voice-capture.ts:78-85
this.stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    sampleRate: TARGET_SAMPLE_RATE,   // 16_000
    echoCancellation: true,
    noiseSuppression: true,
    // autoGainControl não especificado: default true do browser
  },
});
```

**Formato de saída:** mono, 16 kHz, PCM 16-bit signed little-endian, encapsulado em WAV (header RIFF de 44 bytes):

```ts
// voice-capture.ts:235-266
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, 1, true);  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint16(34, 16, true); // 16-bit
  // samples Float32 [-1,1] → Int16: s < 0 ? s*0x8000 : s*0x7fff
}
```

**Assinaturas principais:**

```ts
// voice-capture.ts:44-151
export class VoiceCapture {
  onLevel: ((level: number) => void) | null = null;  // alimenta orb visualizador
  isCapturing(): boolean
  async start(autoStop?: AutoStopOptions): Promise<void>
  async stop(): Promise<CaptureResult>
}

export interface CaptureResult {
  heardSpeech?: boolean;   // false = silêncio puro → evita alucinação Whisper
  wavBase64: string;
  sampleRate: number;
  durationSec: number;
}

export interface AutoStopOptions {
  silenceMs: number;       // silêncio pós-fala que encerra utterance
  minListenMs?: number;    // janela mínima antes de silêncio valer
  maxMs: number;           // cap duro total
  onAutoStop: () => void;
}
```

O grafo usa `AudioWorkletNode` (`nexus-pcm-processor`) com fallback `ScriptProcessorNode(4096)`:

```ts
// voice-capture.ts:98-113
try {
  await this.ctx.audioWorklet.addModule(pcmWorkletUrl);
  const node = new AudioWorkletNode(this.ctx, 'nexus-pcm-processor');
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
  ...
} catch {
  const node = this.ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0).slice(0));
  ...
}
```

Deadline duro por timer (além do auto-stop por frames): se o mic morrer no meio da captura, o timer fecha o turno mesmo sem novos frames:

```ts
// voice-capture.ts:119-126
if (autoStop) {
  this.autoStopDeadline = setTimeout(() => {
    if (this.capturing && !this.autoStopFired) {
      this.autoStopFired = true;
      autoStop.onAutoStop();
    }
  }, autoStop.maxMs + 1_000);
}
```

**Auto-stop por silêncio (`trackSilence`):**

```ts
// voice-capture.ts:153-173
private trackSilence(frame: Float32Array): void {
  const rms = frameRms(frame);   // SPEECH_RMS = 0.015
  if (rms >= SPEECH_RMS) { this.heardSpeech = true; this.lastSpeechAt = now; }
  if (
    (this.heardSpeech && quietFor >= opts.silenceMs && total >= minListenMs) ||
    total >= opts.maxMs
  ) { this.autoStopFired = true; opts.onAutoStop(); }
}
```

**Helpers PCM (puros, testáveis):**

```ts
// voice-capture.ts:196-276
export function frameRms(frame: Float32Array): number   // energia média por amostra
export function mergeChunks(chunks: Float32Array[]): Float32Array
export function downsample(input, inRate, outRate): Float32Array  // linear interpolation
export function encodeWav(samples, sampleRate): Uint8Array        // Float32 → PCM16 WAV
export function bytesToBase64(bytes: Uint8Array): string          // chunks de 0x8000 bytes
```

**O essencial para reimplementar:** getUserMedia 16 kHz mono com AEC/NS → AudioWorklet/ScriptProcessor → acumular Float32 chunks → ao parar: mergeChunks → downsample → encodeWav → base64. Deadline duro por timer além do auto-stop por frames. `heardSpeech` detectado via `SPEECH_RMS = 0.015`.

---

#### AGC adaptativo (`agc.ts`)

`SoftAgc` existe porque o APM do Chromium (`autoGainControl`) foi desligado no stream do wake (commit `897ce56`) — ele achatava o sinal do fifine e corrompía as features do openWakeWord. Ganho fixo não serve (perto satura, longe some). O AGC é o meio-termo: adapta sobre fala, ignora ruído de fundo.

```ts
// agc.ts:15-25
export const AGC_TARGET_RMS = 0.1;   // alvo ≈ −20dB FS
export const AGC_MAX_GAIN = 24;       // +27.6 dB
export const AGC_MIN_GAIN = 1;        // nunca atenua
export const AGC_SPEECH_FLOOR = 0.006; // só adapta acima deste RMS (fala, não silêncio)
const AGC_UP_RATE = 1.06;   // +0.5dB/frame (80ms) → alvo em ~2s de fala
const AGC_DOWN_RATE = 0.85; // −1.4dB/frame → reage rápido a saturação
```

```ts
// agc.ts:27-64
export class SoftAgc {
  constructor(initialGain = 18) {}

  currentGain(): number

  /**
   * Processa frame IN-PLACE. Retorna RMS cru (antes do ganho).
   */
  process(frame: Float32Array): number {
    // RMS cru
    const rawRms = Math.sqrt(sum / frame.length);
    if (rawRms >= AGC_SPEECH_FLOOR) {
      const ideal = AGC_TARGET_RMS / rawRms;
      if (ideal < this.gain) {
        // sinal forte: desce rápido até o ideal
        this.gain = Math.max(ideal, this.gain * AGC_DOWN_RATE, AGC_MIN_GAIN);
      } else {
        // sinal fraco: sobe devagar, sem passar do ideal nem do teto
        this.gain = Math.min(this.gain * AGC_UP_RATE, ideal, AGC_MAX_GAIN);
      }
    }
    // aplica com clamp ±1 in-place
    for (let i = 0; i < frame.length; i += 1) {
      const amplified = frame[i] * this.gain;
      frame[i] = amplified > 1 ? 1 : amplified < -1 ? -1 : amplified;
    }
    return rawRms;
  }
}
```

No `WakeMic`, o ganho inicial é 24× (calibrado ao vivo em 2026-07-07):

```ts
// wake-mic.ts:46-47
const WAKE_INITIAL_GAIN = 24;
private readonly agc = new SoftAgc(WAKE_INITIAL_GAIN);
```

**Propriedade crítica:** o AGC só adapta o ganho quando `rawRms >= AGC_SPEECH_FLOOR (0.006)` — em silêncio, o ganho fica congelado e não amplifica ruído de fundo até o alvo.

**O essencial para reimplementar:** instanciar `SoftAgc` com ganho inicial 24; chamar `process(frame)` in-place a cada frame antes de alimentar o `WakeEngine` ou acumular utterance; retorna rawRms para telemetria. Subida lenta (~2 s para alvo), descida rápida (1 frame).
### 6.3 STT

#### Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/main/voice/stt-service.ts` | Pipeline de transcrição + fallback chain |
| `src/main/voice/provider-select.ts` | Resolução e reordenação do provider chain |
| `src/main/voice/voice-secrets.ts` | Leitura de API keys (env + secure storage) |

---

#### `transcribe` — entrada pública

```ts
// src/main/voice/stt-service.ts:263–295
export async function transcribe(
  req: TranscribeRequest,
  config: VoiceConfig,
  _probes: ProviderProbes,
  deps: SttDeps = defaultDeps,
): Promise<TranscribeResult>
```

`TranscribeRequest` (shared/voice-ipc) carrega:

```ts
// campo          tipo       descrição
audioBase64       string     áudio codificado em base64
mime              string     "audio/webm" | "audio/wav"
language?         string     BCP-47, opcional
translate?        boolean    true → /audio/translations (sempre → EN)
```

`TranscribeResult`:

```ts
// ok path
{ ok: true;  text: string; provider: string; fallbackNote?: string; attempts: SttAttempt[] }
// fail path
{ ok: false; error: string; needsKey: boolean; attempts: SttAttempt[] }
```

A função achata a chain com `flattenChain(config.stt)` (ver abaixo), itera provider a provider e retorna na primeira resposta `ok: true`. Todos os erros intermediários são acumulados em `attempts` e aparecem em `fallbackNote` quando houve fallback.

---

#### Deadlines

```ts
// src/main/voice/stt-service.ts:43–44
export const STT_CLOUD_TIMEOUT_MS = 12_000;
export const STT_LOCAL_TIMEOUT_MS = 30_000;
```

Timeout cloud usa `AbortSignal.timeout(STT_CLOUD_TIMEOUT_MS)` na chamada `fetch`. Timeout local passa `{ timeout: STT_LOCAL_TIMEOUT_MS, killSignal: 'SIGKILL' }` para `execFile` do whisper.cpp. Sem esses deadlines um socket pendurado ou binary travado congela o event loop do main indefinidamente.

---

#### Providers suportados e suas dependências

| Provider | Kind | Env var obrigatório | Endpoint padrão | Modelo padrão |
|---|---|---|---|---|
| `groq` | cloud | `GROQ_API_KEY` | `https://api.groq.com/openai/v1/audio/transcriptions` | `whisper-large-v3-turbo` |
| `openai` | cloud | `OPENAI_API_KEY` | `https://api.openai.com/v1/audio/transcriptions` | `whisper-large-v3-turbo` |
| whisper.cpp (`local`) | local | nenhum | — | arquivo ggml em `~/.nexus/models/whisper/` |

A chain padrão é `groq → openai → whisper.cpp`. Qualquer HTTP 429/401/402/403/5xx ou erro de rede faz o loop continuar para o próximo — o fallback é **error-driven**, não apenas por ausência de key.

```ts
// src/main/voice/stt-service.ts:98–105
export function describeHttpFailure(status: number): { reason: string; needsKey: boolean } {
  if (status === 429) return { reason: 'throttled (429 rate limit)', needsKey: false };
  if (status === 402) return { reason: 'quota/billing (402)', needsKey: false };
  if (status === 403) return { reason: 'forbidden/quota (403)', needsKey: false };
  if (status === 401) return { reason: 'invalid key (401)', needsKey: true };
  if (status >= 500) return { reason: `server error (${status})`, needsKey: false };
  return { reason: `error (${status})`, needsKey: false };
}
```

---

#### Cloud path (`attemptCloud`)

```ts
// src/main/voice/stt-service.ts:111–180
async function attemptCloud(
  plugin: VoicePlugin,
  req: TranscribeRequest,
  deps: SttDeps,
): Promise<Attempt>
```

Constrói um `FormData` com `model`, `response_format: "json"`, `language` (omitido em modo translate) e o blob de áudio. Para translate, troca automaticamente `whisper-large-v3-turbo` → `whisper-large-v3` porque o endpoint `/audio/translations` do Groq rejeita o turbo:

```ts
// src/main/voice/stt-service.ts:130–133
let model = plugin.model ?? 'whisper-large-v3-turbo';
if (translate && model === 'whisper-large-v3-turbo') {
  model = 'whisper-large-v3';
}
```

O endpoint é calculado por `resolveEndpoint`:

```ts
// src/main/voice/stt-service.ts:84–90
export function resolveEndpoint(plugin: VoicePlugin, translate: boolean): string {
  const base = plugin.endpoint ?? 'https://api.groq.com/openai/v1/audio/transcriptions';
  if (translate && base.endsWith('/audio/transcriptions')) {
    return base.replace(/\/audio\/transcriptions$/, '/audio/translations');
  }
  return base;
}
```

Resposta esperada da API: `{ text: string }` (JSON). Campo `text` vazio → trata como falha.

---

#### Local path (`attemptLocal` — whisper.cpp)

```ts
// src/main/voice/stt-service.ts:214–245
async function attemptLocal(
  plugin: VoicePlugin,
  req: TranscribeRequest,
  deps: SttDeps,
): Promise<Attempt>
```

Binary candidates (em ordem de preferência):

```ts
// src/main/voice/stt-service.ts:185–195
function whisperBinCandidates(plugin: VoicePlugin): string[] {
  const nexusBin = path.join(os.homedir(), '.nexus', 'bin');
  return [
    plugin.localBin,
    'whisper-cli',
    'whisper-cpp',
    'main',
    path.join(nexusBin, 'whisper-cli'),
    path.join(nexusBin, 'main'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
}
```

Modelo ggml candidates (`~/.nexus/models/whisper/`): `ggml-{plugin.model}.bin` → `ggml-base.bin` → `ggml-small.bin` → `ggml-base.en.bin`.

Escreve o áudio em `.wav` em `os.tmpdir()`, chama o binário com `-f <wav> -m <model> -otxt -nt [-tr]`, lê o `.txt` gerado, limpa os temporários no `finally`.

---

#### `provider-select.ts` — resolução do chain

```ts
// src/main/voice/provider-select.ts:93–104
export function flattenChain(head: VoicePlugin): VoicePlugin[]
```

Percorre `head → head.fallback → …` (máx 32 links) e retorna array plano. `transcribe` usa essa lista diretamente para iterar; a seleção pro-ativa usa `selectPlugin`:

```ts
// src/main/voice/provider-select.ts:118–127
export function selectPlugin(
  head: VoicePlugin,
  probes: ProviderProbes,
): VoicePlugin | null
```

`classifyKind` define se o provider é `'cloud'` | `'local'` | `'system'`:

```ts
// src/main/voice/provider-select.ts:29–33
export function classifyKind(plugin: VoicePlugin): ProviderKind {
  if (SYSTEM_PROVIDERS.has(plugin.provider)) return 'system';
  if (plugin.localBin) return 'local';
  return 'cloud';
}
```

`promoteProvider` reordena o chain quando o usuário pina um provider nas configurações (puro, sem mutação):

```ts
// src/main/voice/provider-select.ts:134–140
export function promoteProvider(head: VoicePlugin, providerId: string): VoicePlugin {
  const plugins = flattenChain(head);
  const idx = plugins.findIndex((p) => p.provider === providerId);
  if (idx <= 0) return head;
  const reordered = [plugins[idx], ...plugins.filter((_, i) => i !== idx)];
  return relink(reordered);
}
```

---

#### Leitura de secrets (`voice-secrets.ts`)

```ts
// src/main/voice/voice-secrets.ts:18–23
export function resolveVoiceApiKey(envVar: string): string | undefined {
  const stored = getVoiceApiKey(envVar)?.trim();
  if (stored) return stored;
  const inherited = process.env[envVar]?.trim();
  return inherited || undefined;
}
```

Prioridade: **secure storage** (Electron `safeStorage`, prefixo `voice-env:`) → `process.env[envVar]`. Em `SttDeps`, `getEnv` aponta para `resolveVoiceApiKey` (linha 70: `getEnv: resolveVoiceApiKey`). Keys nunca saem do processo main.

---

### 6.4 TTS

#### Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/main/voice/tts-service.ts` | Síntese de fala + fallback chain + seam do echo-suppressor |
| `src/main/voice/jarvis-narrator.ts` | Narração proativa de handoffs (eventos de worker) |
| `src/renderer/voice/voice-playback.ts` | Decodificação e reprodução de áudio no renderer |

---

#### `speak` — entrada pública

```ts
// src/main/voice/tts-service.ts:266–311
export async function speak(
  req: SpeakRequest,
  config: VoiceConfig,
  _probes: ProviderProbes,
  deps: TtsDeps = defaultDeps,
): Promise<SpeakResult>
```

`SpeakRequest`:

```ts
// campo          tipo       descrição
text              string     texto a sintetizar
speakMode?        string     override de config.speakMode
echoRecord?       boolean    false → não registra na janela de eco
```

`SpeakResult` (sucesso com áudio):

```ts
{ ok: true; provider: string; mode: 'audio'; format: 'mp3'|'wav'; audioBase64: string; fallbackNote?: string }
```

`SpeakResult` (fallback macOS say — sem bytes):

```ts
{ ok: true; provider: 'macos-say'; mode: 'played' }
```

`SpeakResult` (silêncio — texto em branco após `toSpeakable`):

```ts
{ ok: true; provider: '-'; mode: 'silent' }
```

---

#### Deadlines

```ts
// src/main/voice/tts-service.ts:52–53
export const TTS_CLOUD_TIMEOUT_MS = 15_000;
export const TTS_LOCAL_TIMEOUT_MS = 20_000;
```

Cloud usa `AbortSignal.timeout(TTS_CLOUD_TIMEOUT_MS)` no `fetch`. Piper usa `setTimeout` + `proc.kill('SIGKILL')` após `TTS_LOCAL_TIMEOUT_MS`.

---

#### Providers suportados e suas dependências

| Provider | Kind | Env var | Endpoint padrão | Modelo / voz padrão | Formato retornado |
|---|---|---|---|---|---|
| `openai` | cloud | `OPENAI_API_KEY` | `https://api.openai.com/v1/audio/speech` | `gpt-4o-mini-tts` / `nova` | `mp3` |
| `piper` | local | nenhum | — | `plugin.modelPath` | `wav` |
| `macos-say` | system | nenhum | `/usr/bin/say` | `plugin.voice` (opcional) | played (sem bytes) |

A chain padrão é `openai → piper → macos-say`. Como o fallback final é keyless e sempre disponível em macOS, a pipeline **pode sempre falar**.

---

#### Cloud path (`speakCloud`)

```ts
// src/main/voice/tts-service.ts:164–214
async function speakCloud(
  plugin: VoicePlugin,
  text: string,
  deps: TtsDeps,
  persona: VoicePersona,
): Promise<SpeakResult>
```

Corpo JSON enviado ao endpoint:

```ts
{
  model:           plugin.model ?? 'tts-1',
  voice:           plugin.voice ?? 'nova',
  instructions:    ttsInstructions(persona),   // apenas para gpt-4o-mini-tts
  input:           text,
  response_format: plugin.format ?? 'mp3',
  speed:           plugin.speed ?? 1.0,
}
```

`instructions` é incluído apenas quando `model.startsWith('gpt-4o-mini-tts')`:

```ts
// src/main/voice/tts-service.ts:188–191
...((plugin.model ?? 'gpt-4o-mini-tts').startsWith('gpt-4o-mini-tts')
  ? { instructions: ttsInstructions(persona) }
  : {}),
```

`ttsInstructions` monta um prompt de persona com nome do assistente, nome do usuário e instruções customizadas (src/main/voice/tts-service.ts:145–162).

A resposta é lida como `arrayBuffer` e retornada como `audioBase64` (base64 dos bytes brutos de MP3/WAV). Não há parsing JSON.

---

#### Local path — Piper

```ts
// src/main/voice/tts-service.ts:113–143
function runPiperLocal(plugin: VoicePlugin, text: string): Promise<Buffer>
```

Spawna `piper --output_file - [--model <path>]`, escreve o texto em `stdin`, lê WAV de `stdout`. Timer de `TTS_LOCAL_TIMEOUT_MS` mata com `SIGKILL` se travar. Retorna `Buffer` com bytes WAV.

---

#### System path — macOS `say`

```ts
// src/main/voice/tts-service.ts:91–111
export function speakViaSay(text: string, voice?: string): Promise<void>
```

Spawna `/usr/bin/say` com texto como único argv (sem shell → sem injeção). Mantém referência em `activeSay` para permitir barge-in:

```ts
// src/main/voice/tts-service.ts:76–85
export function stopSystemSpeech(): void {
  if (activeSay) {
    try { activeSay.kill('SIGKILL'); } catch { }
    activeSay = null;
  }
}
```

SIGKILL no `say` é tratado como conclusão normal (não erro) — barge-in limpo.

---

#### Seam do echo-suppressor

```ts
// src/main/voice/tts-service.ts:298
if (req.echoRecord !== false) echoSuppressor.record(text);
```

Toda síntese bem-sucedida registra o texto falado na janela do `echoSuppressor` (importado de `./echo-suppress`). Acks e fillers curtos (ex.: "Sim?", "Deixa comigo.") enviam `echoRecord: false` para não poluir a janela — evita que respostas legítimas do usuário com palavras coincidentes sejam censuradas pelo STT logo depois. A lógica interna do supressor (tamanho da janela, matching) vive em §5 deste documento.

O provider `sticky` (`stickyTtsProvider`) garante que o provider que funcionou na última fala permaneça na frente da chain enquanto a conversa estiver ativa, evitando troca de voz no meio de uma resposta:

```ts
// src/main/voice/tts-service.ts:286
stickyTtsProvider = plugin.provider === chain[0]?.provider ? plugin.provider : null;
```

---

#### `jarvis-narrator.ts` — narração proativa

```ts
// src/main/voice/jarvis-narrator.ts:88–97
export function initJarvisNarrator(broadcast: Broadcast): void
export function shutdownJarvisNarrator(): void
```

Subscreve `onHandoffsChange` (handoff-store) e narra em voz alta quando um worker entrega, trava, falha ou fica bloqueado — sem polling.

Anti-tagarelice:

- **Boot grace** de 6 000 ms: nada é falado nos primeiros segundos (`BOOT_GRACE_MS = 6_000`).
- **Corte temporal**: só narra handoffs com `createdAt > startedAt` (instante do `init`). Histórico do SQLite é marcado como `seen` mas nunca falado.
- **Debounce de 1 500 ms** (`BURST_MS`): rajadas de workers terminando juntos viram um único aviso.
- **Dedup por id**: `seen: Set<string>` evita falar o mesmo handoff duas vezes.
- Só ativo quando `config.routing === 'jarvis'`.

A narração é despachada via `broadcast('voice:narrate', { text })` — o renderer recebe pelo canal IPC, chama `speak` e `playSpeakResult`.

---

#### `voice-playback.ts` — renderer

```ts
// src/renderer/voice/voice-playback.ts:67–71
export async function playSpeakResult(result: SpeakResult): Promise<void> {
  if (result.ok && result.mode === 'audio') {
    await playAudioBase64(result.audioBase64, result.format);
  }
}
```

`playAudioBase64` decodifica base64, usa `AudioContext.decodeAudioData` e `AudioBufferSourceNode`. Geração (`playbackGen`) invalida reproduções em andamento quando chega nova fala (barge-in sem race):

```ts
// src/renderer/voice/voice-playback.ts:44–65
export async function playAudioBase64(base64: string, _format: string): Promise<void> {
  const gen = playbackGen;
  // ...
  if (gen !== playbackGen) return;   // invalida se barge-in aconteceu enquanto decodificava
  suppressWake?.(Math.ceil(audioBuffer.duration * 1000) + 500);
  // ...
}
```

`suppressWake` (injetado via `bindWakeSuppressor`) suprime a detecção de wake word durante toda a duração do áudio + 500 ms, evitando que o alto-falante dispare o próprio wake.

`stopAllPlayback` é o ponto de barge-in:

```ts
// src/renderer/voice/voice-playback.ts:21–35
export function stopAllPlayback(): void {
  if (isJarvisLiveEnabled() && useVoiceStore.getState().status === 'speaking') {
    void window.nexus.voice.liveInterrupt('barge-in');
  }
  void window.nexus.voice.stopSpeak().catch(() => {});
  playbackGen += 1;
  for (const src of liveSources) {
    try { src.stop(); } catch { }
  }
  liveSources = [];
}
```

`mode: 'played'` (macOS `say`) não passa pelo renderer — o áudio foi reproduzido diretamente no main por `speakViaSay`; `playSpeakResult` é no-op para esse case.
### 6.5 Brain + fastpath + tool-catalog + memory

---

#### Arquivos

| Arquivo | Localização |
|---|---|
| `jarvis-brain.ts` | `src/main/voice/jarvis-brain.ts` |
| `jarvis-fastpath.ts` | `src/main/voice/jarvis-fastpath.ts` |
| `jarvis-action-fastpath.ts` | `src/main/voice/jarvis-action-fastpath.ts` |
| `jarvis-tool-catalog.ts` | `src/main/voice/jarvis-tool-catalog.ts` |
| `jarvis-memory.ts` | `src/main/voice/jarvis-memory.ts` |
| `jarvis-action-executor.ts` | `src/renderer/voice/jarvis-action-executor.ts` |
| `jarvis-live.ts` | `src/main/voice/jarvis-live.ts` |
| `live-transport-controller.ts` | `src/main/voice/live-transport-controller.ts` |
| `jarvis-reply-loop.ts` | `src/renderer/voice/jarvis-reply-loop.ts` |
| `guardrails.ts` | `src/main/jarvis/guardrails.ts` |
| `permissions.ts` | `src/main/jarvis/permissions.ts` |
| `confirmation-tokens.ts` | `src/main/jarvis/confirmation-tokens.ts` |
| `transcript-store.ts` | `src/main/jarvis/transcript-store.ts` |
| `mcp-ipc.ts` | `src/main/jarvis/mcp-ipc.ts` |
| `mcp-bridge.ts` | `src/renderer/services/mcp-bridge.ts` |

---

#### 6.5.1 `jarvis-brain.ts` — contrato do executor

**Contrato:** `transcript: string → JarvisReply`

A função central é `jarvisThink`:

```ts
// jarvis-brain.ts:364-429
export async function jarvisThink(
  transcript: string,
  ctx: JarvisContext,
  history: JarvisTurn[],
  deps: BrainDeps = defaultBrainDeps,
): Promise<JarvisReply>
```

`JarvisReply` (definido em `src/shared/voice-ipc`) tem a forma `{ say, expectReply?, action }`. `JarvisContext` carrega o estado da IDE (workspace aberto, squads, panes, orchestrator, recents). `history` fornece os últimos 8 turnos para continuidade conversacional.

**Fluxo interno de `jarvisThink`:**

1. **action fast-path** — `jarvisActionFastPath(transcript, ctx)`: comandos imperativos inequívocos executam em ~0 ms, sem LLM.
2. **state fast-path** — `jarvisFastPath(transcript, ctx)`: consultas de estado (hora, panes, workspace) respondem do contexto, sem LLM.
3. **LLM chain** — monta `messages[]` com system prompt + catálogo de tools + persona + context block + memória + history, itera sobre `flattenJarvisBrainProviders(voiceConfig.jarvisBrain)` (Gemini → OpenAI → Groq), chama `chatOnce`, aplica efeitos de memória com `applyMemoryOps(raw)`, e devolve `parseReply(raw)`.

```ts
// jarvis-brain.ts:380-409
const messages: Array<{ role: string; content: string }> = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'system', content: `Nexus MCP tools (use mcp_tool to invoke):\n${jarvisToolCatalogCompact()}` },
  { role: 'system', content: buildJarvisPersonaInstruction(voiceConfig.persona) },
  { role: 'system', content: contextBlock(ctx) },
  ...(facts
    ? [{ role: 'system', content: `Remembered facts (persistent memory):\n${facts}` }]
    : []),
  ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
  { role: 'user', content: transcript },
];
```

**Deadline duro:** `BRAIN_TIMEOUT_MS = 15_000` ms via `AbortSignal.timeout`. Sem ele, um socket preso do provider segura o turno e o renderer fica busy para sempre.

```ts
// jarvis-brain.ts:312
export const BRAIN_TIMEOUT_MS = 15_000;
```

**`chatOnce`** — chamada HTTP única a um provider:

```ts
// jarvis-brain.ts:314-357
export async function chatOnce(
  endpoint: string,
  key: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  deps: BrainDeps,
  jsonMode: boolean,
  maxTokens = 420,
): Promise<string>
```

`maxTokens` default 420 serve às respostas de voz; consumidores de JSON longo (ex: `squad-architect`) devem subir — JSON truncado causa parse error.

**`chatViaBrainChain`** — loop de fallback reutilizável por outros subsistemas (squad-architect, harness-enrich):

```ts
// jarvis-brain.ts:277-306
export async function chatViaBrainChain(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  deps: BrainDeps = defaultBrainDeps,
): Promise<string>
```

**`parseReply`** — extrai o primeiro objeto JSON do raw do modelo (que às vezes vem embrulhado em fences), normaliza `say`/`expectReply`/`action`, e retorna `JarvisReply`. Falha de parse → devolve `say: raw.slice(0,300)` como fallback seguro.

**`applyMemoryOps`** — lê campos extras `remember`/`forget` do JSON cru e chama `jarvisMemory` antes de passar `JarvisReply` ao renderer:

```ts
// jarvis-brain.ts:208-225
function applyMemoryOps(raw: string): void {
  // extrai {remember?: {key,fact}, forget?: string} do JSON
  // chama jarvisMemory.remember() / .forget() — main process only, renderer nunca vê
}
```

**`buildJarvisPersonaInstruction`** — monta bloco de identidade/nome/customInstructions injetado como system message:

```ts
// jarvis-brain.ts:128-164
export function buildJarvisPersonaInstruction(persona: VoicePersona): string
```

**`BrainDeps`** — injeção de dependências para teste:

```ts
// jarvis-brain.ts:166-174
export interface BrainDeps {
  fetchImpl: typeof fetch;
  getKey: (envVar: string) => string | undefined;
}
```

---

#### 6.5.2 Fastpaths — bypass do LLM

Dois módulos distintos, avaliados em série em `jarvisThink` antes de qualquer chamada de rede.

##### `jarvis-fastpath.ts` — consultas de estado (~0 ms)

```ts
// jarvis-fastpath.ts:58-161
export function jarvisFastPath(
  transcript: string,
  ctx: JarvisContext,
): JarvisReply | null
```

Retorna `null` → deixa para o LLM. Retorna `JarvisReply` → bypassa completamente.

**Regra de ouro:** só perguntas de leitura inequívocas. Qualquer verbo de ação ou ambiguidade → `null`. O guard `ACTION_VERBS` vem primeiro:

```ts
// jarvis-fastpath.ts:24-25
const ACTION_VERBS =
  /\b(abre|abra|abrir|roda|rode|rodar|executa|execute|executar|cria|crie|criar|...)\b/;
```

Padrões cobertos (todos com regex após `norm()` — lowercase + NFD + collapse whitespace):

- Hora atual → `new Date().toLocaleTimeString('pt-BR', ...)`
- Panes abertos (`ctx.panes`)
- Pane/URL focado (`ctx.focusedPane`, `ctx.focusedPaneUrl`)
- Squads disponíveis (`ctx.squads`)
- Missões ativas (`ctx.missions`)
- Workspace atual (`ctx.workspace`)
- Orquestrador ativo (`ctx.orchestrator`)
- Tela atual (`ctx.screen`)

Textos até 90 chars são candidatos; acima → LLM.

##### `jarvis-action-fastpath.ts` — ações imperativas inequívocas (~0 ms)

```ts
// jarvis-action-fastpath.ts:37-150
export function jarvisActionFastPath(
  transcript: string,
  ctx: JarvisContext,
): JarvisReply | null
```

Transcrições até 120 chars são candidatas. Padrões cobertos:

| Regex | Action emitida |
|---|---|
| `abre.*terminal` | `{ type: 'open_terminal' }` |
| `abre.*board\|missoes` | `{ type: 'open_board' }` |
| `nova.*missao` | `{ type: 'new_mission' }` |
| `fecha.*pane` | `{ type: 'close_pane' }` |
| `monta.*squad` / `inicia.*squad$` | `{ type: 'design_squad' }` |
| `abre.*squad de <name>` | `{ type: 'open_squad', squadName }` |
| `novo.*workspace` | `{ type: 'new_workspace' }` |
| `abre.*workspace <name>` | `{ type: 'open_workspace', workspaceName }` |
| `roda\|executa <cmd>` | `{ type: 'run_command', command }` |

`stripTail` remove sufixos como "por favor", "agora" antes de extrair o nome do squad/workspace/comando.

**Motivação do design:** o LLM às vezes responde com prosa ("vou abrir o terminal") mas `action: { type: 'none' }` — o usuário ouve a confirmação porém nada acontece. O fast-path de ações elimina essa classe de bug garantindo que comandos curtos e claros disparem a ação correta.

---

#### 6.5.3 `jarvis-tool-catalog.ts` — catálogo de tools

```ts
// jarvis-tool-catalog.ts:4-6
export function jarvisToolCatalogCompact(): string {
  return buildToolset().map((t) => t.name).join(', ');
}
```

`buildToolset()` (em `src/main/orch/tools.ts`) agrega:

```ts
// src/main/orch/tools.ts:21-29
export function buildToolset(): McpToolDef[] {
  return [
    ...buildPaneTools(),      // nexus_pane_*  (~10 tools)
    ...buildDomainTools(),    // nexus_agent_*, nexus_mission_*, nexus_handoff_*, ...
    ...buildMediaTools(),     // nexus_image_*, nexus_video_*, nexus_audio_*
    ...buildFileTools(),      // nexus_file_*  (5 tools)
    ...buildTerminalTools(),  // nexus_terminal_*  (2 tools)
    ...buildGitTools(),       // nexus_git_*   (~10 tools)
    ...buildEditorTools(),    // nexus_editor_* (4 tools)
  ];
}
```

O catálogo compacto é injetado como system message no bloco de tools do LLM — só os nomes, sem schemas completos. O LLM emite `{ type: "mcp_tool", tool: "nexus_*", args: {...} }` e o executor valida + despacha via `mcp-ipc.ts`.

**Para reimplementar:** `jarvisToolCatalogCompact` é um view adapter sobre a registry canônica de tools MCP. Ao portar, o equivalente deve listar os nomes disponíveis para o LLM; schemas completos ficam apenas no dispatcher de IPC.

---

#### 6.5.4 `jarvis-memory.ts` — memória persistente entre sessões

**Problema resolvido:** o histórico de conversa vive ~4 min no renderer e morre com a janela; a memória grava fatos duráveis em disco.

**Shape do fato:**

```ts
// jarvis-memory.ts:17-21
export interface JarvisFact {
  content: string;
  updatedAt: number;
  deleted?: boolean;
  history: Array<{ content: string; at: number }>;
}
```

Armazenado como `Record<string, JarvisFact>` em `~/.nexus/jarvis-memory.json`. Escrita atômica via `write tmp → rename`.

**API pública:**

```ts
// jarvis-memory.ts:52-113
class JarvisMemory {
  remember(key: string, content: string): void   // upsert; mesmo conteúdo = no-op
  forget(key: string): boolean                    // soft-delete; história sobrevive
  list(): Array<{ key, content, updatedAt }>      // ativos, mais recentes primeiro
  factsBlock(maxChars?: number): string           // bloco para system prompt (cap 700 chars)
}
export const jarvisMemory = new JarvisMemory();   // singleton main process
```

**Ciclo de vida de um fato:**

1. LLM inclui `"remember": {"key":"<slug>","fact":"..."}` no JSON de resposta.
2. `applyMemoryOps(raw)` em `jarvis-brain.ts:208` intercepta **antes** de passar ao renderer.
3. `jarvisMemory.remember(key, fact)` grava no arquivo.
4. Na próxima chamada ao cérebro, `jarvisMemory.factsBlock()` injeta os fatos como system message.
5. Para esquecer: LLM inclui `"forget":"<slug>"` → `jarvisMemory.forget(slug)` → `deleted: true`.

**Limites:**

```ts
// jarvis-memory.ts:28-30
const HISTORY_CAP = 10;        // máx histórico por fato
const MAX_FACTS = 200;         // máx total de fatos; evicção LRU + deleted-first
export const FACTS_BLOCK_MAX_CHARS = 700; // cap do bloco para o prompt
```

**Slug:** `slugifyMemoryKey(key)` — lowercase + NFD + `[^a-z0-9]+` → `-`, max 48 chars.

---

#### 6.5.5 `jarvis-action-executor.ts` (renderer) — execução real da ação

```ts
// jarvis-action-executor.ts:84-259
export async function executeJarvisAction(
  reply: JarvisReply,
  context: JarvisContext,
): Promise<JarvisExecutionResult>

export interface JarvisExecutionResult {
  sayText: string;
  expectReply?: boolean;
  toolResult: { tool: JarvisAction['type']; ok: boolean; summary: string } | null;
}
```

**Hierarquia de execução:**

1. **MCP-first** para `mcp_tool`, `close_pane`, `send_to_pane`, `run_command` → `executeViaMcp(action, sayText)`.
2. **UI-path** para `open_squad`, `open_workspace`, `design_squad`, `new_mission`, `new_workspace`, `open_terminal`, `open_board` → operações diretas em Zustand stores e APIs IPC do Electron.

```ts
// jarvis-action-executor.ts:93-101
const mcpFirst = new Set<JarvisAction['type']>([
  'mcp_tool',
  'close_pane',
  'send_to_pane',
  'run_command',
]);
if (mcpFirst.has(action.type)) {
  const mcp = await executeViaMcp(action, sayText);
  if (mcp) return { ...mcp, expectReply };
}
```

**`executeViaMcp`** — converte `JarvisAction` em `{ tool, args }` via `mapActionToTool`, invoca `invokeMcpWithConfirm(tool, args)`:

```ts
// jarvis-action-executor.ts:45-78
async function executeViaMcp(
  action: JarvisAction,
  sayText: string,
): Promise<JarvisExecutionResult | null>
```

Para `run_command`, avisa o usuário antes de pedir confirmação nativa ("Confirma na tela se pedir permissão.").

**Squads** (`open_squad`): fuzzy match no `useOrchStore` por nome exato, depois substring. Guarda exige workspace aberto; chama `launchSquadMission(match, adapters)`.

**Panes** (`send_to_pane`): prefere `orchestratorPaneId` (detectado por `orchRequestId?.startsWith('squad-')`) sobre `focusedPaneId`; chama `writeToPane(id, text + '\n')`.

**`run_command`** (path legado, fora do MCP): abre ou reutiliza shell pane, aguarda sessão com `waitForSession(paneId, 5_000)`, solicita `window.nexus.voice.confirmCommand(command)` → escreve no pane.

##### `mcp-bridge.ts` — lado renderer do IPC MCP

```ts
// mcp-bridge.ts:17-52
export function mapActionToTool(
  action: JarvisAction,
  paneCtx?: McpPaneContext,
): { tool: string; args: Record<string, unknown> } | null
```

Traduz `JarvisAction` para `(tool, args)`:

| Action | Tool MCP |
|---|---|
| `mcp_tool` | passthrough direto |
| `close_pane` | `nexus_pane_close` com `{ paneId: focusedPaneId }` |
| `send_to_pane` | `nexus_pane_write` com `{ paneId, text, submit: true }` |
| `run_command` | `nexus_terminal_run` com `{ command }` |
| UI-only (squad, wizard…) | `null` |

```ts
// mcp-bridge.ts:84-98
export async function invokeMcpWithConfirm(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<McpInvokeResult>
```

Fluxo: `mcpInvoke` → se negado + `requiredConfirmation` → `mcpConfirm` → retry `mcpInvoke`. Tudo via `window.nexus.mcp.*` (preload bridge para IPC).

---

#### 6.5.6 Live turns — roteamento pelo mesmo executor

A arquitetura "route live turns through Jarvis executor" garante que transcrições do modo realtime passem pelo **mesmo** `jarvisThink` / `executeJarvisAction` que o modo classic, sem path paralelo.

##### `jarvis-live.ts` — FSM de sessão no main process

```ts
// jarvis-live.ts:67-229
export class JarvisLiveSession {
  constructor(private emit: Emit, private now: () => number, private transcriptSink?: TranscriptSink)
  start(_req: JarvisLiveStartRequest): JarvisLiveState
  stop(): JarvisLiveState
  endTurn(): JarvisLiveState
  patchStatus(patch: JarvisLiveStatusPatch): JarvisLiveState
  transcript(raw: Omit<JarvisLiveTranscriptEvent, 'sessionId'|'at'>): JarvisLiveTranscriptEvent | null
  onJarvisReply(transcript: string, reply: JarvisReply): void
  toolResult(raw: Omit<...>): JarvisLiveToolResultEvent | null
  interrupt(reason: string): JarvisLiveInterruptEvent
}
```

`JarvisLiveState.status` percorre: `off → dormant → listening → thinking → speaking → interrupted → error`.

`onJarvisReply` é chamado após `jarvisThink` retornar — grava os dois lados da conversa e emite `liveToolCall` se `action.type !== 'none'`:

```ts
// jarvis-live.ts:178-192
onJarvisReply(transcript: string, reply: JarvisReply): void {
  this.transcript({ role: 'user', text: transcript, final: true });
  if (reply.say.trim()) this.transcript({ role: 'assistant', text: reply.say, final: true });
  if (reply.action.type !== 'none') {
    this.emit(VOICE_CHANNELS.liveToolCall, { sessionId, tool: reply.action.type, summary: ... });
  }
}
```

##### `live-transport-controller.ts` — borda IPC ↔ provider realtime

```ts
// live-transport-controller.ts:40-284
export class LiveTransportController {
  constructor(private emit: Emit, private fsm: JarvisLiveSession)
  isRealtimeConfigured(): boolean
  onStart(): Promise<void>             // conecta socket se realtime configurado
  micIn(b64: string): void             // mic → provider (base64 PCM16)
  contextIn(text: string): void        // injeta contexto de texto no provider
  endTurn(): void                      // sinaliza fim de turno ao provider
  interrupt(reason: string): JarvisLiveInterruptEvent
  onStop(): void
}
```

Quando o realtime **não** está configurado (sem key, modo classic), `onStart` faz no-op e o `fsm` recebe `status: 'error'` com mensagem "usando Classic". O Classic segue valendo — fallback nunca perde a intenção.

Bind do provider real:

```ts
// live-transport-controller.ts:175-224
private bindProvider(provider: TurnManagedRealtimeProvider): void {
  provider.onAudioOut(pcm16 => this.emit(VOICE_CHANNELS.liveAudioOut, int16ArrayToBase64(pcm16)));
  provider.onRoleTranscript(line => this.fsm.transcript(line));
  provider.onInterrupted(() => this.fsm.interrupt('barge-in'));
  provider.onResponseDone(() => this.fsm.patchStatus({ status: 'dormant', realtimeReady: true }));
  provider.onError(err => ...);
  provider.onDisconnected(err => { this.scheduleReconnect(); ... });
}
```

Reconnect exponential backoff: base 750 ms, máx 3 tentativas.

`buildSystemInstruction` injeta `loadJarvisSystemPrompt()` + persona + `jarvisMemory.factsBlock()` no provider realtime — mesma memória do Classic.

##### `jarvis-reply-loop.ts` — controle anti-loop no renderer

```ts
// jarvis-reply-loop.ts:47-67
export function shouldReopenJarvisListening(opts: {
  expectReply: boolean;
  sayText: string;
  realtimeTurnActive: boolean;
  isRealtimeLive: boolean;
  captureReason?: JarvisCaptureReason;
}): boolean
```

Impede TTS→mic→"não entendi"→TTS→… loop infinito:

```ts
// jarvis-reply-loop.ts:8-9
export const MAX_AUTO_REPLY_LOOPS = 5;
export const MAX_CONFUSION_REPLY_REOPENS = 1;
```

Regras de reabertura:
1. Se `autoReplyLoopCount >= 5` → nunca reabre.
2. Se realtime turn ativo + live → sempre reabre (full-duplex já cuida do controle).
3. Se `isConfusionReply(sayText)` (detecção de frases tipo "não entendi") → reabre só uma vez.
4. Caso geral: reabre se `expectReply === true`.

`resetAutoReplyLoopForCapture(reason)` reseta o contador quando o motivo da captura não é `'reply'` (manual, wake, PTT).

---

#### 6.5.7 Governance — guardrails, permissions, tokens, transcript, MCP IPC

##### `guardrails.ts` — classificação destrutivo/seguro

```ts
// guardrails.ts:86-140
export function isDestructive(command: string): boolean
export function requiresConfirmation(toolName: string, args: Record<string, unknown>): boolean
export function confirmationReason(toolName: string, args: Record<string, unknown>): string
```

Três categorias:

- **`NEVER_CONFIRM_TOOLS`**: leitura pura — `nexus_file_read`, `nexus_git_status`, `nexus_git_diff`, `nexus_pane_read`, `nexus_agent_list`, … — executam sem diálogo.
- **`ALWAYS_CONFIRM_TOOLS`**: impacto alto — `nexus_file_write`, `nexus_terminal_run`, `nexus_git_push`, `nexus_git_commit`, `nexus_editor_insert`, `nexus_editor_replace_selection` — sempre pedem confirmação nativa.
- **Default safety-first**: qualquer tool desconhecida → `requiresConfirmation = true`.

`DESTRUCTIVE_PATTERNS` (15+ regexes) cobre `rm -rf`, `git push --force`, `git reset --hard`, `sudo`, `DROP TABLE`, `TRUNCATE`, `kubectl delete`, `docker system prune`, etc.

##### `permissions.ts` — cache in-memory de permissões por sessão

```ts
// permissions.ts:59-108
export function permissionKey(scope: PermissionScope): string // sessionId:workspaceId:toolName:argsHash
export function hasPermission(scope: PermissionScope): boolean
export function grantPermission(scope: PermissionScope): void
export function revokePermission(scope: PermissionScope): void
export function clearSession(sessionId: string): void

export interface PermissionScope {
  sessionId: string;
  workspaceId: string;
  toolName: string;
  args: Record<string, unknown>;
}
```

Hash dos args: SHA-256 (primeiros 16 hex) sobre `JSON.stringify` normalizado (keys ordenadas, ciclos detectados). Workspace hashed também. Resultado: uma aprovação para `(sessionId, workspaceId, tool, args)` não reutiliza em outra sessão ou workspace.

##### `confirmation-tokens.ts` — tokens CSRF de confirmação

```ts
// confirmation-tokens.ts:22-41
export function createConfirmationToken(scope: PermissionScope): string  // 32 bytes hex, TTL 30s
export function consumeConfirmationToken(token: string, scope: PermissionScope): boolean // single-use
```

Tokens são de uso único (deletados no consumo) e expiram em 30 s. Impedem replay attacks: o renderer deve apresentar o token gerado pelo main para confirmar que foi o mesmo fluxo que pediu a permissão.

##### `transcript-store.ts` — persistência de conversa

```ts
// transcript-store.ts:44-141
export class TranscriptStore {
  append(sessionId: string, line: TranscriptAppend): TranscriptRecord | null
  pathForSession(sessionId: string): string
}
export const transcriptStore = new TranscriptStore();
```

Só grava linhas `final: true`. Escrita em `~/Library/Application Support/NexusIDE/transcripts/<ISO-date>-<sessionId>.jsonl`. Rotação por tamanho (1 MB) e retenção de 30 dias (pruneExpired). Texto truncado em 4 000 chars por linha.

```ts
// transcript-store.ts:26-33
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 4_000;
const DEFAULT_RETENTION_DAYS = 30;
```

##### `mcp-ipc.ts` — bridge main-side IPC para MCP tools

```ts
// mcp-ipc.ts:64-78
export async function invokeMcpTool(raw: McpInvokeRequest): Promise<McpInvokeResult>
// mcp-ipc.ts:103-163
export async function confirmMcpTool(raw: McpConfirmRequest): Promise<McpConfirmResult>
```

**Fluxo de `confirmMcpTool`:**
1. Resolve tool na registry (`resolveTool`).
2. Valida args (`validateToolArgs`).
3. Se `raw.granted === true`: consome o token de confirmação → `grantPermission(scope)`.
4. Caso contrário: checa `requiresConfirmation` → se necessário, abre `dialog.showMessageBox` nativo → se aprovado, cria token, consome imediatamente, `grantPermission`.

```ts
// mcp-ipc.ts:80-101
async function requestNativeConfirmation(
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
  workspaceId: string,
): Promise<boolean>
// Electron dialog.showMessageBox({ type:'warning', buttons:['Deny','Allow'], ... })
```

Handlers IPC registrados em `registerMcpIpc()`:
- `MCP_CHANNELS.invoke` → `invokeMcpTool`
- `MCP_CHANNELS.confirm` → `confirmMcpTool`
- `MCP_CHANNELS.clearSession` → `clearMcpRendererSession` (chama `clearSession('jarvis-renderer')`)

---

#### Diagrama de fluxo (Classic turn)

```
Transcript (string)
       │
       ▼
jarvisActionFastPath()   ──── match ────► JarvisReply (action, ~0ms)
       │ null
       ▼
jarvisFastPath()         ──── match ────► JarvisReply (state, ~0ms)
       │ null
       ▼
 build messages[]
 (system+tools+persona+context+memory+history)
       │
       ▼
chatOnce() × providers   ──── timeout 15s ────► raw JSON string
       │
  applyMemoryOps(raw)    ── remember/forget ──► jarvisMemory (disk)
       │
  parseReply(raw)
       │
       ▼
    JarvisReply
       │
       ▼ (renderer)
executeJarvisAction()
  ├── mcpFirst set ──► mapActionToTool ──► invokeMcpWithConfirm()
  │                     (mcp-bridge)           │
  │                                    mcpInvoke (IPC) ──► invokeMcpTool (main)
  │                                            │            ├─ dispatchToolCall
  │                                            │            └─ (se negado) confirmMcpTool
  │                                                               ├─ requiresConfirmation (guardrails)
  │                                                               ├─ dialog.showMessageBox
  │                                                               ├─ createConfirmationToken
  │                                                               └─ grantPermission
  └── UI-path ──► Zustand stores + Electron IPC
```

#### Pontos críticos para reimplementação

1. **Fast-paths vêm primeiro, sempre.** Qualquer refactor que mova a ordem de avaliação ou chame o LLM antes deles piora a latência percebida e introduz bugs de ação não executada.
2. **`applyMemoryOps` acontece no main**, antes de devolver ao renderer. O renderer não deve ter acesso à camada de persistência de memória.
3. **`BRAIN_TIMEOUT_MS = 15_000`** é um deadline duro. Sem ele, o renderer trava indefinidamente em busy state.
4. **Confirmation tokens são de uso único** e expiram em 30 s. O fluxo invoke→confirm→invoke é obrigatório para qualquer tool em `ALWAYS_CONFIRM_TOOLS`; não há bypass.
5. **`clearSession('jarvis-renderer')`** deve ser chamado no fim de cada sessão Jarvis para liberar o cache de permissões — caso contrário permissões de uma sessão vazam para a próxima.
6. **Live turns passam pelo mesmo `jarvisThink`**, não por um path paralelo. `LiveTransportController` só gerencia o transporte de áudio/transcrição; a decisão de ação ainda é do `jarvis-brain`.
7. **`jarvisToolCatalogCompact()`** injeta apenas os nomes (não os schemas) no prompt. Schemas ficam no dispatcher (`mcp-ipc.ts`/`mcp-dispatch.ts`). Manter essa separação evita prompt bloat.
### 6.6 Prefs / HUD

#### hud-prefs.ts — tipos, constantes e persistência

`src/renderer/voice/hud-prefs.ts` é um módulo puro (zero dependências de browser diretas — DOM/Storage entram por parâmetro) que centraliza todo o modelo de estado persistido do HUD.

**Tipos públicos:**

```ts
// hud-prefs.ts:13-14
export type HudMode = 'expanded' | 'mini' | 'hidden';
export type HudCorner = 'tl' | 'tr' | 'bl' | 'br';

// hud-prefs.ts:16-25
export interface HudPrefs {
  mode: HudMode;
  corner: HudCorner;
  /** Distância horizontal (px) da borda do canto ancorado. */
  dx: number;
  /** Distância vertical (px) da borda do canto ancorado. */
  dy: number;
  /** Largura do painel expandido (px). */
  width: number;
}
```

**Constantes de clamp:**

```ts
// hud-prefs.ts:27-30
export const HUD_MIN_WIDTH = 240;
export const HUD_MAX_WIDTH = 480;
export const HUD_EDGE_MARGIN = 8;

export const DEFAULT_HUD_PREFS: HudPrefs = {
  mode: 'expanded',
  corner: 'br',
  dx: 20,
  dy: 20,
  width: 300,
};
```

**Chave localStorage:**

```ts
// hud-prefs.ts:40
const STORAGE_KEY = 'nexus.voiceHud';
```

**Guardrail 1 — persitência defensiva (`loadHudPrefs` / `saveHudPrefs`):**

`loadHudPrefs` (hud-prefs.ts:111) aceita uma `StorageLike = Pick<Storage, 'getItem' | 'setItem'>`, lê `nexus.voiceHud`, valida cada campo (whitelist de `MODES` e `CORNERS`, `Number.isFinite` para offsets, `clampHudWidth` para a largura) e cai de volta nos defaults se qualquer campo for inválido ou o JSON estiver corrompido. `saveHudPrefs` (hud-prefs.ts:138) silencia silenciosamente falhas de storage (cota cheia ou `localStorage` indisponível): a preferência sobrevive apenas na sessão nesses casos.

```ts
// hud-prefs.ts:111-136
export function loadHudPrefs(storage: StorageLike): HudPrefs {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_HUD_PREFS };
    const parsed = JSON.parse(raw) as Partial<HudPrefs>;
    return {
      mode: MODES.includes(parsed.mode as HudMode)
        ? (parsed.mode as HudMode)
        : DEFAULT_HUD_PREFS.mode,
      corner: CORNERS.includes(parsed.corner as HudCorner)
        ? (parsed.corner as HudCorner)
        : DEFAULT_HUD_PREFS.corner,
      dx: typeof parsed.dx === 'number' && Number.isFinite(parsed.dx) && parsed.dx >= 0
          ? Math.round(parsed.dx) : DEFAULT_HUD_PREFS.dx,
      dy: typeof parsed.dy === 'number' && Number.isFinite(parsed.dy) && parsed.dy >= 0
          ? Math.round(parsed.dy) : DEFAULT_HUD_PREFS.dy,
      width: clampHudWidth(parsed.width ?? DEFAULT_HUD_PREFS.width),
    };
  } catch {
    return { ...DEFAULT_HUD_PREFS };
  }
}
```

**Funções de geometria auxiliares:**

| Função | Assinatura | Propósito |
|---|---|---|
| `clampHudWidth` | `(width: number) => number` | Força `[240, 480]` |
| `nearestCorner` | `(cx, cy, vw, vh) => HudCorner` | Canto pelo centro do elemento |
| `anchorFromDrag` | `(rect: DragRect, viewport) => { corner, dx, dy }` | Converte posição solta em âncora, clampada para dentro do viewport |
| `hudPositionStyle` | `(prefs) => { left?, right?, top?, bottom? }` | CSS `position: fixed` a partir da âncora |

---

#### voice-store.ts — store Zustand do renderer

`src/renderer/voice/voice-store.ts` é a store Zustand que centraliza todo o estado de UI da voz no renderer. As preferências do HUD vivem **dentro** desta store como fatia `hud: HudPrefs`.

**Interface completa da store:**

```ts
// voice-store.ts:36-75
interface VoiceStore {
  status: VoiceUiStatus;      // 'idle' | 'listening' | 'transcribing' | 'routing' | 'speaking' | 'error'
  info: VoiceRuntimeInfo | null;
  level: number;              // [0,1] — amplitude ao vivo do mic
  lastTranscript: string;
  lastSpoken: string;
  note: string | null;
  error: string | null;
  micHealth: MicHealth;       // 'ok' | 'needsPermission' | 'silent'
  settingsOpen: boolean;
  liveState: JarvisLiveState | null;
  liveTranscript: JarvisLiveTranscriptEvent[];
  transcriptAppend: JarvisTranscriptAppendEvent[];
  liveTool: JarvisLiveToolEvent | JarvisLiveToolResultEvent | null;
  liveInterrupted: JarvisLiveInterruptEvent | null;
  hud: HudPrefs;              // persistido em nexus.voiceHud

  setHudMode: (mode: HudMode) => void;
  setHudAnchor: (anchor: { corner: HudCorner; dx: number; dy: number }) => void;
  setHudWidth: (width: number) => void;
  // ...
}
```

**Inicialização do HUD com degradação graceful para teste Node:**

```ts
// voice-store.ts:78-84
const hudStorage: Pick<Storage, 'getItem' | 'setItem'> | null =
  typeof localStorage === 'undefined' ? null : localStorage;

function persistHud(prefs: HudPrefs): HudPrefs {
  if (hudStorage) saveHudPrefs(hudStorage, prefs);
  return prefs;
}
```

A store lê `loadHudPrefs(localStorage)` na criação (voice-store.ts:101) e toda mutação `setHudMode` / `setHudAnchor` / `setHudWidth` chama `persistHud` antes de atualizar o estado — garantindo que a cada clique/drag o `localStorage` esteja em sincronia sem necessidade de um "botão salvar".

---

#### VoiceHud.tsx — painel flutuante

`src/renderer/components/VoiceHud.tsx` é o único componente que consome o estado `hud` do store para montar o painel visual.

**Sem props — o componente é autossuficiente:**

```tsx
// VoiceHud.tsx:53
export function VoiceHud() {
  const hud = useVoiceStore((s) => s.hud);
  const setHudMode = useVoiceStore((s) => s.setHudMode);
  const setHudAnchor = useVoiceStore((s) => s.setHudAnchor);
  const setHudWidth = useVoiceStore((s) => s.setHudWidth);
  // ...
```

**Três modos de renderização:**

| `hud.mode` | Comportamento |
|---|---|
| `'hidden'` | `return null` (linha 94) — zero DOM, a voz funciona 100% sem visual |
| `'mini'` | Pill compacta (orb + rótulo de fase + botão ✕) — clique sem drag expande |
| `'expanded'` | Painel completo com titlebar arrastável, alça de resize e transcript |

**Drag com âncora de canto:** O componente usa refs de estado transitório (`dragPos`) durante o drag — `left/top` absolutos — e ao soltar (`endDrag`, linha 155) converte a posição real do elemento via `anchorFromDrag`, chamando `setHudAnchor` que persiste imediatamente.

**Resize com clamp:** A alça lateral (`beginResize`/`moveResize`, linhas 180–201) calcula o delta em X, inverte dependendo do `hud.corner` (ancoragem à direita alarga à esquerda), e chama `setHudWidth(...)` que aplica `clampHudWidth` na store.

**Guardrail 2 — mic-health surfaced no HUD:**

```tsx
// VoiceHud.tsx:341-364
{micHealth === 'needsPermission' && (
  <span className="voice-hud__detail voice-hud__detail--error">
    Microfone sem permissão — a JARVIS não te ouve.
    <button onClick={() => navigator.mediaDevices.getUserMedia({ audio: true })...}>
      Permitir
    </button>
    <button onClick={() => window.nexus.voice.openMicSettings()}>
      Ajustes
    </button>
  </span>
)}
{micHealth === 'silent' && (
  <span className="voice-hud__detail voice-hud__detail--error">
    Não estou ouvindo nada — mic mudo ou dispositivo errado.
    <button onClick={() => window.nexus.voice.openSoundSettings()}>
      Ajustes de som
    </button>
  </span>
)}
```

O campo `micHealth: MicHealth` do store (`'ok' | 'needsPermission' | 'silent'`) é promovido diretamente no HUD expandido com botões de ação inline.

---

#### VoiceSettings.tsx — drawer de configuração

`src/renderer/components/VoiceSettings.tsx` é o painel lateral de configuração completa. Também lê e escreve o HUD, além de toda a configuração de pipeline.

**Props/contrato:** Sem props. Abre/fecha via `useVoiceStore((s) => s.settingsOpen)`.

**Controles do HUD no settings:**

```tsx
// VoiceSettings.tsx:123-124
const hudMode = useVoiceStore((s) => s.hud.mode);
const setHudMode = useVoiceStore((s) => s.setHudMode);
```

O painel expõe um radiogroup de três botões (`EXPANDIDA` / `MINI` / `SÓ ÁUDIO`) que chamam `setHudMode` diretamente, com persistência imediata via store.

**Toggle "Áudio realtime" com persistência otimista:** O bug original ("coloco live live e não fica") foi corrigido por `persistLive` (linha 273) que chama `window.nexus.voice.setConfig` **imediatamente** ao toglar, sem depender do botão Salvar:

```tsx
// VoiceSettings.tsx:273-289
const persistLive = async (patch: {
  jarvisLiveEnabled?: boolean;
  jarvisLiveTransport?: 'classic' | 'openai-realtime';
}) => { ... }

const toggleJarvisLive = (on: boolean) => {
  setJarvisLiveOn(on);
  void persistLive({ jarvisLiveEnabled: on, ... });
};

const toggleRealtime = (on: boolean) => {
  setLiveRealtime(on);
  if (on) setJarvisLiveOn(true);
  void persistLive({
    jarvisLiveEnabled: on ? true : jarvisLiveOn,
    jarvisLiveTransport: on ? 'openai-realtime' : 'classic',
  });
};
```

---

#### VoiceButton.tsx — pill VOX da WorkspaceBar

`src/renderer/components/VoiceButton.tsx` é o controle permanente da barra de workspace.

**Sem props. Contrato via store:**

```tsx
// VoiceButton.tsx:15-20
export function VoiceButton() {
  const info = useVoiceStore((s) => s.info);
  const status = useVoiceStore((s) => s.status);
  const liveState = useVoiceStore((s) => s.liveState);
  const openSettings = useVoiceStore((s) => s.openSettings);
```

**Não lê `hud`** — é o indicador de estado que permanece visível mesmo em `hud.mode === 'hidden'`. Clique simples → `requestJarvisWake()`; clique modificado (⌥/⌘/⌃) ou right-click → `openSettings()`.

**Rótulo dinâmico:**

```tsx
// VoiceButton.tsx:36-41
const label =
  wakeBlocked ? 'wake preso' :
  liveOn && liveState?.status && liveState.status !== 'off'
    ? `live:${liveState.status}` :
  active ? status :
  `${stt} → ${tts}`;
```

---

## 7. Modo gemini-live hibernado

### 7.1 A interface `TurnManagedRealtimeProvider` (provider.ts)

`src/main/jarvis/realtime/provider.ts` define a hierarquia de interfaces que abstraem qualquer transporte realtime.

```ts
// provider.ts:1-31
export interface RealtimeProvider {
  connect(): Promise<void>;
  sendAudioChunk(pcm16: Int16Array): void;
  onTranscript(cb: (delta: string, final: boolean) => void): void;
  onAudioOut(cb: (pcm16: Int16Array) => void): void;
  onError(cb: (err: Error) => void): void;
  interrupt(): void;
  close(): void;
}

export interface RoleAwareRealtimeProvider extends RealtimeProvider {
  onRoleTranscript(cb: (event: RealtimeTranscriptEvent) => void): void;
}

export interface TurnManagedRealtimeProvider extends RoleAwareRealtimeProvider {
  readonly isReady: boolean;
  endUserTurn(): void;
  sendContext(text: string): void;
  sendText(text: string): void;
  onInterrupted(cb: () => void): void;
  onResponseDone(cb: () => void): void;
  onDisconnected(cb: (err: Error) => void): void;
}

export type RealtimeProviderId = 'openai' | 'gemini';
```

O tipo `RealtimeProviderId = 'openai' | 'gemini'` já nomeia os dois transportes. Ambas as implementações satisfazem `TurnManagedRealtimeProvider` e são intercambiáveis pelo controller.

Utilitários de PCM no mesmo arquivo:

```ts
// provider.ts:35-64
export function int16ArrayToBase64(samples: Int16Array): string { ... }
export function base64ToInt16Array(base64: string): Int16Array { ... }
export function resamplePcm16(input: Int16Array, sourceRate: number, targetRate: number): Int16Array { ... }
```

---

### 7.2 A factory e a seleção de provedor (factory.ts)

`src/main/jarvis/realtime/factory.ts` resolve qual(is) provider(s) instanciar, em ordem de preferência.

**Resolução de IDs de provedor:**

```ts
// factory.ts:63-71
export function resolveRealtimeProviderIds(
  config: VoiceConfig,
  env: NodeJS.ProcessEnv = process.env,
): RealtimeProviderId[] {
  const forced = env.NEXUS_REALTIME_PROVIDER?.trim().toLowerCase();
  if (forced === 'openai' || forced === 'gemini') return [forced];
  if (config.jarvisLive.transport === 'openai-realtime') return ['openai', 'gemini'];
  if (config.jarvisLive.transport === 'gemini-live') return ['gemini'];
  return [];
}
```

- `transport === 'classic'` (padrão de produção) → retorna `[]` → **nenhum provider realtime é criado**.
- `transport === 'openai-realtime'` → tenta `openai` primeiro, usa `gemini` como fallback.
- `transport === 'gemini-live'` → força exclusivamente `gemini`.
- `NEXUS_REALTIME_PROVIDER=gemini` env var → override absoluto.

**Criação de candidatos:**

```ts
// factory.ts:87-131
export function createRealtimeProviderCandidates(
  options: RealtimeProviderFactoryOptions,
): RealtimeProviderCandidate[] {
  // Para cada providerId em resolveRealtimeProviderIds():
  //   'openai' → new OpenAIRealtimeProvider({ apiKey, model, voice, instructions })
  //   'gemini' → new GeminiLiveProvider({ apiKey, model, voiceName, instructions })
  // Candidatos sem key são pulados silenciosamente.
}
```

O `LiveTransportController` chama `createRealtimeProviderCandidates` e tenta cada candidato em sequência (primeiro disponível ganha), com log de aviso no console para cada falha.

---

### 7.3 OpenAIRealtimeProvider — implementação ativa (openai-realtime.ts)

`src/main/jarvis/realtime/openai-realtime.ts` implementa `TurnManagedRealtimeProvider` via WebSocket `wss://api.openai.com/v1/realtime`.

**Classe e campos chave:**

```ts
// openai-realtime.ts:184-218
export class OpenAIRealtimeProvider implements TurnManagedRealtimeProvider {
  private ws: RealtimeWsLike | null = null;
  private ready = false;
  private pendingAudio: Int16Array[] = [];  // buffer pré-setup, teto 512 KB
  private readonly model: string;           // default 'gpt-realtime-2.1'
  private readonly voice: string;           // default 'alloy'
  private readonly sourceRate: number;      // 16 kHz (mic)
  private readonly targetRate: number;      // 24 kHz (API)
  // ...
}
```

**Fluxo de setup:** `connect()` abre o socket, envia `session.update` com `output_modalities: ['audio']` e turn detection desabilitado (VAD manual). A flag `ready = true` é set no evento `session.updated`. Chunks de áudio antes do ready são bufferizados em `pendingAudio` (máx. 512 KB) e `flushPendingAudio` é chamado na transição.

**Barge-in:** O evento `input_audio_buffer.speech_started` do servidor dispara `interrupt()` → envia `response.cancel` + emite `onInterrupted`.

**Resampling:** `sendAudioChunk` aplica `resamplePcm16(pcm16, 16000, 24000)` antes de enviar (openai-realtime.ts:291).

---

### 7.4 GeminiLiveProvider — implementação hibernada (gemini-live-provider.ts)

`src/main/jarvis/realtime/gemini-live-provider.ts` implementa `TurnManagedRealtimeProvider` delegando para `GeminiLiveTransport`.

**Classe:**

```ts
// gemini-live-provider.ts:22-31
export class GeminiLiveProvider implements TurnManagedRealtimeProvider {
  private transport: GeminiLiveTransport | null = null;
  // ... listas de callbacks (audioCallbacks, roleTranscriptCallbacks, etc.)
  private closing = false;
  private readonly deps: LiveTransportDeps;

  constructor(private readonly options: GeminiLiveProviderOptions) {
    this.deps = options.deps ?? defaultGeminiDeps();
  }
```

**`connect()` devolve uma Promise que resolve em `onStateChange('ready')`:**

```ts
// gemini-live-provider.ts:43-95
connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = this.deps.setTimeoutFn(() => {
      settle(new Error('Gemini Live setup timeout'));
    }, CONNECT_TIMEOUT_MS); // 10 s

    const transport = new GeminiLiveTransport({ onStateChange: (state) => {
      if (state === 'ready') settle();
      if (state === 'error') settle(new Error('Gemini Live setup failed'));
      if (state === 'closed' && !settled)
        settle(new Error('Gemini Live socket closed before setup'));
      if (state === 'closed' && settled && !this.closing)
        this.emitDisconnected(new Error('Gemini Live socket closed'));
    }, ... }, this.deps);
    this.transport = transport;
    transport.connect({ apiKey, model, voiceName, systemInstruction: instructions });
  });
}
```

**`interrupt()` é no-op (hibernado):** A Gemini Live API não tem cancel de response na v1beta; o método existe para satisfazer a interface mas não faz nada:

```ts
// gemini-live-provider.ts:130
interrupt(): void {}
```

---

### 7.5 GeminiLiveTransport — transporte WebSocket bruto (gemini-live-transport.ts)

`src/main/voice/gemini-live-transport.ts` é o adaptador de socket bruto para a API `BidiGenerateContent` da Gemini.

**Endpoint:**

```ts
// gemini-live-transport.ts:55-57
const LIVE_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
```

**Classe e alavancas de custo/latência obrigatórias (comentário de cabeçalho do arquivo):**

```ts
// gemini-live-transport.ts:8-14
// Alavancas de custo/latência OBRIGATÓRIAS (auditoria interna 2026-07-06):
// - contextWindowCompression slidingWindow (sempre no setup)
// - pendingMic (primeira frase bufferizada até setupComplete, teto 160 KB)
// - singleton (connect novo mata o socket anterior — nunca "duas vozes")
// - setup timeout 10 s, reconexão exponencial (máx. 3)
```

**Setup com `contextWindowCompression`:**

```ts
// gemini-live-transport.ts:64-101
export function buildSetupMessage(opts: { model, voiceName, systemInstruction, resumeHandle? }): SetupMessage {
  return {
    setup: {
      model: `models/${opts.model.replace(/^models\//, '')}`,
      generationConfig: { responseModalities: ['AUDIO'], ... },
      systemInstruction: { parts: [{ text: opts.systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },   // OBRIGATÓRIO
      sessionResumption: opts.resumeHandle ? { handle: opts.resumeHandle } : {},
    },
  };
}
```

**Singleton via `connectionGeneration`:**

```ts
// gemini-live-transport.ts:177-179
connect(opts: LiveConnectOptions): void {
  this.teardown(true);  // mata socket anterior
  const generation = ++this.connectionGeneration;
```

**Reconexão exponencial (máx. 3 tentativas, backoff `500 * 2^n` ms):**

```ts
// gemini-live-transport.ts:241-249
if (wasReady && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && this.lastOptions) {
  this.reconnectAttempts += 1;
  const delay = 500 * 2 ** this.reconnectAttempts;
  this.reconnectTimer = this.deps.setTimeoutFn(() => { ... this.connect(this.lastOptions) }, delay);
}
```

**`goAway` → reconexão imediata preservando o handle de resumption:**

```ts
// gemini-live-transport.ts:281-284
if (msg.goAway && this.lastOptions) {
  this.connect(this.lastOptions);
}
```

---

### 7.6 LiveTransportController — borda IPC ↔ provider (live-transport-controller.ts)

`src/main/voice/live-transport-controller.ts` é a classe que o `JarvisLiveSession` (FSM) usa para delegar toda a comunicação com o provider realtime.

```ts
// live-transport-controller.ts:40-51
export class LiveTransportController {
  private provider: TurnManagedRealtimeProvider | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectGeneration = 0;

  constructor(
    private emit: Emit,       // canal IPC → renderer
    private fsm: JarvisLiveSession,
  ) {}
```

**Quando o transporte não está disponível, é um no-op seguro:**

```ts
// live-transport-controller.ts:53-58
isRealtimeConfigured(): boolean {
  return resolveRealtimeProviderIds(getVoiceConfig()).some((providerId) => {
    const envVar = providerId === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
    return resolveVoiceApiKey(envVar) !== undefined;
  });
}
```

```ts
// live-transport-controller.ts:61-70
onStart(): Promise<void> {
  if (!this.isRealtimeConfigured()) {
    this.fsm.patchStatus({
      status: 'error', realtimeReady: false,
      error: 'realtime sem credencial disponível — usando Classic',
    });
    return Promise.resolve();   // ← cai de volta no Classic; nada quebra
  }
  // ...
}
```

**Método público `micIn` → provider.sendAudioChunk + métricas:**

```ts
// live-transport-controller.ts:103-114
micIn(b64: string): void {
  if (!this.provider) return;
  const sessionId = this.fsm.getState().sessionId;
  if (sessionId) jarvisLatencyTracker.markAudioIn(sessionId);
  try {
    this.provider.sendAudioChunk(base64ToInt16Array(b64));
  } catch (err) { ... }
}
```

---

### 7.7 metrics.ts — instrumentação de latência

`src/main/jarvis/realtime/metrics.ts` mede as latências fim-a-fim da sessão realtime.

**Métricas rastreadas:**

```ts
// metrics.ts:4-8
export type JarvisRealtimeMetric =
  | 'audio_in_to_transcript_delta_ms'
  | 'transcript_final_to_action_ms'
  | 'transcript_final_to_audio_out_ms'
  | 'roundtrip_ms';
```

**Destino de log:** `~/Library/Logs/NexusIDE/jarvis-metrics.log` (NDJSON, um record por linha). O `JarvisLatencyTracker` mantém um `Map<sessionId, TurnTiming>` em memória e grava ao detectar os pares de eventos.

```ts
// metrics.ts:163-164
export const jarvisMetricsLogger = new JarvisMetricsLogger();
export const jarvisLatencyTracker = new JarvisLatencyTracker(jarvisMetricsLogger);
```

O `LiveTransportController` importa `jarvisLatencyTracker` e chama `markAudioIn`, `markAudioOut`, `markResponseDone` nos pontos corretos do ciclo (live-transport-controller.ts:106, 178, 196).

---

### 7.8 Por que está hibernado e como reativar

#### (a) Por que está hibernado — evidência direta no código

O comentário de cabeçalho do `gemini-live-transport.ts` (linhas 1–15) descreve o transporte como **OPCIONAL** por cima do Jarvis Classic e explicita que "quando cai (sem key, socket morto), o Classic segue valendo". A decisão de produção está codificada na factory:

```ts
// factory.ts:63-71
if (config.jarvisLive.transport === 'openai-realtime') return ['openai', 'gemini'];
if (config.jarvisLive.transport === 'gemini-live')     return ['gemini'];
return [];  // ← 'classic' retorna lista vazia — nenhum socket Gemini Live é aberto
```

O campo `transport` padrão de produção é `'classic'`. Enquanto ele for `'classic'`, `resolveRealtimeProviderIds` devolve `[]`, `createRealtimeProviderCandidates` retorna `[]`, e o `LiveTransportController.onStart()` cai imediatamente no fallback Classic sem abrir nenhum socket. O código Gemini Live está compilado e integrado, mas **nunca instanciado em produção**.

A nota do arquivo de memória do projeto (`jarvis-voice-architecture.md`) confirma explicitamente: _"gemini-live hibernado de propósito; Classic é produção"_.

#### (b) Estrutura que permite reativação

Toda a plumbing está pronta e testável:

1. **Interface unificada** — `GeminiLiveProvider` satisfaz `TurnManagedRealtimeProvider` da mesma forma que `OpenAIRealtimeProvider`; o controller e o FSM não sabem qual está rodando.
2. **Factory com override por env var** — `NEXUS_REALTIME_PROVIDER=gemini` bypassa a config e força o provider sem tocar em código.
3. **Deps injetáveis** — `GeminiLiveTransport` aceita `LiveTransportDeps` (`wsFactory`, `now`, `setTimeoutFn`, `clearTimeoutFn`), permitindo testes sem rede.
4. **Reconexão e session resumption** já implementados no transporte (backoff exponencial + `resumptionHandle`).
5. **VoiceSettings já expõe o toggle "Áudio realtime"** (`liveRealtime` state, `toggleRealtime` handler) e persiste `jarvisLiveTransport: 'openai-realtime'` ou `'classic'` — basta adicionar `'gemini-live'` como opção de UI se necessário.

#### (c) Passos concretos para reativar

**Via env var (teste sem alterar config):**

```sh
NEXUS_REALTIME_PROVIDER=gemini GEMINI_API_KEY=<key> npm start
```

Isso força `resolveRealtimeProviderIds` a retornar `['gemini']` independente do `config.jarvisLive.transport`.

**Via config persistida:**

1. Alterar `config.jarvisLive.transport` para `'gemini-live'` em `voice-config-store` (ou via IPC `setConfig({ jarvisLiveTransport: 'gemini-live' })`).
2. Garantir que `GEMINI_API_KEY` está disponível (`resolveVoiceApiKey('GEMINI_API_KEY')` deve retornar não-undefined).
3. Habilitar Jarvis Live: `config.jarvisLive.enabled = true`.

**Via UI (se o toggle for exposto):**

Em `VoiceSettings.tsx`, o toggle "Áudio realtime" já chama `toggleRealtime(true)` que persiste `jarvisLiveTransport: 'openai-realtime'`. Para expor o Gemini Live como opção, seria necessário adicionar um terceiro estado ao toggle ou um `<select>` com `'openai-realtime'` / `'gemini-live'` e enviar o valor correto para `setConfig({ jarvisLiveTransport: 'gemini-live' })`.

**Verificação de saúde após ativar:**

- `LiveTransportController.isRealtimeConfigured()` deve retornar `true`.
- `fsm.getState().realtimeReady` deve virar `true` após `onStart()`.
- O log de métricas em `~/Library/Logs/NexusIDE/jarvis-metrics.log` deve começar a registrar `audio_in_to_transcript_delta_ms`.
- O HUD expandido deve mostrar `info.jarvisLive.enabled === true` e exibir "JARVIS LIVE" no eyebrow (VoiceHud.tsx:286).

---

## 8. Guia de reimplementação passo a passo

Ordem de porte recomendada. Cada bloco depende do anterior — construir fora de ordem gera fronteiras impossíveis de testar isoladamente. Os números entre parênteses cruzam para a seção de referência.

### 8.1 Ordem de construção

1. **Shared contracts (§3.1–3.2, 3.7).** Comece pelos tipos e schemas Zod (`voice-channels.ts`, `voice-ipc.ts`, `voice-config.ts`). São a fronteira que todo o resto respeita. Sem os schemas de request validando na entrada do main, não há como testar nenhum handler com segurança. Defina o `VoiceConfig` e os `DEFAULT_VOICE_CONFIG` (cadeias STT/TTS/brain) antes de qualquer lógica.

2. **IPC + ciclo de vida (§3.3–3.6).** A ponte preload (`window.nexus.voice.*`), o `registerVoiceIpc()`/`closeVoiceIpc()`, e as duas costuras quentes: o singleton de módulo `liveSession`/`liveTransport` e o handler `voice:wakeAudio` com wake-lock. Instale os `on*` listeners **uma única vez** por canal, não por chamada.

3. **Wake (§6.1).** `WakeEngine` no main (três ONNX em cascata mel→emb→wake, contexto de 480 samples, threshold 0.48, debounce 2.5s). Depende de: modelos openWakeWord bundled + `onnxruntime-node`. Teste com PCM gravado antes de plugar o mic.

4. **Captura (§6.2).** `WakeMic` (stream always-on, APM off, watchdog + rearme) e `VoiceCapture` (PTT, AEC on). Ambos: getUserMedia 16kHz mono → AudioWorklet/ScriptProcessor → `SoftAgc` in-place → acumula Float32 → `encodeWav` base64. Só depois de wake+captura funcionarem juntos você tem os passos 1–6 do turno (§4).

5. **STT (§6.3).** `transcribe` no main com chain `flattenChain` error-driven (groq→openai→whisper.cpp). Depende de: keys de provider (`voice-secrets.ts`) + binário whisper.cpp opcional. Deadlines: cloud 12s, local 30s.

6. **Brain (§6.5).** `jarvisThink`: action fastpath → state fastpath → LLM chain (Gemini→OpenAI→Groq, `AbortSignal` 15s) → `applyMemoryOps` → `parseReply`. Depende de: keys de brain + `jarvis-memory.json` no disco + catálogo de tools. Os fastpaths vêm **sempre** primeiro.

7. **Action executor (§6.5.5).** `executeJarvisAction` no renderer: MCP-first (invoke→confirm→invoke) para `run_command`/`write`/`send_to_pane`, UI-path para squads/workspaces/panes. Depende da governança do main (guardrails, permissions, confirmation-tokens, mcp-ipc).

8. **TTS (§6.4).** `speak` no main com chain openai→piper→macos-say (o último é keyless → sempre fala). Registra no `echoSuppressor`. Renderer decodifica e toca com `playSpeakResult` + barge-in por geração.

9. **Guardrails (§5).** Os 14 guardrails não são um passo separado — são costurados em cada lane acima. Antes de considerar o porte pronto, percorra a tabela do §5 e confirme cada um: wake-lock, watchdogs, deadlines, três camadas anti-eco, loop guard, diálogo nativo.

10. **HUD (§6.6).** `voice-store` (Zustand) + `hud-prefs` (persistência localStorage defensiva) + `VoiceHud`/`VoiceSettings`/`VoiceButton`. É a última lane porque a voz funciona 100% sem visual (`hud.mode === 'hidden'` → zero DOM).

11. **Realtime opcional (§7).** Só depois de o Classic estar sólido. `TurnManagedRealtimeProvider` + factory + `OpenAIRealtimeProvider` (ativo) / `GeminiLiveProvider` (hibernado). Pluga no mesmo `LiveTransportController`/FSM. Reative por `NEXUS_REALTIME_PROVIDER` ou `transport` config.

### 8.2 Dependências externas obrigatórias

| Dependência | Para quê | Onde entra |
|---|---|---|
| SpeechKit wake-word models (`melspectrogram`, `embedding_model`, `hey_jarvis`), commit e checksums pinados, Apache-2.0 | Wake word detection | Bundled base64 em `wake-models.ts`; atribuição em `THIRD_PARTY_NOTICES.md` (§6.1) |
| `onnxruntime-node` | Rodar os ONNX no main | `wake-engine.ts` (§6.1) |
| STT provider + key: `GROQ_API_KEY` e/ou `OPENAI_API_KEY` | Transcrição cloud | `stt-service.ts` (§6.3) |
| whisper.cpp binário + modelo ggml (opcional) | STT local keyless | `~/.nexus/bin/`, `~/.nexus/models/whisper/` (§6.3) |
| TTS provider + `OPENAI_API_KEY` (opcional) | Síntese cloud | `tts-service.ts` (§6.4) |
| Piper binário + modelo (opcional) / `macos-say` (macOS) | TTS local/keyless | `tts-service.ts` (§6.4) |
| Brain key: `GEMINI_API_KEY` / `OPENAI_API_KEY` / `GROQ_API_KEY` | LLM do cérebro | `jarvis-brain.ts` (§6.5) |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` (realtime, opcional) | Transporte live | `jarvis/realtime/*` (§7) |
| Electron `safeStorage` | Guardar keys fora do env | `voice-secrets.ts` (§6.3) |
| Electron `dialog.showMessageBox` | Confirmação nativa anti-injeção | `voice-ipc.ts`, `mcp-ipc.ts` (§5 #14) |

> Todas as chains degradam para um provider keyless (whisper.cpp / macos-say). O JARVIS **fala e ouve sem nenhuma API key** — as keys melhoram qualidade/latência, não são pré-requisito para um turno completar.

### 8.3 Checklist de paridade

Um porte só atinge paridade quando todos os itens abaixo passam. Agrupados por dimensão.

**Contratos e IPC (§3)**
- [ ] Todos os canais de `voice-channels.ts` existem com os mesmos nomes e direções
- [ ] Schemas Zod validam todo request na entrada do main (rejeitam payload malformado)
- [ ] `window.nexus.voice.*` expõe cada método com mesma assinatura via `contextBridge`
- [ ] Listeners `on*` instalados uma única vez por canal (não por chamada)
- [ ] Segredos **nunca** cruzam para o renderer; `VoiceRuntimeInfo` é secret-free
- [ ] `liveSession`/`liveTransport` são singletons de módulo (fora de `registerVoiceIpc`)

**Turno Classic (§4)**
- [ ] Os 11 passos executam na ordem, cada handoff renderer↔main no canal certo
- [ ] Wake ACK toca **antes** de abrir o mic (não vira comando)
- [ ] Utterance capturada sobre o stream quente, sem novo `getUserMedia`
- [ ] Reopen de escuta respeita `expectReply` + guard anti-loop (MAX=5)

**Guardrails (§5) — todos os 14**
- [ ] Wake-lock cross-instance (lockfile PID, ESRCH=órfão, EPERM=vivo)
- [ ] Watchdog de morte de stream (4s poll, 8s stall → rebuild)
- [ ] Utterance deadline watchdog (timer duro além do auto-stop por frames)
- [ ] `TRANSCRIBE_DEADLINE_MS` 60s / `BRAIN_DEADLINE_MS` 35s + `AbortSignal` 15s / `SPEAK_DEADLINE_MS` 40s
- [ ] AEC no stream de utterance (`echoCancellation: true`)
- [ ] `EchoSuppressor` por transcript (janela 300 chars, TTL 60s, overlap 80%)
- [ ] Filtro de Whisper ghosts (COLD/HARD ghosts, context-aware)
- [ ] `stripPromptEcho` no eco do PTY
- [ ] Janela de supressão de wake dinâmica pós-TTS + fixa no ACK
- [ ] Barge-in total no novo "Hey Jarvis"
- [ ] Auto-reply loop guard (MAX=5, reset em captura não-reply)
- [ ] `run_command` exige `dialog.showMessageBox` nativo (renderer não forja)

**Cérebro e governança (§6.5)**
- [ ] Fastpaths (ação + estado) avaliados **antes** de qualquer LLM
- [ ] `applyMemoryOps` roda no main, antes de devolver ao renderer
- [ ] Confirmation tokens de uso único, TTL 30s, fluxo invoke→confirm→invoke obrigatório
- [ ] `clearSession('jarvis-renderer')` no fim de cada sessão (permissões não vazam)
- [ ] Catálogo de tools injeta só nomes, não schemas (evita prompt bloat)

**Resiliência e degradação (§6.1–6.4, §7)**
- [ ] Toda chain (STT/TTS/brain) degrada para provider keyless e completa o turno
- [ ] Rearme lento infinito do mic (nunca fica morto permanentemente)
- [ ] Realtime ausente → no-op seguro → cai no Classic sem perder a intenção

**HUD e prefs (§6.6)**
- [ ] Voz funciona 100% com `hud.mode === 'hidden'` (zero DOM)
- [ ] `hudPrefs` persiste defensivamente (valida campos, cai em defaults, silencia falha de storage)
- [ ] Mic-health surfaced com botões de ação inline
