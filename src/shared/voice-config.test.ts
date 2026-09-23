import { describe, expect, it } from 'vitest';
import {
  voiceConfigSchema,
  voicePluginSchema,
  DEFAULT_VOICE_CONFIG,
  flattenJarvisBrainProviders,
  ensureFullBrainCascade,
  resolveActiveJarvisBrain,
  migrateLegacyVoiceConfig,
  promoteJarvisBrainProvider,
  accelFromCode,
  dictationEnPresetPatch,
  isWindowScopedShortcut,
  keyCodeFromAccelerator,
  normalizeKeyCode,
  legacyVoiceConfigSchema,
  realtimeFallbackHasCredential,
} from './voice-config';

describe('voiceConfigSchema', () => {
  it('accepts the shipped default config', () => {
    const parsed = voiceConfigSchema.safeParse(DEFAULT_VOICE_CONFIG);
    expect(parsed.success).toBe(true);
  });

  it('ships one male OpenAI voice across realtime and classic TTS', () => {
    expect(DEFAULT_VOICE_CONFIG.jarvisLive.openaiVoice).toBe('ash');
    // Gemini 3.8 Flash-Lite na cabeça fala com Charon, a mesma voz do Live;
    // o OpenAI de reserva segue com ash.
    expect(DEFAULT_VOICE_CONFIG.tts.provider).toBe('gemini');
    expect(DEFAULT_VOICE_CONFIG.tts.model).toBe('gemini-3.8-flash-lite-tts');
    expect(DEFAULT_VOICE_CONFIG.tts.voice).toBe('Charon');
    expect(DEFAULT_VOICE_CONFIG.tts.fallback?.provider).toBe('openai');
    expect(DEFAULT_VOICE_CONFIG.tts.fallback?.voice).toBe('ash');
    expect(DEFAULT_VOICE_CONFIG.jarvisLive.voiceName).toBe('Charon');
  });

  it('applies defaults for omitted top-level fields', () => {
    const parsed = voiceConfigSchema.parse({
      stt: { type: 'stt', provider: 'groq' },
      tts: { type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say' },
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.routing).toBe('jarvis');
    expect(parsed.speakMode).toBe('summary');
    expect(parsed.input.shortcut).toBe('CommandOrControl+Shift+Space');
    expect(parsed.jarvisLive.enabled).toBe(false);
    expect(parsed.jarvisLive.graceReuseMs).toBe(90_000);
    expect(parsed.jarvisLive.openaiModel).toBe('gpt-realtime-2.1-mini');
    expect(parsed.jarvisLive.openaiVoice).toBe('ash');
    expect(parsed.jarvisLive.voiceName).toBe('Charon');
    expect(parsed.jarvisBrain.provider).toBe('gemini');
    expect(parsed.jarvisBrain.fallback?.provider).toBe('openai');
  });

  it('validates a nested fallback chain', () => {
    const parsed = voicePluginSchema.safeParse({
      type: 'stt',
      provider: 'groq',
      fallback: {
        type: 'stt',
        provider: 'openai',
        fallback: { type: 'stt', provider: 'local-whisper', localBin: 'whisper-cli' },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a bad endpoint url', () => {
    const parsed = voicePluginSchema.safeParse({
      type: 'stt',
      provider: 'groq',
      endpoint: 'not-a-url',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('jarvis brain providers', () => {
  it('ships Gemini → OpenAI → Groq as the configurable brain chain', () => {
    expect(
      flattenJarvisBrainProviders(DEFAULT_VOICE_CONFIG.jarvisBrain).map(
        (provider) => provider.provider,
      ),
    ).toEqual(['gemini', 'openai', 'groq']);
  });

  it('promotes the selected brain provider without mutating the original chain', () => {
    const promoted = promoteJarvisBrainProvider(
      DEFAULT_VOICE_CONFIG.jarvisBrain,
      'openai',
    );
    expect(flattenJarvisBrainProviders(promoted).map((p) => p.provider)).toEqual([
      'openai',
      'gemini',
      'groq',
    ]);
    expect(
      flattenJarvisBrainProviders(DEFAULT_VOICE_CONFIG.jarvisBrain).map(
        (p) => p.provider,
      ),
    ).toEqual(['gemini', 'openai', 'groq']);
  });

  describe('ensureFullBrainCascade (ITEM 4)', () => {
    it('appends the missing providers to a groq-only config as fallbacks', () => {
      const groqOnly = {
        provider: 'groq' as const,
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        auth: { type: 'api_key' as const, envVar: 'GROQ_API_KEY' },
        model: 'llama-3.1-8b-instant',
        jsonMode: true,
      };
      const full = flattenJarvisBrainProviders(ensureFullBrainCascade(groqOnly));
      // Head (user's groq) preserved; the other two appended as fallbacks.
      expect(full.map((p) => p.provider)).toEqual(['groq', 'gemini', 'openai']);
      // The user's own head model is not rewritten.
      expect(full[0].model).toBe('llama-3.1-8b-instant');
    });

    it('leaves the default (already full) chain untouched', () => {
      expect(ensureFullBrainCascade(DEFAULT_VOICE_CONFIG.jarvisBrain)).toBe(
        DEFAULT_VOICE_CONFIG.jarvisBrain,
      );
    });
  });

  describe('resolveActiveJarvisBrain (ITEM 4/6)', () => {
    it('names the first provider whose key resolves in the full cascade', () => {
      // Only groq resolves → even a gemini-head config answers via the groq tail.
      const active = resolveActiveJarvisBrain(
        DEFAULT_VOICE_CONFIG.jarvisBrain,
        (envVar) => envVar === 'GROQ_API_KEY',
      );
      expect(active?.provider).toBe('groq');
      expect(active?.model).toBe('llama-3.3-70b-versatile');
    });

    it('returns null when no key resolves', () => {
      expect(
        resolveActiveJarvisBrain(DEFAULT_VOICE_CONFIG.jarvisBrain, () => false),
      ).toBeNull();
    });
  });
});

describe('migrateLegacyVoiceConfig', () => {
  const legacyVoice = {
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
    language: 'pt',
    outputMode: 'english',
    captureMode: 'hold',
    pushToTalkKey: { code: 'Space' },
    interactionMode: 'coding',
    targetWpm: 190,
    chunkMs: 4700,
  };

  it('parses a real legacy audio-config', () => {
    expect(legacyVoiceConfigSchema.safeParse(legacyVoice).success).toBe(true);
  });

  it('derives the STT endpoint and translate flag from legacy fields', () => {
    const config = migrateLegacyVoiceConfig(legacyVoice);
    expect(config.stt.provider).toBe('groq');
    expect(config.stt.endpoint).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions',
    );
    expect(config.stt.translate).toBe(true);
    expect(config.stt.model).toBe('whisper-large-v3');
    expect(config.stt.chunkMs).toBe(4700);
  });

  it('carries the fallback + tts blocks from defaults', () => {
    const config = migrateLegacyVoiceConfig(legacyVoice);
    // Groq → OpenAI → local-whisper.
    expect(config.stt.fallback?.provider).toBe('openai');
    expect(config.stt.fallback?.fallback?.provider).toBe('local-whisper');
    expect(config.tts.provider).toBe('gemini');
    expect(config.tts.fallback?.provider).toBe('openai');
    expect(voiceConfigSchema.safeParse(config).success).toBe(true);
  });

  it('maps outputMode !== english to translate false', () => {
    const config = migrateLegacyVoiceConfig({ ...legacyVoice, outputMode: 'raw' });
    expect(config.stt.translate).toBe(false);
  });

  it('builds a window-scoped Space accelerator from peer ADE push-to-talk', () => {
    const config = migrateLegacyVoiceConfig(legacyVoice);
    expect(config.input.shortcut).toBe('Space');
    expect(config.routing).toBe('focused-pane');
    expect(config.speakMode).toBe('off');
  });
});

describe('accelFromCode', () => {
  it('prefixes a modifier so the hotkey does not collide with typing', () => {
    expect(accelFromCode('Space')).toBe('CommandOrControl+Shift+Space');
    expect(accelFromCode('F5')).toBe('CommandOrControl+Shift+F5');
  });
});

describe('isWindowScopedShortcut', () => {
  it('treats bare Space as window-scoped and combos as global', () => {
    expect(isWindowScopedShortcut('Space')).toBe(true);
    expect(isWindowScopedShortcut('F8')).toBe(true);
    expect(isWindowScopedShortcut('CommandOrControl+Shift+Space')).toBe(false);
  });
});

describe('dictationEnPresetPatch', () => {
  it('configures NexusVoice-style EN dictation', () => {
    const patch = dictationEnPresetPatch();
    expect(patch).toEqual({
      routing: 'focused-pane',
      speakMode: 'off',
      shortcut: 'Space',
      pushToTalkKeyCode: 'Space',
      wakeWordEnabled: false,
      jarvisLiveEnabled: false,
      sttProvider: 'groq',
    });
  });
});

describe('push-to-talk key helpers', () => {
  it('extracts the bare trigger key from an accelerator', () => {
    expect(keyCodeFromAccelerator('CommandOrControl+Shift+Space')).toBe('Space');
    expect(keyCodeFromAccelerator('Ctrl+Alt+j')).toBe('J');
  });

  it('normalizes common key names', () => {
    expect(normalizeKeyCode('spacebar')).toBe('Space');
    expect(normalizeKeyCode('f8')).toBe('F8');
    expect(normalizeKeyCode('j')).toBe('J');
  });
});

describe('realtimeFallbackHasCredential', () => {
  it('accepts XAI_API_KEY as the official grok-realtime head', () => {
    expect(
      realtimeFallbackHasCredential(
        'grok-realtime',
        (envVar) => envVar === 'XAI_API_KEY',
      ),
    ).toBe(true);
  });

  it('accepts an OpenAI or Gemini fallback when xAI is missing', () => {
    expect(
      realtimeFallbackHasCredential(
        'grok-realtime',
        (envVar) => envVar === 'OPENAI_API_KEY',
      ),
    ).toBe(true);
    expect(
      realtimeFallbackHasCredential(
        'grok-realtime',
        (envVar) => envVar === 'GEMINI_API_KEY',
      ),
    ).toBe(true);
  });

  it('is false when the chain has no key or the transport is classic', () => {
    expect(realtimeFallbackHasCredential('grok-realtime', () => false)).toBe(false);
    expect(
      realtimeFallbackHasCredential('classic', (envVar) => envVar === 'XAI_API_KEY'),
    ).toBe(false);
  });
});

describe('Grok Voice Transcribe 2.0 (xAI)', () => {
  it('o schema aceita o link xai de fábrica', async () => {
    const { DEFAULT_XAI_STT } = await import('./voice-config');
    expect(voicePluginSchema.safeParse(DEFAULT_XAI_STT).success).toBe(true);
  });

  it('a cadeia default de STT é gemini → xai → groq → openai → local-whisper', () => {
    const providers: string[] = [];
    let node = DEFAULT_VOICE_CONFIG.stt as { provider?: string; fallback?: unknown } | undefined;
    while (node?.provider) {
      providers.push(node.provider);
      node = node.fallback as typeof node;
    }
    expect(providers).toEqual([
      'gemini',
      'xai',
      'groq',
      'openai',
      'local-whisper',
    ]);
  });

  it('xai é transcription-only: não entrega PT→EN', async () => {
    const { sttProviderTranslates } = await import('./voice-config');
    expect(sttProviderTranslates('xai')).toBe(false);
    // Whisper e Gemini seguem podendo traduzir.
    expect(sttProviderTranslates('groq')).toBe(true);
    expect(sttProviderTranslates('gemini')).toBe(true);
  });
});
