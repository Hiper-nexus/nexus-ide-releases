/**
 * P4 — softStop / grace / warm-reuse lifecycle (Overclock F-107 / F-139).
 * Kept in a dedicated file so live-transport-controller.test.ts stays under
 * the 800-line module cap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  run: (LiveTransportController: typeof import('./live-transport-controller').LiveTransportController) => Promise<void>,
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

  const { LiveTransportController } = await import('./live-transport-controller');
  try {
    await run(LiveTransportController);
  } finally {
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

      await controller.onStart();
      expect(session.getState().realtimeReady).toBe(true);

      controller.onStop();
      expect(controller.inGrace).toBe(true);
      expect(provider.closeCalls).toBe(0);
      expect(session.getState()).toMatchObject({
        status: 'dormant',
        realtimeReady: false,
      });
    });
  });

  it('onStart during grace promotes the warm socket (no second connect)', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      let now = 1_000;
      const controller = new LiveTransportController(() => {}, session, () => now);

      await controller.onStart();
      expect(provider.connect).toHaveBeenCalledTimes(1);

      controller.onStop();
      expect(controller.inGrace).toBe(true);

      now = 2_000;
      await controller.onStart();
      expect(provider.connect).toHaveBeenCalledTimes(1);
      expect(controller.inGrace).toBe(false);
      expect(session.getState()).toMatchObject({
        status: 'listening',
        realtimeReady: true,
      });
    });
  });

  it('reuses a ready socket after a long quiet period instead of treating silence as stale', async () => {
    const provider = fakeProvider(async () => {});
    await withGeminiMocks(provider, async (LiveTransportController) => {
      const session = new JarvisLiveSession(() => {}, () => 1000);
      session.setEnabled(true);
      session.start({ reason: 'manual' });
      let now = 1_000;
      const controller = new LiveTransportController(() => {}, session, () => now);

      await controller.onStart();
      expect(provider.connect).toHaveBeenCalledTimes(1);
      controller.onStop();
      expect(controller.inGrace).toBe(true);

      now = 61_000;
      await controller.onStart();
      controller.contextIn('[wake] diga Olá.');

      expect(provider.connect).toHaveBeenCalledTimes(1);
      expect(provider.close).not.toHaveBeenCalled();
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
});
