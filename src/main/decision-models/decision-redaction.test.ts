import { describe, expect, it } from 'vitest';
import { redactQuestions, redactSecrets, redactState } from './decision-redaction';

describe('decision provider egress redaction', () => {
  it('keeps opaque question ids while redacting credential fields in structured instructions', () => {
    const questions = { 'inv:credential_grant': { type: 'noul' as const, instructions: {
      question: 'Does the rule apply?', rule: { flow: 'auth', text: 'API_KEY=private-value' },
    } } };
    expect(redactQuestions(questions)['inv:credential_grant'].instructions).toMatchObject({ rule: { text: 'API_KEY=[REDACTED]' } });
    expect(questions['inv:credential_grant'].instructions.rule.text).toBe('API_KEY=private-value');
    expect(redactState({ nested: { cloudflareToken: 'private-value', note: 'normal text' } })).toEqual({ nested: { cloudflareToken: '[REDACTED]', note: 'normal text' } });
  });

  it('stays linear on a hostile run of letters (was quadratic: 80,000 chars took ~3 s)', () => {
    const started = performance.now();
    expect(redactSecrets('x'.repeat(200_000))).toHaveLength(200_000);
    expect(redactSecrets(`${'a'.repeat(100_000)} API_KEY=private-value`)).toContain('API_KEY=[REDACTED]');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('still redacts credential-looking names of ordinary length', () => {
    expect(redactSecrets('OPENAI_API_KEY=private-value')).toBe('OPENAI_API_KEY=[REDACTED]');
    expect(redactSecrets('MY_SERVICE_SECRET_TOKEN: private-value')).toContain('[REDACTED]');
  });
});
