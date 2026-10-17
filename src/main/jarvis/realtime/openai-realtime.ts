import {
  base64ToInt16Array,
  int16ArrayToBase64,
  resamplePcm16,
  type RealtimeToolCallEvent,
  type RealtimeToolDefinition,
  type RealtimeTranscriptEvent,
  type TurnManagedRealtimeProvider,
} from './provider';
import { ScreenCoalescer } from './screen-coalescer';

export interface RealtimeWsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'close' | 'error', cb: (payload?: unknown) => void): void;
}

export interface RealtimeWsInit {
  headers: Record<string, string>;
}

export interface OpenAIRealtimeProviderOptions {
  apiKey: string;
  instructions: string;
  model?: string;
  voice?: string;
  turnDetection?: OpenAIRealtimeTurnDetection;
  inputSourceRate?: number;
  inputTargetRate?: number;
  tools?: RealtimeToolDefinition[];
  wsFactory?: (url: string, init: RealtimeWsInit) => RealtimeWsLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
  /**
   * Base do WebSocket sem query. Existe porque a xAI publica uma superfície
   * Realtime-compatível (`wss://api.x.ai/v1/realtime`, mesmo Bearer, mesmo
   * fluxo de eventos): trocar o host reaproveita todo o transporte em vez de
   * duplicá-lo. Ver grok-realtime.ts.
   */
  realtimeUrl?: string;
  /**
   * Construtor do `session.update`. Os dialetos divergem só aqui — a xAI põe
   * `voice` e `turn_detection` na raiz da sessão e usa `server_vad`, enquanto a
   * OpenAI aninha em `audio.output.voice` / `audio.input.turn_detection`.
   */
  sessionUpdateBuilder?: SessionUpdateBuilder;
  /**
   * Quem cria a resposta de um turno de fala: NÓS ou o VAD do servidor.
   *
   * A OpenAI honra `turn_detection.create_response: false` e então a resposta
   * do turno é nossa (`endUserTurn`), uma por captura. A xAI aceita e ecoa o
   * campo, mas continua respondendo sozinha quando o operador para de falar
   * (comportamento do `server_vad` dela) — criar a resposta dos dois lados é
   * justamente o que fazia a Jarvis responder DUAS vezes ao mesmo pedido, e
   * ela repetia o que tinha acabado de dizer. Com esta opção em `true` o fim
   * de captura não cria resposta nenhuma: o servidor já criou a dele.
   */
  serverOwnsResponseCreation?: boolean;
}

export type SessionUpdateBuilder = (opts: {
  model: string;
  voice: string;
  instructions: string;
  turnDetection?: OpenAIRealtimeTurnDetection;
  inputRate?: number;
  tools?: RealtimeToolDefinition[];
}) => Record<string, unknown>;

export interface ParsedOpenAIRealtimeEvent {
  type?: string;
  audio?: Int16Array;
  transcript?: RealtimeTranscriptEvent;
  /** Item de conversa a que a transcrição do usuário pertence (dedupe). */
  itemId?: string;
  /**
   * True quando a transcrição do usuário veio do snapshot do item
   * (`conversation.item.created/added/done`) e não do evento dedicado
   * `input_audio_transcription.completed`. O evento dedicado tem prioridade.
   */
  transcriptFromItem?: boolean;
  speechStarted?: boolean;
  speechStopped?: boolean;
  responseCreated?: boolean;
  responseDone?: boolean;
  sessionReady?: boolean;
  responseCancelled?: boolean;
  toolCall?: RealtimeToolCallEvent;
  error?: Error;
}

const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';
const DEFAULT_VOICE = 'ash';
const DEFAULT_TRANSCRIPTION_LANGUAGE = 'pt';
const DEFAULT_SOURCE_RATE = 16_000;
const DEFAULT_TARGET_RATE = 24_000;
const DEFAULT_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const CONNECT_TIMEOUT_MS = 10_000;
const PENDING_AUDIO_MAX_BYTES = 512 * 1024;
const EMITTED_TOOL_CALL_IDS_MAX = 256;
const USER_FINAL_ITEM_IDS_MAX = 64;
const MAX_CONTEXT_CHARS = 1_200;
const WS_OPEN = 1;

export type OpenAIRealtimeTurnDetection = 'semantic_vad' | 'manual';

export function buildOpenAISessionUpdate(opts: {
  model: string;
  voice: string;
  instructions: string;
  turnDetection?: OpenAIRealtimeTurnDetection;
  inputRate?: number;
  tools?: RealtimeToolDefinition[];
}): Record<string, unknown> {
  const tools = opts.tools ?? [];
  const turnDetection = opts.turnDetection ?? 'semantic_vad';
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: opts.model,
      instructions: opts.instructions,
      // A API aceita ['text'] OU ['audio'], nunca ambos; com 'audio'
      // o transcript continua chegando via response.output_audio_transcript.*.
      output_modalities: ['audio'],
      audio: {
        input: {
          format: {
            type: 'audio/pcm',
            rate: opts.inputRate ?? DEFAULT_TARGET_RATE,
          },
          transcription: {
            model: 'gpt-realtime-whisper',
            language: DEFAULT_TRANSCRIPTION_LANGUAGE,
          },
          turn_detection:
            turnDetection === 'manual'
              ? null
              : {
                  type: 'semantic_vad',
                  // Quem cria a resposta é o fim de captura do operador
                  // (`endUserTurn`), nunca o VAD do servidor: com o servidor
                  // respondendo sozinho, qualquer segmento que ele ouvisse —
                  // eco da própria Jarvis, ruído — virava uma SEGUNDA resposta
                  // ao mesmo pedido (ela repetindo o que acabou de dizer).
                  create_response: false,
                },
        },
        output: {
          format: {
            type: 'audio/pcm',
            // A API exige rate explícito no output; 24 kHz casa com o
            // OUTPUT_SAMPLE_RATE do LiveAudioPlayer do renderer.
            rate: DEFAULT_TARGET_RATE,
          },
          voice: opts.voice,
        },
      },
      ...(tools.length > 0
        ? {
            tools,
            tool_choice: 'auto',
          }
        : {}),
    },
  };
}

export function parseOpenAIRealtimeEvent(raw: string): ParsedOpenAIRealtimeEvent {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }

  const type = typeof event.type === 'string' ? event.type : undefined;
  if (!type) return {};

  if (type === 'error') {
    const payload = event.error as { message?: string; code?: string } | undefined;
    return {
      type,
      error: new Error(payload?.message ?? payload?.code ?? 'OpenAI realtime error'),
    };
  }

  if (type === 'session.created' || type === 'session.updated') {
    return { type, sessionReady: type === 'session.updated' };
  }

  if (type === 'input_audio_buffer.speech_started') {
    return { type, speechStarted: true };
  }

  if (type === 'input_audio_buffer.speech_stopped') {
    return { type, speechStopped: true };
  }

  if (type === 'response.created') {
    return { type, responseCreated: true };
  }

  if (type === 'response.done') {
    return { type, responseDone: true };
  }

  if (type === 'response.cancelled') {
    return { type, responseCancelled: true };
  }

  const toolCall = parseToolCallEvent(type, event);
  if (toolCall) return { type, toolCall };

  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    return { type, audio: delta ? base64ToInt16Array(delta) : new Int16Array() };
  }

  // `response.text.*` é o nome beta/legado dos mesmos eventos de texto que o GA
  // chama de `response.output_text.*`; os dois dialetos já apareceram em campo.
  if (
    type === 'response.output_audio_transcript.delta' ||
    type === 'response.audio_transcript.delta' ||
    type === 'response.output_text.delta' ||
    type === 'response.text.delta'
  ) {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    return {
      type,
      transcript: { role: 'assistant', text: delta, final: false },
    };
  }

  if (
    type === 'response.output_audio_transcript.done' ||
    type === 'response.audio_transcript.done' ||
    type === 'response.output_text.done' ||
    type === 'response.text.done'
  ) {
    const text =
      typeof event.transcript === 'string'
        ? event.transcript
        : typeof event.text === 'string'
          ? event.text
          : '';
    return {
      type,
      transcript: { role: 'assistant', text, final: true },
    };
  }

  if (type === 'conversation.item.input_audio_transcription.delta') {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    return {
      type,
      transcript: { role: 'user', text: delta, final: false },
    };
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = typeof event.transcript === 'string' ? event.transcript : '';
    return {
      type,
      ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      transcript: { role: 'user', text: transcript, final: true },
    };
  }

  // Rede de segurança: alguns servidores entregam a fala do usuário só no
  // snapshot do item (`content[].transcript`) e nunca no evento dedicado.
  // SÓ `transcript` (áudio reconhecido) vale — `content[].text` é o `input_text`
  // que o próprio Nexus injeta via sendText ([wake], resultado interno de
  // ação), e devolvê-lo como "fala do usuário" viraria comando fantasma.
  if (
    type === 'conversation.item.created' ||
    type === 'conversation.item.added' ||
    type === 'conversation.item.done'
  ) {
    const item = event.item as Record<string, unknown> | undefined;
    const spoken = userItemSpokenTranscript(item);
    if (!spoken) return { type };
    return {
      type,
      ...(typeof item?.id === 'string' ? { itemId: item.id } : {}),
      transcriptFromItem: true,
      transcript: { role: 'user', text: spoken, final: true },
    };
  }

  return { type };
}

function userItemSpokenTranscript(
  item: Record<string, unknown> | undefined,
): string {
  if (!item || item.role !== 'user' || !Array.isArray(item.content)) return '';
  for (const part of item.content) {
    if (!part || typeof part !== 'object') continue;
    const transcript = (part as Record<string, unknown>).transcript;
    if (typeof transcript === 'string' && transcript.trim()) return transcript;
  }
  return '';
}

function parseToolCallEvent(
  type: string,
  event: Record<string, unknown>,
): RealtimeToolCallEvent | null {
  if (type === 'response.function_call_arguments.done') {
    const callId =
      typeof event.call_id === 'string'
        ? event.call_id
        : typeof event.callId === 'string'
          ? event.callId
          : '';
    const name = typeof event.name === 'string' ? event.name : '';
    if (!callId || !name) return null;
    const argumentsJson =
      typeof event.arguments === 'string'
        ? event.arguments
        : JSON.stringify(event.arguments ?? {});
    return {
      callId,
      name,
      argumentsJson,
      arguments: parseToolArguments(argumentsJson),
    };
  }

  if (type !== 'response.output_item.done') return null;
  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== 'function_call') return null;
  const callId =
    typeof item.call_id === 'string'
      ? item.call_id
      : typeof item.callId === 'string'
        ? item.callId
        : '';
  const name = typeof item.name === 'string' ? item.name : '';
  if (!callId || !name) return null;
  const argumentsJson =
    typeof item.arguments === 'string'
      ? item.arguments
      : JSON.stringify(item.arguments ?? {});
  return {
    callId,
    name,
    argumentsJson,
    arguments: parseToolArguments(argumentsJson),
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid tool JSON is reported to the renderer as an empty arg object.
  }
  return {};
}

export class OpenAIRealtimeProvider implements TurnManagedRealtimeProvider {
  readonly supportsPassiveContextUpdates = true;
  private ws: RealtimeWsLike | null = null;
  private ready = false;
  private pendingAudio: Int16Array[] = [];
  private pendingAudioBytes = 0;
  private emittedToolCallIds = new Set<string>();
  private emittedToolCallOrder: string[] = [];
  private transcriptCallbacks: Array<(delta: string, final: boolean) => void> = [];
  private roleTranscriptCallbacks: Array<(event: RealtimeTranscriptEvent) => void> = [];
  private toolCallCallbacks: Array<(event: RealtimeToolCallEvent) => void> = [];
  private audioCallbacks: Array<(pcm16: Int16Array) => void> = [];
  private errorCallbacks: Array<(err: Error) => void> = [];
  private interruptedCallbacks: Array<() => void> = [];
  private responseDoneCallbacks: Array<() => void> = [];
  private disconnectedCallbacks: Array<(err: Error) => void> = [];
  private latestContext = '';
  private responseActive = false;
  private hasUncommittedAudio = false;
  private serverSpeechStopped = false;
  /**
   * Houve fala nova do operador desde a última resposta. Uma resposta só
   * existe quando há o que responder: um fim de captura atrasado — a limpeza
   * de fim de turno de um caminho Classic que também é chamada depois de a
   * Jarvis já ter respondido — não pode abrir uma resposta para o segmento
   * ANTERIOR (era isso que fazia ela repetir o que acabou de dizer).
   */
  private audioSinceResponse = false;
  private activeTurnId: string | undefined;
  /** Texto final do usuário já entregue por item — dedupe entre as duas fontes. */
  private userFinalByItem = new Map<string, string>();
  /** Sondas de vida do socket quente aguardando a próxima resposta do servidor. */
  private livenessSettlers: Array<(alive: boolean) => void> = [];
  private readonly screenCoalescer: ScreenCoalescer;

  private readonly apiKey: string;
  private readonly instructions: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly turnDetection: OpenAIRealtimeTurnDetection;
  private readonly serverOwnsResponseCreation: boolean;
  private readonly sourceRate: number;
  private readonly targetRate: number;
  private readonly tools: RealtimeToolDefinition[];
  private readonly wsFactory: (url: string, init: RealtimeWsInit) => RealtimeWsLike;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly realtimeUrl: string;
  private readonly sessionUpdateBuilder: SessionUpdateBuilder;

  constructor(options: OpenAIRealtimeProviderOptions) {
    this.realtimeUrl = options.realtimeUrl ?? DEFAULT_REALTIME_URL;
    this.sessionUpdateBuilder =
      options.sessionUpdateBuilder ?? buildOpenAISessionUpdate;
    this.apiKey = options.apiKey;
    this.instructions = options.instructions;
    this.model = options.model ?? DEFAULT_MODEL;
    this.voice = options.voice ?? DEFAULT_VOICE;
    this.turnDetection = options.turnDetection ?? 'semantic_vad';
    this.serverOwnsResponseCreation = options.serverOwnsResponseCreation === true;
    this.sourceRate = options.inputSourceRate ?? DEFAULT_SOURCE_RATE;
    this.targetRate = options.inputTargetRate ?? DEFAULT_TARGET_RATE;
    this.tools = options.tools ?? [];
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.screenCoalescer = new ScreenCoalescer({
      flush: (text) => this.sendContext(text),
      setTimeoutFn: this.setTimeoutFn,
      clearTimeoutFn: this.clearTimeoutFn,
    });
  }

  get isReady(): boolean {
    return this.ready && this.ws?.readyState === WS_OPEN;
  }

  connect(): Promise<void> {
    this.close();
    this.ready = false;
    this.emittedToolCallIds = new Set();
    this.emittedToolCallOrder = [];
    const url = `${this.realtimeUrl}?model=${encodeURIComponent(this.model)}`;
    const ws = this.wsFactory(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      let runtimeDisconnectEmitted = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.clearTimeoutFn(timer);
        if (err) reject(err);
        else resolve();
      };
      const disconnectAfterSetup = (err: Error) => {
        const wasReady = this.ready;
        this.ready = false;
        this.responseActive = false;
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        this.settleLiveness(false);
        if (!wasReady || runtimeDisconnectEmitted) return;
        runtimeDisconnectEmitted = true;
        this.emitDisconnected(err);
      };
      const timer = this.setTimeoutFn(() => {
        settle(new Error('OpenAI realtime setup timeout'));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        this.sendSessionUpdate();
      });
      ws.on('message', (payload) => {
        const raw = payloadToString(payload);
        const parsed = parseOpenAIRealtimeEvent(raw);
        // Qualquer frame do servidor prova que a sessão responde; um erro dele
        // prova o contrário (sonda do socket quente).
        this.settleLiveness(!parsed.error);
        this.handleParsedEvent(parsed);
        if (parsed.sessionReady) {
          this.ready = true;
          this.flushPendingAudio();
          settle();
        }
        if (parsed.error) settle(parsed.error);
      });
      ws.on('close', () => {
        if (!settled) {
          this.ready = false;
          this.pendingAudio = [];
          this.pendingAudioBytes = 0;
          settle(new Error('OpenAI realtime socket closed before setup'));
          return;
        }
        disconnectAfterSetup(new Error('OpenAI realtime socket closed'));
      });
      ws.on('error', (payload) => {
        const err =
          payload instanceof Error ? payload : new Error(`OpenAI realtime socket error: ${String(payload)}`);
        this.emitError(err);
        if (!settled) settle(err);
        else disconnectAfterSetup(err);
      });
    });
  }

  sendAudioChunk(pcm16: Int16Array): void {
    if (pcm16.length === 0) return;
    if (!this.isReady) {
      const nextBytes = pcm16.byteLength;
      if (this.pendingAudioBytes + nextBytes > PENDING_AUDIO_MAX_BYTES) return;
      this.pendingAudio.push(pcm16.slice());
      this.pendingAudioBytes += nextBytes;
      return;
    }
    const prepared = resamplePcm16(pcm16, this.sourceRate, this.targetRate);
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: int16ArrayToBase64(prepared),
    });
    this.hasUncommittedAudio = true;
    this.serverSpeechStopped = false;
    this.audioSinceResponse = true;
  }

  beginUserTurn(turnId: string): void {
    const normalized = turnId.trim().slice(0, 128);
    if (normalized) this.activeTurnId = normalized;
  }

  /**
   * Nova ativação no MESMO socket quente: zera só o estado local do turno
   * anterior. Nada vai ao fio — o VAD do servidor já decide o fim do turno, e
   * a xAI não documenta `input_audio_buffer.clear` (evento recusado vira
   * `error` e derrubaria a sessão).
   */
  resetTurn(): void {
    this.hasUncommittedAudio = false;
    this.serverSpeechStopped = false;
    this.audioSinceResponse = false;
  }

  /**
   * Prova de vida do socket quente antes de reutilizá-lo. Um `session.update`
   * idempotente (o mesmo que `sendContext` já manda) obriga o servidor a
   * responder `session.updated`; qualquer frame de volta prova a sessão de
   * aplicação, que um ping/pong não prova (o proxy de borda responde pong mesmo
   * com a origem morta). Sem resposta em `timeoutMs` o socket é zumbi.
   */
  probeLiveness(timeoutMs: number): Promise<boolean> {
    if (!this.isReady) return Promise.resolve(false);
    return new Promise((resolve) => {
      const settle = (alive: boolean): void => {
        this.clearTimeoutFn(timer);
        const at = this.livenessSettlers.indexOf(settle);
        if (at >= 0) this.livenessSettlers.splice(at, 1);
        resolve(alive);
      };
      const timer = this.setTimeoutFn(() => settle(false), timeoutMs);
      this.livenessSettlers.push(settle);
      this.sendSessionUpdate();
    });
  }

  private settleLiveness(alive: boolean): void {
    for (const settle of [...this.livenessSettlers]) settle(alive);
  }

  onTranscript(cb: (delta: string, final: boolean) => void): void {
    this.transcriptCallbacks.push(cb);
  }

  onRoleTranscript(cb: (event: RealtimeTranscriptEvent) => void): void {
    this.roleTranscriptCallbacks.push(cb);
  }

  onToolCall(cb: (event: RealtimeToolCallEvent) => void): void {
    this.toolCallCallbacks.push(cb);
  }

  onAudioOut(cb: (pcm16: Int16Array) => void): void {
    this.audioCallbacks.push(cb);
  }

  onError(cb: (err: Error) => void): void {
    this.errorCallbacks.push(cb);
  }

  onInterrupted(cb: () => void): void {
    this.interruptedCallbacks.push(cb);
  }

  onResponseDone(cb: () => void): void {
    this.responseDoneCallbacks.push(cb);
  }

  onDisconnected(cb: (err: Error) => void): void {
    this.disconnectedCallbacks.push(cb);
  }

  interrupt(): void {
    this.sendEvent({ type: 'response.cancel' });
  }

  endUserTurn(): void {
    if (!this.isReady) return;
    // O servidor não cria mais resposta sozinho (`turn_detection.create_response:
    // false`): quem responde é o fim de captura do operador. Três travas
    // garantem UMA resposta por pedido — era a segunda resposta ao mesmo
    // pedido que fazia a Jarvis repetir o que acabou de dizer:
    //  - `create_response: false` na sessão: o VAD do servidor só DETECTA a
    //    fala; ele não abre mais uma resposta por conta própria para cada
    //    segmento que ouve (cauda de eco da própria voz dela incluída);
    //  - `responseActive`: a volta já está sendo respondida (fim de captura
    //    repetido, ou eco que continuou chegando depois do commit);
    //  - `audioSinceResponse`: só há o que responder se o operador falou
    //    depois da resposta anterior.
    if (this.responseActive) {
      this.hasUncommittedAudio = false;
      return;
    }
    // Rota em que o VAD do servidor já cria a resposta do segmento (xAI: o
    // `create_response` é aceito e ecoado mas não muda nada). Criar a nossa aqui
    // era a SEGUNDA resposta ao mesmo pedido — é o que fazia a Jarvis repetir o
    // que acabou de dizer.
    if (this.turnDetection !== 'manual' && this.serverOwnsResponseCreation) {
      this.hasUncommittedAudio = false;
      return;
    }
    // Nada foi falado desde a última resposta: um fim de captura atrasado (a
    // limpeza de turno que vários caminhos Classic também chamam DEPOIS de a
    // Jarvis já ter respondido) não pode responder ao segmento anterior.
    if (!this.audioSinceResponse) return;
    // O VAD do servidor já fechou o segmento: o buffer está commitado por ele,
    // então falta só pedir a resposta (commit repetido viraria erro de buffer
    // vazio). Sem esse fechamento — a parada local por silêncio é mais rápida
    // que a volta do frame de VAD — a volta é fechada por nós, senão a Jarvis
    // ficaria muda.
    if (this.turnDetection !== 'manual' && this.serverSpeechStopped) {
      this.createResponse();
      return;
    }
    if (!this.hasUncommittedAudio) return;
    this.forceEndUserTurn();
  }

  forceEndUserTurn(): void {
    if (!this.isReady) return;
    this.sendEvent({ type: 'input_audio_buffer.commit' });
    this.createResponse();
  }

  /**
   * Pede a resposta SEM recommitar o buffer: com o VAD do servidor o segmento
   * já foi commitado por ele, e repetir o commit devolve erro de buffer vazio.
   */
  private createResponse(): void {
    this.sendEvent({
      type: 'response.create',
      response: { output_modalities: ['audio'] },
    });
    this.responseActive = true;
    this.hasUncommittedAudio = false;
    this.audioSinceResponse = false;
  }

  sendContext(text: string): void {
    const trimmed = text.trim().slice(0, MAX_CONTEXT_CHARS);
    if (!trimmed || trimmed === this.latestContext) return;
    this.latestContext = trimmed;
    this.sendSessionUpdate();
  }

  sendScreenUpdate(text: string): void {
    this.screenCoalescer.push(text);
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.isReady) return;
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: trimmed }],
      },
    });
    this.createResponse();
  }

  sendToolResult(callId: string, output: unknown): void {
    const trimmedCallId = callId.trim();
    if (!trimmedCallId || !this.isReady) return;
    const outputText =
      typeof output === 'string' ? output : JSON.stringify(output ?? {});
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: trimmedCallId,
        output: outputText.slice(0, 20_000),
      },
    });
    this.createResponse();
  }

  close(): void {
    this.ready = false;
    this.responseActive = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.hasUncommittedAudio = false;
    this.serverSpeechStopped = false;
    this.audioSinceResponse = false;
    this.activeTurnId = undefined;
    this.emittedToolCallIds.clear();
    this.emittedToolCallOrder = [];
    this.userFinalByItem.clear();
    this.screenCoalescer.clear();
    this.settleLiveness(false);
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    this.ws = null;
  }

  private sendSessionUpdate(): void {
    const contextBlock = this.latestContext
      ? `${this.instructions}\n\nCurrent Nexus IDE context:\n${this.latestContext}`
      : this.instructions;
    this.sendEvent(
      this.sessionUpdateBuilder({
        model: this.model,
        voice: this.voice,
        instructions: contextBlock,
        turnDetection: this.turnDetection,
        inputRate: this.targetRate,
        tools: this.tools,
      }),
    );
  }

  private flushPendingAudio(): void {
    const chunks = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    for (const chunk of chunks) this.sendAudioChunk(chunk);
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.ws.send(JSON.stringify(event));
  }

  private handleParsedEvent(event: ParsedOpenAIRealtimeEvent): void {
    if (event.error) {
      this.emitError(event.error);
      return;
    }
    if (event.speechStarted) {
      this.serverSpeechStopped = false;
      if (this.responseActive) {
        this.interrupt();
        for (const cb of this.interruptedCallbacks) cb();
      }
      return;
    }
    if (event.speechStopped) {
      this.serverSpeechStopped = true;
      this.hasUncommittedAudio = false;
    }
    if (event.responseCreated) {
      this.responseActive = true;
      this.hasUncommittedAudio = false;
    }
    if (event.responseDone || event.responseCancelled) {
      this.responseActive = false;
    }
    if (event.responseDone) {
      for (const cb of this.responseDoneCallbacks) cb();
    }
    if (event.toolCall) {
      if (!this.emittedToolCallIds.has(event.toolCall.callId)) {
        this.emittedToolCallIds.add(event.toolCall.callId);
        this.emittedToolCallOrder.push(event.toolCall.callId);
        if (this.emittedToolCallOrder.length > EMITTED_TOOL_CALL_IDS_MAX) {
          const expired = this.emittedToolCallOrder.shift();
          if (expired) this.emittedToolCallIds.delete(expired);
        }
        for (const cb of this.toolCallCallbacks) cb(event.toolCall);
      }
    }
    if (event.audio) {
      this.responseActive = true;
      for (const cb of this.audioCallbacks) cb(event.audio);
    }
    if (event.transcript && this.acceptTranscript(event)) {
      this.emitRoleTranscript(event.transcript);
    }
  }

  /**
   * A fala final do usuário pode chegar por duas fontes (evento dedicado e
   * snapshot do item). O evento dedicado sempre vale; o snapshot só quando o
   * item ainda não foi entregue, e o dedicado repetido com o mesmo texto cai.
   * Revisões do mesmo item (texto diferente) continuam passando.
   */
  private acceptTranscript(event: ParsedOpenAIRealtimeEvent): boolean {
    const transcript = event.transcript;
    if (!transcript || transcript.role !== 'user' || !transcript.final) return true;
    if (!event.itemId) return true;
    const previous = this.userFinalByItem.get(event.itemId);
    if (event.transcriptFromItem ? previous !== undefined : previous === transcript.text) {
      return false;
    }
    this.userFinalByItem.set(event.itemId, transcript.text);
    if (this.userFinalByItem.size > USER_FINAL_ITEM_IDS_MAX) {
      const oldest = this.userFinalByItem.keys().next().value;
      if (oldest !== undefined) this.userFinalByItem.delete(oldest);
    }
    return true;
  }

  private emitRoleTranscript(event: RealtimeTranscriptEvent): void {
    const scoped = { ...event, turnId: this.activeTurnId };
    for (const cb of this.transcriptCallbacks) cb(scoped.text, scoped.final);
    for (const cb of this.roleTranscriptCallbacks) cb(scoped);
  }

  private emitError(err: Error): void {
    for (const cb of this.errorCallbacks) cb(err);
  }

  private emitDisconnected(err: Error): void {
    for (const cb of this.disconnectedCallbacks) cb(err);
  }
}

function payloadToString(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return String(payload);
}

function defaultWsFactory(url: string, init: RealtimeWsInit): RealtimeWsLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- ws só carrega no connect real (os testes injetam wsFactory); a anotação tipa só a superfície usada
  const WsCtor = require('ws').WebSocket as new (
    url: string,
    init: RealtimeWsInit,
  ) => RealtimeWsLike;
  return new WsCtor(url, init);
}
