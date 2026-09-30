import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLiveTransportSingleton,
  buildSetupMessage,
  GeminiLiveTransport,
  parseServerMessage,
  TRANSCRIPTION_SETTLE_MS,
  type LiveTransportEvents,
  type WsLike,
} from './gemini-live-transport';
import { NARRATION_ENVELOPE } from '../jarvis/realtime/live-narration';
import { SCREEN_UPDATE_DEBOUNCE_MS } from '../jarvis/realtime/screen-coalescer';
import { TURN_MAX_MS } from '../jarvis/realtime/turn-queue';
import { COARSE_VOICE_TOOLS } from '../jarvis/realtime/coarse-voice-tools';

const GEMINI_31_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

function fakeWs(): WsLike & {
  sent: string[];
  fire(event: 'open' | 'message' | 'close' | 'error', payload?: unknown): void;
} {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  return {
    sent: [],
    readyState: 1,
    send(data: string) {
      this.sent.push(data);
    },
    close: vi.fn(),
    on(event: string, cb: (payload?: unknown) => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    },
    fire(event, payload) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

function events(): LiveTransportEvents & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    audioOut: [],
    transcript: [],
    interrupted: [],
    turnComplete: [],
    stateChange: [],
    error: [],
  };
  return {
    calls,
    onAudioOut: (b64) => calls.audioOut.push(b64),
    onTranscript: (role, text, final) => calls.transcript.push({ role, text, final }),
    onInterrupted: () => calls.interrupted.push(1),
    onTurnComplete: () => calls.turnComplete.push(1),
    onStateChange: (state) => calls.stateChange.push(state),
    onError: (msg) => calls.error.push(msg),
  };
}

type TranscriptCall = { role: string; text: string; final: boolean };
function transcriptFinals(ev: { calls: Record<string, unknown[]> }): TranscriptCall[] {
  return (ev.calls.transcript as TranscriptCall[]).filter(
    (c) => c.role === 'user' && c.final,
  );
}

function makeTransport(ws: WsLike, ev: LiveTransportEvents) {
  return new GeminiLiveTransport(ev, {
    wsFactory: () => ws,
    now: () => 1000,
    setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
    clearTimeoutFn: () => {},
  });
}

function makeTimedTransport(ws: WsLike, ev: LiveTransportEvents) {
  return new GeminiLiveTransport(ev, {
    wsFactory: () => ws,
    now: () => 1000,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  });
}

describe('buildSetupMessage', () => {
  it('configura Native Audio sem languageCode e mantém PT-BR no system instruction', () => {
    const msg = buildSetupMessage({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      voiceName: 'Charon',
      systemInstruction: 'Você é o Jarvis.',
    });
    expect(msg.setup.model).toBe(
      'models/gemini-2.5-flash-native-audio-preview-12-2025',
    );
    const gen = msg.setup.generationConfig as Record<string, unknown>;
    expect(gen.responseModalities).toEqual(['AUDIO']);
    expect(JSON.stringify(msg)).toContain('Charon');
    expect(gen.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } },
    });
    expect(msg.setup.systemInstruction.parts[0].text).toContain('pt-BR');
    expect(msg.setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(msg.setup.inputAudioTranscription).toEqual({});
    expect(msg.setup.outputAudioTranscription).toEqual({});
    expect(msg.setup.realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: 20,
        silenceDurationMs: 300,
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
    });
  });

  it('configura o Gemini 3.1 Live com thinking mínimo para baixa latência', () => {
    const msg = buildSetupMessage({
      model: GEMINI_31_LIVE_MODEL,
      voiceName: 'Charon',
      systemInstruction: 'Você é o Jarvis.',
    });
    const gen = msg.setup.generationConfig as Record<string, unknown>;
    expect(msg.setup.model).toBe(`models/${GEMINI_31_LIVE_MODEL}`);
    expect(gen.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(gen.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } },
      languageCode: 'pt-BR',
    });
  });

  it('declara as 4 tools coarse (delegar/consultar/ler/navegar) + encerrar no setup', () => {
    const msg = buildSetupMessage({
      model: 'm',
      voiceName: 'Charon',
      systemInstruction: 's',
    });
    const decls = msg.setup.tools[0].functionDeclarations.map((d) => d.name);
    expect(decls).toEqual([
      'delegar',
      'consultar',
      'ler',
      'navegar',
      'encerrar',
      'comandar',
      'restaurar',
      'perguntar',
    ]);
  });

  it('aceita nexus_action junto das tools coarse no setup Live', () => {
    const msg = buildSetupMessage({
      model: GEMINI_31_LIVE_MODEL,
      voiceName: 'Charon',
      systemInstruction: 'You are Jarvis.',
      tools: [
        ...COARSE_VOICE_TOOLS,
        {
          name: 'nexus_action',
          description: 'Audited Nexus action.',
          parameters: {
            type: 'OBJECT',
            properties: {
              action: { type: 'STRING', enum: ['run_command', 'mcp_tool'] },
            },
            required: ['action'],
          },
        },
      ],
    });

    expect(msg.setup.tools[0].functionDeclarations.map((tool) => tool.name)).toContain(
      'nexus_action',
    );
  });
});

describe('parseServerMessage', () => {
  it('extrai áudio inline, transcrições e interrupção', () => {
    const audio = parseServerMessage(
      JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'QUJD' } }] },
        },
      }),
    );
    expect(audio.audioB64s).toEqual(['QUJD']);

    const inTx = parseServerMessage(
      JSON.stringify({ serverContent: { inputTranscription: { text: 'olá' } } }),
    );
    expect(inTx.inputTranscription).toBe('olá');

    const outTx = parseServerMessage(
      JSON.stringify({ serverContent: { outputTranscription: { text: 'oi!' } } }),
    );
    expect(outTx.outputTranscription).toBe('oi!');

    const stop = parseServerMessage(
      JSON.stringify({ serverContent: { interrupted: true } }),
    );
    expect(stop.interrupted).toBe(true);

    const done = parseServerMessage(JSON.stringify({ setupComplete: {} }));
    expect(done.setupComplete).toBe(true);

    const turnDone = parseServerMessage(
      JSON.stringify({ serverContent: { turnComplete: true } }),
    );
    expect(turnDone.turnComplete).toBe(true);
  });

  it('preserva todos os blocos de áudio quando o Gemini 3.1 agrupa partes', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QUFB' } },
              { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QkJC' } },
            ],
          },
          outputTranscription: { text: 'resposta' },
        },
      }),
    );
    expect(parsed.audioB64s).toEqual(['QUFB', 'QkJC']);
    expect(parsed.outputTranscription).toBe('resposta');
  });

  it('extrai chamadas de função (toolCall) e cancelamentos', () => {
    const call = parseServerMessage(
      JSON.stringify({
        toolCall: {
          functionCalls: [
            { id: 'c1', name: 'delegar', args: { briefing: 'cria a landing' } },
            { name: 'consultar', args: { pergunta: 'quais panes?' } },
          ],
        },
      }),
    );
    expect(call.toolCalls).toEqual([
      { id: 'c1', name: 'delegar', args: { briefing: 'cria a landing' } },
      { id: '', name: 'consultar', args: { pergunta: 'quais panes?' } },
    ]);

    const cancel = parseServerMessage(
      JSON.stringify({ toolCallCancellation: { ids: ['c1', 'c2'] } }),
    );
    expect(cancel.cancelledToolCallIds).toEqual(['c1', 'c2']);
  });

  it('mensagem ilegível não explode', () => {
    expect(parseServerMessage('garbage')).toEqual({});
  });
});

describe('GeminiLiveTransport', () => {
  beforeEach(() => __resetLiveTransportSingleton());

  it('bufferiza mic antes do setupComplete e faz flush depois (pendingMic)', () => {
    const ws = fakeWs();
    const ev = events();
    const t = makeTransport(ws, ev);
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    // setup enviado na abertura
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).setup).toBeTruthy();

    // mic antes do setupComplete → bufferizado, não enviado
    t.sendMicChunk('QUJD');
    expect(ws.sent).toHaveLength(1);

    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    // flush do buffer
    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[1]).realtimeInput.audio.data).toBe('QUJD');

    // depois do setup, mic flui direto
    t.sendMicChunk('REVG');
    expect(ws.sent).toHaveLength(3);
  });

  it('descarta pendingMic acima do teto (não cresce sem limite)', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    const big = 'A'.repeat(64 * 1024);
    for (let i = 0; i < 10; i += 1) t.sendMicChunk(big);
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    // 160KB cap → no máximo 2 chunks de 64KB + setup = 3 mensagens ou menos
    expect(ws.sent.length).toBeLessThanOrEqual(4);
  });

  it('emite áudio, transcrições e barge-in a partir do servidor', () => {
    const ws = fakeWs();
    const ev = events();
    const t = makeTransport(ws, ev);
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    ws.fire(
      'message',
      JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'QUJD' } }] },
          outputTranscription: { text: 'oi' },
        },
      }),
    );
    ws.fire('message', JSON.stringify({ serverContent: { interrupted: true } }));
    ws.fire('message', JSON.stringify({ serverContent: { turnComplete: true } }));
    expect(ev.calls.audioOut).toEqual(['QUJD']);
    expect(ev.calls.transcript).toContainEqual({ role: 'assistant', text: 'oi', final: false });
    expect(ev.calls.interrupted).toHaveLength(1);
    expect(ev.calls.turnComplete).toHaveLength(1);
  });

  it('emite na ordem todos os áudios agrupados no mesmo evento do Gemini 3.1', () => {
    const ws = fakeWs();
    const ev = events();
    const t = makeTransport(ws, ev);
    t.connect({ apiKey: 'k', model: GEMINI_31_LIVE_MODEL, voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    ws.fire('message', JSON.stringify({
      serverContent: { inputTranscription: { text: 'responda' } },
    }));
    ws.fire('message', JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QUFB' } },
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QkJC' } },
          ],
        },
        outputTranscription: { text: 'claro' },
      },
    }));
    expect(ev.calls.audioOut).toEqual(['QUFB', 'QkJC']);
    expect(ev.calls.transcript).toContainEqual({
      role: 'assistant',
      text: 'claro',
      final: false,
    });
    // Audio does not finalize input transcription: the API explicitly sends
    // those streams independently and may deliver more input text later.
    expect(transcriptFinals(ev)).toEqual([]);
  });

  it('finaliza transcrições completas após turnComplete, incluindo fragmentos fora de ordem', async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const ev = events();
    const t = makeTimedTransport(ws, ev);
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    // Input/output transcription are independent from model audio and can
    // arrive after the response has already started.
    ws.fire('message', JSON.stringify({ serverContent: { inputTranscription: { text: 'abre o ' } } }));
    ws.fire(
      'message',
      JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'QUJD' } }] },
          outputTranscription: { text: 'feito' },
        },
      }),
    );
    expect(transcriptFinals(ev)).toHaveLength(0);

    ws.fire('message', JSON.stringify({ serverContent: { inputTranscription: { text: 'terminal' } } }));
    ws.fire('message', JSON.stringify({ serverContent: { turnComplete: true } }));
    ws.fire('message', JSON.stringify({ serverContent: { outputTranscription: { text: '!' } } }));
    await vi.advanceTimersByTimeAsync(500);

    expect(transcriptFinals(ev)).toEqual([
      { role: 'user', text: 'abre o terminal', final: true },
    ]);
    expect(ev.calls.transcript).toContainEqual({
      role: 'assistant',
      text: 'feito!',
      final: true,
    });
    vi.useRealTimers();
  });

  it('keeps final transcripts scoped to the provider turn that produced them', async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const transcripts: Array<{
      role: string;
      text: string;
      final: boolean;
      turnId?: string;
    }> = [];
    const ev = events();
    ev.onTranscript = (role, text, final, turnId) => {
      transcripts.push({ role, text, final, turnId });
    };
    const t = makeTimedTransport(ws, ev);
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));

    t.beginUserTurn('turn-1');
    ws.fire('message', JSON.stringify({
      serverContent: { inputTranscription: { text: 'comando antigo' } },
    }));
    t.beginUserTurn('turn-2');
    ws.fire('message', JSON.stringify({
      serverContent: { inputTranscription: { text: 'comando atual' }, turnComplete: true },
    }));
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_SETTLE_MS + 1);

    expect(transcripts.filter((line) => line.final)).toEqual([
      { role: 'user', text: 'comando antigo', final: true, turnId: 'turn-1' },
      { role: 'user', text: 'comando atual', final: true, turnId: 'turn-2' },
    ]);
    vi.useRealTimers();
  });

  it('MUTE FIX: não vaza transcript final se o turno for interrompido (barge-in)', () => {
    const ws = fakeWs();
    const ev = events();
    const t = makeTransport(ws, ev);
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    ws.fire('message', JSON.stringify({ serverContent: { inputTranscription: { text: 'oi' } } }));
    ws.fire('message', JSON.stringify({ serverContent: { interrupted: true } }));
    // buffer descartado no barge-in → o próximo áudio não finaliza o texto velho
    ws.fire(
      'message',
      JSON.stringify({
        serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'QUJD' } }] } },
      }),
    );
    expect(transcriptFinals(ev)).toHaveLength(0);
  });

  it('anexa contexto Gemini 3.1 ao próximo turno em vez de dispará-lo durante ociosidade', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: GEMINI_31_LIVE_MODEL, voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    const before = ws.sent.length;
    t.sendContext('tela: 3 panes abertos');
    expect(ws.sent).toHaveLength(before);

    t.sendMicChunk(Buffer.from([1, 0]).toString('base64'));

    expect(ws.sent).toHaveLength(before + 2);
    const context = JSON.parse(ws.sent.at(-2)!);
    const audio = JSON.parse(ws.sent.at(-1)!);
    expect(context.clientContent).toBeUndefined();
    expect(context.realtimeInput.text).toContain('[context_update]');
    expect(context.realtimeInput.text).toContain('3 panes');
    expect(audio.realtimeInput.audio.data).toBeTruthy();
  });

  it('coalesce contexto Gemini 3.1 ocioso e entrega apenas o snapshot mais recente', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: GEMINI_31_LIVE_MODEL, voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    const before = ws.sent.length;

    t.sendContext('tela antiga');
    t.sendContext('tela atual');
    expect(ws.sent).toHaveLength(before);
    t.sendTextTurn('o que está aberto?');

    expect(ws.sent).toHaveLength(before + 2);
    expect(ws.sent.at(-2)).toContain('tela atual');
    expect(ws.sent.at(-2)).not.toContain('tela antiga');
    expect(JSON.parse(ws.sent.at(-1)!).realtimeInput.text).toBe('o que está aberto?');
  });

  it('envia texto do Gemini 3.1 por realtimeInput.text para smoke/fallback', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: GEMINI_31_LIVE_MODEL, voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendTextTurn('teste jarvis');
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.clientContent).toBeUndefined();
    expect(last.realtimeInput.text).toBe('teste jarvis');
  });

  it('mantém clientContent para modelos Gemini 2.5 compatíveis', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({
      apiKey: 'k',
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      voiceName: 'V',
      systemInstruction: 's',
    });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendTextTurn('teste legado');
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.clientContent.turnComplete).toBe(true);
  });

  it('singleton: connect novo mata o socket anterior', () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    let call = 0;
    const t = new GeminiLiveTransport(events(), {
      wsFactory: () => (call++ === 0 ? ws1 : ws2),
      now: () => 1000,
      setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    expect(ws1.close).toHaveBeenCalled();
  });

  it('injectNarration embrulha no envelope e usa realtimeInput no Gemini 3.1', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: GEMINI_31_LIVE_MODEL, voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.injectNarration('o build passou');
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.clientContent).toBeUndefined();
    const text = last.realtimeInput.text as string;
    expect(text.startsWith(NARRATION_ENVELOPE)).toBe(true);
    expect(text.endsWith('o build passou')).toBe(true);
  });

  it('serializa narrações concorrentes — 1 turno em voo, libera no turnComplete', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    const before = ws.sent.length;
    t.injectNarration('primeiro');
    t.injectNarration('segundo');
    // só o primeiro foi ao socket
    expect(ws.sent.length).toBe(before + 1);
    expect(ws.sent.at(-1)).toContain('primeiro');
    // turnComplete do servidor libera a fila → drena o segundo
    ws.fire('message', JSON.stringify({ serverContent: { turnComplete: true } }));
    expect(ws.sent.length).toBe(before + 2);
    expect(ws.sent.at(-1)).toContain('segundo');
  });

  it('barge-in (interrupted) também libera a fila serializada', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    const before = ws.sent.length;
    t.injectNarration('a');
    t.injectNarration('b');
    ws.fire('message', JSON.stringify({ serverContent: { interrupted: true } }));
    expect(ws.sent.length).toBe(before + 2);
    expect(ws.sent.at(-1)).toContain('b');
  });

  it('turnos injetados antes do setupComplete são bufferizados e drenados depois', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    // greeting injetado pré-setup → não vai ao socket ainda (só o setup foi)
    t.injectContext('[wake] cumprimente o usuário');
    expect(ws.sent).toHaveLength(1);
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    // agora drena
    expect(ws.sent.at(-1)).toContain('[wake]');
  });

  it('injectContext([wake]) jumps a busy TurnQueue (priority)', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.injectNarration('stale narration still in flight');
    const before = ws.sent.length;
    t.injectContext('[wake] diga exatamente Olá.');
    expect(ws.sent.length).toBe(before + 1);
    expect(ws.sent.at(-1)).toContain('[wake]');
    expect(ws.sent.at(-1)).not.toContain('stale narration');
  });

  it('interrupt ends audio turn and clears pending mic without waiting for server', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendMicChunk(Buffer.from([1, 0, 2, 0]).toString('base64'));
    t.interrupt();
    expect(ws.sent.some((s) => s.includes('audioStreamEnd'))).toBe(true);
  });

  it('endUserTurn is a no-op when no mic audio was streamed (cold wake)', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    const before = ws.sent.length;
    t.endUserTurn();
    expect(ws.sent.length).toBe(before);
    expect(ws.sent.some((s) => s.includes('audioStreamEnd'))).toBe(false);
  });

  it('coalesce a rajada de [update] de tela — só o estado assentado como contexto silencioso', async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const t = new GeminiLiveTransport(events(), {
      wsFactory: () => ws,
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    const before = ws.sent.length;
    t.injectScreenUpdate('tela: passo 1');
    t.injectScreenUpdate('tela: passo 2');
    t.injectScreenUpdate('tela: passo 3 final');
    // nada enviado antes do debounce
    expect(ws.sent.length).toBe(before);
    await vi.advanceTimersByTimeAsync(SCREEN_UPDATE_DEBOUNCE_MS);
    expect(ws.sent.length).toBe(before + 1);
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.clientContent.turnComplete).toBe(false);
    expect(JSON.stringify(last)).toContain('passo 3 final');
    vi.useRealTimers();
  });

  it('disjuntor TURN_MAX_MS libera a fila se um turno nunca sinaliza fim', async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const t = new GeminiLiveTransport(events(), {
      wsFactory: () => ws,
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    const before = ws.sent.length;
    t.injectNarration('a');
    t.injectNarration('b');
    expect(ws.sent.length).toBe(before + 1);
    // servidor nunca manda turnComplete — o disjuntor precisa drenar 'b'
    await vi.advanceTimersByTimeAsync(TURN_MAX_MS);
    expect(ws.sent.length).toBe(before + 2);
    expect(ws.sent.at(-1)).toContain('b');
    vi.useRealTimers();
  });

  it('emite toolCall e devolve toolResponse; ignora callId desconhecido', () => {
    const ws = fakeWs();
    const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const cancelled: string[] = [];
    const ev = {
      ...events(),
      onToolCall: (c: typeof calls[number]) => calls.push(c),
      onToolCallCancelled: (callId: string) => cancelled.push(callId),
    };
    const t = makeTransport(ws, ev);
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    ws.fire(
      'message',
      JSON.stringify({
        toolCall: { functionCalls: [{ id: 'c1', name: 'navegar', args: { target: 'grid' } }] },
      }),
    );
    expect(calls).toEqual([{ id: 'c1', name: 'navegar', args: { target: 'grid' } }]);

    ws.fire(
      'message',
      JSON.stringify({
        toolCall: { functionCalls: [{ id: 'c1', name: 'navegar', args: { target: 'grid' } }] },
      }),
    );
    expect(calls).toHaveLength(1);

    ws.fire(
      'message',
      JSON.stringify({ toolCallCancellation: { ids: ['c1'] } }),
    );
    expect(cancelled).toEqual(['c1']);

    const before = ws.sent.length;
    // callId desconhecido não emite nada
    t.sendToolResult('nope', 'navegar', { ok: true });
    expect(ws.sent.length).toBe(before);
    // callId cancelado não devolve toolResponse
    t.sendToolResult('c1', 'navegar', { ok: true, output: 'grade aberta' });
    const after = ws.sent.length;
    t.sendToolResult('c1', 'navegar', { ok: true });
    expect(ws.sent.length).toBe(after);

    ws.fire(
      'message',
      JSON.stringify({
        toolCall: { functionCalls: [{ id: 'c2', name: 'navegar', args: { target: 'board' } }] },
      }),
    );
    t.sendToolResult('c2', 'navegar', { ok: true, output: 'quadro aberto' });
    expect(JSON.parse(ws.sent.at(-1)!).toolResponse.functionResponses[0]).toMatchObject({
      id: 'c2',
      name: 'navegar',
      response: { output: { ok: true, output: 'quadro aberto' } },
    });

    ws.fire(
      'message',
      JSON.stringify({
        toolCall: { functionCalls: [{ id: 'c1', name: 'navegar', args: { target: 'grid' } }] },
      }),
    );
    expect(calls).toHaveLength(2);
  });

  it('audioStreamEnd fecha o turno de fala do usuário', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendMicChunk(Buffer.from([1, 0]).toString('base64'));
    t.endUserTurn();
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.realtimeInput.audioStreamEnd).toBe(true);
  });

  it('mantém uma sessão saudável aberta durante ociosidade normal', async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const ev = events();
    const t = new GeminiLiveTransport(ev, {
      wsFactory: () => ws,
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(ev.calls.error).toHaveLength(0);
    vi.useRealTimers();
  });

  it('watchdog de progresso: 30s sem resposta para um turno fecha o socket zumbi', async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const ev = events();
    const t = new GeminiLiveTransport(ev, {
      wsFactory: () => ws,
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendTextTurn('responda');
    // 30s sem resposta para o turno enviado → fecha o socket + erra diagnóstico
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.close).toHaveBeenCalled();
    expect(ev.calls.error.some((m) => String(m).includes('progresso'))).toBe(true);
    vi.useRealTimers();
  });

  it('watchdog de progresso é re-armado a cada mensagem do servidor', async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const t = new GeminiLiveTransport(events(), {
      wsFactory: () => ws,
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendTextTurn('responda');
    // mensagens periódicas re-armam o watchdog → nunca fecha
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      ws.fire('message', JSON.stringify({ serverContent: { outputTranscription: { text: 'oi' } } }));
    }
    expect(ws.close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('turnComplete desarma o watchdog do turno concluído', async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const ev = events();
    const t = new GeminiLiveTransport(ev, {
      wsFactory: () => ws,
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendTextTurn('responda');
    ws.fire('message', JSON.stringify({ serverContent: { turnComplete: true } }));

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(ev.calls.error).toHaveLength(0);
    vi.useRealTimers();
  });

  it('não reconecta internamente após queda; propaga closed ao controller', async () => {
    vi.useFakeTimers();
    const sockets: Array<ReturnType<typeof fakeWs>> = [];
    const ev = events();
    const t = new GeminiLiveTransport(ev, {
      wsFactory: () => {
        const ws = fakeWs();
        sockets.push(ws);
        return ws;
      },
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    const ws = sockets[0];
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(ev.calls.stateChange).toEqual(['connecting', 'ready', 'closed']);
    vi.useRealTimers();
  });

  it('não reconecta internamente nem após progresso real do servidor', async () => {
    vi.useFakeTimers();
    const sockets: Array<ReturnType<typeof fakeWs>> = [];
    const ev = events();
    const t = new GeminiLiveTransport(ev, {
      wsFactory: () => {
        const ws = fakeWs();
        sockets.push(ws);
        return ws;
      },
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    const ws = sockets[0];
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    ws.fire(
      'message',
      JSON.stringify({ serverContent: { outputTranscription: { text: 'oi' } } }),
    );
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(ev.calls.stateChange).toEqual(['connecting', 'ready', 'closed']);
    vi.useRealTimers();
  });

  it('goAway encerra o socket para o controller reconectar, sem abrir outro', async () => {
    vi.useFakeTimers();
    const sockets: Array<ReturnType<typeof fakeWs>> = [];
    const ev = events();
    const t = new GeminiLiveTransport(ev, {
      wsFactory: () => {
        const ws = fakeWs();
        sockets.push(ws);
        return ws;
      },
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    const ws = sockets[0];
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    ws.fire('message', JSON.stringify({ goAway: { timeLeft: '1s' } }));
    expect(ws.close).toHaveBeenCalledOnce();
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(ev.calls.stateChange).toEqual(['connecting', 'ready', 'closed']);
    vi.useRealTimers();
  });

  it('erro fatal de socket sobe o diagnóstico e encerra a sessão', () => {
    const ws = fakeWs();
    const ev = events();
    const t = makeTransport(ws, ev);
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    ws.fire('error', new Error('ECONNRESET'));
    expect(ev.calls.error).toEqual(['live: socket error — ECONNRESET']);
    expect(ws.close).toHaveBeenCalledOnce();
    ws.fire('close');
    expect(ev.calls.stateChange).toEqual(['connecting', 'ready', 'closed']);
  });

  it('remove a API key de erros WebSocket antes de emitir/logar', () => {
    const ws = fakeWs();
    const ev = events();
    const secret = 'AIzaSyDONT_LEAK_THIS_GEMINI_KEY_123456';
    const t = makeTransport(ws, ev);
    t.connect({
      apiKey: secret,
      model: 'm',
      voiceName: 'V',
      systemInstruction: 's',
    });
    ws.fire('open');
    ws.fire(
      'error',
      new Error(
        `Unexpected 403 at wss://example.test/live?key=${secret}&alt=ws (${secret})`,
      ),
    );

    const emitted = String(ev.calls.error[0]);
    expect(emitted).toContain('Unexpected 403');
    expect(emitted).toContain('key=[REDACTED]');
    expect(emitted).not.toContain(secret);
  });

  it('singleton cross-instância: conectar um 2º transporte encerra o 1º', () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    const t1 = new GeminiLiveTransport(events(), {
      wsFactory: () => ws1,
      now: () => 1000,
      setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    });
    const t2 = new GeminiLiveTransport(events(), {
      wsFactory: () => ws2,
      now: () => 1000,
      setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    });
    t1.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws1.fire('open');
    ws1.fire('message', JSON.stringify({ setupComplete: {} }));
    expect(t1.isReady).toBe(true);
    // t2 reivindica o slot → t1 é encerrado (F-133)
    t2.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    expect(ws1.close).toHaveBeenCalled();
    expect(t1.isReady).toBe(false);
  });

  it('órfã (perdeu o slot) não reconecta ao cair — auto-encerra', async () => {
    vi.useFakeTimers();
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    const t1calls = { n: 0 };
    const t1 = new GeminiLiveTransport(events(), {
      wsFactory: () => {
        t1calls.n += 1;
        return ws1;
      },
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    const t2 = new GeminiLiveTransport(events(), {
      wsFactory: () => ws2,
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    t1.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws1.fire('open');
    ws1.fire('message', JSON.stringify({ setupComplete: {} }));
    // t2 toma o slot; t1 vira órfã
    t2.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    const beforeCalls = t1calls.n;
    // t1 nem tenta reconectar (já encerrado); avança tempo pra provar
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t1calls.n).toBe(beforeCalls);
    vi.useRealTimers();
  });

  it('reconnect manual invalida eventos obsoletos do socket anterior', async () => {
    vi.useFakeTimers();
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    const ws3 = fakeWs();
    const sockets = [ws1, ws2, ws3];
    const ev = events();
    let call = 0;
    const t = new GeminiLiveTransport(ev, {
      wsFactory: () => sockets[call++],
      now: () => 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws1.fire('open');
    ws1.fire('message', JSON.stringify({ setupComplete: {} }));

    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws2.fire('open');
    ws2.fire('message', JSON.stringify({ setupComplete: {} }));

    ws1.fire('close');

    await vi.advanceTimersByTimeAsync(1000);

    expect(call).toBe(2);
    expect(ws2.close).not.toHaveBeenCalled();
    expect(t.isReady).toBe(true);
    vi.useRealTimers();
  });
});
