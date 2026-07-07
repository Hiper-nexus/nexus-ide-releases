import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../shared/voice-config';
import { JarvisLiveSession } from './jarvis-live';
import type { TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';
import type { RealtimeProviderCandidate } from '../jarvis/realtime/factory';

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

function fakeProvider(connect: () => Promise<void>): TurnManagedRealtimeProvider & {
  closeCalls: number;
} {
  let ready = false;
  let closeCalls = 0;
  return {
    get closeCalls() {
      return closeCalls;
    },
    get isReady() {
      return ready;
    },
    connect: vi.fn(async () => {
      await connect();
      ready = true;
    }),
    sendAudioChunk: vi.fn(),
    onTranscript: vi.fn(),
    onRoleTranscript: vi.fn(),
    onAudioOut: vi.fn(),
    onError: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(() => {
      closeCalls += 1;
      ready = false;
    }),
    endUserTurn: vi.fn(),
    sendContext: vi.fn(),
    sendText: vi.fn(),
    onInterrupted: vi.fn(),
    onResponseDone: vi.fn(),
  };
}

describe('LiveTransportController', () => {
  it('falls back from a failed OpenAI realtime provider to Gemini Live', async () => {
    vi.resetModules();
    const openai = fakeProvider(async () => {
      throw new Error('OpenAI setup failed');
    });
    const gemini = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [
      { id: 'openai', provider: openai },
      { id: 'gemini', provider: gemini },
    ];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'openai-realtime',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai', 'gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();

    expect(openai.connect).toHaveBeenCalledTimes(1);
    expect(openai.closeCalls).toBe(1);
    expect(gemini.connect).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({
      status: 'listening',
      realtimeReady: true,
      error: undefined,
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('reuses an in-flight realtime connection instead of opening another socket', async () => {
    vi.resetModules();
    const pending = deferred();
    const provider = fakeProvider(() => pending.promise);
    const candidates: RealtimeProviderCandidate[] = [{ id: 'openai', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'openai-realtime',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    const first = controller.onStart();
    const second = controller.onStart();
    expect(provider.connect).toHaveBeenCalledTimes(1);

    pending.resolve();
    await Promise.all([first, second]);
    expect(session.getState().realtimeReady).toBe(true);

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });
});
