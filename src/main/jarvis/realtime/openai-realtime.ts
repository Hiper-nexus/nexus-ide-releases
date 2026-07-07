import {
  base64ToInt16Array,
  int16ArrayToBase64,
  resamplePcm16,
  type RealtimeToolCallEvent,
  type RealtimeToolDefinition,
  type RealtimeTranscriptEvent,
  type TurnManagedRealtimeProvider,
} from './provider';

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
  inputSourceRate?: number;
  inputTargetRate?: number;
  tools?: RealtimeToolDefinition[];
  wsFactory?: (url: string, init: RealtimeWsInit) => RealtimeWsLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface ParsedOpenAIRealtimeEvent {
  type?: string;
  audio?: Int16Array;
  transcript?: RealtimeTranscriptEvent;
  speechStarted?: boolean;
  speechStopped?: boolean;
  responseDone?: boolean;
  sessionReady?: boolean;
  responseCancelled?: boolean;
  toolCall?: RealtimeToolCallEvent;
  error?: Error;
}

const DEFAULT_MODEL = 'gpt-realtime-2.1';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_SOURCE_RATE = 16_000;
const DEFAULT_TARGET_RATE = 24_000;
const CONNECT_TIMEOUT_MS = 10_000;
const PENDING_AUDIO_MAX_BYTES = 512 * 1024;
const WS_OPEN = 1;

export function buildOpenAISessionUpdate(opts: {
  model: string;
  voice: string;
  instructions: string;
  inputRate?: number;
  tools?: RealtimeToolDefinition[];
}): Record<string, unknown> {
  const tools = opts.tools ?? [];
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
          },
          turn_detection: null,
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

  if (
    type === 'response.output_audio_transcript.delta' ||
    type === 'response.audio_transcript.delta' ||
    type === 'response.output_text.delta'
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
    type === 'response.output_text.done'
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
      transcript: { role: 'user', text: transcript, final: true },
    };
  }

  return { type };
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
  private ws: RealtimeWsLike | null = null;
  private ready = false;
  private pendingAudio: Int16Array[] = [];
  private pendingAudioBytes = 0;
  private emittedToolCallIds = new Set<string>();
  private transcriptCallbacks: Array<(delta: string, final: boolean) => void> = [];
  private roleTranscriptCallbacks: Array<(event: RealtimeTranscriptEvent) => void> = [];
  private toolCallCallbacks: Array<(event: RealtimeToolCallEvent) => void> = [];
  private audioCallbacks: Array<(pcm16: Int16Array) => void> = [];
  private errorCallbacks: Array<(err: Error) => void> = [];
  private interruptedCallbacks: Array<() => void> = [];
  private responseDoneCallbacks: Array<() => void> = [];
  private disconnectedCallbacks: Array<(err: Error) => void> = [];
  private latestContext = '';

  private readonly apiKey: string;
  private readonly instructions: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly sourceRate: number;
  private readonly targetRate: number;
  private readonly tools: RealtimeToolDefinition[];
  private readonly wsFactory: (url: string, init: RealtimeWsInit) => RealtimeWsLike;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(options: OpenAIRealtimeProviderOptions) {
    this.apiKey = options.apiKey;
    this.instructions = options.instructions;
    this.model = options.model ?? DEFAULT_MODEL;
    this.voice = options.voice ?? DEFAULT_VOICE;
    this.sourceRate = options.inputSourceRate ?? DEFAULT_SOURCE_RATE;
    this.targetRate = options.inputTargetRate ?? DEFAULT_TARGET_RATE;
    this.tools = options.tools ?? [];
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  get isReady(): boolean {
    return this.ready && this.ws?.readyState === WS_OPEN;
  }

  connect(): Promise<void> {
    this.close();
    this.ready = false;
    this.emittedToolCallIds = new Set();
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
    const ws = this.wsFactory(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.clearTimeoutFn(timer);
        if (err) reject(err);
        else resolve();
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
        this.handleParsedEvent(parsed);
        if (parsed.sessionReady) {
          this.ready = true;
          this.flushPendingAudio();
          settle();
        }
        if (parsed.error) settle(parsed.error);
      });
      ws.on('close', () => {
        const wasReady = this.ready;
        this.ready = false;
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        if (!settled) {
          settle(new Error('OpenAI realtime socket closed before setup'));
          return;
        }
        if (wasReady) this.emitDisconnected(new Error('OpenAI realtime socket closed'));
      });
      ws.on('error', (payload) => {
        const err =
          payload instanceof Error ? payload : new Error(`OpenAI realtime socket error: ${String(payload)}`);
        this.emitError(err);
        settle(err);
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
    this.sendEvent({ type: 'input_audio_buffer.commit' });
    this.sendEvent({
      type: 'response.create',
      response: { output_modalities: ['audio'] },
    });
  }

  sendContext(text: string): void {
    const trimmed = text.trim().slice(0, 800);
    if (!trimmed || trimmed === this.latestContext) return;
    this.latestContext = trimmed;
    this.sendSessionUpdate();
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
    this.sendEvent({
      type: 'response.create',
      response: { output_modalities: ['audio'] },
    });
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
    this.sendEvent({
      type: 'response.create',
      response: { output_modalities: ['audio'] },
    });
  }

  close(): void {
    this.ready = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.emittedToolCallIds.clear();
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
      buildOpenAISessionUpdate({
        model: this.model,
        voice: this.voice,
        instructions: contextBlock,
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
      this.interrupt();
      for (const cb of this.interruptedCallbacks) cb();
      return;
    }
    if (event.responseDone) {
      for (const cb of this.responseDoneCallbacks) cb();
    }
    if (event.toolCall) {
      if (!this.emittedToolCallIds.has(event.toolCall.callId)) {
        this.emittedToolCallIds.add(event.toolCall.callId);
        for (const cb of this.toolCallCallbacks) cb(event.toolCall);
      }
    }
    if (event.audio) {
      for (const cb of this.audioCallbacks) cb(event.audio);
    }
    if (event.transcript) {
      this.emitRoleTranscript(event.transcript);
    }
  }

  private emitRoleTranscript(event: RealtimeTranscriptEvent): void {
    for (const cb of this.transcriptCallbacks) cb(event.text, event.final);
    for (const cb of this.roleTranscriptCallbacks) cb(event);
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WsCtor = require('ws').WebSocket as new (
    url: string,
    init: RealtimeWsInit,
  ) => RealtimeWsLike;
  return new WsCtor(url, init);
}
