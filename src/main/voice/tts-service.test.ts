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
});
