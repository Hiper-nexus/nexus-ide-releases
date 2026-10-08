import { describe, expect, it, vi } from 'vitest';
import type { JevQuestion } from '../jev/jev-client';
import { judgeLuna } from './luna-client';

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
