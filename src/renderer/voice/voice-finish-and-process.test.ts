/**
 * F-371 — o ditado (Space na janela) espera 6 s em silêncio visual: o voice
 * store precisa expor `dictationPending`/`dictationFailed` para o chip do pane.
 *
 * Também cobre o ramo realtime: a resposta que o server_vad começa ANTES do fim
 * da captura (áudio ou tool) tem de contar como evidência do turno — sem isso o
 * turno degradava para o Classic com o Live já falando.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishAndProcess,
  type FinishAndProcessDeps,
} from './voice-finish-and-process';
import { useVoiceStore } from './voice-store';
import {
  bumpRealtimeNativeToolInFlight,
  markTurnAudioBaseline,
  realtimeAudioPlayedCounter,
  realtimeAudioSuppressedCounter,
  realtimeTranscriptWaiter,
  setActiveCaptureReason,
  setLastRealtimeNativeToolAt,
  setLastRealtimeNativeToolCallId,
  setRealtimeTurnActive,
  turnExecution,
} from './voice-session-state';
import {
  markLiveMicFrameOffered,
  resetLiveMuteRescues,
  resetOfferedLiveMicFramesThisTurn,
} from './live-mute-rescue';
import { releaseAfterLiveProviderAnswer, releaseAfterLiveToolAnswer } from './live-followup';
import { routeDictation, runJarvisTurn } from './voice-run-jarvis-turn';
import type { VoiceCapture } from './voice-capture';
import type {
  TranscribeResult,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';

vi.mock('./voice-run-jarvis-turn', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./voice-run-jarvis-turn')>();
  return { ...actual, routeDictation: vi.fn(), runJarvisTurn: vi.fn(async () => {}) };
});

// A continuidade pós-resposta agenda reabertura de mic por timers reais: os
// testes só precisam saber QUE caminho o turno escolheu, não reabrir a escuta.
vi.mock('./live-followup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./live-followup')>()),
  releaseAfterLiveProviderAnswer: vi.fn(),
  releaseAfterLiveToolAnswer: vi.fn(),
}));

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

describe('F-1424 — privacidade do ditado (nunca grava texto falado em log ou console)', () => {
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
      info: voiceInfo('portuguese'),
    } as never);
  });

  afterEach(() => {
    setActiveCaptureReason('manual');
    vi.unstubAllGlobals();
  });

  it('ditado com frase sintética não vaza texto para o logVoice nem para console.log', async () => {
    const syntheticPhrase = 'frase-sintetica-f1424';
    transcribe.mockResolvedValueOnce(sttOk(syntheticPhrase));

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await finishAndProcess(makeCapture(), { current: false }, makeDeps());

      const logCalls = (window.nexus.voice.logVoice as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const transcriptCall = logCalls.find((call) => call[0]?.event === 'stt.dictationTranscript');
      expect(transcriptCall).toBeDefined();
      expect(transcriptCall?.[0].msg).not.toContain(syntheticPhrase);
      expect(JSON.stringify(transcriptCall?.[0])).not.toContain(syntheticPhrase);

      const consoleCalls = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(consoleCalls).not.toContain(syntheticPhrase);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });
});



describe('ramo realtime — a resposta que o server_vad começa antes do fim da captura', () => {
  const logVoice = vi.fn();
  const liveQuiesce = vi.fn(async () => ({}));
  const WAKE_WINDOW_MS = 4_800;
  let token = 0;

  const liveState = {
    enabled: true,
    sessionId: 'sess-1',
    status: 'listening',
    realtimeReady: true,
    startedAt: 1,
    lastActiveAt: 1,
    turns: 0,
    pendingMic: false,
  };

  function realtimeInfo(): VoiceRuntimeInfo {
    return {
      routing: 'jarvis',
      dictationOutputMode: 'portuguese',
      persona: { userName: 'Cleo' },
      keys: [{ envVar: 'XAI_API_KEY', hasEnv: true, hasStoredKey: false }],
      jarvisLive: { enabled: true, transport: 'grok-realtime' },
    } as unknown as VoiceRuntimeInfo;
  }

  /** Espelha o que o beginListening faz ao abrir uma captura de wake. */
  function openWakeTurn(): number {
    realtimeTranscriptWaiter.supersede();
    realtimeAudioPlayedCounter.reset();
    realtimeAudioSuppressedCounter.reset();
    resetOfferedLiveMicFramesThisTurn();
    markLiveMicFrameOffered();
    markLiveMicFrameOffered();
    const opened = turnExecution.beginTurn();
    markTurnAudioBaseline();
    realtimeTranscriptWaiter.beginTurn(String(opened));
    return opened;
  }

  /** O provider tocou `chunks` pedaços de áudio durante a fala do operador. */
  function providerPlayedDuringCapture(chunks: number): void {
    for (let i = 0; i < chunks; i += 1) realtimeAudioPlayedCounter.tick(Date.now());
  }

  function events(): string[] {
    return logVoice.mock.calls.map(([payload]) => (payload as { event: string }).event);
  }

  /** Dispara o finishAndProcess sem esperá-lo: os timers do vitest são do teste. */
  function startTurn() {
    let finished = false;
    const done = finishAndProcess(makeCapture(), { current: false }, makeDeps()).then(() => {
      finished = true;
    });
    return { done, isFinished: () => finished };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    logVoice.mockReset();
    liveQuiesce.mockClear();
    transcribe.mockReset();
    transcribe.mockResolvedValue(sttOk('abre o terminal'));
    vi.stubGlobal('window', {
      nexus: {
        voice: {
          transcribe,
          logVoice,
          liveStatus: vi.fn(async () => ({})),
          liveInterrupt: vi.fn(async () => ({})),
          liveEndTurn: vi.fn(async () => liveState),
          liveEndUserAudio: vi.fn(async () => liveState),
          liveQuiesce,
          liveHardTeardown: vi.fn(async () => ({})),
          liveRescueIn: vi.fn(async () => ({ accepted: false })),
          recordEcho: vi.fn(async () => ({})),
        },
        mcp: { clearSession: vi.fn(async () => ({ ok: true })) },
      },
    });
    useVoiceStore.setState({
      status: 'idle',
      error: null,
      note: null,
      dictationPending: null,
      dictationFailed: false,
      info: realtimeInfo(),
      liveState,
    } as never);
    setActiveCaptureReason('wake');
    setRealtimeTurnActive(true);
    resetLiveMuteRescues();
    bumpRealtimeNativeToolInFlight(-99);
    setLastRealtimeNativeToolAt(0);
    setLastRealtimeNativeToolCallId(null);
    token = openWakeTurn();
  });

  afterEach(() => {
    setActiveCaptureReason('manual');
    setRealtimeTurnActive(false);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('áudio tocado ANTES do fim da captura + transcript: o provider é mantido, sem Classic', async () => {
    providerPlayedDuringCapture(4);
    realtimeTranscriptWaiter.deliver('abre o terminal', String(token));

    const turn = startTurn();
    // Evidência imediata: o turno fecha sem gastar o orçamento de 3,5 s.
    await vi.advanceTimersByTimeAsync(200);
    expect(turn.isFinished()).toBe(true);
    await turn.done;

    // Antes da correção a base era lida no fim da captura: nenhum chunk novo,
    // o wait de evidência estourava em 3,5 s e o turno degradava para o Classic
    // (runJarvisTurn + liveQuiesce) com o Live já falando.
    expect(vi.mocked(runJarvisTurn)).not.toHaveBeenCalled();
    expect(liveQuiesce).not.toHaveBeenCalled();
    expect(vi.mocked(releaseAfterLiveProviderAnswer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(releaseAfterLiveProviderAnswer)).toHaveBeenCalledWith(
      expect.objectContaining({ armFollowUp: true }),
    );
    expect(events()).toContain('jarvis.liveProviderAnswer');
    expect(events()).not.toContain('jarvis.liveProviderMuteDegraded');
    expect(turnExecution.owner).toBe('realtime-audio');
  });

  it('só áudio, sem transcript: encerra a espera bem antes da janela do wake', async () => {
    providerPlayedDuringCapture(2);
    const turn = startTurn();

    // Sondagem de 50 ms + carência de 450 ms: ~0,5 s, não os 4,8 s do wake.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(turn.isFinished()).toBe(true);
    await turn.done;

    expect(vi.mocked(runJarvisTurn)).not.toHaveBeenCalled();
    expect(liveQuiesce).not.toHaveBeenCalled();
    expect(vi.mocked(releaseAfterLiveProviderAnswer)).toHaveBeenCalledWith(
      expect.objectContaining({ armFollowUp: true }),
    );
    expect(events()).toContain('jarvis.transcriptWaitEndedEarly');
    const answer = logVoice.mock.calls
      .map(([payload]) => payload as { event: string; msg?: string })
      .find((payload) => payload.event === 'jarvis.liveProviderAnswer');
    expect(answer?.msg).toContain('áudio sem transcript final');
    expect(turnExecution.owner).toBe('realtime-audio');
  });

  it('o transcript que chega dentro da carência segue o caminho normal (sem saída antecipada)', async () => {
    providerPlayedDuringCapture(2);
    const turn = startTurn();

    await vi.advanceTimersByTimeAsync(200);
    realtimeTranscriptWaiter.deliver('abre o terminal', String(token));
    await vi.advanceTimersByTimeAsync(300);
    expect(turn.isFinished()).toBe(true);
    await turn.done;

    expect(events()).not.toContain('jarvis.transcriptWaitEndedEarly');
    expect(events()).toContain('jarvis.realtimeTranscript');
    expect(vi.mocked(runJarvisTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(releaseAfterLiveProviderAnswer)).toHaveBeenCalledTimes(1);
  });

  it('tool nativa durante a espera encerra o turno na hora, pelo caminho da tool', async () => {
    const turn = startTurn();

    await vi.advanceTimersByTimeAsync(120);
    expect(turn.isFinished()).toBe(false); // sem evidência ainda: a espera segue
    // O provider chama uma tool: o handler registra o instante e assume o turno.
    setLastRealtimeNativeToolAt(Date.now());
    bumpRealtimeNativeToolInFlight(1);
    setLastRealtimeNativeToolCallId('call-1');
    expect(turnExecution.claimRealtimeTool(token)).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(turn.isFinished()).toBe(true);
    await turn.done;
    bumpRealtimeNativeToolInFlight(-1);

    expect(vi.mocked(releaseAfterLiveToolAnswer)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', callId: 'call-1' }),
    );
    expect(vi.mocked(runJarvisTurn)).not.toHaveBeenCalled();
    expect(liveQuiesce).not.toHaveBeenCalled();
    expect(events()).toContain('jarvis.transcriptWaitEndedEarly');
  });

  it('provider mudo (sem áudio nem tool): a janela inteira corre e o mute ainda degrada para o Classic', async () => {
    const turn = startTurn();

    // Nada de saída antecipada nem de degradação antes de esgotar a janela.
    await vi.advanceTimersByTimeAsync(WAKE_WINDOW_MS - 200);
    expect(events()).not.toContain('jarvis.transcriptWaitEndedEarly');
    expect(events()).not.toContain('jarvis.realtimeMuteDegraded');
    expect(vi.mocked(runJarvisTurn)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(turn.isFinished()).toBe(true);
    await turn.done;

    expect(events()).toContain('jarvis.realtimeMuteDegraded');
    expect(events()).not.toContain('jarvis.transcriptWaitEndedEarly');
    expect(liveQuiesce).toHaveBeenCalledWith('classic-action-bridge-timeout');
    expect(vi.mocked(runJarvisTurn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(releaseAfterLiveProviderAnswer)).not.toHaveBeenCalled();
  });

  it('com o Classic podendo falar (Live não é dono) a espera nunca termina por áudio retido', async () => {
    // Sessão não pronta: o Classic assume. O áudio do provider fica retido e
    // não é prova de resposta ouvida — a janela curta do Classic segue valendo.
    useVoiceStore.setState({
      liveState: { ...liveState, realtimeReady: false },
    } as never);
    providerPlayedDuringCapture(3);

    const turn = startTurn();
    await vi.advanceTimersByTimeAsync(WAKE_WINDOW_MS + 4_000);
    await turn.done;

    expect(events()).not.toContain('jarvis.transcriptWaitEndedEarly');
  });
});
