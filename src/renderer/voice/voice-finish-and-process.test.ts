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

  it('F-1393: ditado recusado e copiado — o HUD manda colar com ⌘V', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    vi.mocked(routeDictation).mockResolvedValue({
      ok: false,
      reason: 'delivery-failed',
      preserved: true,
    });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(useVoiceStore.getState().error).toContain('copiado');
    expect(useVoiceStore.getState().error).toContain('⌘V');
  });

  it('F-1393: pane com diálogo — HUD diz que o ditado aguarda o pane ficar livre, sem falha', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    vi.mocked(routeDictation).mockResolvedValue({
      ok: false,
      reason: 'pending',
      paneId: 'pane-1',
    });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(useVoiceStore.getState().note).toContain('aguardando o pane ficar livre');
    // B1: o pendente não é copiado — a nota não pode mandar colar.
    expect(useVoiceStore.getState().note).not.toContain('copiado');
    expect(useVoiceStore.getState().note).toContain('Digitar no pane cancela');
    expect(useVoiceStore.getState().dictationFailed).toBe(false);
    expect(useVoiceStore.getState().dictationPending).toBeNull();
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

describe('F-1392 — uma linha dictation.session por ditado, sem o texto', () => {
  const logVoice = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    transcribe.mockReset();
    logVoice.mockReset();
    vi.stubGlobal('window', {
      nexus: {
        voice: {
          transcribe,
          logVoice,
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
  });

  function sessions(): Array<Record<string, unknown>> {
    return logVoice.mock.calls
      .map(([payload]) => payload as { event: string; msg?: string; data?: Record<string, unknown> })
      .filter((payload) => payload.event === 'dictation.session')
      .map((payload) => {
        expect(payload.msg).toBeUndefined();
        return payload.data ?? {};
      });
  }

  it('ditado CODE entregue: modo, STT, idioma, duração, tamanhos e reescrita', async () => {
    transcribe.mockResolvedValue({
      ok: true,
      text: 'Commit this and push the worktree.',
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      polish: { ok: true, rawChars: 41 },
      attempts: [],
    } satisfies TranscribeResult);

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    const all = sessions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      mode: 'code',
      sttProvider: 'groq',
      sttModel: 'whisper-large-v3-turbo',
      language: 'pt',
      audioMs: 1400,
      rawChars: 41,
      polishedChars: 34,
      polished: true,
      result: 'ok',
    });
    expect(typeof all[0]!.latencyMs).toBe('number');
    expect(JSON.stringify(all[0])).not.toContain('worktree');
  });

  it('pane não confirma: resultado erro com o código da entrega', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    vi.mocked(routeDictation).mockResolvedValue({ ok: false, reason: 'delivery-failed' });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(sessions()).toEqual([
      expect.objectContaining({ result: 'error', errorCode: 'delivery-failed', polished: false }),
    ]);
  });

  it('F-1393: ditado enfileirado no pane ocupado vira resultado queued; pendente vira pending', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    vi.mocked(routeDictation).mockResolvedValueOnce({ ok: true, paneId: 'pane-1', queued: true });
    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    vi.mocked(routeDictation).mockResolvedValueOnce({ ok: false, reason: 'pending', paneId: 'pane-1' });
    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(sessions()).toEqual([
      expect.objectContaining({ result: 'queued' }),
      expect.objectContaining({ result: 'pending' }),
    ]);
  });

  it('STT falha: resultado erro com código curto; transcript vazio: resultado vazio', async () => {
    transcribe.mockResolvedValueOnce(sttFail());
    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    transcribe.mockResolvedValueOnce(sttOk('   '));
    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(sessions()).toEqual([
      expect.objectContaining({ result: 'error', errorCode: 'stt-throttled', mode: 'code' }),
      expect.objectContaining({ result: 'empty', errorCode: 'discarded', sttProvider: 'groq' }),
    ]);
  });
});

