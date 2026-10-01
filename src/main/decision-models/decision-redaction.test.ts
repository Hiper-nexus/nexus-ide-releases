import { describe, expect, it } from 'vitest';
import { redactQuestions, redactState } from './decision-redaction';

describe('decision provider egress redaction', () => {
  it('keeps opaque question ids while redacting credential fields in structured instructions', () => {
    const questions = { 'inv:credential_grant': { type: 'noul' as const, instructions: {
      question: 'Does the rule apply?', rule: { flow: 'auth', text: 'API_KEY=private-value' },
    } } };
    expect(redactQuestions(questions)['inv:credential_grant'].instructions).toMatchObject({ rule: { text: 'API_KEY=[REDACTED]' } });
    expect(questions['inv:credential_grant'].instructions.rule.text).toBe('API_KEY=private-value');
    expect(redactState({ nested: { cloudflareToken: 'private-value', note: 'normal text' } })).toEqual({ nested: { cloudflareToken: '[REDACTED]', note: 'normal text' } });
  });
});
