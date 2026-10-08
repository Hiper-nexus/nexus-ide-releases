import {
  GeminiLiveTransport,
  type LiveTransportDeps,
} from '../../voice/gemini-live-transport';
import {
  base64ToInt16Array,
  int16ArrayToBase64,
  type RealtimeToolCallEvent,
  type RealtimeTranscriptEvent,
  type TurnManagedRealtimeProvider,
} from './provider';
import type { GeminiFunctionDeclaration } from './coarse-voice-tools';

export interface GeminiLiveProviderOptions {
  apiKey: string;
  model: string;
  voiceName: string;
  instructions: string;
  tools?: GeminiFunctionDeclaration[];
  resumeHandle?: string;
  onResumptionHandle?(handle: string | undefined): void;
  deps?: LiveTransportDeps;
}

const CONNECT_TIMEOUT_MS = 10_000;

export class GeminiLiveProvider implements TurnManagedRealtimeProvider {
  /** Gemini 3.1 maps realtimeInput.text to user activity; it is not silent. */
  readonly supportsPassiveContextUpdates = false;
  private transport: GeminiLiveTransport | null = null;
  private transcriptCallbacks: Array<(delta: string, final: boolean) => void> = [];
  private roleTranscriptCallbacks: Array<(event: RealtimeTranscriptEvent) => void> = [];
  private audioCallbacks: Array<(pcm16: Int16Array) => void> = [];
  private errorCallbacks: Array<(err: Error) => void> = [];
  private interruptedCallbacks: Array<() => void> = [];
  private responseDoneCallbacks: Array<() => void> = [];
  private disconnectedCallbacks: Array<(err: Error) => void> = [];
  private toolCallCallbacks: Array<(event: RealtimeToolCallEvent) => void> = [];
  private toolCallCancelledCallbacks: Array<(callId: string) => void> = [];
  private pendingCallNames = new Map<string, string>();
  private closing = false;

  private readonly deps: LiveTransportDeps;

  constructor(private readonly options: GeminiLiveProviderOptions) {
    this.deps = options.deps ?? defaultGeminiDeps();
  }

  get isReady(): boolean {
    return this.transport?.isReady === true;
  }

  connect(): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      let settled = false;
      let didReachReady = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.deps.clearTimeoutFn(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = this.deps.setTimeoutFn(() => {
        settle(new Error('Gemini Live setup timeout'));
      }, CONNECT_TIMEOUT_MS);

      const transport = new GeminiLiveTransport(
        {
          onAudioOut: (b64) => this.emitAudioOut(base64ToInt16Array(b64)),
          onTranscript: (role, text, final, turnId) =>
            this.emitRoleTranscript({ role, text, final, turnId }),
          onToolCall: (call) => this.emitToolCall(call),
          onToolCallCancelled: (callId) => this.emitToolCallCancelled(callId),
          onResumptionHandle: (handle) => this.options.onResumptionHandle?.(handle),
          onInterrupted: () => {
            for (const cb of this.interruptedCallbacks) cb();
          },
          onTurnComplete: () => {
            for (const cb of this.responseDoneCallbacks) cb();
          },
          onStateChange: (state) => {
            if (state === 'ready') {
              didReachReady = true;
              settle();
              return;
            }
            if (state === 'error') {
              if (this.options.resumeHandle) {
                this.options.onResumptionHandle?.(undefined);
              }
              settle(new Error('Gemini Live setup failed'));
              return;
            }
            if (state === 'closed' && !didReachReady) {
              settle(new Error('Gemini Live socket closed before setup'));
              return;
            }
            if (state === 'closed' && !this.closing) {
              this.emitDisconnected(new Error('Gemini Live socket closed'));
            }
          },
          onError: (message) => {
            const err = new Error(message);
            this.emitError(err);
            settle(err);
          },
        },
        this.deps,
      );
      this.transport = transport;
      transport.connect({
        apiKey: this.options.apiKey,
        model: this.options.model,
        voiceName: this.options.voiceName,
        systemInstruction: this.options.instructions,
        tools: this.options.tools,
        resumeHandle: this.options.resumeHandle,
      });
    });
  }

  sendAudioChunk(pcm16: Int16Array): void {
    if (pcm16.length === 0) return;
    this.transport?.sendMicChunk(int16ArrayToBase64(pcm16));
  }

  beginUserTurn(turnId: string): void {
    this.transport?.beginUserTurn(turnId);
  }

  onTranscript(cb: (delta: string, final: boolean) => void): void {
    this.transcriptCallbacks.push(cb);
  }

  onRoleTranscript(cb: (event: RealtimeTranscriptEvent) => void): void {
    this.roleTranscriptCallbacks.push(cb);
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
    this.transport?.interrupt();
  }

  close(): void {
    this.closing = true;
    this.transport?.disconnect();
    this.closing = false;
    this.transport = null;
    this.pendingCallNames.clear();
  }

  endUserTurn(): void {
    this.transport?.endUserTurn();
  }

  sendContext(_text: string): void {
    // Gemini 3.1 has no passive mid-session context channel:
    // realtimeInput.text is user activity and may trigger/interleave a turn.
    // The controller keeps fresh state for consultar/ler and seeds the initial
    // snapshot in the setup instruction instead.
  }

  sendScreenUpdate(_text: string): void {
    // See sendContext. Screen telemetry remains in the controller until a
    // read-only voice tool asks for the current state.
  }

  sendText(text: string): void {
    this.transport?.sendTextTurn(text);
  }

  sendToolResult(callId: string, output: unknown): void {
    const name = this.pendingCallNames.get(callId) ?? '';
    this.pendingCallNames.delete(callId);
    this.transport?.sendToolResult(callId, name, output);
  }

  sendNamedToolResult(callId: string, name: string, output: unknown): void {
    this.pendingCallNames.delete(callId);
    // The app-level registry is authoritative across socket generations. A
    // resumed server session may still await this call even though the new
    // transport has not replayed its toolCall locally.
    this.transport?.sendToolResult(callId, name, output, {
      allowResumedCall: true,
    });
  }

  onToolCall(cb: (event: RealtimeToolCallEvent) => void): void {
    this.toolCallCallbacks.push(cb);
  }

  onToolCallCancelled(cb: (callId: string) => void): void {
    this.toolCallCancelledCallbacks.push(cb);
  }

  private emitToolCall(call: { id: string; name: string; args: Record<string, unknown> }): void {
    if (call.id) this.pendingCallNames.set(call.id, call.name);
    const event: RealtimeToolCallEvent = {
      callId: call.id,
      name: call.name,
      argumentsJson: JSON.stringify(call.args ?? {}),
      arguments: call.args ?? {},
    };
    for (const cb of this.toolCallCallbacks) cb(event);
  }

  private emitToolCallCancelled(callId: string): void {
    this.pendingCallNames.delete(callId);
    for (const cb of this.toolCallCancelledCallbacks) cb(callId);
  }

  private emitAudioOut(pcm16: Int16Array): void {
    for (const cb of this.audioCallbacks) cb(pcm16);
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

function defaultGeminiDeps(): LiveTransportDeps {
  return {
    wsFactory: (url) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- ws só carrega no connect real (os testes injetam wsFactory); a anotação tipa só a superfície usada
      const WsCtor = require('ws').WebSocket as new (url: string) => {
        readyState: number;
        send(data: string): void;
        close(): void;
        on(
          event: 'open' | 'message' | 'close' | 'error',
          cb: (payload?: unknown) => void,
        ): void;
      };
      const ws = new WsCtor(url);
      return {
        get readyState() {
          return ws.readyState;
        },
        send: (data: string) => ws.send(data),
        close: () => ws.close(),
        on: (event, cb) => ws.on(event, cb),
      };
    },
    now: Date.now,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  };
}
