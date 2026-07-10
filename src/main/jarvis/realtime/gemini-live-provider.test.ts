import { describe, expect, it, vi } from 'vitest';
import type { WsLike } from '../../voice/gemini-live-transport';
import { GeminiLiveProvider } from './gemini-live-provider';
import { createGeminiRealtimeTools } from './gemini-realtime-tools';
import { createNexusRealtimeTools } from './nexus-realtime-tools';

function fakeWs(): WsLike & {
  fire(event: 'open' | 'message' | 'close' | 'error', payload?: unknown): void;
} {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on(event, cb) {
      const callbacks = listeners.get(event) ?? [];
      callbacks.push(cb);
      listeners.set(event, callbacks);
    },
    fire(event, payload) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

function makeProvider(ws: WsLike): GeminiLiveProvider {
  return new GeminiLiveProvider({
    apiKey: 'k',
    model: 'gemini-live',
    voiceName: 'Charon',
    instructions: 'Responda em português brasileiro (pt-BR).',
    deps: {
      wsFactory: () => ws,
      now: () => 1_000,
      setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    },
  });
}

describe('GeminiLiveProvider lifecycle composition', () => {
  it('rejeita close antes do setup sem emitir desconexão runtime', async () => {
    const ws = fakeWs();
    const provider = makeProvider(ws);
    const disconnected = vi.fn();
    provider.onDisconnected(disconnected);

    const connecting = provider.connect();
    ws.fire('open');
    ws.fire('close');

    await expect(connecting).rejects.toThrow('closed before setup');
    expect(disconnected).not.toHaveBeenCalled();
  });

  it('emite desconexão runtime somente depois de uma sessão ready', async () => {
    const ws = fakeWs();
    const provider = makeProvider(ws);
    const disconnected = vi.fn();
    provider.onDisconnected(disconnected);

    const connecting = provider.connect();
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    await expect(connecting).resolves.toBeUndefined();

    ws.fire('close');
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('propaga toolCallCancellation com a identidade original', async () => {
    const ws = fakeWs();
    const provider = makeProvider(ws);
    const cancelled = vi.fn();
    provider.onToolCallCancelled(cancelled);

    const connecting = provider.connect();
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    await connecting;
    ws.fire(
      'message',
      JSON.stringify({
        toolCall: {
          functionCalls: [{ id: 'call-cancel', name: 'navegar', args: {} }],
        },
      }),
    );
    ws.fire(
      'message',
      JSON.stringify({ toolCallCancellation: { ids: ['call-cancel'] } }),
    );

    expect(cancelled).toHaveBeenCalledWith('call-cancel');
  });

  it('entrega nexus_action ao setup do transporte Gemini', async () => {
    const ws = fakeWs();
    const provider = new GeminiLiveProvider({
      apiKey: 'k',
      model: 'gemini-live',
      voiceName: 'Charon',
      instructions: 'Use nexus_action com guardrails.',
      tools: createGeminiRealtimeTools([], createNexusRealtimeTools()),
      deps: {
        wsFactory: () => ws,
        now: () => 1_000,
        setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
        clearTimeoutFn: () => {},
      },
    });

    const connecting = provider.connect();
    ws.fire('open');
    const setup = JSON.parse(
      String(vi.mocked(ws.send).mock.calls[0]?.[0]),
    ) as {
      setup: { tools: Array<{ functionDeclarations: Array<{ name: string }> }> };
    };
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    await connecting;

    expect(
      setup.setup.tools[0].functionDeclarations.map((tool) => tool.name),
    ).toContain('nexus_action');
  });

  it('preserves the original function name when a result completes after reconnect', async () => {
    const ws = fakeWs();
    const provider = makeProvider(ws);
    const connecting = provider.connect();
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    await connecting;
    // A resumed Gemini socket reissues the pending call id before accepting a
    // response. The controller's exactly-once registry retains the original
    // declaration name even if the replay payload is inconsistent.
    ws.fire(
      'message',
      JSON.stringify({
        toolCall: {
          functionCalls: [
            { id: 'call-resumed', name: 'unexpected_alias', args: {} },
          ],
        },
      }),
    );

    provider.sendNamedToolResult('call-resumed', 'nexus_git_status', {
      ok: true,
      summary: 'working tree clean',
    });

    const payload = JSON.parse(
      String(vi.mocked(ws.send).mock.calls.at(-1)?.[0]),
    ) as {
      toolResponse: {
        functionResponses: Array<{ id: string; name: string }>;
      };
    };
    expect(payload.toolResponse.functionResponses[0]).toMatchObject({
      id: 'call-resumed',
      name: 'nexus_git_status',
    });
  });

  it('resumes with the opaque server handle and publishes its replacement', async () => {
    const ws = fakeWs();
    const onResumptionHandle = vi.fn();
    const provider = new GeminiLiveProvider({
      apiKey: 'k',
      model: 'gemini-live',
      voiceName: 'Charon',
      instructions: 'Responda em português brasileiro (pt-BR).',
      resumeHandle: 'resume-old',
      onResumptionHandle,
      deps: {
        wsFactory: () => ws,
        now: () => 1_000,
        setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
        clearTimeoutFn: () => {},
      },
    });

    const connecting = provider.connect();
    ws.fire('open');
    const setup = JSON.parse(String(vi.mocked(ws.send).mock.calls[0]?.[0])) as {
      setup: { sessionResumption: { handle?: string } };
    };
    expect(setup.setup.sessionResumption.handle).toBe('resume-old');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    await connecting;
    ws.fire(
      'message',
      JSON.stringify({
        sessionResumptionUpdate: { resumable: true, newHandle: 'resume-new' },
      }),
    );
    expect(onResumptionHandle).toHaveBeenCalledWith('resume-new');
  });

  it('returns an in-flight tool result immediately after session resumption', async () => {
    const ws = fakeWs();
    const provider = makeProvider(ws);
    const connecting = provider.connect();
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    await connecting;

    provider.sendNamedToolResult('call-from-previous-socket', 'nexus_git_status', {
      ok: true,
    });

    const payload = JSON.parse(
      String(vi.mocked(ws.send).mock.calls.at(-1)?.[0]),
    ) as {
      toolResponse?: { functionResponses: Array<{ id: string; name: string }> };
    };
    expect(payload.toolResponse?.functionResponses[0]).toMatchObject({
      id: 'call-from-previous-socket',
      name: 'nexus_git_status',
    });
  });
});
