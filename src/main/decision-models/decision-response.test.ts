import { describe, expect, it } from 'vitest';
import { validateDecisionResponse } from './decision-response';
import type { JevQuestion } from '../jev/jev-client';

const questions: Record<string, JevQuestion> = {
  present: { type: 'noul', instructions: 'Is evidence present?' },
  action: { type: 'choice', instructions: 'Choose an action.', criteria: { inspect: 'Inspect', none: 'None' } },
  severity: { type: 'score', instructions: 'Rate severity.', criteria: ['Low', 'Medium', 'High'] },
};
const response = () => ({ model: 'clef', usage: { input_tokens: 100, output_tokens: 0 }, answers: {
  present: { type: 'noul', noul: 0.8 },
  action: { type: 'choice', choice: 'inspect', confidence: 0.7, probabilities: { inspect: 0.8, none: 0.2 } },
  severity: { type: 'score', score: 1.1, confidence: 0.6, legend: { '0': 'Low', '1': 'Medium', '2': 'High' }, probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 } },
} });

describe('typed provider response validation', () => {
  it('returns complete typed answers with reported usage', () => {
    expect(validateDecisionResponse(response(), questions)?.answers.severity).toMatchObject({ type: 'score', score: 1.1 });
  });

  it.each([
    (data: any) => { delete data.answers.present; },
    (data: any) => { data.answers.present.noul = NaN; },
    (data: any) => { data.answers.action.choice = 'invented'; },
    (data: any) => { data.answers.action.probabilities.inspect = 2; },
    (data: any) => { data.answers.action.probabilities = { inspect: 0.2, none: 0.2 }; },
    (data: any) => { data.answers.action.confidence = Infinity; },
    (data: any) => { data.answers.severity.score = 3; },
    (data: any) => { data.answers.severity.probabilities = { '0': 1 }; },
    (data: any) => { delete data.usage; },
    (data: any) => { data.usage.input_tokens = -1; },
  ])('rejects a response that cannot support the requested decisions', mutate => {
    const data = response(); mutate(data);
    expect(validateDecisionResponse(data, questions)).toBeNull();
  });
});
