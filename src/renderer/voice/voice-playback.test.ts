/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playAudioBase64, playSpeakResult } from './voice-playback';
import { isResponseMuted } from './response-output-gate';

vi.mock('./voice-store', () => ({
  useVoiceStore: { getState: () => ({ info: null, status: 'idle' }) },
}));
vi.mock('./response-output-gate', () => ({ isResponseMuted: vi.fn(() => false) }));
vi.mock('./audio-device-preferences', () => ({
  requirePreferredOutputDevice: vi.fn(async () => undefined),
}));
vi.mock('./live-local-audio-gate', () => ({
  clearLocalAudioGate: vi.fn(),
  markLocalAudioPlaying: vi.fn(),
}));

const WAV_BASE64 = btoa(
  String.fromCharCode(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0),
);

describe('playAudioBase64', () => {
  let decoded: number;
  let started: number;

  beforeEach(() => {
    decoded = 0;
    started = 0;
    vi.mocked(isResponseMuted).mockReturnValue(false);

    class FakeAudioBufferSource {
      buffer: unknown = null;
      onended: (() => void) | null = null;
      connect() {}
      start() {
        started += 1;
        // O browser dispara `onended` quando o buffer acaba; sem isso a
        // promise de playback nunca resolve e o teste expira.
        this.onended?.();
      }
      stop() {}
    }

    class FakeAudioContext {
      state = 'running';
      destination = {};
      async resume() {}
      close() {}
      createBufferSource() {
        return new FakeAudioBufferSource();
      }
      async decodeAudioData() {
        decoded += 1;
        return { duration: 0.5 };
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        voice: {
          logVoice: vi.fn(),
          stopSpeak: vi.fn(async () => {}),
          liveInterrupt: vi.fn(async () => {}),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('respostas mutadas: a fala normal não toca (0 ms)', async () => {
    vi.mocked(isResponseMuted).mockReturnValue(true);
    const duration = await playAudioBase64(WAV_BASE64, 'wav');
    expect(duration).toBe(0);
    expect(decoded).toBe(0);
  });

  it('ignoreMute: a pré-escuta toca mesmo com as respostas mutadas', async () => {
    vi.mocked(isResponseMuted).mockReturnValue(true);
    const duration = await playAudioBase64(WAV_BASE64, 'wav', undefined, {
      ignoreMute: true,
    });
    expect(duration).toBe(500);
    expect(decoded).toBe(1);
    expect(started).toBe(1);
  });

  it('playSpeakResult repassa ignoreMute só quando pedido', async () => {
    vi.mocked(isResponseMuted).mockReturnValue(true);
    const result = await playSpeakResult(
      {
        ok: true,
        provider: 'gemini',
        mode: 'audio',
        format: 'wav',
        audioBase64: WAV_BASE64,
      },
      undefined,
      { ignoreMute: true },
    );
    expect(result).toBe(500);

    vi.mocked(isResponseMuted).mockReturnValue(true);
    const muted = await playSpeakResult({
      ok: true,
      provider: 'gemini',
      mode: 'audio',
      format: 'wav',
      audioBase64: WAV_BASE64,
    });
    expect(muted).toBe(0);
  });
});
