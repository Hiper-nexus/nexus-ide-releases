import { describe, expect, it } from 'vitest';
import { decisionEvalCasesSchema, evaluateDecisionCases, type DecisionEvalCase } from './decision-evaluation';

const cases: DecisionEvalCase[] = [
  { id: 'dev-read', surface: 'toolPick', split: 'development', state: 'private development payload',
    questions: { action: { type: 'choice', instructions: 'Select the permitted operation.', criteria: { read: 'Read', none: 'None' } } }, expected: { action: 'read' } },
  { id: 'heldout-none', surface: 'toolPick', split: 'heldout', state: 'private heldout payload', consequential: true,
    questions: { action: { type: 'choice', instructions: 'Select the permitted operation.', criteria: { read: 'Read', none: 'None' } } }, expected: { action: 'none' } },
];

describe('decision workload evaluation', () => {
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
