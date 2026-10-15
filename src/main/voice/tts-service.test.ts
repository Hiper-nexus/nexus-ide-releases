import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG, type VoiceConfig, type VoicePlugin } from '../../shared/voice-config';
import type { ProviderProbes } from './provider-select';
import {
  buildVoicePreviewText,
  extractGeminiTtsAudio,
  resetStickyTtsProvider,
  speak,
  speakPreview,
  TTS_STICKY_FALLBACK_RETRY_MS,
  VOICE_PREVIEW_MAX_CHARS,
  voicePreviewAllowed,
  type TtsDeps,
} from './tts-service';

const PROBES: ProviderProbes = { hasEnv: () => false, hasBin: () => true, platform: 'darwin' };

function deps(over: Partial<TtsDeps>): TtsDeps {
  return {
    fetchImpl: vi.fn(async () => new Response('audio', { status: 200 })) as unknown as typeof fetch,
    speakViaSay: vi.fn(async () => undefined),
    runPiper: vi.fn(() => Buffer.from('wav')),
    getEnv: vi.fn(() => undefined),
    ...over,
  };
}

/** A config whose TTS head is macOS say (no key needed). */
function sayConfig(): VoiceConfig {
  const tts: VoicePlugin = { type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say', voice: 'Luciana' };
  return { ...DEFAULT_VOICE_CONFIG, tts };
}

describe('speak', () => {
  beforeEach(() => {
    resetStickyTtsProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('condenses to a summary and plays via macOS say', async () => {
    const speakViaSay = vi.fn(async (_text: string, _voice?: string) => undefined);
    const result = await speak(
      { text: 'The build passed. All 46 tests are green. Here is a code block: `x=1`.' },
      sayConfig(),
      PROBES,
      deps({ speakViaSay }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('played');
    expect(speakViaSay).toHaveBeenCalledOnce();
    const spokenText = speakViaSay.mock.calls[0][0] as string;
    expect(spokenText).toContain('The build passed.');
    expect(spokenText).not.toContain('x=1'); // inline code stripped
  });

  it('renders macOS say to bytes when an explicit app output is selected', async () => {
    const speakViaSay = vi.fn(async () => undefined);
    const renderViaSay = vi.fn(async () => Buffer.from('aiff-audio'));
    const result = await speak(
      { text: 'Saída selecionada.', speakMode: 'full' },
      sayConfig(),
      PROBES,
      deps({
        speakViaSay,
        renderViaSay,
        getOutputDeviceId: () => 'bluetooth-headset',
      }),
    );

    expect(speakViaSay).not.toHaveBeenCalled();
    expect(renderViaSay).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      provider: 'macos-say',
      mode: 'audio',
      format: 'aiff',
    });
  });

  it('returns silent (no TTS call) when speakMode is off', async () => {
    const speakViaSay = vi.fn(async () => undefined);
    const result = await speak(
      { text: 'anything', speakMode: 'off' },
      sayConfig(),
      PROBES,
      deps({ speakViaSay }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('silent');
    expect(speakViaSay).not.toHaveBeenCalled();
  });

  it('falls through a throttled cloud provider (429) to macOS say', async () => {
    // openai (cloud) → macos-say. The cloud provider is strangled (429), so the
    // chain must land on keyless `say` instead of returning {ok:false}.
    const tts: VoicePlugin = {
      type: 'tts',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/audio/speech',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      model: 'tts-1',
      voice: 'onyx',
      format: 'mp3',
      fallback: { type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say', voice: 'Luciana' },
    };
    const config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, tts };
    const fetchImpl = vi.fn(
      async () => new Response('rate limit exceeded', { status: 429 }),
    ) as unknown as typeof fetch;
    const speakViaSay = vi.fn(async () => undefined);

    const result = await speak(
      { text: 'Tell me the build result, please.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      deps({ fetchImpl, getEnv: () => 'key', speakViaSay }),
    );

    expect(fetchImpl).toHaveBeenCalledOnce(); // cloud was actually attempted
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('played'); // spoken via say
    if (result.ok) expect(result.fallbackNote).toContain('TTS fallback');
    expect(speakViaSay).toHaveBeenCalledOnce();
  });

  it('pins the fallback voice after a primary failure to avoid voice hopping', async () => {
    const tts: VoicePlugin = {
      type: 'tts',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/audio/speech',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      fallback: { type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say', voice: 'Luciana' },
    };
    const config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, tts };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('quota', { status: 429 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    const speakViaSay = vi.fn(async () => undefined);

    await speak(
      { text: 'Primeira fala.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      deps({ fetchImpl, getEnv: () => 'key', speakViaSay }),
    );
    const second = await speak(
      { text: 'Segunda fala.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      deps({ fetchImpl, getEnv: () => 'key', speakViaSay }),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(speakViaSay).toHaveBeenCalledTimes(2);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.provider).toBe('macos-say');
      expect(second.fallbackNote).toContain('TTS fallback temporário');
    }
  });

  it('retries the configured primary voice after the fallback cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T12:00:00Z'));
    const tts: VoicePlugin = {
      type: 'tts',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/audio/speech',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      format: 'mp3',
      fallback: { type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say', voice: 'Luciana' },
    };
    const config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, tts };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('quota', { status: 429 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    const speakViaSay = vi.fn(async () => undefined);
    const sharedDeps = deps({ fetchImpl, getEnv: () => 'key', speakViaSay });

    await speak(
      { text: 'Primeira fala.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      sharedDeps,
    );
    await speak(
      { text: 'Segunda fala.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      sharedDeps,
    );
    vi.setSystemTime(new Date(vi.getMockedSystemTime()!.getTime() + TTS_STICKY_FALLBACK_RETRY_MS + 1));
    const recovered = await speak(
      { text: 'Terceira fala.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      sharedDeps,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(speakViaSay).toHaveBeenCalledTimes(2);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.provider).toBe('openai');
      expect(recovered.mode).toBe('audio');
      expect(recovered.fallbackNote).toBeUndefined();
    }
  });

  it('walks openai(429) → piper(broken) → say to keep the guarantee', async () => {
    const tts: VoicePlugin = {
      type: 'tts',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/audio/speech',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      fallback: {
        type: 'tts',
        provider: 'piper',
        localBin: 'piper',
        fallback: { type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say' },
      },
    };
    const config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, tts };
    const fetchImpl = vi.fn(
      async () => new Response('quota', { status: 429 }),
    ) as unknown as typeof fetch;
    const runPiper = vi.fn(() => {
      throw new Error('piper binary missing');
    });
    const speakViaSay = vi.fn(async () => undefined);

    const result = await speak(
      { text: 'Please read the summary aloud now.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      deps({ fetchImpl, getEnv: () => 'key', runPiper, speakViaSay }),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(runPiper).toHaveBeenCalledOnce();
    expect(speakViaSay).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('played');
  });

  it('reports every attempt when the whole chain fails', async () => {
    // openai(429) → piper(broken); no `say` terminal. Error must name both.
    const tts: VoicePlugin = {
      type: 'tts',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/audio/speech',
      auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
      fallback: { type: 'tts', provider: 'piper', localBin: 'piper' },
    };
    const config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, tts };
    const fetchImpl = vi.fn(
      async () => new Response('rate limit', { status: 429 }),
    ) as unknown as typeof fetch;
    const runPiper = vi.fn(() => {
      throw new Error('no piper');
    });

    const result = await speak(
      { text: 'Read this back to me.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      deps({ fetchImpl, getEnv: () => 'key', runPiper }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('openai');
      expect(result.error).toContain('piper');
    }
  });

  it('returns audio bytes when a cloud TTS provider is active', async () => {
    const config: VoiceConfig = {
      ...DEFAULT_VOICE_CONFIG,
      tts: {
        type: 'tts',
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1/audio/speech',
        auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
        model: 'tts-1',
        voice: 'onyx',
        format: 'mp3',
      },
    };
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await speak(
      { text: 'Speak this line, please.', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      deps({ fetchImpl, getEnv: () => 'key' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'audio') {
      expect(result.format).toBe('mp3');
      expect(result.audioBase64.length).toBeGreaterThan(0);
    }
  });

  it('sends persona instructions to the high-quality OpenAI voice model', async () => {
    const config: VoiceConfig = {
      ...DEFAULT_VOICE_CONFIG,
      persona: {
        assistantName: 'Jarvis',
        userName: 'patrão',
        customInstructions: 'seja cordial e breve',
      },
      tts: {
        type: 'tts',
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1/audio/speech',
        auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
        model: 'gpt-4o-mini-tts',
        voice: 'nova',
        format: 'mp3',
      },
    };
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await speak(
      { text: 'Pois não, patrão?', speakMode: 'full' },
      config,
      { ...PROBES, hasEnv: () => true },
      deps({ fetchImpl, getEnv: () => 'key' }),
    );

    expect(result.ok).toBe(true);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-4o-mini-tts');
    expect(body.instructions).toContain('pronúncia brasileira');
    expect(body.instructions).toContain('patrão');
    expect(body.instructions).toContain('seja cordial e breve');
  });
});

describe('Gemini 3.8 TTS', () => {
  beforeEach(() => {
    resetStickyTtsProvider();
  });

  const geminiResponse = (data: string) =>
    new Response(
      JSON.stringify({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data }] }],
      }),
      { status: 200 },
    );

  it('fala pelo Flash-Lite com a key Gemini, persona no style e WAV de volta', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => geminiResponse('UklGRg=='));
    const result = await speak(
      { text: 'O build terminou.', speakMode: 'full' },
      DEFAULT_VOICE_CONFIG,
      PROBES,
      deps({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getEnv: vi.fn((name: string) => (name === 'GEMINI_API_KEY' ? 'g-key' : undefined)),
      }),
    );
    expect(result).toMatchObject({ ok: true, provider: 'gemini', mode: 'audio', format: 'wav', audioBase64: 'UklGRg==' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gemini-3.8-flash-lite-tts');
    expect(body.generation_config.speech_config).toEqual([{ voice: 'Charon' }]);
    expect(body.input[0].content[0].text).toBe('O build terminou.');
    expect(body.input[0].content[0].annotations[0].style).toContain('português brasileiro');
  });

  it('sem key Gemini cai direto no OpenAI de reserva, sem chamar o Google', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('mp3', { status: 200 }));
    const result = await speak(
      { text: 'Oi.', speakMode: 'full' },
      DEFAULT_VOICE_CONFIG,
      PROBES,
      deps({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getEnv: vi.fn((name: string) => (name === 'OPENAI_API_KEY' ? 'o-key' : undefined)),
      }),
    );
    expect(result).toMatchObject({ ok: true, provider: 'openai' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toContain('api.openai.com');
  });

  it('resposta sem áudio conta como falha e segue a cadeia', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ steps: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('mp3', { status: 200 }));
    const result = await speak(
      { text: 'Oi.', speakMode: 'full' },
      DEFAULT_VOICE_CONFIG,
      PROBES,
      deps({ fetchImpl: fetchImpl as unknown as typeof fetch, getEnv: vi.fn(() => 'k') }),
    );
    expect(result).toMatchObject({ ok: true, provider: 'openai' });
    if (result.ok) expect(result.fallbackNote).toContain('gemini TTS returned no audio');
  });

  it('extrai o áudio de steps[].content[]', () => {
    expect(
      extractGeminiTtsAudio({
        steps: [{ content: [{ type: 'text', text: 'x' }, { type: 'audio', data: 'AA', mime_type: 'audio/wav' }] }],
      }),
    ).toEqual({ data: 'AA', mimeType: 'audio/wav' });
    expect(extractGeminiTtsAudio({ output_audio: { data: 'AA' } })).toBeNull();
  });
});

describe('speakPreview (pre-escuta da voz)', () => {
  beforeEach(() => {
    resetStickyTtsProvider();
  });

  const geminiAudio = () =>
    new Response(
      JSON.stringify({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: 'UklGRg==' }] }],
      }),
      { status: 200 },
    );

  it('a frase da amostra e montada no Main e a voz escolhida vai no corpo', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => geminiAudio());
    const result = await speakPreview(
      { provider: 'gemini', voice: 'Sulafat' },
      { ...DEFAULT_VOICE_CONFIG, persona: { ...DEFAULT_VOICE_CONFIG.persona, assistantName: 'Jarvis' } },
      deps({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getEnv: vi.fn((name: string) => (name === 'GEMINI_API_KEY' ? 'g-key' : undefined)),
      }),
    );

    expect(result).toMatchObject({ ok: true, provider: 'gemini', mode: 'audio' });
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(String(init.body));
    // A voz pedida e a do seletor, nao a do config.
    expect(body.generation_config.speech_config).toEqual([{ voice: 'Sulafat' }]);
    // O texto nao vem do renderer.
    expect(body.input[0].content[0].text).toBe('Olá, eu sou Jarvis. Esta é a minha voz.');
  });

  it('sem fallback: provider pedido que falha devolve o erro DELE, nao a voz de outro', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('googleapis') ? new Response('boom', { status: 500 }) : new Response('mp3', { status: 200 }),
    );
    const result = await speakPreview(
      { provider: 'gemini', voice: 'Charon' },
      DEFAULT_VOICE_CONFIG,
      deps({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getEnv: vi.fn(() => 'k'),
      }),
    );

    expect(result.ok).toBe(false);
    // Uma unica chamada: a cadeia nao foi percorrida.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('googleapis');
  });

  it('voz fora da allowlist e recusada SEM qualquer fetch', async () => {
    const fetchImpl = vi.fn(async () => geminiAudio());
    const result = await speakPreview(
      { provider: 'gemini', voice: 'Zeus' },
      DEFAULT_VOICE_CONFIG,
      deps({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getEnv: vi.fn(() => 'g-key'),
      }),
    );

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a allowlist e a mesma do seletor de tela (por provider)', () => {
    expect(voicePreviewAllowed('gemini', 'Sulafat')).toBe(true);
    expect(voicePreviewAllowed('gemini', 'ash')).toBe(false);
    expect(voicePreviewAllowed('openai', 'ash')).toBe(true);
    expect(voicePreviewAllowed('openai', 'Sulafat')).toBe(false);
  });

  it('a amostra nao gruda no provider sticky nem no supressor de eco', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('googleapis')
        ? new Response(
            JSON.stringify({
              status: 'completed',
              steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: 'UklGRg==' }] }],
            }),
            { status: 200 },
          )
        : new Response('mp3', { status: 200 }),
    );
    const ttsDeps = deps({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getEnv: vi.fn(() => 'k'),
    });

    // Fala normal: a cabeça da cadeia (gemini) funciona e gruda.
    await speak({ text: 'Oi.', speakMode: 'full' }, DEFAULT_VOICE_CONFIG, PROBES, ttsDeps);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('googleapis');

    // Amostra pelo OpenAI: funciona, mas nao pode virar o provider escolhido.
    const preview = await speakPreview(
      { provider: 'openai', voice: 'ash' },
      DEFAULT_VOICE_CONFIG,
      ttsDeps,
    );
    expect(preview).toMatchObject({ ok: true, provider: 'openai' });

    // A fala seguinte continua na cabeça: se a amostra tivesse grudado, viraria
    // openai (fallback promoted) e a voz da conversa mudaria sozinha.
    fetchImpl.mockClear();
    await speak({ text: 'Oi de novo.', speakMode: 'full' }, DEFAULT_VOICE_CONFIG, PROBES, ttsDeps);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('googleapis');
  });

  it('a frase da amostra respeita o nome da persona e o teto de 80 caracteres', () => {
    expect(buildVoicePreviewText('Jarvis')).toBe('Olá, eu sou Jarvis. Esta é a minha voz.');
    expect(buildVoicePreviewText('  ')).toBe('Olá, eu sou Jarvis. Esta é a minha voz.');
    const long = buildVoicePreviewText('N'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(VOICE_PREVIEW_MAX_CHARS);
  });
});
