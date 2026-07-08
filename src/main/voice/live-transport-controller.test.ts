import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../shared/voice-config';
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
  fireRoleTranscript(line: { role: 'user' | 'assistant'; text: string; final: boolean }): void;
} {
  let ready = false;
  let closeCalls = 0;
  const disconnectedCallbacks: Array<(err: Error) => void> = [];
  const toolCallCallbacks: Parameters<TurnManagedRealtimeProvider['onToolCall']>[0][] = [];
  const roleTranscriptCallbacks: Parameters<
    TurnManagedRealtimeProvider['onRoleTranscript']
  >[0][] = [];
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
    onRoleTranscript: vi.fn((cb) => {
      roleTranscriptCallbacks.push(cb);
    }),
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
    sendToolResult: vi.fn(),
    onToolCall: vi.fn((cb) => {
      toolCallCallbacks.push(cb);
    }),
    onInterrupted: vi.fn(),
    onResponseDone: vi.fn(),
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
    fireRoleTranscript(line) {
      for (const cb of roleTranscriptCallbacks) cb(line);
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
  });

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

    expect(provider.sendText).toHaveBeenCalledWith(
      expect.stringContaining('Abrindo um terminal, patrão.'),
    );
    expect(state).toMatchObject({ status: 'thinking', realtimeReady: true });

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  });

  it('buffers mic frames while the realtime provider is connecting', async () => {
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
    expect(Array.from(vi.mocked(provider.sendAudioChunk).mock.calls[0][0])).toEqual([
      1, 2, 3,
    ]);
    expect(Array.from(vi.mocked(provider.sendAudioChunk).mock.calls[1][0])).toEqual([
      4, 5, 6,
    ]);
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
    controller.contextIn('Workspace nexus em canvas com terminal focado.');

    expect(provider.sendContext).not.toHaveBeenCalled();

    pending.resolve();
    await started;

    expect(provider.sendContext).toHaveBeenCalledWith(
      expect.stringContaining('Workspace nexus em canvas com terminal focado.'),
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
    controller.contextIn('Workspace nexus em canvas.');
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
    provider.fireToolCall();

    const toolCall = events.find((event) => event.channel === VOICE_CHANNELS.liveToolCall);
    expect(toolCall?.payload).toMatchObject({
      source: 'realtime',
      callId: 'call_1',
      name: 'nexus_action',
      tool: 'open_terminal',
      args: { action: 'open_terminal' },
    });

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

    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
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

      await vi.advanceTimersByTimeAsync(10_000);

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

  it('bridges realtime MCP tool calls through the audited Jarvis executor path', async () => {
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
      argumentsJson:
        '{"action":"mcp_tool","tool":"nexus_git_status","args":{"short":true}}',
      arguments: {
        action: 'mcp_tool',
        tool: 'nexus_git_status',
        args: { short: true },
      },
    });

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
