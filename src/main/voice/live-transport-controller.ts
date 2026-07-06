import { VOICE_CHANNELS } from '../../shared/voice-channels';
import { getVoiceConfig } from './voice-config-store';
import { resolveVoiceApiKey } from './voice-secrets';
import { jarvisMemory } from './jarvis-memory';
import { buildLiveSystemInstruction } from './jarvis-live-prompt';
import {
  GeminiLiveTransport,
  type LiveTransportDeps,
  type WsLike,
} from './gemini-live-transport';
import type { JarvisLiveSession } from './jarvis-live';

type Emit = (channel: string, payload?: unknown) => void;

/**
 * Borda entre o IPC e o transporte realtime: decide se a sessão live usa o
 * Gemini Live (áudio full-duplex) e, quando usa, conecta o socket, roteia
 * mic→servidor e áudio/transcrição/barge-in→renderer + FSM. Quando o
 * transporte não está disponível (sem key, config classic), tudo isto é
 * no-op e o Jarvis Classic segue valendo — fallback nunca perde a intenção.
 */
export class LiveTransportController {
  private transport: GeminiLiveTransport | null = null;

  constructor(
    private emit: Emit,
    private fsm: JarvisLiveSession,
    private deps?: Partial<LiveTransportDeps>,
  ) {}

  /** True quando a config pede o transporte realtime E há key. */
  isRealtimeConfigured(): boolean {
    const live = getVoiceConfig().jarvisLive;
    return (
      live.transport === 'gemini-live' &&
      resolveVoiceApiKey('GEMINI_API_KEY') !== undefined
    );
  }

  /** Chamado no start() do live: conecta o socket se o realtime estiver ligado. */
  onStart(): void {
    if (!this.isRealtimeConfigured()) {
      this.patchRealtimeReady(false);
      return;
    }
    const key = resolveVoiceApiKey('GEMINI_API_KEY');
    if (!key) {
      this.patchRealtimeReady(false);
      return;
    }
    if (this.transport?.isReady) {
      this.fsm.patchStatus({ status: 'listening', realtimeReady: true });
      return;
    }
    const live = getVoiceConfig().jarvisLive;
    const persona = getVoiceConfig().persona;
    const systemInstruction = buildLiveSystemInstruction(
      persona,
      jarvisMemory.factsBlock(),
    );
    this.transport ??= new GeminiLiveTransport(
      {
        onAudioOut: (b64) => this.emit(VOICE_CHANNELS.liveAudioOut, b64),
        onTranscript: (role, text, final) =>
          this.fsm.transcript({ role, text, final }),
        onInterrupted: () => this.fsm.interrupt('barge-in'),
        onStateChange: (state) => {
          if (state === 'connecting') {
            this.fsm.patchStatus({ status: 'listening', realtimeReady: false });
          } else if (state === 'ready') {
            this.fsm.patchStatus({ status: 'listening', realtimeReady: true });
          } else if (state === 'closed') {
            this.patchRealtimeReady(false);
          } else if (state === 'error') {
            this.fsm.patchStatus({
              status: 'error',
              realtimeReady: false,
              error: 'transporte realtime falhou — usando Classic',
            });
          }
        },
        onError: (msg) => console.warn('[live]', msg),
      },
      {
        wsFactory: (url) => defaultWsFactory(url),
        now: Date.now,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
        ...this.deps,
      },
    );
    this.transport.connect({
      apiKey: key,
      model: live.liveModel,
      voiceName: live.voiceName,
      systemInstruction,
    });
  }

  micIn(b64: string): void {
    this.transport?.sendMicChunk(b64);
  }

  contextIn(text: string): void {
    this.transport?.sendContext(text);
  }

  endTurn(): void {
    this.transport?.endUserTurn();
  }

  onStop(): void {
    this.transport?.disconnect();
    this.transport = null;
    this.patchRealtimeReady(false);
  }

  private patchRealtimeReady(realtimeReady: boolean): void {
    const state = this.fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    this.fsm.patchStatus({
      status: state.status === 'off' ? 'dormant' : state.status,
      realtimeReady,
      error: realtimeReady ? undefined : state.error,
    });
  }
}

function defaultWsFactory(url: string): WsLike {
  // Lazy require: 'ws' é dep de main; manter fora do topo preserva os módulos
  // testáveis (o teste injeta um wsFactory fake).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WsCtor = require('ws').WebSocket as new (url: string) => {
    readyState: number;
    send(data: string): void;
    close(): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
  };
  const socket = new WsCtor(url);
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data: string) => socket.send(data),
    close: () => socket.close(),
    on: (event, cb) => {
      socket.on(event, cb as (...args: unknown[]) => void);
    },
  };
}
