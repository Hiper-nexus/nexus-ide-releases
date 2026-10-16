import { describe, expect, it } from 'vitest';
import { decisionEvalCasesSchema, evaluateDecisionCases, type DecisionEvalCase } from './decision-evaluation';
import { judgeLuna } from './luna-client';

const cases: DecisionEvalCase[] = [
  { id: 'dev-read', surface: 'toolPick', split: 'development', state: 'private development payload',
    questions: { action: { type: 'choice', instructions: 'Select the permitted operation.', criteria: { read: 'Read', none: 'None' } } }, expected: { action: 'read' } },
  { id: 'heldout-none', surface: 'toolPick', split: 'heldout', state: 'private heldout payload', consequential: true,
    questions: { action: { type: 'choice', instructions: 'Select the permitted operation.', criteria: { read: 'Read', none: 'None' } } }, expected: { action: 'none' } },
];

describe('decision workload evaluation', () => {
  it('retains paid refusal usage from the real Luna client', async () => {
    const report = await evaluateDecisionCases([cases[0]], (_model, input) => judgeLuna(input, 'synthetic-key', {
      fetch: (async () => Response.json({ model: 'gpt-6-luna', usage: { input_tokens: 1000 },
        answers: [{ type: 'refusal', name: 'q0' }] })) as typeof fetch,
    }), ['luna']);
    expect(report.observations[0]).toMatchObject({ status: 'failed', failureReason: 'refusal',
      inputTokens: 1000, usd: 0.0001, requestCount: 1, usageIncomplete: false });
    expect(report.models.luna.usd).toBeCloseTo(0.0001, 10);
  });

  it('preserves the last usage receipt and reason when a judge throws afterwards', async () => {
    const report = await evaluateDecisionCases([cases[0]], async (_model, input) => {
      input.onUsage?.({ inputTokens: 100, usd: 0.001, requestCount: 2, durationMs: 20, usageIncomplete: true });
      input.onNoAnswer?.('network');
      throw new Error('synthetic provider error');
    }, ['luna']);
    expect(report.observations[0]).toMatchObject({ status: 'failed', failureReason: 'network',
      inputTokens: 100, usd: 0.001, requestCount: 2, durationMs: 20, usageIncomplete: true });
    expect(report.models.luna.usd).toBeNull();
    expect(JSON.stringify(report)).not.toContain('synthetic provider error');
  });

  it('keeps the paid first batch as a lower bound when the second Luna batch fails', async () => {
    const questions = Object.fromEntries(Array.from({ length: 65 }, (_, index) =>
      [`p${index}`, { type: 'noul' as const, instructions: 'Is this ready?' }]));
    const testCase: DecisionEvalCase = { ...cases[0], questions,
      expected: Object.fromEntries(Object.keys(questions).map(id => [id, true])) };
    let calls = 0;
    const report = await evaluateDecisionCases([testCase], (_model, input) => judgeLuna(input, 'synthetic-key', {
      fetch: (async (_url, init) => {
        if (++calls === 2) return new Response('', { status: 403 });
        const sent = JSON.parse(String(init?.body)) as { questions: { name: string }[] };
        return Response.json({ model: 'gpt-6-luna', usage: { input_tokens: 1000 },
          answers: sent.questions.map(question => ({ type: 'predicate', name: question.name, probability: 0.9 })) });
      }) as typeof fetch,
    }), ['luna']);
    expect(calls).toBe(2);
    expect(report.observations[0]).toMatchObject({ status: 'failed', inputTokens: 1000,
      usd: 0.0001, requestCount: 2, usageIncomplete: true });
    expect(report.models.luna.usd).toBeNull();
  });

  it('scores an answered Jev observation while keeping omitted usage unknown', async () => {
    const report = await evaluateDecisionCases(cases, async model => ({ model,
      answers: { action: { type: 'choice', choice: 'read', probabilities: { read: 1, none: 0 }, confidence: 1 } },
      usageMissing: true, usage: { input_tokens: 0, output_tokens: 0 } }));
    expect(report.models.jev.answered).toBe(2);
    expect(report.models.jev.usd).toBeNull();
    expect(report.observations[0].inputTokens).toBeNull();
  });
  it('rejects empty labels, mismatched question IDs and reversed scoring ranges', () => {
    expect(decisionEvalCasesSchema.safeParse([{ ...cases[0], expected: {} }]).success).toBe(false);
    expect(decisionEvalCasesSchema.safeParse([{ ...cases[0], expected: { missing: true } }]).success).toBe(false);
    expect(decisionEvalCasesSchema.safeParse([{ ...cases[0], expected: { action: { min: 1, max: 0 } } }]).success).toBe(false);
  });
  it('scores heldout decisions separately and retains unavailable cases in the denominator', async () => {
    const report = await evaluateDecisionCases(cases, async (model, input) => {
      if (model === 'clef-flash') return null;
      return { model, answers: { action: { type: 'choice', choice: model === 'jev' ? 'read' : input.state === 'private heldout payload' ? 'none' : 'read',
        probabilities: { read: 0.5, none: 0.5 }, confidence: 0.5 } },
        usage: { input_tokens: 100, output_tokens: 0 }, durationMs: model === 'jev' ? 20 : 10 };
    });
    expect(report.models.jev.heldout).toMatchObject({ cases: 1, correct: 0, consequentialErrors: 1 });
    expect(report.models.clef.heldout).toMatchObject({ cases: 1, correct: 1, accuracy: 1 });
    expect(report.models['clef-flash']).toMatchObject({ answered: 0, failures: 2, usd: null });
    expect(report.models['clef-omni'].heldout).toMatchObject({ cases: 1, correct: 1 });
    expect(report.models.clef.p50Ms).toBe(10);
    expect(JSON.stringify(report)).not.toContain('private heldout payload');
    expect(JSON.stringify(report)).not.toContain('private development payload');
  });

  it('does not count a text-only model as a failed visual classifier', async () => {
    const visual: DecisionEvalCase = { id: 'visual', surface: 'browserTool', split: 'heldout', state: 'private pixels',
      images: [{ content_type: 'image/png', base64: 'private-image-bytes' }],
      questions: { visible: { type: 'noul', instructions: 'Is an error visible?' } }, expected: { visible: true } };
    const report = await evaluateDecisionCases([visual], async model => ({ model,
      answers: { visible: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 0 } }));
    expect(report.models.jev).toMatchObject({ unsupported: 1, failures: 0 });
    expect(JSON.stringify(report)).not.toContain('private-image-bytes');
  });

  it('turns provider exceptions into failed observations without exposing their contents', async () => {
    const report = await evaluateDecisionCases(cases, async () => { throw new Error('private-token-in-error'); });
    expect(report.models.clef.failures).toBe(2);
    expect(report.models.clef.heldout.accuracy).toBe(0);
    expect(JSON.stringify(report)).not.toContain('private-token-in-error');
  });
});
