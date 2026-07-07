import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../../shared/voice-config';
import {
  loadJarvisSystemPrompt,
  resolveRealtimeProviderId,
} from './factory';

describe('resolveRealtimeProviderId', () => {
  it('prioritizes NEXUS_REALTIME_PROVIDER over panel transport', () => {
    const config = {
      ...DEFAULT_VOICE_CONFIG,
      jarvisLive: {
        ...DEFAULT_VOICE_CONFIG.jarvisLive,
        transport: 'gemini-live' as const,
      },
    };
    expect(resolveRealtimeProviderId(config, { NEXUS_REALTIME_PROVIDER: 'openai' })).toBe(
      'openai',
    );
  });

  it('maps panel transport to provider id', () => {
    expect(
      resolveRealtimeProviderId({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          transport: 'openai-realtime',
        },
      }),
    ).toBe('openai');
    expect(resolveRealtimeProviderId(DEFAULT_VOICE_CONFIG)).toBe(null);
  });
});

describe('loadJarvisSystemPrompt', () => {
  it('loads the English system prompt from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-prompt-'));
    const file = path.join(dir, 'system.en.md');
    fs.writeFileSync(file, 'You are Jarvis.\n', 'utf-8');

    expect(loadJarvisSystemPrompt(file)).toBe('You are Jarvis.');
  });

  it('has an English fallback when packaged prompt is missing', () => {
    expect(loadJarvisSystemPrompt('/missing/system.en.md')).toContain(
      'voice assistant embedded in Nexus IDE',
    );
  });
});

describe('createRealtimeProvider', () => {
  it('returns null when OPENAI_API_KEY is unavailable', async () => {
    vi.resetModules();
    vi.doMock('../../voice/voice-secrets', () => ({
      resolveVoiceApiKey: () => undefined,
    }));
    const { createRealtimeProvider } = await import('./factory');
    const config = {
      ...DEFAULT_VOICE_CONFIG,
      jarvisLive: {
        ...DEFAULT_VOICE_CONFIG.jarvisLive,
        transport: 'openai-realtime' as const,
      },
    };

    expect(createRealtimeProvider({ config, instructions: 'You are Jarvis.' })).toBe(null);
    vi.doUnmock('../../voice/voice-secrets');
  });
});
