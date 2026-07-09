import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../../shared/voice-config';
import {
  loadJarvisSystemPrompt,
  resolveOpenAiRealtimeVoice,
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
    // Default transport is now realtime (gemini-live) — the 2026-07-06
    // hibernation ('classic' → no provider) was reverted by the approved
    // decision; runtime degradation to Classic replaces config coercion.
    expect(resolveRealtimeProviderId(DEFAULT_VOICE_CONFIG)).toBe('gemini');
    expect(
      resolveRealtimeProviderId({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, transport: 'classic' },
      }),
    ).toBe(null);
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

  it('gemini-live prefers Gemini but keeps OpenAI Realtime as fallback', () => {
    // A keyless Gemini is skipped by createRealtimeProviderCandidates, so an
    // existing OPENAI_API_KEY still engages realtime instead of degrading.
    expect(
      resolveRealtimeProviderIds({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          transport: 'gemini-live',
        },
      }),
    ).toEqual(['gemini', 'openai']);
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
    const prompt = loadJarvisSystemPrompt('/missing/system.en.md');
    expect(prompt).toContain('voice assistant embedded in Nexus IDE');
    expect(prompt).toContain('nexus_action');
    expect(prompt).toContain('mcp_tool');
    expect(prompt).toContain('Speak directly for normal conversation');
    expect(prompt).not.toContain('safe Nexus UI actions only');
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

  it('maps unsupported OpenAI TTS voices (nova) to the stable realtime voice', async () => {
    expect(resolveOpenAiRealtimeVoice('nova')).toBe('marin');
    expect(resolveOpenAiRealtimeVoice('cedar')).toBe('cedar');

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
