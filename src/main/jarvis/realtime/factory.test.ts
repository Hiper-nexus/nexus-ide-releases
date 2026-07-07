import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../../shared/voice-config';
import {
  loadJarvisSystemPrompt,
  resolveRealtimeProviderId,
  resolveRealtimeProviderIds,
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

  it('orders OpenAI Realtime before Gemini Live fallback', () => {
    expect(
      resolveRealtimeProviderIds({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          transport: 'openai-realtime',
        },
      }),
    ).toEqual(['openai', 'gemini']);
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

  it('creates the Gemini Live fallback when GEMINI_API_KEY is available', async () => {
    vi.resetModules();
    vi.doMock('../../voice/voice-secrets', () => ({
      resolveVoiceApiKey: (envVar: string) =>
        envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined,
    }));
    const { createRealtimeProvider } = await import('./factory');
    const config = {
      ...DEFAULT_VOICE_CONFIG,
      jarvisLive: {
        ...DEFAULT_VOICE_CONFIG.jarvisLive,
        transport: 'gemini-live' as const,
      },
    };

    expect(createRealtimeProvider({ config, instructions: 'You are Jarvis.' })).not.toBe(null);
    vi.doUnmock('../../voice/voice-secrets');
  });

  it('creates candidates in OpenAI then Gemini order when both keys are available', async () => {
    vi.resetModules();
    vi.doMock('../../voice/voice-secrets', () => ({
      resolveVoiceApiKey: (envVar: string) =>
        envVar === 'OPENAI_API_KEY' || envVar === 'GEMINI_API_KEY'
          ? `${envVar}-value`
          : undefined,
    }));
    const { createRealtimeProviderCandidates } = await import('./factory');
    const config = {
      ...DEFAULT_VOICE_CONFIG,
      jarvisLive: {
        ...DEFAULT_VOICE_CONFIG.jarvisLive,
        transport: 'openai-realtime' as const,
      },
    };

    expect(
      createRealtimeProviderCandidates({ config, instructions: 'You are Jarvis.' }).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(['openai', 'gemini']);
    vi.doUnmock('../../voice/voice-secrets');
  });

  it('maps unsupported OpenAI TTS voices (nova) to alloy for realtime', async () => {
    vi.resetModules();
    vi.doMock('../../voice/voice-secrets', () => ({
      resolveVoiceApiKey: (envVar: string) =>
        envVar === 'OPENAI_API_KEY' || envVar === 'GEMINI_API_KEY'
          ? `${envVar}-value`
          : undefined,
    }));
    const { createRealtimeProviderCandidates } = await import('./factory');
    const config = {
      ...DEFAULT_VOICE_CONFIG,
      jarvisLive: {
        ...DEFAULT_VOICE_CONFIG.jarvisLive,
        transport: 'openai-realtime' as const,
        openaiVoice: 'nova',
      },
    };

    expect(
      createRealtimeProviderCandidates({ config, instructions: 'You are Jarvis.' }).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(['openai', 'gemini']);
    vi.doUnmock('../../voice/voice-secrets');
  });
});
