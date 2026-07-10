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
 * - setup timeout 10 s; reconnect pertence exclusivamente ao controller
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
import type { GeminiFunctionDeclaration } from '../jarvis/realtime/coarse-voice-tools';
import {
  buildSetupMessage,
  CONTEXT_UPDATE_ENVELOPE,
  parseServerMessage,
  usesGemini31Contract,
  type LiveToolCall,
} from './gemini-live-protocol';

export {
  buildSetupMessage,
  parseServerMessage,
  type LiveToolCall,
  type ParsedServerMessage,
  type SetupMessage,
} from './gemini-live-protocol';

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'close' | 'error', cb: (payload?: unknown) => void): void;
}

export interface LiveTransportEvents {
  /** PCM 24 kHz base64 para o renderer tocar. */
  onAudioOut(b64: string): void;
  onTranscript(
    role: 'user' | 'assistant',
    text: string,
    final: boolean,
    turnId?: string,
  ): void;
  onInterrupted(): void;
  onTurnComplete?(): void;
  onStateChange(state: LiveTransportState): void;
  onError(message: string): void;
  /** Chamada de função coarse (delegar/consultar/ler/navegar/encerrar). */
  onToolCall?(call: LiveToolCall): void;
  /** Gemini revoked a function call that may still be running locally. */
  onToolCallCancelled?(callId: string): void;
  /** Updated opaque handle used to resume the same server-side Live session. */
  onResumptionHandle?(handle: string): void;
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
  tools?: GeminiFunctionDeclaration[];
  resumeHandle?: string;
}

const LIVE_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const SETUP_TIMEOUT_MS = 10_000;
// F-059/2461: 30s sem progresso ENQUANTO há um turno aguardando resposta =
// socket zumbi. Uma conexão Live saudável pode ficar ociosa indefinidamente,
// portanto setupComplete/turnComplete nunca deixam este relógio armado.
const SDK_PROGRESS_TIMEOUT_MS = 30_000;
const PENDING_MIC_MAX_BYTES = 160 * 1024;
export const TRANSCRIPTION_SETTLE_MS = 250;
const HANDLED_TOOL_CALL_IDS_MAX = 256;
const WS_OPEN = 1;

function transportErrorMessage(err: unknown, secrets: readonly string[]): string {
  let message = err instanceof Error ? err.message : String(err);
  message = message.replace(
    /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"'<>]+/gi,
    '$1[REDACTED]',
  );
  for (const secret of secrets) {
    if (!secret) continue;
    message = message.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) message = message.split(encoded).join('[REDACTED]');
  }
  return message;
}

/**
 * F-133: SINGLETON cross-instância — no máximo 1 transporte Live vivo por
 * processo. Duas GeminiLiveTransport vivas em paralelo = "duas vozes". Toda
 * conexão nova reivindica este slot e encerra a anterior.
 */
let currentLiveTransport: GeminiLiveTransport | null = null;

/** Test-only: limpa o slot singleton entre casos isolados. */
export function __resetLiveTransportSingleton(): void {
  currentLiveTransport = null;
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
  private awaitingServerProgress = false;
  private connectionGeneration = 0;
  private resumptionHandle: string | undefined;
  /** Gemini 3.1 forbids clientContent after initial history seeding. */
  private useRealtimeText = false;
  /** Gemini 3.1 text updates share the realtime input stream and can trigger a
   * model turn. Keep only the latest snapshot and prepend it to real activity. */
  private pendingSilentContext: string | null = null;
  private readonly pendingToolCalls = new Set<string>();
  private readonly handledToolCallIds = new Set<string>();
  private readonly handledToolCallOrder: string[] = [];
  private readonly turnQueue: TurnQueue;
  private readonly screenCoalescer: ScreenCoalescer;
  /** Input/output transcription are independent streams with no order guarantee. */
  private userTranscriptBuffer = '';
  private assistantTranscriptBuffer = '';
  private transcriptFinalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptTurnComplete = false;
  private activeTurnId: string | undefined;
  private transcriptTurnId: string | undefined;

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

  beginUserTurn(turnId: string): void {
    const normalized = turnId.trim().slice(0, 128);
    if (!normalized || normalized === this.activeTurnId) return;
    if (this.userTranscriptBuffer || this.assistantTranscriptBuffer) {
      this.finalizeTranscripts();
    }
    this.activeTurnId = normalized;
    this.transcriptTurnId = normalized;
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
    // transporte Live vivo antes de conectar (evita "duas vozes").
    this.claimSingleton();
    // Singleton por instância: nunca duas sessões (= duas vozes) vivas.
    this.teardown();
    this.resumptionHandle = opts.resumeHandle ?? this.resumptionHandle;
    this.useRealtimeText = usesGemini31Contract(opts.model);
    const generation = ++this.connectionGeneration;
    this.setupDone = false;
    this.events.onStateChange('connecting');
    const url = `${LIVE_WS_BASE}?key=${encodeURIComponent(opts.apiKey)}`;
    let ws: WsLike;
    try {
      ws = this.deps.wsFactory(url);
    } catch (err) {
      this.events.onError(
        `live: falha ao abrir socket — ${transportErrorMessage(err, [opts.apiKey])}`,
      );
      this.releaseSingleton();
      this.events.onStateChange('error');
      return;
    }
    this.ws = ws;

    this.setupTimer = this.deps.setTimeoutFn(() => {
      if (generation !== this.connectionGeneration) return;
      if (!this.setupDone) {
        this.events.onError('live: setup timeout (10s)');
        this.teardown();
        this.releaseSingleton();
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
            resumeHandle: this.resumptionHandle,
            tools: opts.tools,
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
      // Invalida callbacks atrasados e garante que `closed` seja terminal para
      // esta geração. O LiveTransportController é a única autoridade de retry.
      this.connectionGeneration += 1;
      this.setupDone = false;
      this.clearSetupTimer();
      this.clearProgressWatchdog();
      if (this.ws === ws) this.ws = null;
      this.releaseSingleton();
      this.events.onStateChange('closed');
    });

    ws.on('error', (err) => {
      if (generation !== this.connectionGeneration) return;
      this.events.onError(
        `live: socket error — ${transportErrorMessage(err, [opts.apiKey])}`,
      );
      // `error` não garante `close` em todas as implementações de WebSocket.
      // Solicita encerramento; o evento `close` acima propaga a desconexão ao
      // controller, que decide se/quando deve abrir uma nova sessão.
      try {
        ws.close();
      } catch {
        this.connectionGeneration += 1;
        this.setupDone = false;
        this.clearSetupTimer();
        this.clearProgressWatchdog();
        if (this.ws === ws) this.ws = null;
        this.releaseSingleton();
        this.events.onStateChange('closed');
      }
    });
  }

  private handleServerMessage(raw: string): void {
    const msg = parseServerMessage(raw);
    // Só um turno em voo possui deadline. Silêncio entre turnos é o estado
    // normal de uma sessão Live e não pode provocar um ciclo de reconexões.
    if (this.awaitingServerProgress) this.armProgressWatchdog();
    if (msg.setupComplete) {
      this.setupDone = true;
      this.clearSetupTimer();
      this.flushPendingMic();
      // F-113: drena os turnos que ficaram na fila até a sessão ficar viva
      // (greeting/reconexão bufferizados pré-setupComplete).
      this.turnQueue.drain();
      this.events.onStateChange('ready');
    }
    const audioB64s = msg.audioB64s ?? [];
    for (const audioB64 of audioB64s) this.events.onAudioOut(audioB64);
    if (msg.inputTranscription) {
      this.transcriptTurnId ??= this.activeTurnId;
      this.userTranscriptBuffer += msg.inputTranscription;
      this.events.onTranscript(
        'user',
        msg.inputTranscription,
        false,
        this.transcriptTurnId,
      );
      this.rescheduleTranscriptFinalization();
    }
    if (msg.outputTranscription) {
      this.transcriptTurnId ??= this.activeTurnId;
      this.assistantTranscriptBuffer += msg.outputTranscription;
      this.events.onTranscript(
        'assistant',
        msg.outputTranscription,
        false,
        this.transcriptTurnId,
      );
      this.rescheduleTranscriptFinalization();
    }
    // F-113: turno abortado (barge-in) ou concluído libera a fila e drena o próximo.
    if (msg.interrupted) {
      // Barge-in: o turno do usuário anterior nunca virou resposta — descarta o
      // buffer para não vazar num transcript final tardio no próximo turno.
      this.discardTranscriptTurn();
      this.finishAwaitingServerProgress();
      this.events.onInterrupted();
      this.turnQueue.release();
    }
    if (msg.turnComplete) {
      this.transcriptTurnComplete = true;
      this.rescheduleTranscriptFinalization();
      this.finishAwaitingServerProgress();
      this.events.onTurnComplete?.();
      this.turnQueue.release();
    }
    if (msg.toolCalls) {
      // O servidor está deliberadamente parado à espera do resultado local da
      // ferramenta (que pode incluir uma confirmação humana demorada).
      this.finishAwaitingServerProgress();
      for (const call of msg.toolCalls) {
        if (!call.id || this.handledToolCallIds.has(call.id)) continue;
        this.handledToolCallIds.add(call.id);
        this.handledToolCallOrder.push(call.id);
        if (this.handledToolCallOrder.length > HANDLED_TOOL_CALL_IDS_MAX) {
          const expired = this.handledToolCallOrder.shift();
          if (expired) this.handledToolCallIds.delete(expired);
        }
        this.pendingToolCalls.add(call.id);
        this.events.onToolCall?.(call);
      }
    }
    if (msg.cancelledToolCallIds) {
      for (const id of msg.cancelledToolCallIds) {
        // Only propagate cancellations for calls this transport actually
        // emitted. Unknown ids must not create cancellation tombstones in the
        // application-level exactly-once registry.
        if (!this.pendingToolCalls.delete(id)) continue;
        this.events.onToolCallCancelled?.(id);
      }
    }
    if (msg.resumptionHandle) {
      this.resumptionHandle = msg.resumptionHandle;
      this.events.onResumptionHandle?.(msg.resumptionHandle);
    }
    if (msg.goAway && this.ws) {
      // Não abre um segundo socket aqui: encerra e deixa o controller coordenar
      // backoff, limite de tentativas e eventual fallback de provider.
      try {
        this.ws.close();
      } catch {
        // O callback de erro/close do socket já cobre a propagação terminal.
      }
    }
  }

  /**
   * Devolve o resultado de uma função coarse ao modelo (toolResponse). Ignora
   * calls já cancelados (o servidor mandou toolCallCancellation no meio-tempo).
   */
  sendToolResult(
    callId: string,
    name: string,
    output: unknown,
    options: { allowResumedCall?: boolean } = {},
  ): void {
    if (
      callId &&
      !options.allowResumedCall &&
      !this.pendingToolCalls.has(callId)
    ) {
      return;
    }
    if (callId) this.pendingToolCalls.delete(callId);
    if (!this.isReady || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id: callId, name, response: { output } }],
        },
      }),
    );
    this.beginAwaitingServerProgress();
  }

  /** Mic PCM 16 kHz base64. Antes do setupComplete, bufferiza (teto 160 KB). */
  sendMicChunk(b64: string): void {
    // A new audio turn is an unambiguous boundary if a previous transcription
    // grace window is still open.
    if (this.transcriptTurnComplete) this.finalizeTranscripts();
    if (this.isReady && this.ws) {
      if (!this.audioStreamOpen) this.flushPendingSilentContext();
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

  private rescheduleTranscriptFinalization(): void {
    if (!this.transcriptTurnComplete) return;
    this.clearTranscriptFinalizeTimer();
    this.transcriptFinalizeTimer = this.deps.setTimeoutFn(() => {
      this.transcriptFinalizeTimer = null;
      this.finalizeTranscripts();
    }, TRANSCRIPTION_SETTLE_MS);
  }

  private finalizeTranscripts(): void {
    this.clearTranscriptFinalizeTimer();
    const userText = this.userTranscriptBuffer.trim();
    const assistantText = this.assistantTranscriptBuffer.trim();
    const turnId = this.transcriptTurnId;
    this.userTranscriptBuffer = '';
    this.assistantTranscriptBuffer = '';
    this.transcriptTurnComplete = false;
    this.transcriptTurnId = undefined;
    if (userText) this.events.onTranscript('user', userText, true, turnId);
    if (assistantText) this.events.onTranscript('assistant', assistantText, true, turnId);
  }

  private discardTranscriptTurn(): void {
    this.clearTranscriptFinalizeTimer();
    this.userTranscriptBuffer = '';
    this.assistantTranscriptBuffer = '';
    this.transcriptTurnComplete = false;
    this.transcriptTurnId = undefined;
  }

  private clearTranscriptFinalizeTimer(): void {
    if (this.transcriptFinalizeTimer === null) return;
    this.deps.clearTimeoutFn(this.transcriptFinalizeTimer);
    this.transcriptFinalizeTimer = null;
  }

  /** Fecha o turno de fala do usuário (VAD manual / PTT soltou). */
  endUserTurn(): void {
    if (!this.isReady || !this.ws) return;
    // Orphan audioStreamEnd (no prior mic) confuses Gemini Live — cold wake
    // inject then stays silent until a later re-wake (~3s) or ~20s ambient reply.
    if (!this.audioStreamOpen) return;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    this.audioStreamOpen = false;
    this.beginAwaitingServerProgress();
  }

  /**
   * Barge-in / wake prep: close any open audio user-turn and free the TurnQueue
   * so a `[wake]` inject is not stuck behind a phantom busy turn.
   * Does NOT emit onInterrupted — that is reserved for server barge-in signals.
   */
  interrupt(): void {
    this.endUserTurn();
    this.finishAwaitingServerProgress();
    this.discardTranscriptTurn();
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
    if (this.useRealtimeText) {
      const trimmed = text.trim();
      if (trimmed) {
        this.pendingSilentContext =
          `${CONTEXT_UPDATE_ENVELOPE}\n${trimmed.slice(0, 400)}`;
      }
      return;
    }
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
    if (this.transcriptTurnComplete) this.finalizeTranscripts();
    if (this.useRealtimeText) {
      this.flushPendingSilentContext();
      this.ws.send(JSON.stringify({ realtimeInput: { text } }));
      this.beginAwaitingServerProgress();
      return;
    }
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );
    this.beginAwaitingServerProgress();
  }

  private flushPendingSilentContext(): void {
    const text = this.pendingSilentContext;
    if (!text || !this.isReady || !this.ws) return;
    this.pendingSilentContext = null;
    this.ws.send(JSON.stringify({ realtimeInput: { text } }));
  }

  disconnect(): void {
    this.turnQueue.reset();
    this.screenCoalescer.clear();
    this.teardown();
    this.releaseSingleton();
    this.events.onStateChange('closed');
  }

  /** F-133: reivindica o slot singleton, encerrando qualquer transporte Live anterior. */
  private claimSingleton(): void {
    if (currentLiveTransport && currentLiveTransport !== this) {
      currentLiveTransport.disconnect();
    }
    currentLiveTransport = this;
  }

  /** Libera o slot apenas se esta instância ainda for a proprietária. */
  private releaseSingleton(): void {
    if (currentLiveTransport === this) currentLiveTransport = null;
  }

  /**
   * F-138/2461: watchdog de um turno em voo — re-armado a cada progresso do
   * servidor. Ociosidade sem turno não tem deadline.
   */
  private beginAwaitingServerProgress(): void {
    this.awaitingServerProgress = true;
    this.armProgressWatchdog();
  }

  private finishAwaitingServerProgress(): void {
    this.awaitingServerProgress = false;
    this.clearProgressWatchdog();
  }

  private armProgressWatchdog(): void {
    this.clearProgressWatchdog();
    if (!this.awaitingServerProgress) return;
    const generation = this.connectionGeneration;
    this.progressTimer = this.deps.setTimeoutFn(() => {
      this.progressTimer = null;
      if (
        generation !== this.connectionGeneration ||
        !this.setupDone ||
        !this.awaitingServerProgress
      ) return;
      this.awaitingServerProgress = false;
      this.events.onError(
        `live: sem progresso do servidor (${SDK_PROGRESS_TIMEOUT_MS / 1000}s) — encerrando sessão`,
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

  private clearSetupTimer(): void {
    if (this.setupTimer === null) return;
    this.deps.clearTimeoutFn(this.setupTimer);
    this.setupTimer = null;
  }

  private teardown(): void {
    this.connectionGeneration += 1;
    this.clearSetupTimer();
    this.clearProgressWatchdog();
    this.awaitingServerProgress = false;
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
    this.pendingSilentContext = null;
    this.pendingToolCalls.clear();
    this.handledToolCallIds.clear();
    this.handledToolCallOrder.length = 0;
    this.discardTranscriptTurn();
  }
}
