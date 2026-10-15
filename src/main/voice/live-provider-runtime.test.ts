import { describe, expect, it, vi } from 'vitest';
import { ThrottledCounter } from '../../shared/live-flow-counter';
import { JarvisLiveSession } from './jarvis-live';
import {
  connectFirstLiveProvider,
  type LiveProviderRuntimeHost,
} from './live-provider-runtime';
import type { RealtimeProviderCandidate } from '../jarvis/realtime/factory';
import type { TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';

/**
 * O runtime do realtime é onde a falha vivia invisível: um `console.warn` e
 * nada no estado. Aqui a prova é que a falha SOBE para o estado do Live, com
 * categoria, e que um patch de status posterior não a apaga.
 */

function fakeCandidate(
  id: 'grok' | 'openai' | 'gemini',
  connect: () => Promise<void>,
  model?: string,
): RealtimeProviderCandidate {
  const provider = {
    isReady: true,
    connect: vi.fn(connect),
    close: vi.fn(),
    beginUserTurn: vi.fn(),
    sendAudioChunk: vi.fn(),
    onTranscript: vi.fn(),
    onRoleTranscript: vi.fn(),
    onAudioOut: vi.fn(),
    onInterrupted: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
    onResponseDone: vi.fn(),
    onToolCall: vi.fn(),
    onToolCallCancelled: vi.fn(),
    sendText: vi.fn(),
    sendContext: vi.fn(),
  } as unknown as TurnManagedRealtimeProvider;
  const candidate: RealtimeProviderCandidate = { id, provider };
  if (model) candidate.model = model;
  return candidate;
}

function hostFor(
  session: JarvisLiveSession,
): LiveProviderRuntimeHost & { invalidateAttempts(): void } {
  let provider: TurnManagedRealtimeProvider | null = null;
  let generation = 0;
  return {
    fsm: session,
    toolCalls: {} as LiveProviderRuntimeHost['toolCalls'],
    now: () => 1_700_000_000_000,
    emitLiveAudio: vi.fn(),
    micFramesCounter: new ThrottledCounter(25, 2_000),
    serverAudioCounter: new ThrottledCounter(25, 2_000),
    getProvider: () => provider,
    setProvider: (next) => {
      provider = next;
    },
    getActiveTurnId: () => undefined,
    setProviderSpeaking: vi.fn(),
    setLastUserTranscript: vi.fn(),
    abandonPendingConversationTurn: vi.fn(),
    settleSmokeResponseDone: vi.fn(),
    settleSmokeFailure: vi.fn(),
    recordLiveHistory: vi.fn(),
    touchIdle: vi.fn(),
    routePendingAnswer: vi.fn(),
    clearReconnectStabilityTimer: vi.fn(),
    scheduleReconnect: vi.fn(),
    handleToolCall: vi.fn(),
    armReconnectStability: vi.fn(),
    sendProviderContext: vi.fn(),
    hasLiveHistory: () => false,
    injectResumeContext: vi.fn(),
    sendGreetingIfSafe: vi.fn(),
    flushPendingMic: vi.fn(),
    startQuestionPoll: vi.fn(),
    clearPendingMic: vi.fn(),
    beginConnectAttempt: () => {
      generation += 1;
      return generation;
    },
    isAttemptCurrent: (attempt) => attempt === generation,
    // Simula o hardStop do controller: a geração morre e o provider sai do host.
    invalidateAttempts: () => {
      generation += 1;
      provider = null;
    },
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function liveSession(): JarvisLiveSession {
  const session = new JarvisLiveSession(() => {}, () => 1_700_000_000_000);
  session.setEnabled(true);
  session.start({ reason: 'manual' });
  return session;
}

describe('connectFirstLiveProvider', () => {
  it('a 1ª rota cai e a 2ª conecta: o estado é online e a falha anterior fica registrada', async () => {
    const session = liveSession();
    const host = hostFor(session);
    const grok = fakeCandidate(
      'grok',
      async () => {
        throw new Error('Unexpected server response: 404');
      },
      'grok-voice-3.0',
    );
    const openai = fakeCandidate('openai', async () => {}, 'gpt-realtime-2.1-mini');

    await connectFirstLiveProvider([grok, openai], undefined, host);

    const state = session.getState();
    expect(state.realtimeReady).toBe(true);
    // A rota que conectou é a REAL, não a configurada.
    expect(state.realtimeProvider).toBe('openai');
    // Sucesso limpa a falha do socket: sobraria um erro velho na tela.
    expect(state.realtimeFailure).toBeNull();
    expect(grok.provider.close).toHaveBeenCalled();
  });

  it('deixa o motivo da 1ª queda visível enquanto a próxima rota ainda tenta', async () => {
    const session = liveSession();
    const host = hostFor(session);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const grok = fakeCandidate(
      'grok',
      async () => {
        throw new Error('Unexpected server response: 404');
      },
      'grok-voice-3.0',
    );
    const openai = fakeCandidate('openai', async () => {
      await gate;
    });

    const started = connectFirstLiveProvider([grok, openai], undefined, host);
    // Enquanto a 2ª rota tenta, a falha da 1ª precisa ser consultável: é isso
    // que o chip traduz. Sem isso a pessoa só veria "conectando" de novo.
    await vi.waitFor(() =>
      expect(session.getState().realtimeFailure).toMatchObject({
        category: 'model_rejected',
        provider: 'grok',
        model: 'grok-voice-3.0',
        status: 404,
      }),
    );
    release();
    await started;

    // A sessão terminou conectada, então a falha foi limpa.
    expect(session.getState().realtimeFailure).toBeNull();
  });

  it('todas as rotas caem: a última categoria sobe com status e contagem de tentativas', async () => {
    const session = liveSession();
    const host = hostFor(session);
    const grok = fakeCandidate(
      'grok',
      async () => {
        throw new Error('Unexpected server response: 401');
      },
      'grok-voice-3.0',
    );
    const openai = fakeCandidate(
      'openai',
      async () => {
        throw new Error('OpenAI realtime setup timeout');
      },
      'gpt-realtime-2.1-mini',
    );

    await connectFirstLiveProvider([grok, openai], undefined, host);

    const state = session.getState();
    expect(state.realtimeReady).toBe(false);
    expect(state.status).toBe('error');
    expect(state.realtimeFailure).toMatchObject({
      category: 'timeout',
      provider: 'openai',
      model: 'gpt-realtime-2.1-mini',
      attempts: 2,
    });
  });

  it('hardStop durante o connect: a rejeição tardia não publica falha antiga nem tenta a próxima rota', async () => {
    const session = liveSession();
    const host = hostFor(session);
    const pending = deferred();
    const openai = fakeCandidate('openai', () => pending.promise, 'fixture-old-model');
    const gemini = fakeCandidate('gemini', async () => {}, 'gemini-live');

    const started = connectFirstLiveProvider([openai, gemini], undefined, host);
    // Troca de chave/modelo no meio do socket: a cadeia inteira fica obsoleta.
    host.invalidateAttempts();
    pending.reject(new Error('websocket closed before setup'));
    await started;

    expect(session.getState().realtimeFailure ?? null).toBeNull();
    expect(session.getState().status).not.toBe('error');
    // O 2º candidato da cadeia ANTIGA não é tentado.
    expect(gemini.provider.connect).not.toHaveBeenCalled();
  });

  it('socket que abre depois do hardStop é fechado e não ativa', async () => {
    const session = liveSession();
    const host = hostFor(session);
    const pending = deferred();
    const openai = fakeCandidate('openai', () => pending.promise, 'fixture-old-model');

    const started = connectFirstLiveProvider([openai], undefined, host);
    host.invalidateAttempts();
    pending.resolve();
    await started;

    expect(openai.provider.close).toHaveBeenCalled();
    expect(host.getProvider()).toBeNull();
    expect(session.getState().realtimeReady).toBe(false);
    expect(session.getState().realtimeFailure ?? null).toBeNull();
  });

  it('não deixa vazar chave nem texto cru do provedor no estado', async () => {
    const session = liveSession();
    const host = hostFor(session);
    const grok = fakeCandidate(
      'grok',
      async () => {
        throw new Error('chave xai-super-secreta-123456 recusada pelo servidor');
      },
      'grok-voice-3.0',
    );

    await connectFirstLiveProvider([grok], undefined, host);

    const serialized = JSON.stringify(session.getState());
    expect(serialized).not.toContain('xai-super-secreta');
    expect(serialized).not.toContain('recusada pelo servidor');
    expect(session.getState().realtimeFailure?.category).toBe('provider_error');
  });
});
