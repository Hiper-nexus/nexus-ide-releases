/**
 * Gemini Live — transporte de áudio full-duplex real (WSS BidiGenerateContent,
 * v1beta). Mic PCM 16 kHz sobe em realtimeInput.audio; TTS desce como PCM
 * 24 kHz em serverContent.modelTurn inlineData; barge-in chega como
 * serverContent.interrupted. Este transporte é OPCIONAL por cima do Jarvis
 * Classic — quando cai (sem key, socket morto), o Classic segue valendo.
 *
 * Alavancas de custo/latência OBRIGATÓRIAS (auditoria 2026-07-06 — a
 * evidência do concorrente é 12,9M tokens/noite sem elas):
 * - contextWindowCompression slidingWindow (sempre no setup)
 * - pendingMic (primeira frase bufferizada até setupComplete, teto 160 KB)
 * - singleton (connect novo mata o socket anterior — nunca "duas vozes")
 * - setup timeout 10 s, reconexão exponencial (máx. 3)
 *
 * Deps injetáveis (wsFactory/now/timers) — testável sem rede.
 */

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'close' | 'error', cb: (payload?: unknown) => void): void;
}

export interface LiveTransportEvents {
  /** PCM 24 kHz base64 para o renderer tocar. */
  onAudioOut(b64: string): void;
  onTranscript(role: 'user' | 'assistant', text: string, final: boolean): void;
  onInterrupted(): void;
  onStateChange(state: LiveTransportState): void;
  onError(message: string): void;
}

export type LiveTransportState =
  | 'connecting'
  | 'ready'
  | 'closed'
  | 'error';

export interface LiveTransportDeps {
  wsFactory(url: string): WsLike;
  now(): number;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void;
}

export interface LiveConnectOptions {
  apiKey: string;
  model: string;
  voiceName: string;
  systemInstruction: string;
  languageCode?: string;
}

const LIVE_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const SETUP_TIMEOUT_MS = 10_000;
const PENDING_MIC_MAX_BYTES = 160 * 1024;
const MAX_RECONNECT_ATTEMPTS = 3;
const WS_OPEN = 1;

export interface SetupMessage {
  setup: {
    model: string;
    generationConfig: Record<string, unknown>;
    systemInstruction: { parts: Array<{ text: string }> };
    inputAudioTranscription: Record<string, never>;
    outputAudioTranscription: Record<string, never>;
    contextWindowCompression: { slidingWindow: Record<string, never> };
    sessionResumption: Record<string, unknown>;
  };
}

export function buildSetupMessage(opts: {
  model: string;
  voiceName: string;
  systemInstruction: string;
  languageCode?: string;
  resumeHandle?: string;
}): SetupMessage {
  return {
    setup: {
      model: `models/${opts.model.replace(/^models\//, '')}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        temperature: 0.3,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName } },
          languageCode: opts.languageCode ?? 'pt-BR',
        },
      },
      systemInstruction: { parts: [{ text: opts.systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: opts.resumeHandle ? { handle: opts.resumeHandle } : {},
    },
  };
}

export interface ParsedServerMessage {
  setupComplete?: boolean;
  audioB64?: string;
  inputTranscription?: string;
  outputTranscription?: string;
  interrupted?: boolean;
  turnComplete?: boolean;
  resumptionHandle?: string;
  goAway?: boolean;
}

export function parseServerMessage(raw: string): ParsedServerMessage {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: ParsedServerMessage = {};
  if (msg.setupComplete !== undefined) out.setupComplete = true;
  const content = msg.serverContent as
    | {
        modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        interrupted?: boolean;
        turnComplete?: boolean;
      }
    | undefined;
  if (content) {
    const inline = content.modelTurn?.parts?.find((p) => p.inlineData?.data);
    if (inline?.inlineData?.data) out.audioB64 = inline.inlineData.data;
    if (typeof content.inputTranscription?.text === 'string') {
      out.inputTranscription = content.inputTranscription.text;
    }
    if (typeof content.outputTranscription?.text === 'string') {
      out.outputTranscription = content.outputTranscription.text;
    }
    if (content.interrupted) out.interrupted = true;
    if (content.turnComplete) out.turnComplete = true;
  }
  const resumption = msg.sessionResumptionUpdate as
    | { newHandle?: string; resumable?: boolean }
    | undefined;
  if (resumption?.resumable && typeof resumption.newHandle === 'string') {
    out.resumptionHandle = resumption.newHandle;
  }
  if (msg.goAway !== undefined) out.goAway = true;
  return out;
}

export class GeminiLiveTransport {
  private ws: WsLike | null = null;
  private setupDone = false;
  private pendingMic: string[] = [];
  private pendingMicBytes = 0;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private lastOptions: LiveConnectOptions | null = null;
  private resumptionHandle: string | undefined;
  private closedByUs = false;

  constructor(
    private events: LiveTransportEvents,
    private deps: LiveTransportDeps,
  ) {}

  get isReady(): boolean {
    return this.setupDone && this.ws?.readyState === WS_OPEN;
  }

  connect(opts: LiveConnectOptions): void {
    // Singleton: nunca duas sessões (= duas vozes) vivas.
    this.teardown(true);
    this.lastOptions = opts;
    this.closedByUs = false;
    this.setupDone = false;
    this.events.onStateChange('connecting');
    const url = `${LIVE_WS_BASE}?key=${encodeURIComponent(opts.apiKey)}`;
    let ws: WsLike;
    try {
      ws = this.deps.wsFactory(url);
    } catch (err) {
      this.events.onError(
        `live: falha ao abrir socket — ${err instanceof Error ? err.message : String(err)}`,
      );
      this.events.onStateChange('error');
      return;
    }
    this.ws = ws;

    this.setupTimer = this.deps.setTimeoutFn(() => {
      if (!this.setupDone) {
        this.events.onError('live: setup timeout (10s)');
        this.teardown(true);
        this.events.onStateChange('error');
      }
    }, SETUP_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(
        JSON.stringify(
          buildSetupMessage({
            model: opts.model,
            voiceName: opts.voiceName,
            systemInstruction: opts.systemInstruction,
            languageCode: opts.languageCode,
            resumeHandle: this.resumptionHandle,
          }),
        ),
      );
    });

    ws.on('message', (payload) => {
      const raw =
        typeof payload === 'string'
          ? payload
          : Buffer.isBuffer(payload)
          ? payload.toString('utf8')
          : String(payload);
      this.handleServerMessage(raw);
    });

    ws.on('close', () => {
      const wasReady = this.setupDone;
      this.setupDone = false;
      if (this.closedByUs) {
        this.events.onStateChange('closed');
        return;
      }
      // Queda inesperada: reconecta com backoff até o teto.
      if (wasReady && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && this.lastOptions) {
        this.reconnectAttempts += 1;
        const delay = 500 * 2 ** this.reconnectAttempts;
        this.deps.setTimeoutFn(() => {
          if (!this.closedByUs && this.lastOptions) this.connect(this.lastOptions);
        }, delay);
      } else {
        this.events.onStateChange('closed');
      }
    });

    ws.on('error', (err) => {
      this.events.onError(
        `live: socket error — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private handleServerMessage(raw: string): void {
    const msg = parseServerMessage(raw);
    if (msg.setupComplete) {
      this.setupDone = true;
      this.reconnectAttempts = 0;
      if (this.setupTimer) this.deps.clearTimeoutFn(this.setupTimer);
      this.flushPendingMic();
      this.events.onStateChange('ready');
    }
    if (msg.audioB64) this.events.onAudioOut(msg.audioB64);
    if (msg.inputTranscription) {
      this.events.onTranscript('user', msg.inputTranscription, false);
    }
    if (msg.outputTranscription) {
      this.events.onTranscript('assistant', msg.outputTranscription, false);
    }
    if (msg.interrupted) this.events.onInterrupted();
    if (msg.resumptionHandle) this.resumptionHandle = msg.resumptionHandle;
    if (msg.goAway && this.lastOptions) {
      // O servidor vai derrubar — reconectar preservando o handle de resume.
      this.connect(this.lastOptions);
    }
  }

  /** Mic PCM 16 kHz base64. Antes do setupComplete, bufferiza (teto 160 KB). */
  sendMicChunk(b64: string): void {
    if (this.isReady && this.ws) {
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: { mimeType: 'audio/pcm;rate=16000', data: b64 },
          },
        }),
      );
      return;
    }
    const bytes = b64.length;
    if (this.pendingMicBytes + bytes > PENDING_MIC_MAX_BYTES) return;
    this.pendingMic.push(b64);
    this.pendingMicBytes += bytes;
  }

  private flushPendingMic(): void {
    const buffered = this.pendingMic;
    this.pendingMic = [];
    this.pendingMicBytes = 0;
    for (const b64 of buffered) this.sendMicChunk(b64);
  }

  /** Fecha o turno de fala do usuário (VAD manual / PTT soltou). */
  endUserTurn(): void {
    if (!this.isReady || !this.ws) return;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  /** Contexto de tela como TEXTO (nunca pixels), sem fechar o turno. */
  sendContext(text: string): void {
    if (!this.isReady || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            { role: 'user', parts: [{ text: `[update] ${text.slice(0, 400)}` }] },
          ],
          turnComplete: false,
        },
      }),
    );
  }

  disconnect(): void {
    this.teardown(true);
    this.events.onStateChange('closed');
  }

  private teardown(markClosed: boolean): void {
    if (markClosed) this.closedByUs = true;
    if (this.setupTimer) this.deps.clearTimeoutFn(this.setupTimer);
    this.setupTimer = null;
    this.setupDone = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // socket já morto
      }
      this.ws = null;
    }
    this.pendingMic = [];
    this.pendingMicBytes = 0;
  }
}
