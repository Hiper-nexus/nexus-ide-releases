import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from '../../shared/voice-config';
import type { TranscribeRequest } from '../../shared/voice-ipc';
import type { ProviderProbes } from './provider-select';
import { transcribe, describeHttpFailure, resolveEndpoint, type SttDeps } from './stt-service';

const REQ: TranscribeRequest = {
  audioBase64: Buffer.from('fake-wav').toString('base64'),
  mime: 'audio/wav',
  sampleRate: 16_000,
};

const PROBES: ProviderProbes = { hasEnv: () => true, hasBin: () => true, platform: 'darwin' };

/** Build a config with the Groq → OpenAI → local-whisper chain. */
function config(): VoiceConfig {
  return DEFAULT_VOICE_CONFIG;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Base deps with everything stubbed; override per test. */
function deps(over: Partial<SttDeps>): SttDeps {
  return {
    fetchImpl: vi.fn(async () => jsonResponse(500, {})) as unknown as typeof fetch,
    runLocal: vi.fn(),
    readText: vi.fn(() => ''),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    fileExists: vi.fn(() => false),
    findBin: vi.fn(() => null),
    getEnv: vi.fn(() => 'test-key'),
    ...over,
  };
}

describe('describeHttpFailure', () => {
  it('classifies rate-limit / quota / auth / server errors', () => {
    expect(describeHttpFailure(429).reason).toContain('429');
    expect(describeHttpFailure(402).reason).toContain('402');
    expect(describeHttpFailure(403).reason).toContain('403');
    expect(describeHttpFailure(401).needsKey).toBe(true);
    expect(describeHttpFailure(503).reason).toContain('503');
  });
});

describe('resolveEndpoint', () => {
  it('swaps to /audio/translations when translating', () => {
    expect(
      resolveEndpoint(
        { type: 'stt', provider: 'groq', endpoint: 'https://x/openai/v1/audio/transcriptions' },
        true,
      ),
    ).toBe('https://x/openai/v1/audio/translations');
  });

  it('keeps /audio/transcriptions when not translating', () => {
    expect(
      resolveEndpoint(
        { type: 'stt', provider: 'groq', endpoint: 'https://x/openai/v1/audio/transcriptions' },
        false,
      ),
    ).toBe('https://x/openai/v1/audio/transcriptions');
  });
});

describe('transcribe — quota/rate-limit fallback (free-tier Groq)', () => {
  it('falls through from a 429 Groq to a working OpenAI', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('groq.com')) return jsonResponse(429, { error: 'rate limit' });
      return jsonResponse(200, { text: 'hello from openai' });
    }) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('openai');
      expect(result.text).toBe('hello from openai');
      expect(result.fallbackNote).toContain('groq');
      expect(result.fallbackNote).toContain('429');
    }
  });

  it('skips a keyless Groq and uses OpenAI without a network call to Groq', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'via openai' })) as unknown as typeof fetch;
    const getEnv = vi.fn((n: string) => (n === 'OPENAI_API_KEY' ? 'key' : undefined));

    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl, getEnv }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe('openai');
    // Only OpenAI was called; Groq was skipped for the missing key.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('falls all the way to keyless local whisper.cpp when both clouds fail', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('groq.com')) return jsonResponse(429, {});
      return jsonResponse(402, {}); // openai quota exhausted
    }) as unknown as typeof fetch;

    const result = await transcribe(
      REQ,
      config(),
      PROBES,
      deps({
        fetchImpl,
        findBin: vi.fn(() => 'whisper-cli'),
        fileExists: vi.fn(() => true),
        readText: vi.fn(() => '  transcribed locally  '),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('local-whisper');
      expect(result.text).toBe('transcribed locally');
    }
  });

  it('reports a clear, actionable error when everything fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {})) as unknown as typeof fetch;
    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('whisper.cpp');
      expect(result.error).toMatch(/GROQ_API_KEY|OPENAI_API_KEY/);
      expect(result.attempts.map((a) => a.provider)).toEqual([
        'groq',
        'openai',
        'local-whisper',
      ]);
    }
  });

  it('does not call the network for a provider whose key is missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'x' })) as unknown as typeof fetch;
    const getEnv = vi.fn(() => undefined); // no keys anywhere
    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl, getEnv }));
    // Both clouds skipped (no key), local unavailable → failure, zero fetches.
    expect(result.ok).toBe(false);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    if (!result.ok) expect(result.needsKey).toBe(true);
  });
});
