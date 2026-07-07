import { VOICE_CHANNELS } from '../../shared/voice-channels';
import { getVoiceConfig } from './voice-config-store';
import { resolveVoiceApiKey } from './voice-secrets';
import { jarvisMemory } from './jarvis-memory';
import type { JarvisLiveSession } from './jarvis-live';
import {
  createRealtimeProviderCandidates,
  loadJarvisSystemPrompt,
  resolveRealtimeProviderIds,
  type RealtimeProviderCandidate,
} from '../jarvis/realtime/factory';
import {
  base64ToInt16Array,
  int16ArrayToBase64,
  type TurnManagedRealtimeProvider,
} from '../jarvis/realtime/provider';
import { jarvisLatencyTracker } from '../jarvis/realtime/metrics';

type Emit = (channel: string, payload?: unknown) => void;
const RUNTIME_RECONNECT_BASE_MS = 750;
const RUNTIME_RECONNECT_MAX_ATTEMPTS = 3;

/**
 * Borda entre o IPC e o provider realtime: conecta o socket escolhido, roteia
 * mic→servidor e áudio/transcrição/barge-in→renderer + FSM. Quando o
 * transporte não está disponível (sem key, config classic), tudo isto é no-op
 * e o Jarvis Classic segue valendo — fallback nunca perde a intenção.
 */
export class LiveTransportController {
  private provider: TurnManagedRealtimeProvider | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectGeneration = 0;

  constructor(
    private emit: Emit,
    private fsm: JarvisLiveSession,
  ) {}

  /** True quando a config pede o transporte realtime E há key. */
  isRealtimeConfigured(): boolean {
    return resolveRealtimeProviderIds(getVoiceConfig()).some((providerId) => {
      const envVar = providerId === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
      return resolveVoiceApiKey(envVar) !== undefined;
    });
  }

  /** Chamado no start() do live: conecta o socket se o realtime estiver ligado. */
  onStart(): Promise<void> {
    this.clearReconnectTimer();
    if (!this.isRealtimeConfigured()) {
      this.patchRealtimeReady(false);
      return Promise.resolve();
    }
    if (this.provider?.isReady) {
      this.fsm.patchStatus({ status: 'listening', realtimeReady: true });
      return Promise.resolve();
    }
    if (this.connecting) return this.connecting;
    const candidates = createRealtimeProviderCandidates({
      config: getVoiceConfig(),
      instructions: this.buildSystemInstruction(),
    });
    if (candidates.length === 0) {
      this.patchRealtimeReady(false);
      return Promise.resolve();
    }
    this.fsm.patchStatus({ status: 'listening', realtimeReady: false });
    const connecting = this.connectFirstAvailable(candidates)
      .finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
    this.connecting = connecting;
    return connecting;
  }

  async smokeTest(text: string): Promise<ReturnType<JarvisLiveSession['getState']>> {
    if (!this.fsm.getState().sessionId) this.fsm.start({ reason: 'manual' });
    await this.onStart();
    if (this.provider?.isReady) {
      this.provider.sendText(text);
      this.fsm.patchStatus({ status: 'thinking', realtimeReady: true });
    }
    return this.fsm.getState();
  }

  micIn(b64: string): void {
    if (!this.provider) return;
    const sessionId = this.fsm.getState().sessionId;
    if (sessionId) jarvisLatencyTracker.markAudioIn(sessionId);
    try {
      this.provider.sendAudioChunk(base64ToInt16Array(b64));
    } catch (err) {
      this.fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  contextIn(text: string): void {
    this.provider?.sendContext(text);
  }

  endTurn(): void {
    this.provider?.endUserTurn();
  }

  interrupt(reason: string): ReturnType<JarvisLiveSession['interrupt']> {
    this.provider?.interrupt();
    return this.fsm.interrupt(reason);
  }

  onStop(): void {
    this.clearReconnectTimer();
    this.provider?.close();
    this.provider = null;
    this.connecting = null;
    this.patchRealtimeReady(false);
  }

  private async connectFirstAvailable(
    candidates: RealtimeProviderCandidate[],
  ): Promise<void> {
    this.provider?.close();
    this.provider = null;
    for (const candidate of candidates) {
      const provider = candidate.provider;
      this.provider = provider;
      this.bindProvider(provider);
      try {
        await provider.connect();
        if (this.provider === provider) {
          this.reconnectAttempt = 0;
          this.fsm.patchStatus({ status: 'listening', realtimeReady: true });
        }
        return;
      } catch (err) {
        console.warn(
          `[live] ${candidate.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        provider.close();
        if (this.provider === provider) this.provider = null;
      }
    }
    this.fsm.patchStatus({
      status: 'error',
      realtimeReady: false,
      error: 'transporte realtime falhou — usando Classic',
    });
  }

  private bindProvider(provider: TurnManagedRealtimeProvider): void {
    provider.onAudioOut((pcm16) => {
      if (this.provider !== provider) return;
      const sessionId = this.fsm.getState().sessionId;
      if (sessionId) jarvisLatencyTracker.markAudioOut(sessionId);
      this.fsm.patchStatus({ status: 'speaking', realtimeReady: true });
      this.emit(VOICE_CHANNELS.liveAudioOut, int16ArrayToBase64(pcm16));
    });
    provider.onRoleTranscript((line) => {
      if (this.provider !== provider) return;
      if (!line.text.trim()) return;
      const event = this.fsm.transcript(line);
      if (!event) return;
    });
    provider.onInterrupted(() => {
      if (this.provider !== provider) return;
      this.fsm.interrupt('barge-in');
    });
    provider.onResponseDone(() => {
      if (this.provider !== provider) return;
      const sessionId = this.fsm.getState().sessionId;
      if (sessionId) jarvisLatencyTracker.markResponseDone(sessionId);
      this.fsm.patchStatus({ status: 'dormant', realtimeReady: true });
    });
    provider.onError((err) => {
      if (this.provider !== provider) return;
      console.warn('[live]', err.message);
      this.fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: err.message,
      });
    });
    provider.onDisconnected((err) => {
      if (this.provider !== provider) return;
      console.warn('[live]', err.message);
      provider.close();
      if (this.provider === provider) this.provider = null;
      this.fsm.patchStatus({
        status: 'listening',
        realtimeReady: false,
        error: err.message,
      });
      this.scheduleReconnect();
    });
  }

  private buildSystemInstruction(): string {
    const config = getVoiceConfig();
    const persona = config.persona;
    const parts = [loadJarvisSystemPrompt()];
    if (persona.assistantName?.trim()) {
      parts.push(`Assistant name: ${persona.assistantName.trim()}.`);
    }
    if (persona.userName?.trim()) {
      parts.push(`User name: ${persona.userName.trim()}.`);
    }
    if (persona.customInstructions?.trim()) {
      parts.push(`User custom instructions:\n${persona.customInstructions.trim()}`);
    }
    const memory = jarvisMemory.factsBlock();
    if (memory.trim()) parts.push(`Long-term memory:\n${memory.trim()}`);
    return parts.join('\n\n');
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

  private scheduleReconnect(): void {
    const state = this.fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    if (this.reconnectAttempt >= RUNTIME_RECONNECT_MAX_ATTEMPTS) return;
    this.reconnectAttempt += 1;
    this.clearReconnectTimer();
    const generation = this.reconnectGeneration;
    const delay = RUNTIME_RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.reconnectGeneration) return;
      const latest = this.fsm.getState();
      if (!latest.enabled || !latest.sessionId) return;
      void this.onStart()
        .then(() => {
          if (!this.provider?.isReady) this.scheduleReconnect();
        })
        .catch((err) => {
          console.warn('[live] reconnect failed', err);
          this.scheduleReconnect();
        });
    }, delay);
  }

  private clearReconnectTimer(): void {
    this.reconnectGeneration += 1;
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
