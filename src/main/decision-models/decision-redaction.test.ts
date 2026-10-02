import { describe, expect, it } from 'vitest';
import { redactQuestions, redactSecrets, redactState } from './decision-redaction';

describe('decision provider egress redaction', () => {
  it('hides the Cloudflare token even when it has no surrounding credential label', () => {
    expect(redactSecrets('cfut-synthetic_cloudflare_token_1234567890')).toBe('[REDACTED]');
  });
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

  it.each([
    ['apiKey: synthetic123456789', 'apiKey: [REDACTED]'],
    ['access-key=synthetic123456789', 'access-key=[REDACTED]'],
    ['token: synthetic123456789', 'token: [REDACTED]'],
    ['password=synthetic123456789', 'password=[REDACTED]'],
    ['token: the design token system', 'token: the design token system'],
    ['secret: private-value', 'secret: private-value'],
    ['API_KEY=short', 'API_KEY=[REDACTED]'],
    ['MONKEY: short', 'MONKEY: [REDACTED]'],
    ['cfat-synthetic_cloudflare_token_1234567890', '[REDACTED]'],
    ['Bearer abcdefghijklmnopqrstuvwxyz012345', '[REDACTED]'],
    ['sk-abcdefghijklmnopqrstuvwxyz012345', '[REDACTED]'],
    ['npm_abcdefghijklmnopqrst0123456789', '[REDACTED]'],
  ])('preserves independent and embedded credential rules for %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('redacts uppercase assignments on repeated calls and after long names or whitespace', () => {
    const inputs = [
      'KEY=short', 'TOKEN=short', 'SECRET=short', 'PASSWORD=short',
      `${'a'.repeat(129)}API_KEY :\n\tshort`,
    ];
    for (let repetition = 0; repetition < 3; repetition += 1) {
      for (const input of inputs) expect(redactSecrets(input)).toContain('[REDACTED]');
      expect(redactSecrets('ordinary text: no credential')).toBe('ordinary text: no credential');
    }
  });
});
