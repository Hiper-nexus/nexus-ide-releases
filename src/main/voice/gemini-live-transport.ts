/**
 * Gemini Live — transporte de áudio full-duplex real (WSS BidiGenerateContent,
 * v1beta). Mic PCM 16 kHz sobe em realtimeInput.audio; TTS desce como PCM
 * 24 kHz em serverContent.modelTurn inlineData; barge-in chega como
 * serverContent.interrupted. Este transporte é OPCIONAL por cima do Jarvis
 * Classic — quando cai (sem key, socket morto), o Classic segue valendo.
 *
 * Alavancas de custo/latência OBRIGATÓRIAS (auditoria interna 2026-07-06):
 * - contextWindowCompression slidingWindow (sempre no setup)
 * - pendingMic (primeira frase bufferizada até setupComplete, teto 160 KB)
 * - singleton (connect novo mata o socket anterior — nunca "duas vozes")
 * - setup timeout 10 s, reconexão exponencial (máx. 3)
 *
 * Deps injetáveis (wsFactory/now/timers) — testável sem rede.
 *
 * Narração serializada (F-113) + coalescing de tela (C-092.7 b): contexto/
 * narração/greeting viram TURNOS falados (turnComplete:true) drenados 1 por vez
 * pela TurnQueue (disjuntor TURN_MAX_MS); a rajada de [update] de tela é
 * coalescida pela ScreenCoalescer e injetada como contexto SILENCIOSO
 * (turnComplete:false, sem resposta) só no estado assentado.
 */

import { ScreenCoalescer } from '../jarvis/realtime/screen-coalescer';
import { TurnQueue } from '../jarvis/realtime/turn-queue';
import { wrapNarration } from '../jarvis/realtime/live-narration';
import {
  COARSE_VOICE_TOOLS,
  type GeminiFunctionDeclaration,
} from '../jarvis/realtime/coarse-voice-tools';

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'close' | 'error', cb: (payload?: unknown) => void): void;
}

/** A Gemini Live function call parsed off a `toolCall` server message. */
export interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveTransportEvents {
  /** PCM 24 kHz base64 para o renderer tocar. */
  onAudioOut(b64: string): void;
  onTranscript(role: 'user' | 'assistant', text: string, final: boolean): void;
  onInterrupted(): void;
  onTurnComplete?(): void;
  onStateChange(state: LiveTransportState): void;
  onError(message: string): void;
  /** Chamada de função coarse (delegar/consultar/ler/navegar/encerrar). */
  onToolCall?(call: LiveToolCall): void;
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
// F-059/2461: 30s sem NENHUMA mensagem do servidor numa sessão VIVA = socket
// zumbi (local OPEN, servidor mudo — o caso F-138). Re-armado a cada mensagem;
// dispara → fecha o socket → o handler de close reconecta com backoff.
const SDK_PROGRESS_TIMEOUT_MS = 30_000;
const PENDING_MIC_MAX_BYTES = 160 * 1024;
const MAX_RECONNECT_ATTEMPTS = 3;
const WS_OPEN = 1;

/**
 * F-133: SINGLETON cross-instância — no máximo 1 transporte Live vivo por
 * processo. Duas GeminiLiveTransport reconectando em paralelo = "duas vozes".
 * Toda conexão nova reivindica este slot e encerra a anterior; a órfã (não é a
 * corrente) se auto-encerra ao tentar reconectar.
 */
let currentLiveTransport: GeminiLiveTransport | null = null;

/** Test-only: limpa o slot singleton entre casos isolados. */
export function __resetLiveTransportSingleton(): void {
  currentLiveTransport = null;
}

export interface SetupMessage {
  setup: {
    model: string;
    generationConfig: Record<string, unknown>;
    systemInstruction: { parts: Array<{ text: string }> };
    tools: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
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
  tools?: GeminiFunctionDeclaration[];
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
      // 4 coarse voice tools (delegar/consultar/ler/navegar) + encerrar declared
      // inline (Overclock F-056) — NOT the full action catalog.
      tools: [{ functionDeclarations: opts.tools ?? COARSE_VOICE_TOOLS }],
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
  toolCalls?: LiveToolCall[];
  cancelledToolCallIds?: string[];
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
  const toolCall = msg.toolCall as
    | { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> }
    | undefined;
  if (Array.isArray(toolCall?.functionCalls)) {
    const calls: LiveToolCall[] = [];
    for (const fc of toolCall.functionCalls) {
      if (typeof fc?.name !== 'string') continue;
      calls.push({
        id: typeof fc.id === 'string' ? fc.id : '',
        name: fc.name,
        args:
          fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args)
            ? (fc.args as Record<string, unknown>)
            : {},
      });
    }
    if (calls.length > 0) out.toolCalls = calls;
  }
  const cancel = msg.toolCallCancellation as { ids?: unknown } | undefined;
  if (Array.isArray(cancel?.ids)) {
    out.cancelledToolCallIds = cancel.ids.filter((id): id is string => typeof id === 'string');
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
  /** True after at least one mic chunk hit the socket (needs audioStreamEnd). */
  private audioStreamOpen = false;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connectionGeneration = 0;
  private lastOptions: LiveConnectOptions | null = null;
  private resumptionHandle: string | undefined;
  private closedByUs = false;
  private readonly pendingToolCalls = new Set<string>();
  private readonly turnQueue: TurnQueue;
  private readonly screenCoalescer: ScreenCoalescer;
  /**
   * MUTE FIX: o Gemini Live manda inputTranscription EM PARTES, sempre com
   * final=false — nunca um evento "usuário terminou". O renderer, porém, só
   * libera o ÁUDIO da resposta ao ver um transcript de usuário FINAL (paridade
   * com o `.completed` do OpenAI). Sem finalização, a resposta realtime fica
   * eternamente suprimida → sessão MUDA. Acumulamos os pedaços e emitimos UM
   * transcript final quando o modelo começa a responder (primeiro áudio/output)
   * ou no turnComplete. Fecha o gate que segurava a voz.
   */
  private userTranscriptBuffer = '';

  constructor(
    private events: LiveTransportEvents,
    private deps: LiveTransportDeps,
  ) {
    this.turnQueue = new TurnQueue({
      send: (text) => this.sendTurn(text),
      canSend: () => this.isReady,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    });
    this.screenCoalescer = new ScreenCoalescer({
      flush: (text) => this.sendSilentContext(text),
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    });
  }

  get isReady(): boolean {
    return this.setupDone && this.ws?.readyState === WS_OPEN;
  }

  connect(opts: LiveConnectOptions): void {
    // F-113: turnos que ainda não foram enviados sobrevivem à reconexão — o
    // in-flight (busy) do socket morto é perdido; os pendentes voltam pra fila
    // e são drenados no próximo setupComplete. Coalescer zera o baseline (o
    // socket novo não sabe o último [update] enviado).
    const carriedTurns = this.turnQueue.flush();
    this.turnQueue.reset();
    for (const turn of carriedTurns) this.turnQueue.enqueue(turn);
    this.screenCoalescer.clear();
    this.screenCoalescer.resetBaseline();
    // F-133: reivindica o slot singleton cross-instância — mata QUALQUER outro
    // transporte Live vivo antes de conectar (evita "duas vozes"). Só a instância
    // corrente reconecta; as outras se auto-encerram no reconnect.
    this.claimSingleton();
    // Singleton por instância: nunca duas sessões (= duas vozes) vivas.
    this.teardown(true);
    const generation = ++this.connectionGeneration;
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
      if (generation !== this.connectionGeneration) return;
      if (!this.setupDone) {
        this.events.onError('live: setup timeout (10s)');
        this.teardown(true);
        this.events.onStateChange('error');
      }
    }, SETUP_TIMEOUT_MS);

    ws.on('open', () => {
      if (generation !== this.connectionGeneration) return;
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
      if (generation !== this.connectionGeneration) return;
      const raw =
        typeof payload === 'string'
          ? payload
          : Buffer.isBuffer(payload)
          ? payload.toString('utf8')
          : String(payload);
      this.handleServerMessage(raw);
    });

    ws.on('close', () => {
      if (generation !== this.connectionGeneration) return;
      const wasReady = this.setupDone;
      this.setupDone = false;
      this.clearProgressWatchdog();
      if (this.closedByUs) {
        this.events.onStateChange('closed');
        return;
      }
      // F-133: instância órfã (perdeu o slot singleton) nunca reconecta — encerra.
      if (currentLiveTransport !== this) {
        this.teardown(true);
        this.events.onStateChange('closed');
        return;
      }
      // Queda inesperada: reconecta com backoff até o teto.
      if (wasReady && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && this.lastOptions) {
        this.reconnectAttempts += 1;
        const delay = 500 * 2 ** this.reconnectAttempts;
        this.clearReconnectTimer();
        this.reconnectTimer = this.deps.setTimeoutFn(() => {
          this.reconnectTimer = null;
          if (generation !== this.connectionGeneration) return;
          // F-133: re-checa identidade no disparo — o slot pode ter sido tomado
          // por outra sessão durante o backoff.
          if (currentLiveTransport !== this) return;
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
    // F-138/2461: toda mensagem do servidor é PROGRESSO — re-arma o watchdog de
    // sessão viva (30s de silêncio = socket zumbi → fecha → reconecta).
    if (this.setupDone || msg.setupComplete) this.armProgressWatchdog();
    if (msg.setupComplete) {
      this.setupDone = true;
      if (this.setupTimer) this.deps.clearTimeoutFn(this.setupTimer);
      this.flushPendingMic();
      // F-113: drena os turnos que ficaram na fila até a sessão ficar viva
      // (greeting/reconexão bufferizados pré-setupComplete).
      this.turnQueue.drain();
      this.events.onStateChange('ready');
    }
    // HIGH-3: o orçamento de reconexão só zera com PROGRESSO REAL (áudio,
    // transcrição, tool-call, fim de turno) — NÃO no bare setupComplete. Um
    // socket que só chega a setupComplete e nunca é alimentado (mic parado entre
    // turnos no modelo turn-scoped do nexus) senão zerava o contador a cada
    // relight → o watchdog de 30s reconectava para sempre. Agora exaure em
    // MAX_RECONNECT_ATTEMPTS e emite 'closed' (o controller degrada p/ Classic).
    const sawServerProgress =
      msg.audioB64 !== undefined ||
      msg.inputTranscription !== undefined ||
      msg.outputTranscription !== undefined ||
      msg.toolCalls !== undefined ||
      msg.turnComplete === true ||
      msg.interrupted === true;
    if (sawServerProgress) this.reconnectAttempts = 0;
    // MUTE FIX: o áudio ou a transcrição do MODELO marca o fim do turno do
    // usuário. Se juntamos pedaços de inputTranscription, emitimos AGORA o
    // transcript final do usuário (uma vez) para o renderer liberar a resposta.
    if (msg.audioB64 || msg.outputTranscription) this.finalizeUserTranscript();
    if (msg.audioB64) this.events.onAudioOut(msg.audioB64);
    if (msg.inputTranscription) {
      this.userTranscriptBuffer += msg.inputTranscription;
      this.events.onTranscript('user', msg.inputTranscription, false);
    }
    if (msg.outputTranscription) {
      this.events.onTranscript('assistant', msg.outputTranscription, false);
    }
    // F-113: turno abortado (barge-in) ou concluído libera a fila e drena o próximo.
    if (msg.interrupted) {
      // Barge-in: o turno do usuário anterior nunca virou resposta — descarta o
      // buffer para não vazar num transcript final tardio no próximo turno.
      this.userTranscriptBuffer = '';
      this.events.onInterrupted();
      this.turnQueue.release();
    }
    if (msg.turnComplete) {
      // Rede de segurança: se o modelo terminou sem que áudio/output tivessem
      // finalizado o transcript (ex.: resposta só-tool), finaliza aqui.
      this.finalizeUserTranscript();
      this.events.onTurnComplete?.();
      this.turnQueue.release();
    }
    if (msg.toolCalls) {
      for (const call of msg.toolCalls) {
        if (call.id) this.pendingToolCalls.add(call.id);
        this.events.onToolCall?.(call);
      }
    }
    if (msg.cancelledToolCallIds) {
      for (const id of msg.cancelledToolCallIds) this.pendingToolCalls.delete(id);
    }
    if (msg.resumptionHandle) this.resumptionHandle = msg.resumptionHandle;
    if (msg.goAway && this.lastOptions) {
      // O servidor vai derrubar — reconectar preservando o handle de resume.
      this.connect(this.lastOptions);
    }
  }

  /**
   * Devolve o resultado de uma função coarse ao modelo (toolResponse). Ignora
   * calls já cancelados (o servidor mandou toolCallCancellation no meio-tempo).
   */
  sendToolResult(callId: string, name: string, output: unknown): void {
    if (callId && !this.pendingToolCalls.has(callId)) return;
    if (callId) this.pendingToolCalls.delete(callId);
    if (!this.isReady || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id: callId, name, response: { output } }],
        },
      }),
    );
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
      this.audioStreamOpen = true;
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

  /**
   * MUTE FIX: emite o transcript do usuário ACUMULADO como FINAL (uma vez) e
   * limpa o buffer. Chamado quando o modelo começa a responder (áudio/output) ou
   * no turnComplete — o equivalente Gemini ao `.completed` do OpenAI. Sem isto o
   * renderer nunca via um transcript de usuário final e mantinha o áudio da
   * resposta suprimido para sempre (sessão muda).
   */
  private finalizeUserTranscript(): void {
    const text = this.userTranscriptBuffer.trim();
    this.userTranscriptBuffer = '';
    if (!text) return;
    this.events.onTranscript('user', text, true);
  }

  /** Fecha o turno de fala do usuário (VAD manual / PTT soltou). */
  endUserTurn(): void {
    if (!this.isReady || !this.ws) return;
    // Orphan audioStreamEnd (no prior mic) confuses Gemini Live — cold wake
    // inject then stays silent until a later re-wake (~3s) or ~20s ambient reply.
    if (!this.audioStreamOpen) return;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    this.audioStreamOpen = false;
  }

  /**
   * Barge-in / wake prep: close any open audio user-turn and free the TurnQueue
   * so a `[wake]` inject is not stuck behind a phantom busy turn.
   * Does NOT emit onInterrupted — that is reserved for server barge-in signals.
   */
  interrupt(): void {
    this.endUserTurn();
    this.userTranscriptBuffer = '';
    this.pendingMic = [];
    this.pendingMicBytes = 0;
    this.audioStreamOpen = false;
    this.turnQueue.reset();
    this.screenCoalescer.clear();
  }

  /** Contexto de tela como TEXTO (nunca pixels), sem fechar o turno. Imediato. */
  sendContext(text: string): void {
    this.sendSilentContext(text);
  }

  /**
   * C-092.7 (b): rajada de [update] de tela coalescida — só o estado ASSENTADO
   * (após SCREEN_UPDATE_DEBOUNCE_MS) é injetado como contexto silencioso, e um
   * estado final idêntico ao último é descartado.
   */
  injectScreenUpdate(text: string): void {
    this.screenCoalescer.push(text);
  }

  /**
   * F-113: narração (resultado delegado, progresso, handoff) — vai embrulhada no
   * NARRATION_ENVELOPE (diretiva separada do dado) e entra na fila serializada.
   */
  injectNarration(payload: string): void {
    this.routeTurn(wrapNarration(payload));
  }

  /** F-113: contexto que DEVE virar fala (greeting no wake, resumo de reconexão). */
  injectContext(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('[wake]') || trimmed.startsWith('[reconexão]')) {
      this.routePriorityTurn(trimmed);
      return;
    }
    this.routeTurn(trimmed);
  }

  private sendSilentContext(text: string): void {
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

  /** Entrada textual direta para smoke tests e fallback sem áudio. */
  sendText(text: string): void {
    this.sendTextTurn(text);
  }

  /** Text prompt into the live conversation, used by smoke tests and fallback. */
  sendTextTurn(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const clipped = trimmed.slice(0, 4000);
    if (clipped.startsWith('[wake]') || clipped.startsWith('[reconexão]')) {
      this.routePriorityTurn(clipped);
      return;
    }
    this.routeTurn(clipped);
  }

  /** F-113: enfileira um turno falável serializado (1 por vez, disjuntor TURN_MAX_MS). */
  private routeTurn(text: string): void {
    this.turnQueue.enqueue(text);
  }

  /** Wake/reconexão: jump the queue (see TurnQueue.enqueuePriority). */
  private routePriorityTurn(text: string): void {
    this.turnQueue.enqueuePriority(text);
  }

  /** Callback de envio da TurnQueue — turno de usuário que dispara resposta do modelo. */
  private sendTurn(text: string): void {
    if (!this.isReady || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );
  }

  disconnect(): void {
    this.turnQueue.reset();
    this.screenCoalescer.clear();
    this.teardown(true);
    // F-133: libera o slot singleton se ESTA é a corrente (não derruba posse alheia).
    if (currentLiveTransport === this) currentLiveTransport = null;
    this.events.onStateChange('closed');
  }

  /** F-133: reivindica o slot singleton, encerrando qualquer transporte Live anterior. */
  private claimSingleton(): void {
    if (currentLiveTransport && currentLiveTransport !== this) {
      currentLiveTransport.disconnect();
    }
    currentLiveTransport = this;
  }

  /**
   * F-138/2461: watchdog de progresso da sessão viva — re-armado a cada mensagem
   * do servidor. 30s sem mensagem = socket zumbi: fecha o WS pra que o handler de
   * close reconecte com backoff (não é terminal — a exaustão do reconnect é quem
   * emite o 'closed' final).
   */
  private armProgressWatchdog(): void {
    this.clearProgressWatchdog();
    const generation = this.connectionGeneration;
    this.progressTimer = this.deps.setTimeoutFn(() => {
      this.progressTimer = null;
      if (generation !== this.connectionGeneration || !this.setupDone) return;
      this.events.onError(
        `live: sem progresso do servidor (${SDK_PROGRESS_TIMEOUT_MS / 1000}s) — reconectando`,
      );
      if (this.ws) {
        try {
          this.ws.close();
        } catch {
          // socket já morto
        }
      }
    }, SDK_PROGRESS_TIMEOUT_MS);
  }

  private clearProgressWatchdog(): void {
    if (this.progressTimer === null) return;
    this.deps.clearTimeoutFn(this.progressTimer);
    this.progressTimer = null;
  }

  private teardown(markClosed: boolean): void {
    if (markClosed) {
      this.closedByUs = true;
      this.connectionGeneration += 1;
    }
    if (this.setupTimer) this.deps.clearTimeoutFn(this.setupTimer);
    this.setupTimer = null;
    this.clearProgressWatchdog();
    this.clearReconnectTimer();
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
    this.audioStreamOpen = false;
    this.pendingToolCalls.clear();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    this.deps.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
