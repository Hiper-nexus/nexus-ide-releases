import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../shared/voice-config';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import { JarvisLiveSession } from './jarvis-live';
import type {
  RealtimeToolCallEvent,
  TurnManagedRealtimeProvider,
} from '../jarvis/realtime/provider';
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

function pcmBase64(values: number[]): string {
  const samples = new Int16Array(values);
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString(
    'base64',
  );
}

function fakeProvider(connect: () => Promise<void>): TurnManagedRealtimeProvider & {
  closeCalls: number;
  fireDisconnected(err: Error): void;
  fireToolCall(call?: Partial<RealtimeToolCallEvent>): void;
  fireToolCallCancelled(callId: string): void;
  fireRoleTranscript(line: { role: 'user' | 'assistant'; text: string; final: boolean }): void;
  fireAudioOut(samples?: Int16Array): void;
  fireResponseDone(): void;
  setSynchronousToolResponseDone(enabled?: boolean): void;
  fireError(err: Error): void;
} {
  let ready = false;
  let closeCalls = 0;
  const disconnectedCallbacks: Array<(err: Error) => void> = [];
  const toolCallCallbacks: Parameters<TurnManagedRealtimeProvider['onToolCall']>[0][] = [];
  const toolCallCancelledCallbacks: Array<(callId: string) => void> = [];
  const roleTranscriptCallbacks: Parameters<
    TurnManagedRealtimeProvider['onRoleTranscript']
  >[0][] = [];
  const audioOutCallbacks: Parameters<TurnManagedRealtimeProvider['onAudioOut']>[0][] = [];
  const responseDoneCallbacks: Array<() => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  let respondDoneDuringToolResult = false;
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
    beginUserTurn: vi.fn(),
    sendAudioChunk: vi.fn(),
    onTranscript: vi.fn(),
    onRoleTranscript: vi.fn((cb) => {
      roleTranscriptCallbacks.push(cb);
    }),
    onAudioOut: vi.fn((cb) => {
      audioOutCallbacks.push(cb);
    }),
    onError: vi.fn((cb) => {
      errorCallbacks.push(cb);
    }),
    interrupt: vi.fn(),
    close: vi.fn(() => {
      closeCalls += 1;
      ready = false;
    }),
    endUserTurn: vi.fn(),
    forceEndUserTurn: vi.fn(),
    sendContext: vi.fn(),
    sendText: vi.fn(),
    sendToolResult: vi.fn(() => {
      if (respondDoneDuringToolResult) {
        for (const cb of responseDoneCallbacks) cb();
      }
    }),
    onToolCall: vi.fn((cb) => {
      toolCallCallbacks.push(cb);
    }),
    onToolCallCancelled: vi.fn((cb) => {
      toolCallCancelledCallbacks.push(cb);
    }),
    onInterrupted: vi.fn(),
    onResponseDone: vi.fn((cb) => {
      responseDoneCallbacks.push(cb);
    }),
    onDisconnected: vi.fn((cb) => {
      disconnectedCallbacks.push(cb);
    }),
    fireDisconnected(err) {
      ready = false;
      for (const cb of disconnectedCallbacks) cb(err);
    },
    fireToolCall(call = {}) {
      for (const cb of toolCallCallbacks) {
        cb({
          callId: call.callId ?? 'call_1',
          name: call.name ?? 'nexus_action',
          argumentsJson: call.argumentsJson ?? '{"action":"open_terminal"}',
          arguments: call.arguments ?? { action: 'open_terminal' },
        });
      }
    },
    fireToolCallCancelled(callId) {
      for (const cb of toolCallCancelledCallbacks) cb(callId);
    },
    fireRoleTranscript(line) {
      for (const cb of roleTranscriptCallbacks) cb(line);
    },
    fireAudioOut(samples = new Int16Array([1])) {
      for (const cb of audioOutCallbacks) cb(samples);
    },
    fireResponseDone() {
      for (const cb of responseDoneCallbacks) cb();
    },
    setSynchronousToolResponseDone(enabled = true) {
      respondDoneDuringToolResult = enabled;
    },
    fireError(err) {
      for (const cb of errorCallbacks) cb(err);
    },
  };
}

describe('LiveTransportController', () => {
  it('does not keep a realtime turn pending when credentials are unavailable', async () => {
    vi.resetModules();
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
      resolveVoiceApiKey: () => undefined,
      voiceApiKeySource: () => 'missing',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();

    // LOW-7: degradação benigna — dormante, sem erro (nada de HUD vermelho).
    expect(session.getState()).toMatchObject({
      status: 'dormant',
      realtimeReady: false,
    });
    expect(session.getState().error).toBeUndefined();

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  // This case resets and imports the full realtime graph. Under the complete
  // suite (OCR + server integration workers in parallel), cold transform can
  // legitimately exceed Vitest's 10 s default even though onStart resolves
  // immediately once loaded.
  }, 30_000);

  it('nenhum candidato com a chave listada: erro visível de vault, não "conectando"', async () => {
    vi.resetModules();
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'grok-realtime',
        },
      }),
    }));
    // A chave CONSTA (isRealtimeConfigured passa) mas não decifra: é o caso em
    // que pedir uma chave nova não resolve. Antes isso saía mudo e o cliente
    // ficava olhando "Grok Voice conectando" para sempre.
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => undefined,
      voiceApiKeySource: () => 'stored',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['grok'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();

    expect(session.getState()).toMatchObject({
      status: 'error',
      realtimeReady: false,
    });
    expect(session.getState().realtimeFailure).toMatchObject({
      category: 'vault_unreadable',
      provider: null,
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  }, 30_000);

  it('clearRealtimeFailure apaga a falha velha (mudança de config/credencial)', async () => {
    vi.resetModules();
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'grok-realtime',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => undefined,
      voiceApiKeySource: () => 'stored',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['grok'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();
    expect(session.getState().realtimeFailure).toMatchObject({
      category: 'vault_unreadable',
    });

    // A troca de rota/credencial invalida o motivo: ele era da config antiga.
    controller.clearRealtimeFailure();
    expect(session.getState().realtimeFailure ?? null).toBeNull();

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  }, 30_000);

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
      voiceApiKeySource: () => 'env',
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

  it('reports realtime smoke success only after renderer playback is acknowledged', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    let wall = 1_000;
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [{ id: 'gemini', provider }],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const aec = {
      capture: vi.fn((samples: Int16Array, sink: (processed: Int16Array) => void) => {
        sink(new Int16Array([...samples].map((sample) => sample + 10)));
      }),
      render24k: vi.fn(),
      reset: vi.fn(),
    };
    const session = new JarvisLiveSession(() => {}, () => wall);
    session.setEnabled(true);
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const controller = new LiveTransportController(
      (channel, payload) => emitted.push({ channel, payload }),
      session,
      () => wall,
      undefined,
      undefined,
      aec,
    );

    const resultPromise = controller.smokeTest('responda que está online', 101);
    await vi.waitFor(() => expect(provider.sendText).toHaveBeenCalledOnce());
    controller.micIn(pcmBase64([1, 2, 3]));
    expect(aec.capture).toHaveBeenCalledOnce();
    expect(provider.sendAudioChunk).toHaveBeenCalledWith(new Int16Array([11, 12, 13]));
    wall = 1_240;
    provider.fireAudioOut(new Int16Array([7, 8]));
    const audio = emitted.find((event) => event.channel === VOICE_CHANNELS.liveAudioOut);
    expect(audio?.payload).toMatchObject({ pcm16: expect.any(String), id: expect.any(String) });

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    // response.done may race the renderer IPC receipt; delivered PCM keeps the
    // probe open until the matching owner reports playback started.
    provider.fireResponseDone();
    controller.reportAudioPlayback(
      {
        id: (audio!.payload as { id: string }).id,
        outcome: 'started',
      },
      202,
    );
    expect(aec.render24k).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(settled).toBe(false);

    controller.reportAudioPlayback(
      {
        id: (audio!.payload as { id: string }).id,
        outcome: 'started',
      },
      101,
    );
    expect(aec.render24k).toHaveBeenCalledWith(new Int16Array([7, 8]));

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      evidence: 'audio',
      latencyMs: 240,
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('rejects realtime smoke when the renderer cannot start provider playback', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [{ id: 'gemini', provider }],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1_000);
    session.setEnabled(true);
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const controller = new LiveTransportController(
      (channel, payload) => emitted.push({ channel, payload }),
      session,
    );

    const resultPromise = controller.smokeTest('responda que está online');
    await vi.waitFor(() => expect(provider.sendText).toHaveBeenCalledOnce());
    provider.fireAudioOut();
    const audio = emitted.find((event) => event.channel === VOICE_CHANNELS.liveAudioOut);
    controller.reportAudioPlayback({
      id: (audio!.payload as { id: string }).id,
      outcome: 'failed',
      error: 'sink rejected',
    });

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      reason: 'audio_playback_failed',
    });
    expect(session.getState()).toMatchObject({ status: 'error', realtimeReady: false });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('rejects a realtime smoke response that completes without audio', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [{ id: 'gemini', provider }],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1_000);
    session.setEnabled(true);
    const controller = new LiveTransportController(() => {}, session);

    const resultPromise = controller.smokeTest('responda que está online');
    await vi.waitFor(() => expect(provider.sendText).toHaveBeenCalledOnce());
    provider.fireResponseDone();

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      reason: 'no_audio_response',
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
      voiceApiKeySource: () => 'env',
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

  it('speaks short app results through the ready realtime provider', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
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
      voiceApiKeySource: () => 'env',
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

    await controller.onStart();
    const state = await controller.say('Abrindo um terminal, patrão.');

    expect(provider.connect).toHaveBeenCalledTimes(1);
    expect(provider.close).not.toHaveBeenCalled();
    expect(provider.sendText).toHaveBeenCalledWith(
      expect.stringContaining('Abrindo um terminal, patrão.'),
    );
    expect(state).toMatchObject({ status: 'thinking', realtimeReady: true });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('flushes manual/PTT mic frames buffered while the realtime provider connects', async () => {
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
      voiceApiKeySource: () => 'env',
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

    controller.beginTurn('turn-1');
    const started = controller.onStart();
    controller.micIn(pcmBase64([1, 2, 3]));
    controller.micIn(pcmBase64([4, 5, 6]));

    expect(provider.sendAudioChunk).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({
      status: 'listening',
      realtimeReady: false,
      pendingMic: true,
    });

    pending.resolve();
    await started;

    expect(provider.sendAudioChunk).toHaveBeenCalledTimes(2);
    expect(provider.beginUserTurn).toHaveBeenLastCalledWith('turn-1');
    const finalTurnBindOrder = vi.mocked(provider.beginUserTurn!).mock.invocationCallOrder.at(-1)!;
    const firstAudioOrder = vi.mocked(provider.sendAudioChunk).mock.invocationCallOrder[0];
    expect(finalTurnBindOrder).toBeLessThan(firstAudioOrder);
    expect(provider.sendAudioChunk).toHaveBeenNthCalledWith(
      1,
      new Int16Array([1, 2, 3]),
    );
    expect(provider.sendAudioChunk).toHaveBeenNthCalledWith(
      2,
      new Int16Array([4, 5, 6]),
    );
    expect(session.getState()).toMatchObject({
      status: 'listening',
      realtimeReady: true,
      pendingMic: false,
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('preserva o fim do turno durante a conexão e o envia depois dos frames', async () => {
    vi.resetModules();
    const pending = deferred();
    const provider = fakeProvider(() => pending.promise);
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    const started = controller.onStart();
    controller.micIn(pcmBase64([1, 2, 3]));
    controller.micIn(pcmBase64([4, 5, 6]));
    controller.endTurn();
    controller.endTurn();
    expect(provider.endUserTurn).not.toHaveBeenCalled();

    pending.resolve();
    await started;

    expect(provider.sendAudioChunk).toHaveBeenCalledTimes(2);
    expect(provider.endUserTurn).toHaveBeenCalledOnce();
    const lastAudioOrder = vi.mocked(provider.sendAudioChunk).mock.invocationCallOrder.at(-1)!;
    const endOrder = vi.mocked(provider.endUserTurn).mock.invocationCallOrder[0];
    expect(lastAudioOrder).toBeLessThan(endOrder);

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('pendingMic do controller também é drop-oldest durante setup lento', async () => {
    vi.resetModules();
    const pending = deferred();
    const provider = fakeProvider(() => pending.promise);
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'wake' });
    const controller = new LiveTransportController(() => {}, session);

    const started = controller.onStart();
    // 16 chunks × 32KB = exactly the 512KB controller cap.
    for (let i = 0; i < 16; i += 1) {
      controller.micIn(pcmBase64(new Array(16 * 1024).fill(i + 1)));
    }
    // Adding one more chunk must evict only the oldest chunk, not reject the
    // newest command tail.
    const newest = new Array(16 * 1024).fill(99);
    controller.micIn(pcmBase64(newest));

    pending.resolve();
    await started;

    expect(provider.sendAudioChunk).toHaveBeenCalledTimes(16);
    expect(provider.sendAudioChunk).not.toHaveBeenCalledWith(
      new Int16Array(new Array(16 * 1024).fill(1)),
    );
    expect(provider.sendAudioChunk).toHaveBeenLastCalledWith(new Int16Array(newest));

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('omits a cold wake greeting when user audio arrived during connect', async () => {
    vi.resetModules();
    const pending = deferred();
    const provider = fakeProvider(() => pending.promise);
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
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
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'wake' });
    const controller = new LiveTransportController(() => {}, session);

    const started = controller.onStart({ greeting: '[wake] diga Olá.' });
    controller.micIn(pcmBase64([1, 2, 3]));
    pending.resolve();
    await started;

    expect(provider.sendText).not.toHaveBeenCalled();
    expect(provider.sendAudioChunk).toHaveBeenCalledOnce();

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('sends a warm wake greeting before accepting the next audio turn', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
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
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'wake' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();
    await controller.onStart({ greeting: '[wake] diga Olá.', freshTurn: true });
    controller.micIn(pcmBase64([4, 5, 6]));

    expect(provider.sendText).toHaveBeenCalledWith('[wake] diga Olá.');
    expect(vi.mocked(provider.sendText).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(provider.sendAudioChunk).mock.invocationCallOrder[0],
    );

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('resends a zero-frame turn as filtered text exactly once per turn id', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
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
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1_000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);
    await controller.onStart();

    expect(controller.rescueText('turn-7', 'abra o terminal')).toBe(true);
    expect(controller.rescueText('turn-7', 'abra o terminal')).toBe(true);

    expect(provider.sendText).toHaveBeenCalledOnce();
    expect(provider.sendText).toHaveBeenCalledWith('abra o terminal');
    expect(controller.lastUserTranscript).toBe('abra o terminal');
    expect(provider.sendAudioChunk).not.toHaveBeenCalled();
    expect(provider.forceEndUserTurn).not.toHaveBeenCalled();

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('recovers explicit engineering work when Gemini finishes after only narrating', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, enabled: true, transport: 'gemini-live' },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => 1_000,
    );
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(
      (channel, payload) => events.push({ channel, payload }),
      session,
    );
    await controller.onStart();

    controller.beginTurn('fix-turn');
    expect(controller.rescueText('fix-turn', 'analise os logs e corrija esse erro')).toBe(true);
    provider.fireResponseDone();

    const recovered = events.find((event) =>
      event.channel === VOICE_CHANNELS.liveToolCall &&
      (event.payload as { callId?: string }).callId?.includes('recover-delegation'),
    );
    expect(recovered?.payload).toMatchObject({
      name: 'nexus_action',
      tool: 'send_to_pane',
      args: {
        action: 'send_to_pane',
        text: 'analise os logs e corrija esse erro',
      },
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('does not recover work abandoned by a superseding unrelated turn', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, enabled: true, transport: 'gemini-live' },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => 1_000,
    );
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(
      (channel, payload) => events.push({ channel, payload }),
      session,
    );
    await controller.onStart();
    controller.beginTurn('work-turn');
    expect(controller.rescueText('work-turn', 'analise os logs')).toBe(true);
    controller.interrupt('barge-in');
    controller.beginTurn('question-turn');
    provider.fireRoleTranscript({ role: 'user', text: 'que horas são?', final: true });
    provider.fireResponseDone();

    expect(events.some((event) =>
      event.channel === VOICE_CHANNELS.liveToolCall &&
      (event.payload as { callId?: string }).callId?.includes('recover-delegation'),
    )).toBe(false);

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('replays screen context after the realtime provider becomes ready', async () => {
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
      voiceApiKeySource: () => 'env',
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

    const started = controller.onStart();
    controller.contextIn('Workspace nexus em grade com terminal focado.');

    expect(provider.sendContext).not.toHaveBeenCalled();

    pending.resolve();
    await started;

    expect(provider.sendContext).toHaveBeenCalledWith(
      expect.stringContaining('Workspace nexus em grade com terminal focado.'),
    );

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('sends action results back into realtime provider context', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
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
      voiceApiKeySource: () => 'env',
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

    await controller.onStart();
    controller.contextIn('Workspace nexus em grade.');
    controller.toolResult({
      sessionId: 'session-1',
      at: 1001,
      tool: 'open_terminal',
      ok: true,
      summary: 'terminal aberto',
    });

    expect(provider.sendContext).toHaveBeenLastCalledWith(
      expect.stringContaining('Recent Nexus action results'),
    );
    expect(provider.sendContext).toHaveBeenLastCalledWith(
      expect.stringContaining('open_terminal: ok (terminal aberto)'),
    );

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('bridges native realtime tool calls to the renderer and returns function output', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'openai', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];

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
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const {
      LiveTransportController,
      TOOL_FOLLOW_UP_COMPLETION_DEADLINE_MS,
    } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => 1000,
    );
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(
      (channel, payload) => events.push({ channel, payload }),
      session,
    );

    await controller.onStart();
    // A tool can finish after the user has already begun a newer turn. Its
    // completion must not be re-labelled as that newer turn or reopen its mic.
    controller.beginTurn('tool-origin-turn');
    provider.fireToolCall({ callId: 'call_late' });
    controller.beginTurn('newer-turn');
    controller.toolResult({
      sessionId: session.getState().sessionId ?? 'session',
      at: 1_000,
      source: 'realtime',
      callId: 'call_late',
      name: 'nexus_action',
      tool: 'open_terminal',
      ok: true,
      summary: 'terminal abriu depois do novo turno',
    });
    provider.fireResponseDone();
    const recovered = events.filter(
      (event) => event.channel === VOICE_CHANNELS.liveToolTurnComplete,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.payload).toMatchObject({
      turnId: 'newer-turn',
      callId: 'call_late',
    });

    controller.beginTurn('tool-turn-1');
    provider.fireToolCall();

    const toolCall = events.find(
      (event) =>
        event.channel === VOICE_CHANNELS.liveToolCall &&
        (event.payload as { callId?: string }).callId === 'call_1',
    );
    expect(toolCall?.payload).toMatchObject({
      source: 'realtime',
      callId: 'call_1',
      name: 'nexus_action',
      tool: 'open_terminal',
      args: { action: 'open_terminal' },
    });

    // Gemini can synchronously finish a response while sendToolResult runs.
    // The controller must have armed the renderer completion before that call.
    provider.setSynchronousToolResponseDone();
    controller.toolResult({
      sessionId: session.getState().sessionId ?? 'session',
      at: 1001,
      source: 'realtime',
      callId: 'call_1',
      name: 'nexus_action',
      tool: 'open_terminal',
      ok: true,
      summary: 'terminal aberto',
      output: { ok: true },
    });

    expect(provider.sendToolResult).toHaveBeenCalledWith(
      'call_1',
      expect.objectContaining({
        ok: true,
        tool: 'open_terminal',
        summary: 'terminal aberto',
      }),
    );
    const completions = events.filter(
      (event) => event.channel === VOICE_CHANNELS.liveToolTurnComplete,
    );
    expect(completions).toHaveLength(2);
    expect(completions[1]?.payload).toMatchObject({
      sessionId: session.getState().sessionId,
      turnId: 'tool-turn-1',
      callId: 'call_1',
    });

    // Gemini sometimes accepts the result but never emits responseDone. A
    // bounded local deadline must release the renderer instead of leaving the
    // capture open for 20-60 seconds.
    controller.beginTurn('tool-turn-deadline');
    provider.setSynchronousToolResponseDone(false);
    provider.fireToolCall({ callId: 'call_deadline' });
    controller.toolResult({
      sessionId: session.getState().sessionId ?? 'session',
      at: 1002,
      source: 'realtime',
      callId: 'call_deadline',
      name: 'nexus_action',
      tool: 'open_terminal',
      ok: true,
      summary: 'terminal aberto sem responseDone',
    });

    expect(TOOL_FOLLOW_UP_COMPLETION_DEADLINE_MS).toBe(3_000);
    await vi.advanceTimersByTimeAsync(TOOL_FOLLOW_UP_COMPLETION_DEADLINE_MS - 1);
    expect(
      events.filter((event) => event.channel === VOICE_CHANNELS.liveToolTurnComplete),
    ).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const deadlineCompletions = events.filter(
      (event) => event.channel === VOICE_CHANNELS.liveToolTurnComplete,
    );
    expect(deadlineCompletions).toHaveLength(3);
    expect(deadlineCompletions[2]?.payload).toMatchObject({
      turnId: 'tool-turn-deadline',
      callId: 'call_deadline',
    });
    // The local completion is only a renderer-unblock fallback. It must not
    // interrupt Gemini: a late narration is still valid audio and cutting it
    // here was the source of "action happened, then Jarvis went silent".
    expect(provider.interrupt).not.toHaveBeenCalled();

    // A late provider callback is harmless and must not emit twice.
    provider.fireResponseDone();
    expect(
      events.filter((event) => event.channel === VOICE_CHANNELS.liveToolTurnComplete),
    ).toHaveLength(3);

    controller.hardStop();
    vi.useRealTimers();

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('dedupes callId across reconnect and cancels renderer execution by IPC', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const firstProvider = fakeProvider(async () => {});
    const secondProvider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [
      { id: 'gemini', provider: firstProvider },
    ];
    const events: Array<{ channel: string; payload: unknown }> = [];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    try {
      const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
      const { LiveTransportController } = await import('./live-transport-controller');
      const emit = (channel: string, payload: unknown) =>
        events.push({ channel, payload });
      const session = new JarvisLiveSession(emit, () => 1_000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      const controller = new LiveTransportController(emit, session);

      await controller.onStart();
      firstProvider.fireToolCall({ callId: 'call-completed' });
      controller.toolResult({
        sessionId: session.getState().sessionId ?? 'session',
        at: 1_000,
        source: 'realtime',
        callId: 'call-completed',
        name: 'nexus_action',
        tool: 'open_terminal',
        ok: true,
        summary: 'terminal aberto uma vez',
        output: { ok: true },
      });
      firstProvider.fireToolCall({ callId: 'call-reconnect' });
      expect(
        events.filter((event) => event.channel === VOICE_CHANNELS.liveToolCall),
      ).toHaveLength(2);

      candidates.splice(0, candidates.length, {
        id: 'gemini',
        provider: secondProvider,
      });
      firstProvider.fireDisconnected(new Error('socket caiu'));
      await vi.advanceTimersByTimeAsync(750);
      expect(secondProvider.isReady).toBe(true);

      secondProvider.fireToolCall({ callId: 'call-completed' });
      secondProvider.fireToolCall({ callId: 'call-reconnect' });
      expect(
        events.filter((event) => event.channel === VOICE_CHANNELS.liveToolCall),
      ).toHaveLength(2);
      expect(secondProvider.sendToolResult).toHaveBeenCalledWith(
        'call-completed',
        expect.objectContaining({ ok: true, summary: 'terminal aberto uma vez' }),
      );

      secondProvider.fireToolCallCancelled('call-reconnect');
      expect(
        events.filter(
          (event) => event.channel === VOICE_CHANNELS.liveToolCancelled,
        ).at(-1)?.payload,
      ).toMatchObject({
        callId: 'call-reconnect',
        reason: 'provider_cancelled',
      });

      // If session resumption repeats a cancelled id, answer with the cached
      // terminal state instead of either re-executing or leaving it pending.
      secondProvider.fireToolCall({ callId: 'call-reconnect' });
      expect(secondProvider.sendToolResult).toHaveBeenLastCalledWith(
        'call-reconnect',
        expect.objectContaining({
          ok: false,
          output: { error: 'provider_cancelled' },
        }),
      );

      controller.toolResult({
        sessionId: session.getState().sessionId ?? 'session',
        at: 1_001,
        source: 'realtime',
        callId: 'call-reconnect',
        name: 'nexus_action',
        tool: 'open_terminal',
        ok: true,
        summary: 'terminal abriu tarde',
        output: { ok: true, effectCommitted: true },
      });
      expect(secondProvider.sendToolResult).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.doUnmock('./voice-config-store');
      vi.doUnmock('./voice-secrets');
      vi.doUnmock('./jarvis-memory');
      vi.doUnmock('../jarvis/realtime/factory');
    }
  });

  it('marks realtime action latency as soon as the provider requests a tool', async () => {
    vi.resetModules();
    const markAction = vi.fn();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'openai', provider }];

    vi.doMock('../jarvis/realtime/metrics', () => ({
      jarvisLatencyTracker: {
        markAction,
        markAudioIn: vi.fn(),
        markAudioOut: vi.fn(),
        markResponseDone: vi.fn(),
        discard: vi.fn(),
      },
    }));
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
      voiceApiKeySource: () => 'env',
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

    await controller.onStart();
    provider.fireToolCall({ callId: 'call_metrics' });

    expect(markAction).toHaveBeenCalledWith(session.getState().sessionId);

    vi.doUnmock('../jarvis/realtime/metrics');
    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('returns a structured timeout when a realtime tool call never resolves', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'openai', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];

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
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai'],
    }));

    try {
      const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
      const { LiveTransportController } = await import('./live-transport-controller');
      const session = new JarvisLiveSession(
        (channel, payload) => events.push({ channel, payload }),
        () => 1000,
      );
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      const controller = new LiveTransportController(
        (channel, payload) => events.push({ channel, payload }),
        session,
      );

      await controller.onStart();
      provider.fireToolCall({ callId: 'call_timeout' });

      expect(provider.sendToolResult).not.toHaveBeenCalled();

      // Human confirmation gets a real reading/decision window; expiration is
      // explicit and aborts the renderer by callId.
      await vi.advanceTimersByTimeAsync(120_000);

      expect(provider.sendToolResult).toHaveBeenCalledWith(
        'call_timeout',
        expect.objectContaining({
          ok: false,
          tool: 'open_terminal',
          summary: expect.stringContaining('sem resposta do executor'),
          output: { error: 'tool_result_timeout' },
        }),
      );
      expect(events.some((event) => event.channel === VOICE_CHANNELS.liveToolResult)).toBe(
        true,
      );
      expect(
        events.find((event) => event.channel === VOICE_CHANNELS.liveToolCancelled)
          ?.payload,
      ).toMatchObject({ callId: 'call_timeout', reason: 'timeout' });

      controller.toolResult({
        sessionId: session.getState().sessionId ?? 'session',
        at: 121_001,
        source: 'realtime',
        callId: 'call_timeout',
        name: 'nexus_action',
        tool: 'open_terminal',
        ok: true,
        summary: 'executor terminou depois do timeout',
        output: { effectCommitted: true },
      });
      expect(provider.sendToolResult).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.doUnmock('./voice-config-store');
      vi.doUnmock('./voice-secrets');
      vi.doUnmock('./jarvis-memory');
      vi.doUnmock('../jarvis/realtime/factory');
    }
  });

  it('returns structured errors for invalid realtime action arguments', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'openai', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];

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
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => 1000,
    );
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(
      (channel, payload) => events.push({ channel, payload }),
      session,
    );

    await controller.onStart();
    provider.fireToolCall({
      callId: 'call_bad',
      argumentsJson: '{"action":"open_workspace"}',
      arguments: { action: 'open_workspace' },
    });

    expect(provider.sendToolResult).toHaveBeenCalledWith(
      'call_bad',
      expect.objectContaining({
        ok: false,
        tool: 'none',
        summary: expect.stringContaining('ação realtime inválida'),
        output: expect.objectContaining({ error: 'invalid_action' }),
      }),
    );
    expect(events.some((event) => event.channel === VOICE_CHANNELS.liveToolResult)).toBe(
      true,
    );

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('bridges exact Gemini MCP declarations through the audited Jarvis executor path', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'openai', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];

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
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => 1000,
    );
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(
      (channel, payload) => events.push({ channel, payload }),
      session,
    );

    await controller.onStart();
    provider.fireToolCall({
      callId: 'call_mcp',
      name: 'nexus_git_status',
      argumentsJson: '{"short":true}',
      arguments: { short: true },
    });

    // The real MCP catalog loads on demand, outside the static boot graph.
    await vi.dynamicImportSettled();
    const toolCall = events.find((event) => event.channel === VOICE_CHANNELS.liveToolCall);
    expect(toolCall?.payload).toMatchObject({
      source: 'realtime',
      callId: 'call_mcp',
      name: 'nexus_action',
      tool: 'mcp_tool',
      summary: 'executar tool nexus_git_status',
      args: {
        action: 'mcp_tool',
        tool: 'nexus_git_status',
        args: { short: true },
      },
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('marks realtime not ready and reconnects after a post-setup disconnect', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const provider = fakeProvider(async () => {});
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
      voiceApiKeySource: () => 'env',
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

    await controller.onStart();
    provider.fireDisconnected(new Error('OpenAI realtime socket closed'));

    expect(provider.closeCalls).toBe(1);
    expect(session.getState()).toMatchObject({
      status: 'listening',
      realtimeReady: false,
      error: 'OpenAI realtime socket closed',
    });

    await vi.advanceTimersByTimeAsync(750);

    expect(provider.connect).toHaveBeenCalledTimes(2);
    expect(session.getState()).toMatchObject({
      status: 'listening',
      realtimeReady: true,
      error: undefined,
    });

    vi.useRealTimers();
    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('backs off and stops reconnecting when ready sockets keep flapping', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const providers = Array.from({ length: 4 }, () => fakeProvider(async () => {}));
    let providerIndex = 0;

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
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [
        {
          id: 'openai',
          provider: providers[Math.min(providerIndex++, providers.length - 1)],
        },
      ],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['openai'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();
    providers[0].fireDisconnected(new Error('flap 1'));
    await vi.advanceTimersByTimeAsync(750);
    expect(providers[1].connect).toHaveBeenCalledOnce();

    providers[1].fireDisconnected(new Error('flap 2'));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(providers[2].connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(providers[2].connect).toHaveBeenCalledOnce();

    providers[2].fireDisconnected(new Error('flap 3'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(providers[3].connect).toHaveBeenCalledOnce();

    providers[3].fireDisconnected(new Error('flap 4'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(providers[3].connect).toHaveBeenCalledOnce();
    expect(session.getState()).toMatchObject({
      status: 'error',
      realtimeReady: false,
    });

    vi.useRealTimers();
    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('opens the reconnect circuit when sockets emit one event then flap before stability', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const providers = Array.from({ length: 5 }, () => fakeProvider(async () => {}));
    let providerIndex = 0;

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [
        {
          id: 'gemini',
          provider: providers[Math.min(providerIndex++, providers.length - 1)],
        },
      ],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    try {
      const { LiveTransportController } = await import('./live-transport-controller');
      const session = new JarvisLiveSession(() => {}, () => 1_000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      const controller = new LiveTransportController(() => {}, session);

      await controller.onStart();
      for (let index = 0; index < 4; index += 1) {
        providers[index].fireAudioOut();
        providers[index].fireDisconnected(new Error(`eventual flap ${index + 1}`));
        await vi.advanceTimersByTimeAsync(10_000);
      }

      expect(providers[4].connect).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        status: 'error',
        realtimeReady: false,
      });
    } finally {
      vi.useRealTimers();
      vi.doUnmock('./voice-config-store');
      vi.doUnmock('./voice-secrets');
      vi.doUnmock('./jarvis-memory');
      vi.doUnmock('../jarvis/realtime/factory');
    }
  });

  it('does not treat a 30-second progress-timeout loop as a stable connection', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const providers = Array.from({ length: 5 }, () => fakeProvider(async () => {}));
    let providerIndex = 0;

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => [
        {
          id: 'gemini',
          provider: providers[Math.min(providerIndex++, providers.length - 1)],
        },
      ],
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    try {
      const { LiveTransportController } = await import('./live-transport-controller');
      const session = new JarvisLiveSession(() => {}, () => 1_000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      const controller = new LiveTransportController(() => {}, session);

      await controller.onStart();
      for (let index = 0; index < 4; index += 1) {
        // Mirrors Gemini's in-flight progress watchdog. A socket that only
        // survives until this deadline has delivered no useful response.
        await vi.advanceTimersByTimeAsync(30_000);
        providers[index].fireDisconnected(new Error('sem progresso por 30s'));
        if (index < 3) {
          await vi.advanceTimersByTimeAsync(750 * 2 ** index);
          expect(providers[index + 1].connect).toHaveBeenCalledOnce();
        }
      }

      await vi.advanceTimersByTimeAsync(120_000);
      expect(providers[4].connect).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        status: 'error',
        realtimeReady: false,
      });
    } finally {
      vi.useRealTimers();
      vi.doUnmock('./voice-config-store');
      vi.doUnmock('./voice-secrets');
      vi.doUnmock('./jarvis-memory');
      vi.doUnmock('../jarvis/realtime/factory');
    }
  });

  it('roteia a coarse tool "delegar" pelo mesmo executor auditado (send_to_pane)', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => 1000,
    );
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(
      (channel, payload) => events.push({ channel, payload }),
      session,
    );

    await controller.onStart();
    provider.fireToolCall({
      callId: 'call_delegar',
      name: 'delegar',
      arguments: { briefing: 'cria a landing page' },
    });

    // CRITICAL-1: o evento emitido ao renderer carrega name='nexus_action'
    // (coarse relabelada) + args em vocabulário Nexus + o callId ORIGINAL.
    const toolCall = events.find((event) => event.channel === VOICE_CHANNELS.liveToolCall);
    expect(toolCall?.payload).toMatchObject({
      source: 'realtime',
      callId: 'call_delegar',
      name: 'nexus_action',
      tool: 'send_to_pane',
      args: { action: 'send_to_pane', text: 'cria a landing page' },
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  // CRITICAL-1 (integração, sem tautologia): um toolCall `delegar` FAKE do Gemini
  // atravessa o transporte real → controller → o MESMO mapeamento do executor do
  // RENDERER (realtimeToolEventToJarvisAction) → o resultado do renderer volta
  // pelo controller e fecha o loop como toolResponse no provider. Prova que a
  // costura coarse→executor→toolResponse funciona ponta-a-ponta.
  it('leva um toolCall coarse (delegar) FAKE do Gemini pelo executor real do renderer até o toolResponse', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const emitted: Array<{ channel: string; payload: unknown }> = [];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');
    // Executor REAL do renderer (mapeia o evento emitido → JarvisAction). Se o
    // name não fosse 'nexus_action' ou o callId fosse vazio, devolveria null e o
    // toolResponse nunca fecharia — exatamente o CRITICAL-1.
    const { realtimeToolEventToJarvisAction } = await import(
      '../../renderer/voice/realtime-action'
    );

    const emit = (channel: string, payload: unknown) => emitted.push({ channel, payload });
    const session = new JarvisLiveSession(emit, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(emit, session);

    await controller.onStart();

    // Gemini dispara a função coarse `delegar`.
    provider.fireToolCall({
      callId: 'call_delegar',
      name: 'delegar',
      arguments: { briefing: 'cria a landing page' },
    });

    const toolCallEvent = emitted.find(
      (event) => event.channel === VOICE_CHANNELS.liveToolCall,
    )?.payload as import('../../shared/voice-ipc').JarvisLiveToolEvent;
    expect(toolCallEvent).toBeTruthy();

    // O renderer só executa se o executor real aceitar este evento.
    const action = realtimeToolEventToJarvisAction(toolCallEvent);
    expect(action).toEqual({ type: 'send_to_pane', text: 'cria a landing page' });

    // Renderer executou → devolve o liveToolResult com o MESMO callId. O
    // controller precisa transformá-lo em toolResponse ao provider.
    const rendererResult = session.toolResult({
      source: 'realtime',
      callId: toolCallEvent.callId!,
      name: toolCallEvent.name!,
      tool: action!.type,
      args: toolCallEvent.args,
      ok: true,
      summary: 'tarefa enviada ao pane',
      output: { ok: true, summary: 'tarefa enviada ao pane', tool: action!.type },
    });
    expect(rendererResult).toBeTruthy();
    controller.toolResult(rendererResult!);

    // Loop fechado: o provider recebeu o toolResponse com o callId original.
    expect(provider.sendToolResult).toHaveBeenCalledWith(
      'call_delegar',
      expect.objectContaining({ ok: true, tool: 'send_to_pane' }),
    );

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  // CRITICAL-2 (integração): uma pergunta pendente registrada + a próxima fala
  // FINAL do usuário → o roteamento determinístico dispara send_to_pane pelo
  // MESMO executor auditado do renderer, SEM devolver toolResponse ao modelo
  // (callId local). Prova que a rota chega ao send_to_pane ponta-a-ponta.
  it('roteia a resposta a uma pergunta pendente até o send_to_pane do executor real (sem toolResponse ao modelo)', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const emitted: Array<{ channel: string; payload: unknown }> = [];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController, isLocalToolCallId } = await import(
      './live-transport-controller'
    );
    const { realtimeToolEventToJarvisAction } = await import(
      '../../renderer/voice/realtime-action'
    );

    const emit = (channel: string, payload: unknown) => emitted.push({ channel, payload });
    const session = new JarvisLiveSession(emit, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(emit, session);

    await controller.onStart();
    controller.beginTurn('route-answer-turn');

    // Upstream: uma pane delegada narrou uma pergunta pendente.
    controller.noteNarratedQuestion('pane-42', 'Qual banco de dados devo usar?');

    // A PRÓXIMA fala final do usuário (não-UI, curta) é a resposta.
    provider.fireRoleTranscript({
      role: 'user',
      text: 'pode seguir com o postgres mesmo',
      final: true,
    });

    const routed = emitted.find(
      (event) => event.channel === VOICE_CHANNELS.liveToolCall,
    )?.payload as import('../../shared/voice-ipc').JarvisLiveToolEvent;
    expect(routed).toBeTruthy();
    expect(routed).toMatchObject({
      source: 'realtime',
      name: 'nexus_action',
      tool: 'send_to_pane',
      // NEW-B: the routed answer carries the ASKING pane (pane-42) verbatim.
      args: { action: 'send_to_pane', text: 'pode seguir com o postgres mesmo', paneId: 'pane-42' },
    });
    // callId LOCAL (não vazio) — o renderer aceita e executa.
    expect(routed.callId).toBeTruthy();
    expect(isLocalToolCallId(routed.callId!)).toBe(true);

    // Executor real do renderer aceita e mapeia para send_to_pane COM o paneId.
    expect(realtimeToolEventToJarvisAction(routed)).toEqual({
      type: 'send_to_pane',
      text: 'pode seguir com o postgres mesmo',
      paneId: 'pane-42',
    });

    // Renderer executou → devolve o resultado. O controller NÃO manda
    // toolResponse (callId local = ação iniciada pelo controller, não do modelo).
    const rendererResult = session.toolResult({
      source: 'realtime',
      callId: routed.callId!,
      name: routed.name!,
      tool: 'send_to_pane',
      args: routed.args,
      ok: true,
      summary: 'tarefa enviada ao pane',
      output: { ok: true, summary: 'tarefa enviada ao pane', tool: 'send_to_pane' },
    });
    controller.toolResult(rendererResult!);
    expect(provider.sendToolResult).not.toHaveBeenCalled();
    expect(
      emitted.filter((event) => event.channel === VOICE_CHANNELS.liveToolTurnComplete),
    ).toContainEqual({
      channel: VOICE_CHANNELS.liveToolTurnComplete,
      payload: expect.objectContaining({
        sessionId: session.getState().sessionId,
        turnId: 'route-answer-turn',
        callId: routed.callId,
      }),
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  // CRITICAL-2 (upstream): o QUESTION_POLL injetado alimenta noteNarratedQuestion
  // — sem ele, o router nunca teria uma pergunta e a rota seria inerte.
  it('QUESTION_POLL: registra perguntas pendentes da source injetada ao conectar', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const emitted: Array<{ channel: string; payload: unknown }> = [];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');

    const emit = (channel: string, payload: unknown) => emitted.push({ channel, payload });
    const session = new JarvisLiveSession(emit, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const source = {
      poll: () => [{ paneId: 'pane-7', questionHash: 'Menu com 3 opções. Qual?' }],
    };
    const controller = new LiveTransportController(emit, session, () => 1000, source);

    await controller.onStart();

    // O poll rodou uma vez ao conectar → a pergunta está registrada. Provamos
    // roteando a próxima fala final (curta, não-UI) para send_to_pane.
    provider.fireRoleTranscript({ role: 'user', text: 'a opção dois', final: true });
    const routed = emitted.find(
      (event) => event.channel === VOICE_CHANNELS.liveToolCall,
    )?.payload as import('../../shared/voice-ipc').JarvisLiveToolEvent;
    expect(routed).toMatchObject({
      name: 'nexus_action',
      args: { action: 'send_to_pane', text: 'a opção dois', paneId: 'pane-7' },
    });

    controller.onStop();

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('responde "consultar" direto do contexto injetado (sem bloquear no brain)', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();
    controller.contextIn('Tela: 3 panes abertos, terminal focado.');
    provider.fireToolCall({
      callId: 'call_consultar',
      name: 'consultar',
      arguments: { pergunta: 'quais panes?' },
    });

    expect(provider.sendToolResult).toHaveBeenCalledWith(
      'call_consultar',
      expect.objectContaining({
        ok: true,
        output: expect.stringContaining('3 panes abertos'),
      }),
    );

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('rejeita coarse tool inválida (delegar sem briefing) com erro estruturado', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();
    provider.fireToolCall({ callId: 'call_bad', name: 'delegar', arguments: {} });

    expect(provider.sendToolResult).toHaveBeenCalledWith(
      'call_bad',
      expect.objectContaining({ ok: false, output: { error: 'invalid_action' } }),
    );

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  // MEDIUM-5: "encerrar" devolve a despedida E encerra de fato — fecha o
  // provider/socket realtime (o Classic segue armado).
  it('encerra a sessão realtime ao processar a tool "encerrar"', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();
    expect(provider.isReady).toBe(true);
    // ITEM 3: only honored after an explicit farewell utterance.
    provider.fireRoleTranscript({ role: 'user', text: 'é só isso, valeu, tchau', final: true });
    provider.fireToolCall({ callId: 'call_bye', name: 'encerrar', arguments: {} });

    // Devolveu a despedida (toolResponse) …
    expect(provider.sendToolResult).toHaveBeenCalledWith(
      'call_bye',
      expect.objectContaining({ ok: true, output: { ended: true } }),
    );
    // … e derrubou o socket realtime.
    expect(provider.closeCalls).toBe(1);
    expect(provider.isReady).toBe(false);
    expect(session.getState()).toMatchObject({ realtimeReady: false });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  // ITEM 3: `encerrar` misfire (no goodbye) must NOT end — session stays alive.
  it('rejeita "encerrar" sem despedida explícita e mantém a sessão viva', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    await controller.onStart();
    expect(provider.isReady).toBe(true);
    // The user asked a normal question — the model misfires `encerrar`.
    provider.fireRoleTranscript({ role: 'user', text: 'me explica o que é impersonar', final: true });
    provider.fireToolCall({ callId: 'call_bye', name: 'encerrar', arguments: {} });

    // Rejected (kept session), NOT ended.
    expect(provider.sendToolResult).toHaveBeenCalledWith(
      'call_bye',
      expect.objectContaining({ ok: false }),
    );
    expect(provider.closeCalls).toBe(0);
    expect(provider.isReady).toBe(true);
    expect(session.getState()).toMatchObject({ realtimeReady: true });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('roteia a resposta a uma pergunta pendente ao pane (send_to_pane, sem toolResponse)', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => 1000,
    );
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(
      (channel, payload) => events.push({ channel, payload }),
      session,
    );

    await controller.onStart();
    // a working pane narrated a pending question
    controller.noteNarratedQuestion('pane-7', 'Qual banco: Postgres ou SQLite?');
    // the user answers by voice (final transcript)
    provider.fireRoleTranscript({ role: 'user', text: 'Postgres', final: true });

    const routed = events
      .filter((e) => e.channel === VOICE_CHANNELS.liveToolCall)
      .map((e) => e.payload)
      .find((p) => (p as { tool?: string }).tool === 'send_to_pane');
    expect(routed).toMatchObject({
      source: 'realtime',
      tool: 'send_to_pane',
      // NEW-B: the ASKING pane (pane-7) is threaded into the routed action.
      args: { action: 'send_to_pane', text: 'Postgres', paneId: 'pane-7' },
    });
    // callId vazio ⇒ nenhuma toolResponse ao modelo
    expect(provider.sendToolResult).not.toHaveBeenCalled();

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('não roteia fala de UI mesmo com pergunta pendente', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => 1000,
    );
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(
      (channel, payload) => events.push({ channel, payload }),
      session,
    );

    await controller.onStart();
    controller.noteNarratedQuestion('pane-7', 'Qual banco?');
    provider.fireRoleTranscript({ role: 'user', text: 'abre o grid', final: true });

    const routed = events
      .filter((e) => e.channel === VOICE_CHANNELS.liveToolCall)
      .map((e) => e.payload)
      .find((p) => (p as { tool?: string }).tool === 'send_to_pane');
    expect(routed).toBeUndefined();

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  // FIX 4: o mesmo gate de ruído do Classic vale no caminho live — um transcript
  // "user" de ≤3 tokens todo-ruído (alucinação/ambiente) é descartado ANTES de
  // virar turno. Prova: com pergunta pendente, um ruído NÃO roteia send_to_pane.
  it('FIX 4: descarta transcript live de ruído/ambiente antes de virar turno', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];
    const logCalls: string[] = [];

    vi.doMock('./voice-log', () => ({
      logVoice: (_level: string, event: string) => logCalls.push(event),
    }));
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');
    const emit = (channel: string, payload: unknown) => events.push({ channel, payload });
    const session = new JarvisLiveSession(emit, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(emit, session);

    await controller.onStart();
    controller.noteNarratedQuestion('pane-7', 'Qual banco?');
    // Ruído puro (2 tokens, ambos ruído) — jamais um comando real.
    provider.fireRoleTranscript({ role: 'user', text: 'hum ah', final: true });

    const routed = events
      .filter((e) => e.channel === VOICE_CHANNELS.liveToolCall)
      .map((e) => e.payload)
      .find((p) => (p as { tool?: string }).tool === 'send_to_pane');
    expect(routed).toBeUndefined();
    expect(logCalls).toContain('live.noiseDiscarded');

    vi.doUnmock('./voice-log');
    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  // FIX 2: eco do ack/TTS que volta pelo mic (full-duplex, AEC off) como
  // transcript "user" é descartado pelo input-side isEcho — não vira turno nem
  // resposta. O ack é gravado na janela de eco quando tocado (recordEcho).
  it('FIX 2: descarta eco do ack no transcript live (input-side isEcho)', async () => {
    vi.resetModules();
    const provider = fakeProvider(async () => {});
    const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
    const events: Array<{ channel: string; payload: unknown }> = [];
    const logCalls: string[] = [];

    vi.doMock('./voice-log', () => ({
      logVoice: (_level: string, event: string) => logCalls.push(event),
    }));
    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'gemini-live',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({ resolveVoiceApiKey: () => 'key', voiceApiKeySource: () => 'env' }));
    vi.doMock('./jarvis-memory', () => ({ jarvisMemory: { factsBlock: () => '' } }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['gemini'],
    }));

    const { VOICE_CHANNELS } = await import('../../shared/voice-channels');
    const { LiveTransportController } = await import('./live-transport-controller');
    const { echoSuppressor } = await import('./echo-suppress');
    echoSuppressor.reset();
    // Ack tocado → gravado na janela de eco (renderer chama recordEcho no wake).
    echoSuppressor.record('Pois não?');

    const emit = (channel: string, payload: unknown) => events.push({ channel, payload });
    const session = new JarvisLiveSession(emit, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(emit, session);

    await controller.onStart();
    controller.noteNarratedQuestion('pane-7', 'Qual banco?');
    // A própria saudação da JARVIS voltando pelo mic (não é ruído — 2 palavras
    // reais — então só o gate de eco a pega, provando o input-side isEcho).
    provider.fireRoleTranscript({ role: 'user', text: 'Pois não', final: true });

    const routed = events
      .filter((e) => e.channel === VOICE_CHANNELS.liveToolCall)
      .map((e) => e.payload)
      .find((p) => (p as { tool?: string }).tool === 'send_to_pane');
    expect(routed).toBeUndefined();
    expect(logCalls).toContain('live.inputEchoDiscarded');
    echoSuppressor.reset();

    vi.doUnmock('./voice-log');
    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('troca de chave durante conexão pendente: a rejeição tardia não publica falha antiga', async () => {
    vi.resetModules();
    const pending = deferred();
    const openai = fakeProvider(() => pending.promise);
    const gemini = fakeProvider(async () => {});
    let candidates: RealtimeProviderCandidate[] = [
      { id: 'openai', provider: openai, model: 'gpt-realtime-2.1-mini' },
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
      voiceApiKeySource: () => 'env',
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

    const started = controller.onStart();
    expect(openai.connect).toHaveBeenCalledTimes(1);

    // setKey no voice-ipc: hardStop + clearRealtimeFailure.
    controller.hardStop();
    controller.clearRealtimeFailure();

    // O socket antigo morre depois: a rejeição chega com a rota já invalidada.
    pending.reject(new Error('websocket closed before setup'));
    await started;

    expect(session.getState().realtimeFailure ?? null).toBeNull();
    expect(session.getState().status).not.toBe('error');
    // O 2º candidato da cadeia ANTIGA não é tentado.
    expect(gemini.connect).not.toHaveBeenCalled();

    // A conexão nova (chave nova) não é afetada pela tentativa morta.
    const fresh = fakeProvider(async () => {});
    candidates = [{ id: 'openai', provider: fresh, model: 'gpt-realtime-2.1-mini' }];
    await controller.onStart();
    expect(fresh.connect).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({
      realtimeReady: true,
      realtimeProvider: 'openai',
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('troca de modelo durante conexão pendente: a falha do modelo antigo não sobe ao chip', async () => {
    vi.resetModules();
    const pending = deferred();
    const grokOld = fakeProvider(() => pending.promise);
    const openai = fakeProvider(async () => {});
    let candidates: RealtimeProviderCandidate[] = [
      { id: 'grok', provider: grokOld, model: 'grok-voice-2.0' },
      { id: 'openai', provider: openai, model: 'gpt-realtime-2.1-mini' },
    ];

    vi.doMock('./voice-config-store', () => ({
      getVoiceConfig: () => ({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: true,
          transport: 'grok-realtime',
        },
      }),
    }));
    vi.doMock('./voice-secrets', () => ({
      resolveVoiceApiKey: () => 'key',
      voiceApiKeySource: () => 'env',
    }));
    vi.doMock('./jarvis-memory', () => ({
      jarvisMemory: { factsBlock: () => '' },
    }));
    vi.doMock('../jarvis/realtime/factory', () => ({
      createRealtimeProviderCandidates: () => candidates,
      loadJarvisSystemPrompt: () => 'You are Jarvis.',
      resolveRealtimeProviderIds: () => ['grok', 'openai'],
    }));

    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const controller = new LiveTransportController(() => {}, session);

    const started = controller.onStart();
    expect(grokOld.connect).toHaveBeenCalledTimes(1);

    // setConfig no voice-ipc (modelo novo): hardStop + clearRealtimeFailure.
    controller.hardStop();
    controller.clearRealtimeFailure();

    // A recusa do modelo ANTIGO chega tarde — era da configuração anterior.
    pending.reject(new Error('Unexpected server response: 404'));
    await started;

    const state = session.getState();
    expect(state.realtimeFailure ?? null).toBeNull();
    expect(state.status).not.toBe('error');
    expect(JSON.stringify(state)).not.toContain('grok-voice-2.0');
    // O fallback da cadeia antiga também não é tentado.
    expect(openai.connect).not.toHaveBeenCalled();

    // A cadeia nova (modelo novo) conecta normalmente.
    const grokNew = fakeProvider(async () => {});
    candidates = [{ id: 'grok', provider: grokNew, model: 'grok-voice-3.0' }];
    await controller.onStart();
    expect(grokNew.connect).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({
      realtimeReady: true,
      realtimeProvider: 'grok',
    });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('não chama response.cancel quando a sessão está dormant', async () => {
    const provider = fakeProvider(async () => {});
    const { LiveTransportController } = await import('./live-transport-controller');
    const session = new JarvisLiveSession(() => {}, () => 1000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    session.patchStatus({ status: 'dormant', realtimeReady: true });
    const interrupt = vi.fn();
    const controller = new LiveTransportController(() => {}, session);
    (controller as unknown as { provider: typeof provider }).provider = {
      ...provider,
      interrupt,
    };
    controller.interrupt('wake-ack');
    expect(interrupt).not.toHaveBeenCalled();
  });
});

describe('isIgnorableRealtimeError', () => {
  it('ignora cancel sem response ativa', async () => {
    const { isIgnorableRealtimeError } = await import('./live-transport-controller');
    expect(isIgnorableRealtimeError('Cancellation failed: no active response')).toBe(true);
    expect(isIgnorableRealtimeError('OpenAI realtime socket closed')).toBe(false);
  });
});
