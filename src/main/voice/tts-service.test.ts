import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG, type VoiceConfig, type VoicePlugin } from '../../shared/voice-config';
import type { ProviderProbes } from './provider-select';
import { speak, type TtsDeps } from './tts-service';

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
    expect(speakViaSay).toHaveBeenCalledOnce();
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
