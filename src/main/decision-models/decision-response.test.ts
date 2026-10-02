import { describe, expect, it } from 'vitest';
import { CLEF_RESPONSE_POLICY, JEV_RESPONSE_POLICY, validateDecisionResponse } from './decision-response';
import type { JevQuestion } from '../jev/jev-client';
import { JEV_REAL_QUESTIONS, jevRealResponse } from './jev-real-response.fixture';

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

describe('provider-specific response policy', () => {
  it('accepts a real production Jev response under both policies', () => {
    for (const policy of [JEV_RESPONSE_POLICY, CLEF_RESPONSE_POLICY]) {
      const result = validateDecisionResponse(jevRealResponse(), JEV_REAL_QUESTIONS, policy);
      expect(result?.model).toBe('jev-1.13.0');
      expect(result?.usage).toEqual({ input_tokens: 422, output_tokens: 73 });
      expect(result?.usageMissing).toBeUndefined();
    }
  });

  it('lets Jev probabilities drift by rounding (0.99 / 1.01) but not by guesswork', () => {
    for (const total of [0.99, 1.01]) {
      const data: any = response(); data.answers.action.probabilities = { inspect: 0.8, none: total - 0.8 };
      expect(validateDecisionResponse(data, questions, JEV_RESPONSE_POLICY)).not.toBeNull();
      expect(validateDecisionResponse(data, questions, CLEF_RESPONSE_POLICY)).toBeNull();
    }
    const guesswork: any = response(); guesswork.answers.action.probabilities = { inspect: 0.8, none: 0.15 };
    expect(validateDecisionResponse(guesswork, questions, JEV_RESPONSE_POLICY)).toBeNull();
    const overshoot: any = response(); overshoot.answers.action.probabilities = { inspect: 0.8, none: 0.3 };
    expect(validateDecisionResponse(overshoot, questions, JEV_RESPONSE_POLICY)).toBeNull();
  });

  it('keeps the legacy Jev tolerance for a missing usage block without inventing tokens', () => {
    const data: any = response(); delete data.usage;
    const result = validateDecisionResponse(data, questions, JEV_RESPONSE_POLICY);
    expect(result).not.toBeNull();
    expect(result?.usageMissing).toBe(true);
    expect(validateDecisionResponse(data, questions, CLEF_RESPONSE_POLICY)).toBeNull();
    expect(validateDecisionResponse(data, questions)).toBeNull();
  });

  it('still rejects a malformed usage block even for Jev', () => {
    const data: any = response(); data.usage = { input_tokens: -3, output_tokens: 0 };
    expect(validateDecisionResponse(data, questions, JEV_RESPONSE_POLICY)).toBeNull();
  });
});
