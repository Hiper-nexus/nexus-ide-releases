import { describe, expect, it } from 'vitest';
import {
  voiceConfigSchema,
  voicePluginSchema,
  DEFAULT_VOICE_CONFIG,
  migrateLegacyVoiceConfig,
  accelFromCode,
  keyCodeFromAccelerator,
  normalizeKeyCode,
  legacyVoiceConfigSchema,
} from './voice-config';

describe('voiceConfigSchema', () => {
  it('accepts the shipped default config', () => {
    const parsed = voiceConfigSchema.safeParse(DEFAULT_VOICE_CONFIG);
    expect(parsed.success).toBe(true);
  });

  it('applies defaults for omitted top-level fields', () => {
    const parsed = voiceConfigSchema.parse({
      stt: { type: 'stt', provider: 'groq' },
      tts: { type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say' },
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.routing).toBe('focused-pane');
    expect(parsed.speakMode).toBe('summary');
    expect(parsed.input.shortcut).toBe('CommandOrControl+Shift+Space');
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
    expect(config.tts.provider).toBe('openai');
    expect(voiceConfigSchema.safeParse(config).success).toBe(true);
  });

  it('maps outputMode !== english to translate false', () => {
    const config = migrateLegacyVoiceConfig({ ...legacyVoice, outputMode: 'raw' });
    expect(config.stt.translate).toBe(false);
  });

  it('builds an accelerator from the push-to-talk key code', () => {
    const config = migrateLegacyVoiceConfig(legacyVoice);
    expect(config.input.shortcut).toBe('CommandOrControl+Shift+Space');
  });
});

describe('accelFromCode', () => {
  it('prefixes a modifier so the hotkey does not collide with typing', () => {
    expect(accelFromCode('Space')).toBe('CommandOrControl+Shift+Space');
    expect(accelFromCode('F5')).toBe('CommandOrControl+Shift+F5');
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
