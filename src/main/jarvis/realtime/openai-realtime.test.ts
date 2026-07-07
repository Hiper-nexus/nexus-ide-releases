import { describe, expect, it, vi } from 'vitest';
import {
  buildOpenAISessionUpdate,
  OpenAIRealtimeProvider,
  parseOpenAIRealtimeEvent,
  type RealtimeWsLike,
} from './openai-realtime';

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

describe('buildOpenAISessionUpdate', () => {
  it('builds the GA realtime session shape with server VAD', () => {
    const update = buildOpenAISessionUpdate({
      model: 'gpt-realtime-2.1',
      voice: 'alloy',
      instructions: 'You are Jarvis.',
    });
    expect(update).toMatchObject({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        output_modalities: ['text', 'audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            turn_detection: { type: 'server_vad', threshold: 0.5 },
          },
          output: {
            format: { type: 'audio/pcm' },
            voice: 'alloy',
          },
        },
      },
    });
  });
});

describe('parseOpenAIRealtimeEvent', () => {
  it('parses GA and beta audio/transcript event names', () => {
    const audio = Buffer.from(new Int16Array([1, -2]).buffer).toString('base64');
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({ type: 'response.output_audio.delta', delta: audio }),
      ).audio,
    ).toEqual(new Int16Array([1, -2]));
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({ type: 'response.audio.delta', delta: audio }),
      ).audio,
    ).toEqual(new Int16Array([1, -2]));
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({
          type: 'response.output_audio_transcript.delta',
          delta: 'oi',
        }),
      ).transcript,
    ).toEqual({ role: 'assistant', text: 'oi', final: false });
  });

  it('parses VAD, user transcription, done and error events', () => {
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
      ).speechStarted,
    ).toBe(true);
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'abra o package',
        }),
      ).transcript,
    ).toEqual({ role: 'user', text: 'abra o package', final: true });
    expect(
      parseOpenAIRealtimeEvent(JSON.stringify({ type: 'response.done' })).responseDone,
    ).toBe(true);
    expect(
      parseOpenAIRealtimeEvent(
        JSON.stringify({ type: 'error', error: { message: 'bad session' } }),
      ).error?.message,
    ).toBe('bad session');
  });
});

describe('OpenAIRealtimeProvider', () => {
  it('connects with Authorization, sends session.update, then flushes pending audio', async () => {
    const ws = fakeWs();
    let observedUrl = '';
    let observedAuth = '';
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'sk-test',
      instructions: 'You are Jarvis.',
      wsFactory: (url, init) => {
        observedUrl = url;
        observedAuth = init.headers.Authorization;
        return ws;
      },
      setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    });

    const connected = provider.connect();
    provider.sendAudioChunk(new Int16Array([100, 200, 300]));
    ws.fire('open');
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).type).toBe('session.update');

    ws.fire('message', JSON.stringify({ type: 'session.updated' }));
    await connected;

    expect(observedUrl).toBe(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
    );
    expect(observedAuth).toBe('Bearer sk-test');
    expect(ws.sent).toHaveLength(2);
    const append = JSON.parse(ws.sent[1]);
    expect(append.type).toBe('input_audio_buffer.append');
    expect(typeof append.audio).toBe('string');
  });

  it('commits a turn and requests an audio/text response', async () => {
    const ws = fakeWs();
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'sk-test',
      instructions: 'You are Jarvis.',
      wsFactory: () => ws,
      setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    });
    const connected = provider.connect();
    ws.fire('open');
    ws.fire('message', JSON.stringify({ type: 'session.updated' }));
    await connected;

    provider.endUserTurn();
    expect(ws.sent.map((item) => JSON.parse(item).type)).toEqual([
      'session.update',
      'input_audio_buffer.commit',
      'response.create',
    ]);
  });

  it('sends text smoke-test input through the realtime conversation', async () => {
    const ws = fakeWs();
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'sk-test',
      instructions: 'You are Jarvis.',
      wsFactory: () => ws,
      setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    });
    const connected = provider.connect();
    ws.fire('open');
    ws.fire('message', JSON.stringify({ type: 'session.updated' }));
    await connected;

    provider.sendText('diagnóstico rápido');

    const sentTypes = ws.sent.map((item) => JSON.parse(item).type);
    expect(sentTypes).toEqual([
      'session.update',
      'conversation.item.create',
      'response.create',
    ]);
    expect(JSON.stringify(JSON.parse(ws.sent[1]))).toContain('diagnóstico rápido');
  });

  it('emits audio/transcript callbacks and cancels response on speech_started', async () => {
    const ws = fakeWs();
    const audioEvents: Int16Array[] = [];
    const transcriptEvents: Array<{ text: string; final: boolean }> = [];
    const roleEvents: unknown[] = [];
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'sk-test',
      instructions: 'You are Jarvis.',
      wsFactory: () => ws,
      setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    });
    provider.onAudioOut((audio) => audioEvents.push(audio));
    provider.onTranscript((text, final) => transcriptEvents.push({ text, final }));
    provider.onRoleTranscript((event) => roleEvents.push(event));

    const connected = provider.connect();
    ws.fire('open');
    ws.fire('message', JSON.stringify({ type: 'session.updated' }));
    await connected;

    const audio = Buffer.from(new Int16Array([7]).buffer).toString('base64');
    ws.fire('message', JSON.stringify({ type: 'response.output_audio.delta', delta: audio }));
    ws.fire(
      'message',
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: 'pronto',
      }),
    );
    ws.fire('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));

    expect(audioEvents).toEqual([new Int16Array([7])]);
    expect(transcriptEvents).toContainEqual({ text: 'pronto', final: false });
    expect(roleEvents).toContainEqual({
      role: 'assistant',
      text: 'pronto',
      final: false,
    });
    expect(ws.sent.map((item) => JSON.parse(item).type)).toContain('response.cancel');
  });
});
