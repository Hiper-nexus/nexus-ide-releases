import type {
  JarvisLiveSmokeFailureReason,
  RealtimeFailure,
} from '../../shared/voice-ipc';
import { ThrottledCounter } from '../../shared/live-flow-counter';
import { isLikelyNoiseTranscript } from '../../shared/voice-noise';
import { jarvisLatencyTracker } from '../jarvis/realtime/metrics';
import type { RealtimeProviderCandidate } from '../jarvis/realtime/factory';
import type {
  RealtimeToolCallEvent,
  TurnManagedRealtimeProvider,
} from '../jarvis/realtime/provider';
import { echoSuppressor } from './echo-suppress';
import type { JarvisLiveSession } from './jarvis-live';
import type { LiveToolCallCoordinator } from './live-tool-call-registry';
import {
  buildRealtimeFailure,
  classifyRealtimeConnectError,
  isIgnorableRealtimeError,
} from './live-transport-helpers';
import { logVoice } from './voice-log';

export interface LiveProviderRuntimeHost {
  fsm: JarvisLiveSession;
  toolCalls: LiveToolCallCoordinator;
  now(): number;
  emitLiveAudio(pcm16: Int16Array): void;
  micFramesCounter: ThrottledCounter;
  serverAudioCounter: ThrottledCounter;
  getProvider(): TurnManagedRealtimeProvider | null;
  setProvider(provider: TurnManagedRealtimeProvider | null): void;
  getActiveTurnId(): string | undefined;
  setProviderSpeaking(speaking: boolean): void;
  setLastUserTranscript(text: string): void;
  abandonPendingConversationTurn(): void;
  settleSmokeResponseDone(): void;
  settleSmokeFailure(reason: JarvisLiveSmokeFailureReason): void;
  /** Emits a renderer event only when a completed provider response follows a tool result. */
  onProviderResponseDone?(): void;
  recordLiveHistory(role: 'user' | 'assistant', text: string): void;
  touchIdle(): void;
  routePendingAnswer(text: string): void;
  clearReconnectStabilityTimer(): void;
  scheduleReconnect(): void;
  handleToolCall(call: RealtimeToolCallEvent): void;
  armReconnectStability(provider: TurnManagedRealtimeProvider): void;
  sendProviderContext(): void;
  hasLiveHistory(): boolean;
  injectResumeContext(): void;
  sendGreetingIfSafe(
    provider: TurnManagedRealtimeProvider,
    greeting: string | undefined,
  ): void;
  flushPendingMic(provider: TurnManagedRealtimeProvider): void;
  startQuestionPoll(): void;
  clearPendingMic(): void;
}

export async function connectFirstLiveProvider(
  candidates: RealtimeProviderCandidate[],
  greeting: string | undefined,
  host: LiveProviderRuntimeHost,
): Promise<void> {
  host.getProvider()?.close();
  host.setProvider(null);
  const attempts: RealtimeFailure[] = [];
  for (const candidate of candidates) {
    if (await tryConnectCandidate(candidate, greeting, host, attempts)) return;
  }
  // Toda a cadeia caiu. O motivo vai no estado (traduzido para a pessoa) e não
  // num console.warn: era exatamente esse silêncio que deixava o chip
  // "Grok Voice conectando" parado sem explicação nenhuma.
  const last = attempts[attempts.length - 1];
  host.fsm.patchStatus({
    status: 'error',
    realtimeReady: false,
    error: 'transporte realtime falhou — usando Classic',
    realtimeFailure: last
      ? { ...last, attempts: attempts.length }
      : buildRealtimeFailure('no_key', null, host.now()),
  });
  host.clearPendingMic();
}

async function tryConnectCandidate(
  candidate: RealtimeProviderCandidate,
  greeting: string | undefined,
  host: LiveProviderRuntimeHost,
  attempts: RealtimeFailure[],
): Promise<boolean> {
  const provider = candidate.provider;
  host.setProvider(provider);
  bindLiveProvider(provider, host);
  const activeTurnId = host.getActiveTurnId();
  if (activeTurnId) provider.beginUserTurn?.(activeTurnId);
  try {
    await provider.connect();
    activateConnectedProvider(candidate, provider, greeting, host);
    return true;
  } catch (err) {
    const { category, status } = classifyRealtimeConnectError(err);
    const failure = buildRealtimeFailure(category, candidate.id, host.now(), {
      model: candidate.model,
      status,
    });
    attempts.push(failure);
    // Só categoria/modelo/status entram no log — o texto do provedor pode
    // carregar payload e a chave nunca sai daqui.
    logVoice('warn', 'live.candidateFailed', 'rota realtime falhou; tentando a próxima', {
      provider: candidate.id,
      model: candidate.model ?? null,
      category,
      status: status ?? null,
    });
    // A falha sobe AGORA, não só no fim da cadeia: enquanto a próxima rota
    // tenta, o chip precisa dizer o que já caiu. Sem isso a degradação
    // reconecta e a pessoa volta a ver "conectando" sem explicação nenhuma.
    const currentStatus = host.fsm.getState().status;
    if (currentStatus !== 'off') {
      host.fsm.patchStatus({
        status: currentStatus,
        realtimeFailure: failure,
      });
    }
    provider.close();
    if (host.getProvider() === provider) host.setProvider(null);
    return false;
  }
}

function activateConnectedProvider(
  candidate: RealtimeProviderCandidate,
  provider: TurnManagedRealtimeProvider,
  greeting: string | undefined,
  host: LiveProviderRuntimeHost,
): void {
  if (host.getProvider() !== provider) return;
  const activeTurnId = host.getActiveTurnId();
  if (activeTurnId) provider.beginUserTurn?.(activeTurnId);
  host.armReconnectStability(provider);
  host.sendProviderContext();
  if (host.hasLiveHistory() && provider.supportsPassiveContextUpdates !== false) {
    host.injectResumeContext();
  }
  host.sendGreetingIfSafe(provider, greeting);
  host.flushPendingMic(provider);
  host.startQuestionPoll();
  // Sucesso limpa a falha: só agora a pessoa pode ver "online", e o provedor
  // registrado é o que conectou DE FATO (pode ter sido a degradação, não a
  // rota configurada).
  host.fsm.patchStatus({
    status: 'listening',
    realtimeReady: true,
    realtimeFailure: null,
    realtimeProvider: candidate.id,
  });
  logVoice('info', 'live.providerConnected', 'transporte realtime conectado', {
    provider: candidate.id,
    model: candidate.model ?? null,
  });
}

export function bindLiveProvider(
  provider: TurnManagedRealtimeProvider,
  host: LiveProviderRuntimeHost,
): void {
  bindAudioOutput(provider, host);
  bindTranscripts(provider, host);
  bindResponseLifecycle(provider, host);
  bindFailureLifecycle(provider, host);
  bindToolCalls(provider, host);
}

function bindAudioOutput(
  provider: TurnManagedRealtimeProvider,
  host: LiveProviderRuntimeHost,
): void {
  provider.onAudioOut((pcm16) => {
    if (host.getProvider() !== provider) return;
    const sessionId = host.fsm.getState().sessionId;
    if (sessionId) {
      jarvisLatencyTracker.markAudioOut(sessionId, host.getActiveTurnId());
    }
    const audioTick = host.serverAudioCounter.tick(host.now());
    if (audioTick.fire) {
      logVoice('info', 'live.serverAudioChunk', 'áudio do servidor recebido', {
        chunks: audioTick.count,
        micFramesSent: host.micFramesCounter.total,
      });
    }
    host.setProviderSpeaking(true);
    host.fsm.patchStatus({ status: 'speaking', realtimeReady: true });
    host.emitLiveAudio(pcm16);
  });
}

function bindTranscripts(
  provider: TurnManagedRealtimeProvider,
  host: LiveProviderRuntimeHost,
): void {
  // Gemini may emit a function call before it marks input transcription final.
  // Keep the accumulated user deltas as current-turn authority so action gates
  // never consult the previous wake transcript during that ordering window.
  let pendingUserTranscript = '';
  provider.onRoleTranscript((line) => {
    if (host.getProvider() !== provider) return;
    const activeTurnId = host.getActiveTurnId();
    if (line.turnId && activeTurnId && line.turnId !== activeTurnId) {
      logVoice('info', 'live.staleTranscriptDiscarded', 'transcript de turno antigo descartado', {
        turnId: line.turnId,
        activeTurnId,
        role: line.role,
      });
      return;
    }
    if (!line.text.trim()) return;
    if (line.role === 'user' && !line.final) {
      pendingUserTranscript += line.text;
      const evidence = pendingUserTranscript.trim();
      if (evidence) host.setLastUserTranscript(evidence);
    }
    if (line.role === 'assistant') echoSuppressor.record(line.text);
    if (line.role === 'user' && line.final && echoSuppressor.isEcho(line.text)) {
      logVoice('info', 'live.inputEchoDiscarded', 'eco do TTS/ack descartado (live)', {
        chars: line.text.length,
      });
      return;
    }
    if (line.role === 'user' && line.final && isLikelyNoiseTranscript(line.text)) {
      logVoice('info', 'live.noiseDiscarded', 'transcript live ruído/ambiente descartado', {
        chars: line.text.length,
      });
      return;
    }
    const event = host.fsm.transcript(line);
    if (!event) return;
    if (line.final) {
      host.recordLiveHistory(line.role, line.text.trim());
      host.touchIdle();
    }
    if (line.role === 'user' && line.final) {
      const text = line.text.trim();
      pendingUserTranscript = '';
      host.setLastUserTranscript(text);
      host.routePendingAnswer(text);
    }
  });
}

function bindResponseLifecycle(
  provider: TurnManagedRealtimeProvider,
  host: LiveProviderRuntimeHost,
): void {
  provider.onInterrupted(() => {
    if (host.getProvider() !== provider) return;
    host.setProviderSpeaking(false);
    host.abandonPendingConversationTurn();
    host.fsm.interrupt('barge-in');
  });
  provider.onResponseDone(() => {
    if (host.getProvider() !== provider) return;
    host.settleSmokeResponseDone();
    host.setProviderSpeaking(false);
    const sessionId = host.fsm.getState().sessionId;
    if (sessionId) {
      jarvisLatencyTracker.markResponseDone(sessionId, host.getActiveTurnId());
    }
    host.fsm.patchStatus({ status: 'dormant', realtimeReady: true });
    host.onProviderResponseDone?.();
  });
}

function bindFailureLifecycle(
  provider: TurnManagedRealtimeProvider,
  host: LiveProviderRuntimeHost,
): void {
  provider.onError((err) => {
    if (host.getProvider() !== provider) return;
    if (isIgnorableRealtimeError(err.message)) {
      console.log('[live] realtime cancel ignorado:', err.message);
      return;
    }
    host.settleSmokeFailure('provider_error');
    console.warn('[live]', err.message);
    host.fsm.patchStatus({
      status: 'error',
      realtimeReady: false,
      error: err.message,
    });
  });
  provider.onDisconnected((err) => {
    if (host.getProvider() !== provider) return;
    host.settleSmokeFailure('provider_error');
    host.setProviderSpeaking(false);
    host.clearReconnectStabilityTimer();
    console.warn('[live]', err.message);
    provider.close();
    if (host.getProvider() === provider) host.setProvider(null);
    host.fsm.patchStatus({
      status: 'listening',
      realtimeReady: false,
      error: err.message,
    });
    host.scheduleReconnect();
  });
}

function bindToolCalls(
  provider: TurnManagedRealtimeProvider,
  host: LiveProviderRuntimeHost,
): void {
  provider.onToolCall((call) => {
    if (host.getProvider() !== provider) return;
    if (!host.toolCalls.claim(call)) return;
    host.handleToolCall(call);
  });
  provider.onToolCallCancelled?.((callId) => {
    if (host.getProvider() !== provider) return;
    host.toolCalls.cancel(
      callId,
      'provider_cancelled',
      'provider cancelou a chamada antes da conclusão local',
    );
  });
}
