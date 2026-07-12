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

  // A quick provider failure must not silence machines without local whisper.
  // The total budget still bounds a genuinely hung provider.
  it('wake budget: after one fast cloud failure, tries the 2nd cloud inside the remaining budget', async () => {
    const calledHosts: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calledHosts.push(String(url));
      if (String(url).includes('groq.com')) return jsonResponse(429, {});
      return jsonResponse(200, { text: 'openai recovered the wake' });
    }) as unknown as typeof fetch;

    const result = await transcribe(
      { ...REQ, budgetMs: 8_000 },
      config(),
      PROBES,
      deps({
        fetchImpl,
        findBin: vi.fn(() => null),
        fileExists: vi.fn(() => false),
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('openai');
      expect(result.text).toBe('openai recovered the wake');
    }
    expect(calledHosts.filter((h) => h.includes('groq.com'))).toHaveLength(1);
    expect(calledHosts.filter((h) => h.includes('openai.com'))).toHaveLength(1);
  });

  it('wake budget: skips ALL cloud when the budget is already spent (injected clock)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'should-not-run' })) as unknown as typeof fetch;
    // Clock jumps 9s after the first read → budget (8s) is spent before any cloud call.
    let t = 0;
    const now = () => {
      const v = t;
      t += 9_000;
      return v;
    };

    const result = await transcribe(
      { ...REQ, budgetMs: 8_000 },
      config(),
      PROBES,
      deps({
        fetchImpl,
        now,
        findBin: vi.fn(() => 'whisper-cli'),
        fileExists: vi.fn(() => true),
        readText: vi.fn(() => '  local only  '),
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('local-whisper');
      expect(result.stalled).toBe(true);
    }
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('probes Homebrew whisper-cli paths for GUI-launched macOS apps', async () => {
    let candidates: string[] = [];
    const findBin = vi.fn((items: string[]) => {
      candidates = items;
      return items.includes('/opt/homebrew/bin/whisper-cli')
        ? '/opt/homebrew/bin/whisper-cli'
        : null;
    });

    const result = await transcribe(
      REQ,
      config(),
      PROBES,
      deps({
        findBin,
        fileExists: vi.fn(() => true),
        getEnv: vi.fn(() => undefined),
        readText: vi.fn(() => '  local without shell path  '),
      }),
    );

    expect(candidates).toContain('/opt/homebrew/bin/whisper-cli');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('local-whisper');
      expect(result.text).toBe('local without shell path');
    }
  });

  it('honors the turn request language when local whisper is the fallback', async () => {
    const runLocal = vi.fn();

    const result = await transcribe(
      { ...REQ, translate: false, language: 'pt' },
      config(),
      PROBES,
      deps({
        findBin: vi.fn(() => '/opt/homebrew/bin/whisper-cli'),
        fileExists: vi.fn(() => true),
        getEnv: vi.fn(() => undefined),
        readText: vi.fn(() => '  abrir terminal  '),
        runLocal,
      }),
    );

    expect(result.ok).toBe(true);
    const args = runLocal.mock.calls[0]?.[1] ?? [];
    expect(args).toContain('-l');
    expect(args[args.indexOf('-l') + 1]).toBe('pt');
    expect(args).not.toContain('-tr');
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

describe('transcribe — passive wake', () => {
  it('biases the short transcription toward the configured Jarvis wake word', async () => {
    let prompt: FormDataEntryValue | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      prompt = (init?.body as FormData).get('prompt');
      return jsonResponse(200, { text: 'jarvis' });
    }) as unknown as typeof fetch;

    const result = await transcribe(
      { ...REQ, purpose: 'passive-wake', budgetMs: 3_500 },
      config(),
      PROBES,
      deps({ fetchImpl }),
    );

    expect(result.ok).toBe(true);
    expect(prompt).toBeTypeOf('string');
    expect(prompt).toContain('Jarvis');
  });

  it('promotes Groq for a short textual wake instead of waiting on an OpenAI head', async () => {
    const openaiHead: VoiceConfig = {
      ...config(),
      stt: {
        type: 'stt',
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
        fallback: config().stt,
      },
    };
    const calledHosts: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const host = String(url);
      calledHosts.push(host);
      return jsonResponse(200, { text: 'ei jarvis' });
    }) as unknown as typeof fetch;
    const runLocal = vi.fn();

    const result = await transcribe(
      { ...REQ, purpose: 'passive-wake', budgetMs: 3_500 },
      openaiHead,
      PROBES,
      deps({ fetchImpl, runLocal }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe('groq');
    expect(calledHosts).toHaveLength(1);
    expect(calledHosts[0]).toContain('groq.com');
    expect(runLocal).not.toHaveBeenCalled();
  });

  it('never lets a local Whisper fallback delay a passive wake', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {})) as unknown as typeof fetch;
    const runLocal = vi.fn();

    const result = await transcribe(
      { ...REQ, purpose: 'passive-wake', budgetMs: 3_500 },
      config(),
      PROBES,
      deps({
        fetchImpl,
        runLocal,
        findBin: vi.fn(() => 'whisper-cli'),
        fileExists: vi.fn(() => true),
      }),
    );

    expect(result.ok).toBe(false);
    expect(runLocal).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.attempts.map((attempt) => attempt.provider)).toContain('local-whisper');
      expect(result.attempts.map((attempt) => attempt.reason).join(' ')).toContain('passive wake');
    }
  });
});
