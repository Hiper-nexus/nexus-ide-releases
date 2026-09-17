import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capText,
  getJevStats,
  judge,
  redactSecrets,
  redactState,
  resetJevStatsForTesting,
  testJevConnection,
} from './jev-client';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const question = {
  type: 'noul' as const,
  instructions: 'Does the report show verification ran?',
};

const okBody = {
  model: 'jev-1.13.0',
  answers: { q: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 100, output_tokens: 5 },
};

describe('judge', () => {
  beforeEach(() => {
    resetJevStatsForTesting();
    delete process.env.NEXUS_JEV_MODEL;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('parses a success response and increments stats', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(200, okBody));
    const result = await judge(
      { state: 'report text', questions: { q: question } },
      { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => 'k' },
    );
    expect(result?.answers.q).toEqual({ type: 'noul', noul: 0.9 });
    expect(result?.model).toBe('jev-1.13.0');
    const stats = getJevStats();
    expect(stats.calls).toBe(1);
    expect(stats.inputTokens).toBe(100);
    expect(stats.estimatedUsd).toBeCloseTo(100 * 0.042e-6, 10);

    const sentBody = JSON.parse(
      String(((mockFetch.mock.calls[0] as unknown[])[1] as RequestInit).body),
    );
    expect(sentBody.model).toBe('jev-latest');
  });

  it('returns null without a key and never calls fetch', async () => {
    const mockFetch = vi.fn();
    const result = await judge(
      { state: 'x', questions: { q: question } },
      { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => undefined },
    );
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(getJevStats().skippedNoKey).toBe(1);
  });

  it('401 returns null without retrying', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(401, { message: 'bad key' }));
    const result = await judge(
      { state: 'x', questions: { q: question } },
      { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => 'k' },
    );
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getJevStats().failures).toBe(1);
  });

  it('429 retries once honoring retry-after, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, 'slow down', { 'retry-after': '0' }))
        .mockResolvedValueOnce(jsonResponse(200, okBody));
      const promise = judge(
        { state: 'x', questions: { q: question } },
        { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => 'k' },
      );
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result?.answers.q).toMatchObject({ type: 'noul', noul: 0.9 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort/timeout returns null after one retry', async () => {
    vi.useFakeTimers();
    try {
      const mockFetch = vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      });
      const promise = judge(
        { state: 'x', questions: { q: question }, timeoutMs: 10 },
        { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => 'k' },
      );
      await vi.runAllTimersAsync();
      expect(await promise).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(getJevStats().failures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry after a network error gets a fresh, non-aborted signal', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const mockFetch = vi
        .fn()
        .mockImplementationOnce((_url: string, init: RequestInit) => {
          signals.push(init.signal as AbortSignal);
          return Promise.reject(new Error('socket hangup'));
        })
        .mockImplementationOnce((_url: string, init: RequestInit) => {
          signals.push(init.signal as AbortSignal);
          return Promise.resolve(jsonResponse(200, okBody));
        });
      const promise = judge(
        { state: 'x', questions: { q: question } },
        { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => 'k' },
      );
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result?.answers.q).toMatchObject({ type: 'noul', noul: 0.9 });
      expect(signals.length).toBe(2);
      expect(signals[1]).not.toBe(signals[0]);
      expect(signals[1].aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('malformed body returns null', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(200, { nope: true }));
    const result = await judge(
      { state: 'x', questions: { q: question } },
      { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => 'k' },
    );
    expect(result).toBeNull();
  });

  it('model override via input and NEXUS_JEV_MODEL', async () => {
    const bodies: string[] = [];
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return jsonResponse(200, okBody);
    });
    const deps = { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => 'k' };
    await judge({ state: 'x', questions: { q: question }, model: 'jev-preview' }, deps);
    process.env.NEXUS_JEV_MODEL = 'env-model';
    await judge({ state: 'x', questions: { q: question } }, deps);
    expect(JSON.parse(bodies[0]).model).toBe('jev-preview');
    expect(JSON.parse(bodies[1]).model).toBe('env-model');
  });
});

describe('redactSecrets / redactState', () => {
  it('redacts Bearer tokens and JWTs', () => {
    expect(redactSecrets('Authorization: Bearer abcdef1234567890XYZ_-.')).toContain('[REDACTED]');
    const jwt = `token eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)} fim`;
    expect(redactSecrets(jwt)).toBe('token [REDACTED] fim');
  });

  it('redacts provider key prefixes', () => {
    expect(redactSecrets(`sk-ant-${'x'.repeat(40)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`sk-${'x'.repeat(20)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`xai-${'x'.repeat(20)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`gsk_${'x'.repeat(20)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`ghp_${'x'.repeat(25)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`github_pat_${'x'.repeat(25)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`AIza${'x'.repeat(35)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`apikey_${'x'.repeat(25)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`xi_${'x'.repeat(20)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`hf_${'x'.repeat(20)}`)).toBe('[REDACTED]');
    expect(redactSecrets(`npm_${'x'.repeat(20)}`)).toBe('[REDACTED]');
  });

  it('redacts PEM private key blocks', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----`;
    expect(redactSecrets(`a ${pem} b`)).toBe('a [REDACTED] b');
  });

  it('redacts KEY/TOKEN/SECRET/PASSWORD assignments keeping the name', () => {
    expect(redactSecrets('TYPESAFE_API_KEY=apikey_secret123')).toBe(
      'TYPESAFE_API_KEY=[REDACTED]',
    );
    expect(redactSecrets('MY_TOKEN=abc.def')).toBe('MY_TOKEN=[REDACTED]');
  });

  it('redacts camelCase assignments only for credential-looking values', () => {
    const redacted = redactSecrets('apiKey: "abcd1234efgh5678"');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('abcd1234efgh5678');
    // prosa com a palavra token não é credencial: valor curto/sem dígito fica
    expect(redactSecrets('token: the design token system')).toBe(
      'token: the design token system',
    );
    // Bearer continua na regra própria (consome o token inteiro)
    expect(redactSecrets('Authorization: Bearer abcdef1234567890XYZ')).toBe(
      'Authorization: [REDACTED]',
    );
  });

  it('redactState walks nested objects and arrays', () => {
    const state = {
      note: `key is sk-${'x'.repeat(20)}`,
      items: [{ token: 'TYPESAFE_API_KEY=zzz' }, 42, null],
    };
    const out = redactState(state) as typeof state;
    expect(out.note).toBe('key is [REDACTED]');
    expect((out.items[0] as { token: string }).token).toBe('[REDACTED]');
    expect(out.items[1]).toBe(42);
  });

  it('redactState redacts whole values under sensitive field names', () => {
    const state = {
      apiKey: 'not-a-token-shaped-value',
      nested: { password: '123', credential: { secret: 'x' } },
      request: 'the design token system',
    };
    const out = redactState(state) as typeof state;
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.nested.password).toBe('[REDACTED]');
    expect(out.nested.credential).toBe('[REDACTED]');
    expect(out.request).toBe('the design token system');
  });
});

describe('capText', () => {
  it('keeps head by default and tail with keepTail', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    expect(capText(text, 5)).toBe('abcde\n[... 21 chars omitted]');
    expect(capText(text, 5, { keepTail: true })).toBe('\n[... 21 chars omitted]vwxyz');
    expect(capText('short', 10)).toBe('short');
  });
});

describe('testJevConnection', () => {
  it('reports missing key without fetching', async () => {
    const mockFetch = vi.fn();
    const result = await testJevConnection({
      fetch: mockFetch as unknown as typeof fetch,
      resolveKey: () => undefined,
    });
    expect(result).toEqual({ ok: false, detail: 'sem chave configurada' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lists model names on success', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse(200, { models: [{ name: 'jev-latest' }, { name: 'jev-preview' }] }),
    );
    const result = await testJevConnection({
      fetch: mockFetch as unknown as typeof fetch,
      resolveKey: () => 'k',
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('jev-latest');
  });

  it('surfaces HTTP failures without the key', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(401, { message: 'unauthorized' }));
    const result = await testJevConnection({
      fetch: mockFetch as unknown as typeof fetch,
      resolveKey: () => 'k-secret',
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HTTP 401');
    expect(result.detail).not.toContain('k-secret');
  });
});
