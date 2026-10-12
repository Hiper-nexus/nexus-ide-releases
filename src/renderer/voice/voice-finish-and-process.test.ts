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

const hasPendingDictation = vi.hoisted(() => vi.fn(() => false));
vi.mock('./dictation-delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dictation-delivery')>()),
  hasPendingDictation,
}));

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
      expect.any(Function),
      expect.any(Function),
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

    expect(useVoiceStore.getState().note).toContain('entra sozinho quando ele ficar livre');
    // B1: o pendente não é copiado — a nota não pode mandar colar.
    expect(useVoiceStore.getState().note).not.toContain('copiado');
    expect(useVoiceStore.getState().note).toContain('se você digitar no painel, ele é cancelado');
    // HUD: título "Ditado aguardando" enquanto houver pendente.
    expect(useVoiceStore.getState().dictationDelivery).toBe('pending');
    expect(useVoiceStore.getState().dictationFailed).toBe(false);
    expect(useVoiceStore.getState().dictationPending).toBeNull();
  });

  it('C1: texto escrito sem confirmação — HUD manda conferir o pane, sem dizer que nada foi escrito', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    vi.mocked(routeDictation).mockResolvedValue({ ok: false, reason: 'delivery-lost', preserved: true });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());

    expect(useVoiceStore.getState().error).toContain('confira');
    expect(useVoiceStore.getState().error).not.toContain('nada foi escrito');
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

  it('C2: desfecho do pendente vira 2ª linha da sessão e atualiza o HUD', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    const settlers: Array<(settled: { paneId: string; result: 'ok' | 'error'; errorCode?: string; preserved?: boolean }) => void> = [];
    vi.mocked(routeDictation).mockImplementation(async (_text, onSettled) => {
      if (onSettled) settlers.push(onSettled as never);
      return { ok: false, reason: 'pending', paneId: 'pane-1' };
    });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    settlers[0]!({ paneId: 'pane-1', result: 'error', errorCode: 'pending-timeout', preserved: true });

    expect(sessions()).toEqual([
      expect.objectContaining({ result: 'pending' }),
      expect.objectContaining({ result: 'error', errorCode: 'pending-timeout', sttProvider: 'groq' }),
    ]);
    expect(useVoiceStore.getState().note).toContain('10 minutos');
    expect(useVoiceStore.getState().note).toContain('copiado');
    expect(useVoiceStore.getState().dictationFailed).toBe(true);

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    settlers[1]!({ paneId: 'pane-1', result: 'ok' });
    expect(sessions().at(-1)).toEqual(expect.objectContaining({ result: 'ok' }));
    expect(useVoiceStore.getState().note).toContain('entregue');
    expect(useVoiceStore.getState().dictationDelivery).toBeNull();
  });

  it('C-1/C-2/C-5: HUD do pendente cancelado (copiado), substituído (calado) e perdido (confira)', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    const settlers: Array<(settled: { paneId: string; result: 'ok' | 'error'; errorCode?: string; preserved?: boolean }) => void> = [];
    vi.mocked(routeDictation).mockImplementation(async (_text, onSettled) => {
      if (onSettled) settlers.push(onSettled as never);
      return { ok: false, reason: 'pending', paneId: 'pane-1' };
    });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    settlers[0]!({ paneId: 'pane-1', result: 'error', errorCode: 'pending-cancelled', preserved: true });
    expect(useVoiceStore.getState().note).toBe('Ditado cancelado: texto copiado, cole com ⌘V.');
    expect(useVoiceStore.getState().dictationFailed).toBe(false);

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    const noteBefore = useVoiceStore.getState().note;
    settlers[1]!({ paneId: 'pane-1', result: 'error', errorCode: 'pending-replaced' });
    expect(useVoiceStore.getState().note).toBe(noteBefore);
    expect(useVoiceStore.getState().note).not.toContain('você usou o painel');
    expect(useVoiceStore.getState().dictationFailed).toBe(false);

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    settlers[2]!({ paneId: 'pane-1', result: 'error', errorCode: 'pending-lost', preserved: true });
    expect(useVoiceStore.getState().note).toContain('confira o painel');
    expect(useVoiceStore.getState().note).toContain('copiado');
  });

  it('C-3/C-6: HUD mostra "Ditado entrando…" e só tira o título quando não sobra pendente', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    let settle: ((settled: { paneId: string; result: 'ok' | 'error'; errorCode?: string }) => void) | undefined;
    let delivering: ((paneId: string, active: boolean) => void) | undefined;
    vi.mocked(routeDictation).mockImplementation(async (_text, onSettled, onDelivering) => {
      settle = onSettled as never;
      delivering = onDelivering;
      return { ok: false, reason: 'pending', paneId: 'pane-1' };
    });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    delivering!('pane-1', true);
    expect(useVoiceStore.getState().note).toBe('Ditado entrando…');
    delivering!('pane-1', false);
    expect(useVoiceStore.getState().note).toContain('entra sozinho quando ele ficar livre');

    // Outro painel ainda tem pendente: o título "Ditado aguardando" fica.
    hasPendingDictation.mockReturnValueOnce(true);
    settle!({ paneId: 'pane-1', result: 'ok' });
    expect(useVoiceStore.getState().dictationDelivery).toBe('pending');
    settle!({ paneId: 'pane-2', result: 'ok' });
    expect(useVoiceStore.getState().dictationDelivery).toBeNull();
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

  it('F-1393 M5: erro tardio de ditado pendente vira aviso no HUD sem derrubar o status da Jarvis', async () => {
    transcribe.mockResolvedValue(sttOk('abre o painel'));
    let settle: ((settled: { paneId: string; result: 'ok' | 'error'; errorCode?: string; preserved?: boolean }) => void) | undefined;
    vi.mocked(routeDictation).mockImplementation(async (_text, onSettled) => {
      settle = onSettled as never;
      return { ok: false, reason: 'pending', paneId: 'pane-1' };
    });

    await finishAndProcess(makeCapture(), { current: false }, makeDeps());
    expect(settle).toBeDefined();

    // Jarvis está no meio de uma resposta/fala (status = 'speaking')
    useVoiceStore.getState().setStatus('speaking');

    // Ditado pendente falha 10 min depois (pending-timeout)
    settle!({ paneId: 'pane-1', result: 'error', errorCode: 'pending-timeout', preserved: true });

    // Status global da Jarvis NÃO pode ter virado 'error'
    expect(useVoiceStore.getState().status).toBe('speaking');
    // Erro virou aviso no HUD (note), e dictationFailed foi marcado
    expect(useVoiceStore.getState().note).toContain('10 minutos');
    expect(useVoiceStore.getState().dictationFailed).toBe(true);
    expect(useVoiceStore.getState().error).toBeNull();
  });
});


