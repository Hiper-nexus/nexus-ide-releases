/**
 * Reuso do socket quente no wake (Grok Voice / OpenAI Realtime) com prova de
 * vida, e mic full-duplex nos transportes realtime. Arquivo próprio: o teste do
 * controller já passa do teto de linhas (ver live-grace-lifecycle.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../shared/voice-config';
import { JarvisLiveSession } from './jarvis-live';
import type { TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';
import type { RealtimeProviderCandidate } from '../jarvis/realtime/factory';

function pcmBase64(values: number[]): string {
  const samples = new Int16Array(values);
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString(
    'base64',
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Probe = (timeoutMs: number) => Promise<boolean>;

function fakeProvider(opts: { probe?: Probe | null } = {}) {
  let ready = false;
  const audioOut: Array<(pcm16: Int16Array) => void> = [];
  const provider = {
    get isReady() {
      return ready;
    },
    connect: vi.fn(async () => {
      ready = true;
    }),
    beginUserTurn: vi.fn(),
    resetTurn: vi.fn(),
    sendAudioChunk: vi.fn(),
    onTranscript: vi.fn(),
    onRoleTranscript: vi.fn(),
    onAudioOut: vi.fn((cb: (pcm16: Int16Array) => void) => {
      audioOut.push(cb);
    }),
    onError: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(() => {
      ready = false;
    }),
    endUserTurn: vi.fn(),
    forceEndUserTurn: vi.fn(),
    sendContext: vi.fn(),
    sendText: vi.fn(),
    sendToolResult: vi.fn(),
    onToolCall: vi.fn(),
    onInterrupted: vi.fn(),
    onResponseDone: vi.fn(),
    onDisconnected: vi.fn(),
    fireAudioOut(samples = new Int16Array([1, 2, 3, 4])) {
      for (const cb of audioOut) cb(samples);
    },
    ...(opts.probe === null
      ? {}
      : { probeLiveness: vi.fn(opts.probe ?? (async () => true)) }),
  };
  return provider as unknown as TurnManagedRealtimeProvider & {
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    resetTurn: ReturnType<typeof vi.fn>;
    sendAudioChunk: ReturnType<typeof vi.fn>;
    endUserTurn: ReturnType<typeof vi.fn>;
    probeLiveness: ReturnType<typeof vi.fn>;
    fireAudioOut(samples?: Int16Array): void;
  };
}

async function withController(
  provider: TurnManagedRealtimeProvider,
  transport: 'grok-realtime' | 'openai-realtime' | 'gemini-live',
  run: (ctx: {
    controller: InstanceType<
      typeof import('./live-transport-controller').LiveTransportController
    >;
    session: JarvisLiveSession;
    HOT_SOCKET_PROBE_MS: number;
  }) => Promise<void>,
  questionSource?: { poll(): Array<{ paneId: string; questionHash: string }> },
): Promise<void> {
  vi.resetModules();
  const providerId =
    transport === 'grok-realtime' ? 'grok' : transport === 'openai-realtime' ? 'openai' : 'gemini';
  const candidates: RealtimeProviderCandidate[] = [{ id: providerId, provider }];
  vi.doMock('./voice-config-store', () => ({
    getVoiceConfig: () => ({
      ...DEFAULT_VOICE_CONFIG,
      jarvisLive: {
        ...DEFAULT_VOICE_CONFIG.jarvisLive,
        enabled: true,
        transport,
        graceReuseMs: 90_000,
        dormantAfterMs: 300_000,
        maxWindowTurns: 12,
      },
    }),
  }));
  vi.doMock('./voice-secrets', () => ({
    resolveVoiceApiKey: () => 'key',
    voiceApiKeySource: () => 'env',
  }));
  vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
  vi.doMock('../jarvis/realtime/factory', () => ({
    createRealtimeProviderCandidates: () => candidates,
    loadJarvisSystemPrompt: () => 'You are Jarvis.',
    resolveRealtimeProviderIds: () => [providerId],
  }));
  const { LiveTransportController, HOT_SOCKET_PROBE_MS } = await import(
    './live-transport-controller'
  );
  const session = new JarvisLiveSession(() => {}, () => 1_000);
  session.setEnabled(true);
  session.start({ reason: 'manual' });
  const controller = new LiveTransportController(() => {}, session, Date.now, questionSource);
  try {
    await run({ controller, session, HOT_SOCKET_PROBE_MS });
  } finally {
    controller.hardStop();
    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  }
}

describe('LiveTransportController — reuso do socket quente no wake', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaproveita o socket quando a sonda de vida responde (sem reconectar)', async () => {
    const provider = fakeProvider();
    await withController(provider, 'grok-realtime', async ({ controller, session, HOT_SOCKET_PROBE_MS }) => {
      await controller.onStart({ freshTurn: true });
      expect(provider.connect).toHaveBeenCalledTimes(1);
      controller.onStop();
      expect(controller.inGrace).toBe(true);

      await controller.onStart({ freshTurn: true });

      expect(provider.probeLiveness).toHaveBeenCalledWith(HOT_SOCKET_PROBE_MS);
      expect(provider.connect).toHaveBeenCalledTimes(1);
      expect(provider.close).not.toHaveBeenCalled();
      expect(provider.resetTurn).toHaveBeenCalledTimes(1);
      expect(controller.inGrace).toBe(false);
      expect(session.getState()).toMatchObject({ status: 'listening', realtimeReady: true });
    });
  });

  it('o reuso religa o poller de perguntas que o soft-stop tinha parado', async () => {
    const provider = fakeProvider();
    const poll = vi.fn(() => []);
    await withController(
      provider,
      'grok-realtime',
      async ({ controller }) => {
        await controller.onStart({ freshTurn: true });
        await vi.waitFor(() => expect(poll).toHaveBeenCalled());
        controller.onStop();
        poll.mockClear();

        await controller.onStart({ freshTurn: true });

        // Sem religar, a Jarvis deixava de narrar a pergunta de um pane até a
        // próxima conexão fria.
        await vi.waitFor(() => expect(poll).toHaveBeenCalled());
        expect(provider.connect).toHaveBeenCalledTimes(1);
      },
      { poll },
    );
  });

  it('segura o mic na sonda e libera tudo no mesmo socket quando ele está vivo', async () => {
    const verdict = deferred<boolean>();
    const provider = fakeProvider({ probe: () => verdict.promise });
    await withController(provider, 'openai-realtime', async ({ controller }) => {
      await controller.onStart({ freshTurn: true });
      const wake = controller.onStart({ freshTurn: true });

      controller.micIn(pcmBase64([1, 2, 3]));
      controller.micIn(pcmBase64([4, 5, 6]));
      controller.endTurn();
      // Durante a sonda nada pode ir a um socket que pode ser zumbi.
      expect(provider.sendAudioChunk).not.toHaveBeenCalled();
      expect(provider.endUserTurn).not.toHaveBeenCalled();

      verdict.resolve(true);
      await wake;

      expect(provider.sendAudioChunk).toHaveBeenCalledTimes(2);
      expect(provider.endUserTurn).toHaveBeenCalledTimes(1);
      expect(provider.connect).toHaveBeenCalledTimes(1);
    });
  });

  it('socket zumbi (sonda false): reconecta e o áudio retido chega à conexão nova', async () => {
    const provider = fakeProvider({ probe: async () => false });
    await withController(provider, 'grok-realtime', async ({ controller, session }) => {
      await controller.onStart({ freshTurn: true });
      const wake = controller.onStart({ freshTurn: true });
      controller.micIn(pcmBase64([7, 8, 9]));
      await wake;

      expect(provider.close).toHaveBeenCalledTimes(1);
      expect(provider.connect).toHaveBeenCalledTimes(2);
      expect(provider.resetTurn).not.toHaveBeenCalled();
      // O primeiro áudio da fala não pode morrer no socket zumbi.
      expect(provider.sendAudioChunk).toHaveBeenCalledTimes(1);
      expect(session.getState()).toMatchObject({ status: 'listening', realtimeReady: true });
    });
  });

  it('sonda que lança é tratada como socket morto', async () => {
    const provider = fakeProvider({
      probe: async () => {
        throw new Error('ws exploded');
      },
    });
    await withController(provider, 'grok-realtime', async ({ controller }) => {
      await controller.onStart({ freshTurn: true });
      await controller.onStart({ freshTurn: true });

      expect(provider.close).toHaveBeenCalledTimes(1);
      expect(provider.connect).toHaveBeenCalledTimes(2);
    });
  });

  it('wakes simultâneos compartilham uma única sonda', async () => {
    const verdict = deferred<boolean>();
    const provider = fakeProvider({ probe: () => verdict.promise });
    await withController(provider, 'grok-realtime', async ({ controller }) => {
      await controller.onStart({ freshTurn: true });
      const first = controller.onStart({ freshTurn: true });
      const second = controller.onStart({ freshTurn: true });

      verdict.resolve(true);
      await Promise.all([first, second]);

      expect(provider.probeLiveness).toHaveBeenCalledTimes(1);
      expect(provider.connect).toHaveBeenCalledTimes(1);
    });
  });

  it('encerramento durante a sonda não ressuscita a sessão', async () => {
    const verdict = deferred<boolean>();
    const provider = fakeProvider({ probe: () => verdict.promise });
    await withController(provider, 'grok-realtime', async ({ controller }) => {
      await controller.onStart({ freshTurn: true });
      const wake = controller.onStart({ freshTurn: true });

      controller.hardStop();
      verdict.resolve(false);
      await wake;

      expect(provider.connect).toHaveBeenCalledTimes(1);
    });
  });

  it('provider sem prova de vida (Gemini Live) continua reconectando no wake', async () => {
    const provider = fakeProvider({ probe: null });
    await withController(provider, 'gemini-live', async ({ controller }) => {
      await controller.onStart({ freshTurn: true });
      await controller.onStart({ freshTurn: true });

      expect(provider.close).toHaveBeenCalledTimes(1);
      expect(provider.connect).toHaveBeenCalledTimes(2);
    });
  });

  it('reply (freshTurn=false) segue no socket sem sonda', async () => {
    const provider = fakeProvider();
    await withController(provider, 'grok-realtime', async ({ controller }) => {
      await controller.onStart({ freshTurn: true });
      await controller.onStart({ freshTurn: false });

      expect(provider.probeLiveness).not.toHaveBeenCalled();
      expect(provider.connect).toHaveBeenCalledTimes(1);
    });
  });
});

describe('LiveTransportController.micIn — full-duplex em todo transporte realtime', () => {
  it.each(['grok-realtime', 'openai-realtime', 'gemini-live'] as const)(
    '%s: o mic segue para o servidor enquanto ela fala (barge-in)',
    async (transport) => {
      const provider = fakeProvider({ probe: null });
      await withController(provider, transport, async ({ controller, session }) => {
        await controller.onStart();
        provider.fireAudioOut();
        expect(session.getState().status).toBe('speaking');

        controller.micIn(pcmBase64([5, 6, 7]));

        expect(provider.sendAudioChunk).toHaveBeenCalledTimes(1);
      });
    },
  );
});
