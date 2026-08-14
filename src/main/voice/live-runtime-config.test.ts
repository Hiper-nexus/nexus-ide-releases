import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_VOICE_CONFIG } from '../../shared/voice-config';
import {
  isLiveTransportCredential,
  liveRuntimeFingerprint,
} from './live-runtime-config';

describe('live runtime config identity', () => {
  it('changes for provider/model/voice/enabled/persona changes', () => {
    const base = liveRuntimeFingerprint(DEFAULT_VOICE_CONFIG);
    const changed = [
      {
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          enabled: !DEFAULT_VOICE_CONFIG.jarvisLive.enabled,
        },
      },
      { jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, grokModel: 'new-grok' } },
      { jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, grokVoice: 'eve' } },
      { jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, liveModel: 'new-live' } },
      { jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, voiceName: 'Aoede' } },
      { persona: { ...DEFAULT_VOICE_CONFIG.persona, customInstructions: 'curto' } },
    ];

    for (const patch of changed) {
      expect(
        liveRuntimeFingerprint({ ...DEFAULT_VOICE_CONFIG, ...patch }),
      ).not.toBe(base);
    }
  });

  it('does not rebuild a socket only because grace/history limits changed', () => {
    const changed = {
      ...DEFAULT_VOICE_CONFIG,
      jarvisLive: {
        ...DEFAULT_VOICE_CONFIG.jarvisLive,
        graceReuseMs: DEFAULT_VOICE_CONFIG.jarvisLive.graceReuseMs + 1,
        maxWindowTurns: DEFAULT_VOICE_CONFIG.jarvisLive.maxWindowTurns + 1,
      },
    };
    expect(liveRuntimeFingerprint(changed)).toBe(
      liveRuntimeFingerprint(DEFAULT_VOICE_CONFIG),
    );
  });

  it('recognizes only realtime provider credentials', () => {
    expect(isLiveTransportCredential('XAI_API_KEY')).toBe(true);
    expect(isLiveTransportCredential('GEMINI_API_KEY')).toBe(true);
    expect(isLiveTransportCredential('OPENAI_API_KEY')).toBe(true);
    expect(isLiveTransportCredential('GROQ_API_KEY')).toBe(false);
  });
});

describe('live transport credential mapping', () => {
  it('does not collapse grok onto GEMINI_API_KEY', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'live-transport-controller.ts'),
      'utf8',
    );
    expect(source).toContain('REALTIME_PROVIDER_ENV_VAR[id]');
    expect(source).not.toContain(
      "providerId === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'",
    );
    expect(source).not.toContain(
      "id === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'",
    );
  });
});
