/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  playAudioBase64,
  playSpeakResult,
  stopAllPlayback,
  stopPreviewPlayback,
} from './voice-playback';
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

  it('stopPreviewPlayback corta só a amostra; a fala normal segue', async () => {
    const sources: Array<{
      buffer: unknown;
      onended: (() => void) | null;
      stopCalls: number;
      connect(): void;
      start(): void;
      stop(): void;
    }> = [];
    class ManualSource {
      buffer: unknown = null;
      onended: (() => void) | null = null;
      stopCalls = 0;
      connect() {}
      start() {
        sources.push(this);
      }
      stop() {
        this.stopCalls += 1;
        this.onended?.();
      }
    }
    class ManualContext {
      state = 'running';
      destination = {};
      async resume() {}
      close() {}
      createBufferSource() {
        return new ManualSource();
      }
      async decodeAudioData() {
        return { duration: 0.5 };
      }
    }
    vi.stubGlobal('AudioContext', ManualContext);

    const jarvis = playAudioBase64(WAV_BASE64, 'wav');
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    const preview = playAudioBase64(WAV_BASE64, 'wav', undefined, {
      ignoreMute: true,
      preview: true,
    });
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    const [jarvisSource, previewSource] = sources;

    stopPreviewPlayback();
    expect(previewSource.stopCalls).toBe(1);
    // A fala da Jarvis não é tocada pelo Parar da amostra.
    expect(jarvisSource.stopCalls).toBe(0);
    await preview;

    // O barge-in continua cortando a fala normal.
    stopAllPlayback();
    expect(jarvisSource.stopCalls).toBe(1);
    await jarvis;
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
