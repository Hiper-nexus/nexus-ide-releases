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

export interface GeminiLiveProviderOptions {
  apiKey: string;
  model: string;
  voiceName: string;
  instructions: string;
  deps?: LiveTransportDeps;
}

const CONNECT_TIMEOUT_MS = 10_000;

export class GeminiLiveProvider implements TurnManagedRealtimeProvider {
  private transport: GeminiLiveTransport | null = null;
  private transcriptCallbacks: Array<(delta: string, final: boolean) => void> = [];
  private roleTranscriptCallbacks: Array<(event: RealtimeTranscriptEvent) => void> = [];
  private audioCallbacks: Array<(pcm16: Int16Array) => void> = [];
  private errorCallbacks: Array<(err: Error) => void> = [];
  private interruptedCallbacks: Array<() => void> = [];
  private responseDoneCallbacks: Array<() => void> = [];
  private disconnectedCallbacks: Array<(err: Error) => void> = [];
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
          onTranscript: (role, text, final) =>
            this.emitRoleTranscript({ role, text, final }),
          onInterrupted: () => {
            for (const cb of this.interruptedCallbacks) cb();
          },
          onTurnComplete: () => {
            for (const cb of this.responseDoneCallbacks) cb();
          },
          onStateChange: (state) => {
            if (state === 'ready') settle();
            if (state === 'error') settle(new Error('Gemini Live setup failed'));
            if (state === 'closed' && !settled) {
              settle(new Error('Gemini Live socket closed before setup'));
            }
            if (state === 'closed' && settled && !this.closing) {
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
      });
    });
  }

  sendAudioChunk(pcm16: Int16Array): void {
    if (pcm16.length === 0) return;
    this.transport?.sendMicChunk(int16ArrayToBase64(pcm16));
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

  interrupt(): void {}

  close(): void {
    this.closing = true;
    this.transport?.disconnect();
    this.closing = false;
    this.transport = null;
  }

  endUserTurn(): void {
    this.transport?.endUserTurn();
  }

  sendContext(text: string): void {
    this.transport?.sendContext(text);
  }

  sendText(text: string): void {
    this.transport?.sendTextTurn(text);
  }

  sendToolResult(_callId: string, _output: unknown): void {}

  onToolCall(_cb: (event: RealtimeToolCallEvent) => void): void {}

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
      // eslint-disable-next-line @typescript-eslint/no-var-requires
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
