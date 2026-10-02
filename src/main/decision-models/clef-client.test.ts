import { afterEach, describe, expect, it, vi } from 'vitest';
import { judgeClef, testClefConnection } from './clef-client';
import type { JudgeInput } from '../jev/jev-client';

const connection = { accountId: '0123456789abcdef0123456789abcdef', token: 'synthetic-cloudflare-token', model: 'clef' as const };
const input: JudgeInput = { state: { message: 'Observed confirmation' }, questions: { q: { type: 'noul', instructions: 'Did confirmation appear?' } } };
function answer(request: RequestInit | undefined, changes: Record<string, unknown> = {}): Response {
  const body = JSON.parse(String(request?.body));
  return Response.json({ success: true, result: { model: body.model,
    answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])),
    usage: { input_tokens: 100, output_tokens: 0 }, ...changes } });
}

describe('Cloudflare decision transport', () => {
  afterEach(() => vi.useRealTimers());

  it('normalizes the Cloudflare envelope and redacts named credentials', async () => {
    const sent: Array<{ url: string; options: RequestInit }> = [];
    const fetcher = async (url: string | URL | Request, options?: RequestInit) => {
      sent.push({ url: String(url), options: options! }); return answer(options);
    };
    const result = await judgeClef({ ...input, state: { apiToken: 'must-not-leave', message: 'ok' } }, connection, { fetch: fetcher as typeof fetch });
    expect(result?.answers.q).toEqual({ type: 'noul', noul: 0.9 });
    expect(result?.usage.input_tokens).toBe(100);
    expect(sent[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef');
    expect(sent[0].options.redirect).toBe('error');
    expect(JSON.parse(String(sent[0].options.body)).state.apiToken).toBe('[REDACTED]');
    expect(String(sent[0].options.body)).not.toContain('must-not-leave');
  });

  it('preserves 104 arbitrary question identifiers across bounded batches', async () => {
    const requests: Array<Record<string, any>> = [];
    const questions = Object.fromEntries(Array.from({ length: 104 }, (_, index) => [`inv:regra com ação ${index}`, {
      type: 'noul' as const, instructions: { question: 'Does this rule apply?', rule: { flow: 'billing', text: `rule ${index}` } },
    }]));
    const fetcher = async (_url: any, options?: RequestInit) => {
      requests.push(JSON.parse(String(options?.body))); return answer(options);
    };
    const result = await judgeClef({ state: 'task', questions }, connection, { fetch: fetcher as typeof fetch });
    expect(Object.keys(result?.answers ?? {})).toEqual(Object.keys(questions));
    expect(requests.map(request => Object.keys(request.questions).length)).toEqual([64, 40]);
    expect(Object.keys(requests[0].questions).every(id => /^[A-Za-z0-9_.-]{1,100}$/.test(id))).toBe(true);
    expect(Object.values(requests[0].questions)[0]).toMatchObject({ instructions: { rule: { flow: 'billing' } } });
    expect(result?.usage.input_tokens).toBe(200);
    expect(result?.requestCount).toBe(2);
  });

  it.each([401, 403, 302])('does not retry a non-transient HTTP %s response', async status => {
    let requests = 0;
    const result = await judgeClef(input, connection, { fetch: (async () => { requests++; return Response.json({ success: false }, { status }); }) as typeof fetch });
    expect(result).toBeNull(); expect(requests).toBe(1);
  });

  it('does not accept a success:false body on HTTP 200', async () => {
    expect(await judgeClef(input, connection, { fetch: (async () => Response.json({ success: false, result: {} })) as typeof fetch })).toBeNull();
  });

  it('does not expose a partial result when the second batch fails', async () => {
    const questions = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, input.questions.q]));
    let requests = 0;
    const receipt = vi.fn();
    const result = await judgeClef({ ...input, questions, onUsage: receipt }, connection, { fetch: (async (_url, options) => {
      requests++; return requests === 1 ? answer(options) : Response.json({}, { status: 403 });
    }) as typeof fetch });
    expect(result).toBeNull(); expect(requests).toBe(2);
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 100, usd: 0.000024, requestCount: 2, usageIncomplete: true }));
  });

  it('stops before another batch when authority is revoked', async () => {
    const controller = new AbortController(); let requests = 0;
    const questions = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, input.questions.q]));
    const reason = vi.fn();
    const result = await judgeClef({ ...input, questions, signal: controller.signal, onNoAnswer: reason }, connection, { fetch: (async (_url, options) => {
      requests++; controller.abort(); return answer(options);
    }) as typeof fetch });
    expect(result).toBeNull(); expect(requests).toBe(1); expect(reason).toHaveBeenCalledWith('aborted');
  });

  it('does not start a request when authority is already revoked', async () => {
    const controller = new AbortController(); controller.abort(); let requests = 0;
    expect(await judgeClef({ ...input, signal: controller.signal }, connection, { fetch: (async () => { requests++; return answer({ body: JSON.stringify(input) }); }) as typeof fetch })).toBeNull();
    expect(requests).toBe(0);
  });

  it('retries a transient failure once inside the same deadline', async () => {
    vi.useFakeTimers(); let requests = 0;
    const pending = judgeClef(input, connection, { fetch: (async (_url, options) => {
      requests++; return requests === 1 ? Response.json({}, { status: 429, headers: { 'retry-after': '0' } }) : answer(options);
    }) as typeof fetch });
    await vi.runAllTimersAsync();
    expect((await pending)?.answers.q).toMatchObject({ noul: 0.9 }); expect(requests).toBe(2);
  });

  it('returns no answer when the shared deadline expires', async () => {
    const reason = vi.fn();
    const fetcher = (_url: any, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    expect(await judgeClef({ ...input, timeoutMs: 20, onNoAnswer: reason }, connection, { fetch: fetcher as typeof fetch })).toBeNull();
    expect(reason).toHaveBeenCalledWith('timeout');
  });

  it('embeds valid PNG bytes instead of following image URLs', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    let body: Record<string, any> | undefined;
    const result = await judgeClef({ ...input, images: [{ content_type: 'image/png', base64: png }] }, connection, { fetch: (async (_url, options) => {
      body = JSON.parse(String(options?.body)); return answer(options);
    }) as typeof fetch });
    expect(result?.answers.q).toMatchObject({ noul: 0.9 });
    expect(body?.images).toEqual([{ content_type: 'image/png', base64: png }]);
  });

  it('rejects remote URLs and malformed image data before egress', async () => {
    let requests = 0;
    const fetcher = (async () => { requests++; return answer({ body: JSON.stringify(input) }); }) as typeof fetch;
    for (const images of [['https://example.com/private.png'], [{ content_type: 'image/png', base64: 'not-png' }]]) {
      expect(await judgeClef({ ...input, images: images as any }, connection, { fetch: fetcher })).toBeNull();
    }
    expect(requests).toBe(0);
  });

  it('maps a transport failure to a network no-answer after one counted attempt', async () => {
    const reason = vi.fn(); const usage = vi.fn(); let requests = 0;
    const result = await judgeClef({ ...input, onNoAnswer: reason, onUsage: usage }, connection, {
      fetch: (async () => { requests++; throw new TypeError('fetch failed: ECONNRESET with synthetic-cloudflare-token'); }) as typeof fetch });
    expect(result).toBeNull(); expect(requests).toBe(1);
    expect(reason).toHaveBeenCalledWith('network');
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ requestCount: 1, inputTokens: null, usageIncomplete: true }));
    expect(JSON.stringify(reason.mock.calls)).not.toContain('synthetic-cloudflare-token');
  });

  it('treats a non-JSON success body as malformed', async () => {
    const reason = vi.fn();
    expect(await judgeClef({ ...input, onNoAnswer: reason }, connection, { fetch: (async () => new Response('<html>gateway</html>', { status: 200 })) as typeof fetch })).toBeNull();
    expect(reason).toHaveBeenCalledWith('malformed');
  });

  it('refuses a response larger than 2 MiB before it is parsed', async () => {
    const reason = vi.fn();
    const huge = new Response(new Uint8Array(3 * 1024 * 1024).fill(0x20), { status: 200 });
    expect(await judgeClef({ ...input, onNoAnswer: reason }, connection, { fetch: (async () => huge) as typeof fetch })).toBeNull();
    expect(reason).toHaveBeenCalledWith('malformed');
  });

  it('gives up with a server-error after the single retry of a 5xx is spent', async () => {
    vi.useFakeTimers(); let requests = 0; const reason = vi.fn();
    const pending = judgeClef({ ...input, onNoAnswer: reason }, connection, { fetch: (async () => { requests++; return Response.json({}, { status: 503 }); }) as typeof fetch });
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull(); expect(requests).toBe(2);
    expect(reason).toHaveBeenCalledWith('server-error');
  });

  it('never sends a request body above 13 MiB', async () => {
    let requests = 0; const reason = vi.fn();
    const result = await judgeClef({ ...input, state: '1 '.repeat(7 * 1024 * 1024), onNoAnswer: reason }, connection, {
      fetch: (async () => { requests++; return answer({ body: JSON.stringify(input) }); }) as typeof fetch });
    expect(result).toBeNull(); expect(requests).toBe(0);
    expect(reason).toHaveBeenCalledWith('client-error');
  });

  it('sends the same invalid-input guard for out-of-range questions', async () => {
    let requests = 0;
    const tooFewLevels = { type: 'score' as const, instructions: 'Rate it.', criteria: ['only one'] };
    expect(await judgeClef({ ...input, questions: { q: tooFewLevels } }, connection, { fetch: (async () => { requests++; return answer({ body: JSON.stringify(input) }); }) as typeof fetch })).toBeNull();
    expect(requests).toBe(0);
  });
});

describe('Cloudflare connection test', () => {
  it('asks one tiny synthetic question and reports the connected model', async () => {
    let body: Record<string, any> | undefined;
    const result = await testClefConnection(connection, { fetch: (async (_url, options) => { body = JSON.parse(String(options?.body)); return answer(options); }) as typeof fetch });
    expect(result).toEqual({ ok: true, detail: 'Conectado — clef' });
    expect(Object.keys(body!.questions)).toHaveLength(1);
    expect(body!.state).toEqual({ sample: 'connection-check' });
  });

  it('explains a rejected token without ever echoing it', async () => {
    const result = await testClefConnection(connection, { fetch: (async () => Response.json({ success: false, errors: [{ message: 'Invalid synthetic-cloudflare-token' }] }, { status: 401 })) as typeof fetch });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/conta|token/i);
    expect(result.detail).not.toContain('synthetic-cloudflare-token');
  });
});
