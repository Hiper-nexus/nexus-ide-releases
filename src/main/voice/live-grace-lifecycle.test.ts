/**
 * P4 — softStop / grace / warm-reuse lifecycle (peer ADE F-107 / F-139).
 * Kept in a dedicated file so live-transport-controller.test.ts stays under
 * the 800-line module cap.
 */
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../shared/voice-config';
import { JarvisLiveSession } from './jarvis-live';
import type { TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';
import type { RealtimeProviderCandidate } from '../jarvis/realtime/factory';

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
    sendToolResult: vi.fn(),
    onToolCall: vi.fn(),
    onInterrupted: vi.fn(),
    onResponseDone: vi.fn(),
    onDisconnected: vi.fn(),
  };
}

async function withGeminiMocks(
  provider: TurnManagedRealtimeProvider,
  run: (
    LiveTransportController: typeof import('./live-transport-controller').LiveTransportController,
    logVoiceSpy: MockInstance,
  ) => Promise<void>,
): Promise<void> {
  vi.resetModules();
  const candidates: RealtimeProviderCandidate[] = [{ id: 'gemini', provider }];
  vi.doMock('./voice-config-store', () => ({
    getVoiceConfig: () => ({
      ...DEFAULT_VOICE_CONFIG,
      jarvisLive: {
        ...DEFAULT_VOICE_CONFIG.jarvisLive,
        enabled: true,
        transport: 'gemini-live',
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
    resolveRealtimeProviderIds: () => ['gemini'],
  }));

  const voiceLog = await import('./voice-log');
  const logVoiceSpy = vi.spyOn(voiceLog, 'logVoice');
  const { LiveTransportController } = await import('./live-transport-controller');
  try {
    await run(LiveTransportController, logVoiceSpy);
  } finally {
    logVoiceSpy.mockRestore();
    vi.doUnmock('./voice-config-store');
    vi.doUnmock('./voice-secrets');
    vi.doUnmock('./jarvis-memory');
    vi.doUnmock('../jarvis/realtime/factory');
  }
}

describe('LiveTransportController P4 grace lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onStop soft-stops: keeps socket warm, marks dormant, does not close provider', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      const controller = new LiveTransportController(() => {}, session);

      await controller.onStart({ freshTurn: true });
      expect(session.getState().realtimeReady).toBe(true);

      controller.onStop();
      expect(controller.inGrace).toBe(true);
      expect(provider.closeCalls).toBe(0);
      expect(session.getState()).toMatchObject({
        status: 'dormant',
        realtimeReady: false,
      });
    });
  }, 15_000);

  it('onStart during grace discards the warm socket and reconnects fresh', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      let now = 1_000;
      const controller = new LiveTransportController(() => {}, session, () => now);

      await controller.onStart({ freshTurn: true });
      expect(provider.connect).toHaveBeenCalledTimes(1);
      expect(provider.close).not.toHaveBeenCalled();

      controller.onStop();
      expect(controller.inGrace).toBe(true);

      now = 2_000;
      await controller.onStart({ freshTurn: true });
      expect(provider.connect).toHaveBeenCalledTimes(2);
      expect(provider.close).toHaveBeenCalledTimes(1);
      expect(controller.inGrace).toBe(false);
      expect(session.getState()).toMatchObject({
        status: 'listening',
        realtimeReady: true,
      });
    });
  });

  it('reconnects fresh after a long quiet period instead of sending wake text into a zombie', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      let now = 1_000;
      const controller = new LiveTransportController(() => {}, session, () => now);

      await controller.onStart({ freshTurn: true });
      expect(provider.connect).toHaveBeenCalledTimes(1);
      controller.onStop();
      expect(controller.inGrace).toBe(true);

      now = 61_000;
      await controller.onStart({ freshTurn: true });
      controller.contextIn('[wake] diga Olá.');

      expect(provider.connect).toHaveBeenCalledTimes(2);
      expect(provider.close).toHaveBeenCalledTimes(1);
      expect(provider.interrupt).not.toHaveBeenCalled();
      expect(provider.sendText).toHaveBeenCalledWith('[wake] diga Olá.');
      expect(controller.inGrace).toBe(false);
    });
  });

  it('hardStop closes the socket immediately (farewell path)', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      const controller = new LiveTransportController(() => {}, session);

      await controller.onStart();
      controller.hardStop();
      expect(provider.closeCalls).toBe(1);
      expect(controller.inGrace).toBe(false);
      expect(session.getState().realtimeReady).toBe(false);
    });
  });

  it('records final transcripts into liveHistory and injects [reconexão] on reconnect', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      const controller = new LiveTransportController(() => {}, session);

      await controller.onStart();
      controller.recordLiveHistory('user', 'abre o terminal');
      controller.recordLiveHistory('assistant', 'Abrindo o terminal, patrão.');
      expect(controller.liveHistory).toHaveLength(2);

      controller.hardStop();
      // Fresh connect after hard stop should still inject resume if history kept
      // (hardStop keeps history; only enterDormant after idle clears provider)
      await controller.onStart();
      const ctxCalls = vi.mocked(provider.sendContext).mock.calls.map((c) => String(c[0]));
      expect(ctxCalls.some((t) => t.includes('[reconexão]'))).toBe(true);
    });
  });

  it('restores project conversation on construction and persists completed live turns', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      const conversation = {
        resume: vi.fn(() => [
          { role: 'user' as const, content: 'qual era a decisão?' },
          { role: 'assistant' as const, content: 'Manter a memória no Nexus.' },
        ]),
        record: vi.fn(),
        clear: vi.fn(),
      };
      const controller = new LiveTransportController(
        () => {},
        session,
        () => 1000,
        undefined,
        undefined,
        undefined,
        conversation,
      );

      expect(controller.liveHistory).toEqual([
        { role: 'user', text: 'qual era a decisão?' },
        { role: 'assistant', text: 'Manter a memória no Nexus.' },
      ]);

      controller.recordLiveHistory('user', 'e o próximo passo?');
      controller.recordLiveHistory('assistant', 'Persistir o modo Realtime.');
      expect(conversation.record).toHaveBeenCalledWith(
        'e o próximo passo?',
        'Persistir o modo Realtime.',
      );
    });
  });

  it('logs a broken conversation store only once while keeping live history bounded', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController, logVoiceSpy) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      const conversation = {
        resume: vi.fn(() => []),
        record: vi.fn(() => {
          throw new Error('disk unavailable');
        }),
        clear: vi.fn(),
      };
      const controller = new LiveTransportController(
        () => {},
        session,
        () => 1000,
        undefined,
        undefined,
        undefined,
        conversation,
      );

      controller.recordLiveHistory('user', 'primeira pergunta');
      controller.recordLiveHistory('assistant', 'primeira resposta');
      controller.recordLiveHistory('user', 'segunda pergunta');
      controller.recordLiveHistory('assistant', 'segunda resposta');

      expect(conversation.record).toHaveBeenCalledTimes(2);
      expect(controller.liveHistory).toHaveLength(4);
      expect(
        logVoiceSpy.mock.calls.filter(
          (call) => call[1] === 'live.conversationRecordFailed',
        ),
      ).toHaveLength(1);
    });
  });

  it('does not pair an abandoned prompt with a later assistant transcript', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const lifecycleBoundaries = [
        'interrupt',
        'onStop',
        'hardStop',
        'enterDormant',
      ] as const;
      for (const boundary of lifecycleBoundaries) {
        const conversation = {
          resume: vi.fn(() => []),
          record: vi.fn(),
          clear: vi.fn(),
        };
        const controller = new LiveTransportController(
          () => {},
          new JarvisLiveSession(() => {}, () => 1000),
          () => 1000,
          undefined,
          undefined,
          undefined,
          conversation,
        );
        controller.recordLiveHistory('user', `abandoned by ${boundary}`);
        if (boundary === 'interrupt') controller.interrupt('test');
        else controller[boundary]();
        controller.recordLiveHistory('assistant', 'late response');
        expect(conversation.record, boundary).not.toHaveBeenCalled();
      }
    });
  });
});
