/**
 * Transcrição do usuário por item, aliases de texto e prova de vida do socket
 * quente (Grok Voice reaproveita o transporte do OpenAIRealtimeProvider).
 * Arquivo próprio para o teste do provider não passar do teto de linhas.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIRealtimeProvider,
  parseOpenAIRealtimeEvent,
  type RealtimeWsLike,
} from './openai-realtime';
import type { RealtimeTranscriptEvent } from './provider';

function fakeWs(): RealtimeWsLike & {
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
    on(event, cb) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    },
    fire(event, payload) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

/** Relógio manual: o teste decide quando a sonda estoura. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeoutFn: ((cb: () => void) => {
      const id = next++;
      pending.set(id, cb);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => {
      pending.delete(timer as unknown as number);
    },
    fireAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb();
    },
    get size() {
      return pending.size;
    },
  };
}

async function connectedProvider(
  options: { turnDetection?: 'semantic_vad' | 'manual' } = {},
) {
  const ws = fakeWs();
  const timers = manualTimers();
  const provider = new OpenAIRealtimeProvider({
    apiKey: 'sk-test',
    instructions: 'You are Jarvis.',
    turnDetection: options.turnDetection,
    wsFactory: () => ws,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const roleEvents: RealtimeTranscriptEvent[] = [];
  provider.onRoleTranscript((event) => roleEvents.push(event));
  const connected = provider.connect();
  ws.fire('open');
  ws.fire('message', JSON.stringify({ type: 'session.updated' }));
  await connected;
  // O timer de setup já foi limpo pelo settle; o resto é da sonda.
  ws.sent.length = 0;
  return { ws, timers, provider, roleEvents };
}

describe('parseOpenAIRealtimeEvent — texto do assistente (alias beta)', () => {
  it('trata response.text.delta/done como response.output_text.*', () => {
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({ type: 'response.text.delta', delta: 'abri' }),
      ).transcript,
    ).toEqual({ role: 'assistant', text: 'abri', final: false });
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({ type: 'response.text.done', text: 'abri o board' }),
      ).transcript,
    ).toEqual({ role: 'assistant', text: 'abri o board', final: true });
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({ type: 'response.output_text.done', transcript: 'ok' }),
      ).transcript,
    ).toEqual({ role: 'assistant', text: 'ok', final: true });
  });
});

describe('parseOpenAIRealtimeEvent — fala do usuário no snapshot do item', () => {
  const userAudioItem = (type: string, transcript: unknown) =>
    JSON.stringify({
      type,
      item: {
        id: 'item_1',
        role: 'user',
        content: [{ type: 'input_audio', transcript }],
      },
    });

  it.each(['conversation.item.created', 'conversation.item.added', 'conversation.item.done'])(
    'extrai o transcript do usuário em %s',
    (type) => {
      expect(parseOpenAIRealtimeEvent(userAudioItem(type, 'abre o board'))).toMatchObject({
        itemId: 'item_1',
        transcriptFromItem: true,
        transcript: { role: 'user', text: 'abre o board', final: true },
      });
    },
  );

  it('ignora o item criado antes da transcrição (transcript nulo ou vazio)', () => {
    for (const transcript of [null, '', '   ']) {
      expect(
        parseOpenAIRealtimeEvent(userAudioItem('conversation.item.created', transcript))
          .transcript,
      ).toBeUndefined();
    }
  });

  it('NUNCA devolve como fala do usuário o input_text que o próprio Nexus injeta', () => {
    // sendText([wake], resultado interno de ação) cria um item role=user com
    // content[].text. Se isso virasse "fala do usuário" a Jarvis obedeceria o
    // próprio prompt interno como se fosse comando.
    const injected = JSON.stringify({
      type: 'conversation.item.created',
      item: {
        id: 'item_text',
        role: 'user',
        content: [{ type: 'input_text', text: 'Internal Nexus action result. Say this now.' }],
      },
    });
    expect(parseOpenAIRealtimeEvent(injected).transcript).toBeUndefined();
  });

  it('ignora itens do assistente e function_call_output', () => {
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({
          type: 'conversation.item.done',
          item: {
            id: 'item_a',
            role: 'assistant',
            content: [{ type: 'output_audio', transcript: 'pronto' }],
          },
        }),
      ).transcript,
    ).toBeUndefined();
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({
          type: 'conversation.item.created',
          item: { id: 'item_f', type: 'function_call_output', output: '{}' },
        }),
      ).transcript,
    ).toBeUndefined();
  });

  it('o evento dedicado .completed carrega o item_id para o dedupe', () => {
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'item_1',
          transcript: 'abre o board',
        }),
      ),
    ).toMatchObject({ itemId: 'item_1', transcript: { role: 'user', final: true } });
  });
});

describe('OpenAIRealtimeProvider — dedupe da fala final do usuário', () => {
  const doneItem = (id: string, transcript: string) =>
    JSON.stringify({
      type: 'conversation.item.done',
      item: { id, role: 'user', content: [{ type: 'input_audio', transcript }] },
    });
  const completed = (id: string, transcript: string) =>
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      transcript,
    });
  const userFinals = (events: RealtimeTranscriptEvent[]) =>
    events.filter((event) => event.role === 'user' && event.final);

  it('evento dedicado primeiro, snapshot depois: entrega uma vez só', async () => {
    const { ws, roleEvents } = await connectedProvider();
    ws.fire('message', completed('item_1', 'abre o board'));
    ws.fire('message', doneItem('item_1', 'abre o board'));

    expect(userFinals(roleEvents).map((event) => event.text)).toEqual(['abre o board']);
  });

  it('snapshot primeiro, evento dedicado idêntico depois: entrega uma vez só', async () => {
    const { ws, roleEvents } = await connectedProvider();
    ws.fire('message', doneItem('item_1', 'abre o board'));
    ws.fire('message', completed('item_1', 'abre o board'));

    expect(userFinals(roleEvents).map((event) => event.text)).toEqual(['abre o board']);
  });

  it('revisão do mesmo item (texto diferente) continua passando', async () => {
    const { ws, roleEvents } = await connectedProvider();
    ws.fire('message', completed('item_1', 'abre o'));
    ws.fire('message', completed('item_1', 'abre o board'));

    expect(userFinals(roleEvents).map((event) => event.text)).toEqual([
      'abre o',
      'abre o board',
    ]);
  });

  it('itens diferentes não se bloqueiam e item sem id nunca é descartado', async () => {
    const { ws, roleEvents } = await connectedProvider();
    ws.fire('message', completed('item_1', 'um'));
    ws.fire('message', completed('item_2', 'um'));
    ws.fire(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'sem id',
      }),
    );
    ws.fire(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'sem id',
      }),
    );

    expect(userFinals(roleEvents).map((event) => event.text)).toEqual([
      'um',
      'um',
      'sem id',
      'sem id',
    ]);
  });

  it('transcript parcial (delta) do usuário não passa pelo dedupe', async () => {
    const { ws, roleEvents } = await connectedProvider();
    for (const delta of ['ab', 'abre']) {
      ws.fire(
        'message',
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: 'item_1',
          delta,
        }),
      );
    }
    expect(roleEvents.map((event) => event.text)).toEqual(['ab', 'abre']);
  });
});

describe('OpenAIRealtimeProvider.probeLiveness — socket quente', () => {
  it('resolve true quando o servidor responde o session.update da sonda', async () => {
    const { ws, provider } = await connectedProvider();

    const alive = provider.probeLiveness(800);
    expect(ws.sent.map((raw) => JSON.parse(raw).type)).toEqual(['session.update']);
    ws.fire('message', JSON.stringify({ type: 'session.updated' }));

    await expect(alive).resolves.toBe(true);
  });

  it('qualquer frame do servidor prova a sessão, não só session.updated', async () => {
    const { ws, provider } = await connectedProvider();

    const alive = provider.probeLiveness(800);
    ws.fire('message', JSON.stringify({ type: 'rate_limits.updated' }));

    await expect(alive).resolves.toBe(true);
  });

  it('resolve false quando o servidor não responde dentro do prazo (zumbi)', async () => {
    const { provider, timers } = await connectedProvider();

    const alive = provider.probeLiveness(800);
    timers.fireAll();

    await expect(alive).resolves.toBe(false);
  });

  it('resolve false quando o servidor responde com erro', async () => {
    const { ws, provider } = await connectedProvider();
    // O erro também sobe pelo canal de erro; o teste só mede a sonda.
    provider.onError(() => {});

    const alive = provider.probeLiveness(800);
    ws.fire('message', JSON.stringify({ type: 'error', error: { message: 'session expired' } }));

    await expect(alive).resolves.toBe(false);
  });

  it('resolve false quando o socket fecha no meio da sonda', async () => {
    const { ws, provider } = await connectedProvider();
    provider.onDisconnected(() => {});

    const alive = provider.probeLiveness(800);
    ws.fire('close');

    await expect(alive).resolves.toBe(false);
  });

  it('resolve false sem mandar nada quando o provider não está pronto', async () => {
    const ws = fakeWs();
    const timers = manualTimers();
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'sk-test',
      instructions: 'x',
      wsFactory: () => ws,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    await expect(provider.probeLiveness(800)).resolves.toBe(false);
    expect(ws.sent).toEqual([]);
  });

  it('close() durante a sonda resolve false e limpa o timer', async () => {
    const { provider, timers } = await connectedProvider();

    const alive = provider.probeLiveness(800);
    expect(timers.size).toBe(1);
    provider.close();

    await expect(alive).resolves.toBe(false);
    expect(timers.size).toBe(0);
  });

  it('a resposta limpa o timer da sonda (sem estouro tardio)', async () => {
    const { ws, provider, timers } = await connectedProvider();

    const alive = provider.probeLiveness(800);
    ws.fire('message', JSON.stringify({ type: 'session.updated' }));
    await alive;

    expect(timers.size).toBe(0);
  });
});

describe('OpenAIRealtimeProvider.resetTurn', () => {
  it('zera o áudio não commitado do turno anterior sem mandar nada ao servidor', async () => {
    const { ws, provider } = await connectedProvider({ turnDetection: 'manual' });
    provider.sendAudioChunk(new Int16Array([1, 2, 3]));
    ws.sent.length = 0;

    provider.resetTurn();
    provider.endUserTurn();

    // Sem áudio pendente no turno novo, endUserTurn não commita nem pede resposta.
    expect(ws.sent).toEqual([]);
  });
});
