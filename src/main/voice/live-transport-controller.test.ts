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
} {
  let ready = false;
  let closeCalls = 0;
  const disconnectedCallbacks: Array<(err: Error) => void> = [];
  const toolCallCallbacks: Parameters<TurnManagedRealtimeProvider['onToolCall']>[0][] = [];
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

    expect(session.getState()).toMatchObject({
      status: 'error',
      realtimeReady: false,
      error: 'realtime sem credencial disponível — usando Classic',
    });

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
