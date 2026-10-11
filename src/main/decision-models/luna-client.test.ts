import { describe, expect, it, vi } from 'vitest';
import type { DecisionUsageReceipt } from '../../shared/decision-models';
import type { JevQuestion } from '../jev/jev-client';
import { judgeLuna, testLunaConnection } from './luna-client';

const TOKEN = 'sk-test-token-value';
const noul: Record<string, JevQuestion> = { q: { type: 'noul', instructions: 'Is it relevant?' } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenAI Decisions client', () => {
  it('posts only to the fixed decisions endpoint and maps a predicate onto noul', async () => {
    let url = ''; let redirect = ''; let body = '';
    const result = await judgeLuna({ state: 'choose a tool', questions: noul }, TOKEN, { fetch: (async (target, init) => {
      url = String(target); redirect = String(init?.redirect); body = String(init?.body);
      const sent = JSON.parse(body) as { questions: { name: string }[] };
      return json({ answers: sent.questions.map(question => ({ type: 'predicate', name: question.name, probability: 0.81 })) });
    }) as typeof fetch });
    expect(url).toBe('https://api.openai.com/v1/decisions');
    expect(redirect).toBe('error');
    expect(body).not.toContain(TOKEN);
    expect(result?.model).toBe('gpt-6-luna');
    expect(result?.answers.q).toEqual({ type: 'noul', noul: 0.81 });
    expect(result?.usageMissing).toBe(true);
    expect(result?.estimatedUsd).toBeUndefined();
  });

  it('prices reported input tokens at the published rate and ignores output tokens', async () => {
    const result = await judgeLuna({ state: 'x', questions: noul }, TOKEN, { fetch: (async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as { questions: { name: string }[] };
      return json({ model: 'gpt-6-luna', usage: { input_tokens: 1_000_000, output_tokens: 80 },
        answers: sent.questions.map(question => ({ type: 'predicate', name: question.name, probability: 0.5 })) });
    }) as typeof fetch });
    expect(result?.usageMissing).toBeUndefined();
    expect(result?.estimatedUsd).toBeCloseTo(0.10, 10);
  });

  it('keeps our score legend and choice distribution, and never treats a refusal as noul 0', async () => {
    const questions: Record<string, JevQuestion> = {
      dept: { type: 'choice', instructions: 'Which desk?', criteria: { billing: 'pay', other: 'else' } },
      severity: { type: 'score', instructions: 'How bad?', criteria: ['Baixo', 'Alto'] },
    };
    const result = await judgeLuna({ state: 'invoice', questions }, TOKEN, { fetch: (async () => json({ answers: [
      { type: 'choice', name: 'q0', choice: 'billing', confidence: 0.93, probabilities: [
        { value: 'billing', probability: 0.95 }, { value: 'other', probability: 0.05 }] },
      { type: 'score', name: 'q1', score: 0.4, confidence: 0.55, probabilities: [
        { value: 0, label: 'Cosmetic', probability: 0.6 }, { value: 1, label: 'Blocked', probability: 0.4 }] },
    ] })) as typeof fetch });
    expect(result?.answers.dept).toMatchObject({ type: 'choice', choice: 'billing', probabilities: { billing: 0.95, other: 0.05 } });
    expect(result?.answers.severity).toMatchObject({ type: 'score', score: 0.4, legend: { '0': 'Baixo', '1': 'Alto' } });

    const reasons: string[] = [];
    const refused = await judgeLuna({ state: 'secret text', questions: noul, onNoAnswer: reason => reasons.push(reason) }, TOKEN, {
      fetch: (async () => json({ answers: [{ type: 'refusal', name: 'q0' }] })) as typeof fetch });
    expect(refused).toBeNull();
    expect(reasons).toEqual(['refusal']);
  });

  it('classifies a parsed-but-unusable distribution as ambiguous and garbage as malformed', async () => {
    const ambiguous = vi.fn();
    await judgeLuna({ state: 'x', questions: noul, onNoAnswer: ambiguous }, TOKEN, {
      fetch: (async () => json({ answers: [{ type: 'predicate', name: 'q0' }] })) as typeof fetch });
    expect(ambiguous).toHaveBeenCalledWith('ambiguous');
    const malformed = vi.fn();
    await judgeLuna({ state: 'x', questions: noul, onNoAnswer: malformed }, TOKEN, {
      fetch: (async () => new Response('not-json', { status: 200 })) as typeof fetch });
    expect(malformed).toHaveBeenCalledWith('malformed');
    const wrongModel = vi.fn();
    await judgeLuna({ state: 'x', questions: noul, onNoAnswer: wrongModel }, TOKEN, {
      fetch: (async () => json({ model: 'gpt-4o', answers: [{ type: 'predicate', name: 'q0', probability: 0.2 }] })) as typeof fetch });
    expect(wrongModel).toHaveBeenCalledWith('malformed');
  });

  it.each([
    { reason: 'refusal', answers: [{ type: 'refusal', name: 'q0' }] },
    { reason: 'ambiguous', answers: [{ type: 'predicate', name: 'q0' }] },
    { reason: 'malformed', answers: null },
  ])('retains independently measured usage on a 200 $reason verdict', async ({ reason, answers }) => {
    const receipts: DecisionUsageReceipt[] = [];
    const reasons: string[] = [];
    const result = await judgeLuna({ state: 'x', questions: noul,
      onUsage: receipt => receipts.push(receipt), onNoAnswer: value => reasons.push(value) }, TOKEN, {
      fetch: (async () => json({ model: 'gpt-6-luna', usage: { input_tokens: 1_000_000 }, answers })) as typeof fetch,
    });
    expect(result).toBeNull();
    expect(reasons).toEqual([reason]);
    expect(receipts).toEqual([expect.objectContaining({
      inputTokens: 1_000_000, usd: 0.10, requestCount: 1, usageIncomplete: false,
    })]);
  });

  it('retains usage when cancelled after the envelope has been parsed', async () => {
    const controller = new AbortController();
    const receipts: DecisionUsageReceipt[] = [];
    const reasons: string[] = [];
    const result = await judgeLuna({ state: 'x', questions: noul, signal: controller.signal,
      onUsage: receipt => receipts.push(receipt), onNoAnswer: reason => reasons.push(reason) }, TOKEN, {
      fetch: (async () => {
        const response = json({ model: 'gpt-6-luna', usage: { input_tokens: 1_000_000 },
          answers: [{ type: 'predicate', name: 'q0', probability: 0.8 }] });
        const reader = response.body!.getReader();
        const release = reader.releaseLock.bind(reader);
        reader.releaseLock = () => { release(); controller.abort(); };
        Object.defineProperty(response.body, 'getReader', { value: () => reader });
        return response;
      }) as typeof fetch,
    });
    expect(result).toBeNull(); expect(reasons).toEqual(['aborted']);
    expect(receipts).toEqual([expect.objectContaining({
      inputTokens: 1_000_000, usd: 0.10, requestCount: 1, usageIncomplete: false,
    })]);
  });

  it.each([
    { model: 'gpt-4o', usage: { input_tokens: 1_000_000 } },
    { model: 'gpt-6-luna', usage: { input_tokens: -1 } },
  ])('does not trust a mismatched model or invalid measurement %j', async envelope => {
    const receipts: DecisionUsageReceipt[] = [];
    expect(await judgeLuna({ state: 'x', questions: noul, onUsage: receipt => receipts.push(receipt) }, TOKEN, {
      fetch: (async () => json({ ...envelope, answers: [{ type: 'refusal', name: 'q0' }] })) as typeof fetch,
    })).toBeNull();
    expect(receipts).toEqual([expect.objectContaining({ inputTokens: null, usd: null, requestCount: 1, usageIncomplete: true })]);
  });

  it('redacts secrets, sends images only as data URLs, and does not log the token', async () => {
    let body = '';
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const reasons: string[] = [];
    await judgeLuna({
      state: 'prefix sk-abcdefghijklmnopqrstuvwxyz suffix',
      images: [{ content_type: 'image/png', base64: png }],
      questions: { q: { type: 'noul', instructions: { question: 'relevant?', rule: { flow: 'pay', text: 'sk-abcdefghijklmnopqrstuvwxyz' } } } },
      onNoAnswer: reason => reasons.push(reason),
    }, TOKEN, { fetch: (async (_url, init) => { body = String(init?.body); throw new Error(`down ${TOKEN}`); }) as typeof fetch });
    expect(body).toContain('[REDACTED]');
    expect(body).toContain('data:image/png;base64,');
    expect(body).not.toContain('https://');
    expect(body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(body).not.toContain(TOKEN);
    expect(reasons).toEqual(['network']);
  });

  it('retries one transient failure and then accepts the decision', async () => {
    let calls = 0;
    const result = await judgeLuna({ state: 'x', questions: noul }, TOKEN, { fetch: (async (_url, init) => {
      calls += 1;
      if (calls === 1) return json({ error: 'slow down' }, 429);
      const sent = JSON.parse(String(init?.body)) as { questions: { name: string }[] };
      return json({ answers: [{ type: 'predicate', name: sent.questions[0].name, probability: 0.7 }], usage: { input_tokens: 10 } });
    }) as typeof fetch });
    expect(calls).toBe(2);
    expect(result?.answers.q).toEqual({ type: 'noul', noul: 0.7 });
  });
});

describe('Testar a Luna: o motivo real aparece para o operador', () => {
  const answer = (async (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { questions: { name: string }[] };
    return json({ answers: sent.questions.map(question => ({ type: 'predicate', name: question.name, probability: 0.9 })) });
  }) as typeof fetch;

  it.each([
    [401, 'recusou a chave (401)'],
    [403, 'não tem acesso à Decisions API (beta)'],
    [404, 'não tem acesso à Decisions API (beta)'],
    [429, 'limite de uso ou sem crédito'],
    [400, 'recusou a consulta (400)'],
  ])('HTTP %i vira mensagem específica, sem a chave', async (status, text) => {
    const result = await testLunaConnection(TOKEN, { fetch: (async () => json({ error: { message: 'x' } }, status)) as typeof fetch });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(text);
    expect(result.detail).not.toContain(TOKEN);
  });

  it('5xx esgota as tentativas e diz que é o servidor', async () => {
    vi.useFakeTimers();
    try {
      const pending = testLunaConnection(TOKEN, { fetch: (async () => json({}, 503)) as typeof fetch });
      await vi.runAllTimersAsync();
      expect((await pending).detail).toContain('erro no servidor (503)');
    } finally { vi.useRealTimers(); }
  });

  it('sucesso continua "Conectado"', async () => {
    expect(await testLunaConnection(TOKEN, { fetch: answer })).toEqual({ ok: true, detail: 'Conectado — gpt-6-luna (beta)' });
  });
});
