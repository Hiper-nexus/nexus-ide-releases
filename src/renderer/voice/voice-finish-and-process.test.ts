/**
 * F-371 — o ditado (Space na janela) espera 6 s em silêncio visual: o voice
 * store precisa expor `dictationPending`/`dictationFailed` para o chip do pane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishAndProcess,
  type FinishAndProcessDeps,
} from './voice-finish-and-process';
import { useVoiceStore } from './voice-store';
import { setActiveCaptureReason } from './voice-session-state';
import { routeDictation } from './voice-run-jarvis-turn';
import type { VoiceCapture } from './voice-capture';
import type {
  TranscribeResult,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';

vi.mock('./voice-run-jarvis-turn', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./voice-run-jarvis-turn')>();
  return { ...actual, routeDictation: vi.fn() };
});

const transcribe = vi.fn();

function sttOk(text: string): TranscribeResult {
  return { ok: true, text, provider: 'groq', attempts: [] };
}

function sttFail(): TranscribeResult {
  return {
    ok: false,
    error: 'groq 429',
    needsKey: false,
    attempts: [{ provider: 'groq', reason: '429' }],
  };
}

function makeCapture(): VoiceCapture {
  return {
    stop: vi.fn(async () => ({
      wavBase64: 'QUJD',
      sampleRate: 16_000,
      durationSec: 1.4,
      heardSpeech: true,
      maxRms: 0.08,
      maxPeak: 0.4,
    })),
  } as unknown as VoiceCapture;
}

function makeDeps(): FinishAndProcessDeps {
  return {
    beginListening: vi.fn(async () => {}),
    isListening: () => false,
    finishAndProcess: vi.fn(async () => {}),
    wakeAutoStop: vi.fn(
      () => ({ silenceMs: 0, minListenMs: 0, maxMs: 0 }) as never,
    ),
  } as FinishAndProcessDeps;
}

function voiceInfo(mode: 'english' | 'portuguese'): VoiceRuntimeInfo {
  return {
    routing: 'focused-pane',
    dictationOutputMode: mode,
    keys: [],
    jarvisLive: { enabled: false, transport: 'classic' },
  } as unknown as VoiceRuntimeInfo;
}

describe('F-371 — dictationPending/dictationFailed no fluxo de ditado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcribe.mockReset();
    vi.stubGlobal('window', {
      nexus: {
        voice: {
          transcribe,
          logVoice: vi.fn(async () => ({})),
          liveStatus: vi.fn(async () => ({})),
          liveInterrupt: vi.fn(async () => ({})),
          liveEndTurn: vi.fn(async () => ({})),
        },
      },
    });
    setActiveCaptureReason('dictation');
    vi.mocked(routeDictation).mockResolvedValue({ ok: true, paneId: 'pane-1' });
    useVoiceStore.setState({
      status: 'idle',
      error: null,
      note: null,
      dictationPending: null,
      dictationFailed: false,
      info: voiceInfo('english'),
    } as never);
  });

  afterEach(() => {
    setActiveCaptureReason('manual');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sucesso: arma o pendente antes do STT e limpa quando o pane confirma', async () => {
    transcribe.mockImplementation(async () => {
      const pending = useVoiceStore.getState().dictationPending;
      expect(pending).not.toBeNull();
      expect(pending?.mode).toBe('english');
      expect(pending?.startedAt).toBeGreaterThan(0);
      return sttOk('vamos comitar isso');
    });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(useVoiceStore.getState().dictationPending).toBeNull();
    expect(useVoiceStore.getState().dictationFailed).toBe(false);
    expect(vi.mocked(routeDictation)).toHaveBeenCalledWith(
      'vamos comitar isso',
    );
  });

  it('carrega o modo do info: português não é modo CODE', async () => {
    useVoiceStore.setState({ info: voiceInfo('portuguese') } as never);
    transcribe.mockImplementation(async () => {
      expect(useVoiceStore.getState().dictationPending?.mode).toBe(
        'portuguese',
      );
      return sttOk('texto literal');
    });
    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    expect(useVoiceStore.getState().dictationPending).toBeNull();
  });

  it('falha de STT: limpa o pendente e arma a falha transitória (~4s)', async () => {
    vi.useFakeTimers();
    transcribe.mockResolvedValue(sttFail());

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(useVoiceStore.getState().dictationPending).toBeNull();
    expect(useVoiceStore.getState().dictationFailed).toBe(true);
    vi.advanceTimersByTime(4_500);
    expect(useVoiceStore.getState().dictationFailed).toBe(false);
  });

  it('falha de roteamento: limpa o pendente e arma a falha transitória', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    vi.mocked(routeDictation).mockResolvedValue({
      ok: false,
      reason: 'delivery-failed',
    });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(useVoiceStore.getState().dictationPending).toBeNull();
    expect(useVoiceStore.getState().dictationFailed).toBe(true);
  });

  it('descarte (transcript vazio): limpa o pendente SEM armar falha', async () => {
    transcribe.mockResolvedValue(sttOk('   '));

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(useVoiceStore.getState().dictationPending).toBeNull();
    expect(useVoiceStore.getState().dictationFailed).toBe(false);
    expect(vi.mocked(routeDictation)).not.toHaveBeenCalled();
  });

  it('exceção no STT: limpa o pendente e marca falha', async () => {
    transcribe.mockRejectedValue(new Error('ipc caiu'));

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(useVoiceStore.getState().dictationPending).toBeNull();
    expect(useVoiceStore.getState().dictationFailed).toBe(true);
  });
});
