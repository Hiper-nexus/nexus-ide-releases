import { describe, expect, it } from 'vitest';
import {
  buildGrokSessionUpdate,
  createGrokRealtimeProvider,
  GROK_REALTIME_URL,
  GROK_VOICES,
} from './grok-realtime';
import type { RealtimeWsInit, RealtimeWsLike } from './openai-realtime';
import {
  DEFAULT_GROK_VOICE,
  DEFAULT_GROK_VOICE_MODEL,
} from '../../../shared/voice-config';

function sessionOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.session as Record<string, unknown>;
}

describe('buildGrokSessionUpdate', () => {
  it('puts voice and turn_detection at the session root, as xAI expects', () => {
    const session = sessionOf(
      buildGrokSessionUpdate({
        model: DEFAULT_GROK_VOICE_MODEL,
        voice: 'eve',
        instructions: 'oi',
      }),
    );

    // O dialeto diverge da OpenAI exatamente aqui: lá a voz mora em
    // `audio.output.voice` e o VAD em `audio.input.turn_detection`.
    expect(session.voice).toBe('eve');
    expect(session.turn_detection).toEqual({ type: 'server_vad' });
    expect(session.instructions).toBe('oi');
  });

  it('uses server_vad, never the OpenAI semantic_vad', () => {
    const session = sessionOf(
      buildGrokSessionUpdate({
        model: DEFAULT_GROK_VOICE_MODEL,
        voice: DEFAULT_GROK_VOICE,
        instructions: '',
      }),
    );

    expect(JSON.stringify(session)).not.toContain('semantic_vad');
  });

  it('disables server turn detection when the operator holds the key', () => {
    const session = sessionOf(
      buildGrokSessionUpdate({
        model: DEFAULT_GROK_VOICE_MODEL,
        voice: DEFAULT_GROK_VOICE,
        instructions: '',
        turnDetection: 'manual',
      }),
    );

    // Push-to-talk: quem decide o fim do turno é o humano, não o VAD.
    expect(session.turn_detection).toBeNull();
  });

  it('pins both audio legs to 24 kHz PCM so the renderer player matches', () => {
    const session = sessionOf(
      buildGrokSessionUpdate({
        model: DEFAULT_GROK_VOICE_MODEL,
        voice: DEFAULT_GROK_VOICE,
        instructions: '',
      }),
    );
    const audio = session.audio as {
      input: { format: unknown };
      output: { format: unknown };
    };

    expect(audio.input.format).toEqual({ type: 'audio/pcm', rate: 24_000 });
    expect(audio.output.format).toEqual({ type: 'audio/pcm', rate: 24_000 });
  });

  it('omits the tool block entirely when there are no tools', () => {
    const withoutTools = sessionOf(
      buildGrokSessionUpdate({
        model: DEFAULT_GROK_VOICE_MODEL,
        voice: DEFAULT_GROK_VOICE,
        instructions: '',
      }),
    );
    const withTools = sessionOf(
      buildGrokSessionUpdate({
        model: DEFAULT_GROK_VOICE_MODEL,
        voice: DEFAULT_GROK_VOICE,
        instructions: '',
        tools: [
          {
            type: 'function',
            name: 'abrir_missao',
            description: 'abre',
            parameters: { type: 'object' },
          },
        ],
      }),
    );

    expect(withoutTools).not.toHaveProperty('tools');
    expect(withoutTools).not.toHaveProperty('tool_choice');
    expect(withTools.tool_choice).toBe('auto');
    expect(withTools.tools).toHaveLength(1);
  });

  it('never sends a transcription model — the voice model transcribes itself', () => {
    const session = sessionOf(
      buildGrokSessionUpdate({
        model: DEFAULT_GROK_VOICE_MODEL,
        voice: DEFAULT_GROK_VOICE,
        instructions: '',
      }),
    );

    expect(JSON.stringify(session)).not.toContain('whisper');
  });
});

describe('createGrokRealtimeProvider', () => {
  it('dials xAI with the pinned model and a bearer token', async () => {
    let seenUrl = '';
    let seenInit: RealtimeWsInit | undefined;
    const ws: RealtimeWsLike = {
      readyState: 0,
      send: () => {},
      close: () => {},
      on: () => ws,
    } as unknown as RealtimeWsLike;

    const provider = createGrokRealtimeProvider({
      apiKey: 'xai-chave',
      instructions: 'oi',
      wsFactory: (url, init) => {
        seenUrl = url;
        seenInit = init;
        return ws;
      },
      // Sem isso o connect fica pendurado nos 10s reais do timeout.
      setTimeoutFn: ((fn: () => void) => {
        void fn;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: () => {},
    });
    void provider.connect().catch(() => {});

    expect(seenUrl).toBe(
      `${GROK_REALTIME_URL}?model=${encodeURIComponent(DEFAULT_GROK_VOICE_MODEL)}`,
    );
    expect(seenInit?.headers?.Authorization).toBe('Bearer xai-chave');
    // Nunca pode escapar para o host da OpenAI.
    expect(seenUrl).not.toContain('openai.com');
  });

  it('publishes rex as the default voice, and it is a real xAI voice', () => {
    expect(DEFAULT_GROK_VOICE).toBe('rex');
    expect(GROK_VOICES).toContain(DEFAULT_GROK_VOICE);
  });
});
