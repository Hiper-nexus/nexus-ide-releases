import { VOICE_CHANNELS } from '../../shared/voice-channels';
import { getVoiceConfig } from './voice-config-store';
import { resolveVoiceApiKey } from './voice-secrets';
import { jarvisMemory } from './jarvis-memory';
import type { JarvisLiveSession } from './jarvis-live';
import {
  createRealtimeProvider,
  loadJarvisSystemPrompt,
  resolveRealtimeProviderId,
} from '../jarvis/realtime/factory';
import {
  base64ToInt16Array,
  int16ArrayToBase64,
  type TurnManagedRealtimeProvider,
} from '../jarvis/realtime/provider';
import { transcriptStore } from '../jarvis/transcript-store';
import { jarvisLatencyTracker } from '../jarvis/realtime/metrics';

type Emit = (channel: string, payload?: unknown) => void;

/**
 * Borda entre o IPC e o provider realtime: conecta o socket escolhido, roteia
 * mic→servidor e áudio/transcrição/barge-in→renderer + FSM. Quando o
 * transporte não está disponível (sem key, config classic), tudo isto é no-op
 * e o Jarvis Classic segue valendo — fallback nunca perde a intenção.
 */
export class LiveTransportController {
  private provider: TurnManagedRealtimeProvider | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private emit: Emit,
    private fsm: JarvisLiveSession,
  ) {}

  /** True quando a config pede o transporte realtime E há key. */
  isRealtimeConfigured(): boolean {
    const providerId = resolveRealtimeProviderId(getVoiceConfig());
    if (providerId === 'openai') return resolveVoiceApiKey('OPENAI_API_KEY') !== undefined;
    if (providerId === 'gemini') return resolveVoiceApiKey('GEMINI_API_KEY') !== undefined;
    return false;
  }

  /** Chamado no start() do live: conecta o socket se o realtime estiver ligado. */
  onStart(): void {
    if (!this.isRealtimeConfigured()) {
      this.patchRealtimeReady(false);
      return;
    }
    if (this.provider?.isReady) {
      this.fsm.patchStatus({ status: 'listening', realtimeReady: true });
      return;
    }
    this.provider?.close();
    this.provider = createRealtimeProvider({
      config: getVoiceConfig(),
      instructions: this.buildSystemInstruction(),
    });
    if (!this.provider) {
      this.patchRealtimeReady(false);
      return;
    }
    this.bindProvider(this.provider);
    this.fsm.patchStatus({ status: 'listening', realtimeReady: false });
    this.connecting = this.provider
      .connect()
      .then(() => {
        this.fsm.patchStatus({ status: 'listening', realtimeReady: true });
      })
      .catch((err) => {
        console.warn('[live]', err instanceof Error ? err.message : String(err));
        this.provider?.close();
        this.provider = null;
        this.fsm.patchStatus({
          status: 'error',
          realtimeReady: false,
          error: 'transporte realtime falhou — usando Classic',
        });
      });
  }

  async smokeTest(text: string): Promise<ReturnType<JarvisLiveSession['getState']>> {
    if (!this.fsm.getState().sessionId) this.fsm.start({ reason: 'manual' });
    this.onStart();
    if (this.connecting) await this.connecting;
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
    this.provider?.close();
    this.provider = null;
    this.connecting = null;
    this.patchRealtimeReady(false);
  }

  private bindProvider(provider: TurnManagedRealtimeProvider): void {
    provider.onAudioOut((pcm16) => {
      const sessionId = this.fsm.getState().sessionId;
      if (sessionId) jarvisLatencyTracker.markAudioOut(sessionId);
      this.fsm.patchStatus({ status: 'speaking', realtimeReady: true });
      this.emit(VOICE_CHANNELS.liveAudioOut, int16ArrayToBase64(pcm16));
    });
    provider.onRoleTranscript((line) => {
      if (!line.text.trim()) return;
      const event = this.fsm.transcript(line);
      if (!event) return;
      jarvisLatencyTracker.markTranscript(event.sessionId, line.final);
      const record = transcriptStore.append(event.sessionId, {
        role: line.role,
        text: line.text,
        final: line.final,
        audio_url: null,
      });
      this.emit(VOICE_CHANNELS.jarvisTranscriptAppend, {
        sessionId: event.sessionId,
        ...record,
      });
    });
    provider.onInterrupted(() => {
      this.fsm.interrupt('barge-in');
    });
    provider.onResponseDone(() => {
      const sessionId = this.fsm.getState().sessionId;
      if (sessionId) jarvisLatencyTracker.markResponseDone(sessionId);
      this.fsm.patchStatus({ status: 'dormant', realtimeReady: true });
    });
    provider.onError((err) => {
      console.warn('[live]', err.message);
      this.fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: err.message,
      });
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
}
