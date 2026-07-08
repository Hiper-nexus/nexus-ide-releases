import { describe, expect, it, vi } from 'vitest';
import {
  buildSetupMessage,
  GeminiLiveTransport,
  parseServerMessage,
  type LiveTransportEvents,
  type WsLike,
} from './gemini-live-transport';
import { NARRATION_ENVELOPE } from '../jarvis/realtime/live-narration';
import { SCREEN_UPDATE_DEBOUNCE_MS } from '../jarvis/realtime/screen-coalescer';
import { TURN_MAX_MS } from '../jarvis/realtime/turn-queue';

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

function makeTransport(ws: WsLike, ev: LiveTransportEvents) {
  return new GeminiLiveTransport(ev, {
    wsFactory: () => ws,
    now: () => 1000,
    setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
    clearTimeoutFn: () => {},
  });
}

describe('buildSetupMessage', () => {
  it('inclui modelo, voz, idioma, transcrições e sliding window', () => {
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
    expect(JSON.stringify(msg)).toContain('pt-BR');
    expect(msg.setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(msg.setup.inputAudioTranscription).toEqual({});
    expect(msg.setup.outputAudioTranscription).toEqual({});
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
    expect(audio.audioB64).toBe('QUJD');

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

  it('mensagem ilegível não explode', () => {
    expect(parseServerMessage('garbage')).toEqual({});
  });
});

describe('GeminiLiveTransport', () => {
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

  it('envia contexto de tela como clientContent sem fechar o turno', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendContext('tela: 3 panes abertos');
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.clientContent.turnComplete).toBe(false);
    expect(JSON.stringify(last)).toContain('3 panes');
  });

  it('envia texto como turno completo para smoke/fallback', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.sendTextTurn('teste jarvis');
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.clientContent.turnComplete).toBe(true);
    expect(JSON.stringify(last)).toContain('teste jarvis');
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

  it('injectNarration embrulha no envelope e envia como turno completo', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.injectNarration('o build passou');
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.clientContent.turnComplete).toBe(true);
    const text = last.clientContent.turns[0].parts[0].text as string;
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

  it('audioStreamEnd fecha o turno de fala do usuário', () => {
    const ws = fakeWs();
    const t = makeTransport(ws, events());
    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws.fire('open');
    ws.fire('message', JSON.stringify({ setupComplete: {} }));
    t.endUserTurn();
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.realtimeInput.audioStreamEnd).toBe(true);
  });

  it('ignores an obsolete reconnect timer after a manual reconnect', async () => {
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
    ws1.fire('close');

    t.connect({ apiKey: 'k', model: 'm', voiceName: 'V', systemInstruction: 's' });
    ws2.fire('open');
    ws2.fire('message', JSON.stringify({ setupComplete: {} }));

    await vi.advanceTimersByTimeAsync(1000);

    expect(call).toBe(2);
    expect(ws2.close).not.toHaveBeenCalled();
    expect(t.isReady).toBe(true);
    vi.useRealTimers();
  });
});
