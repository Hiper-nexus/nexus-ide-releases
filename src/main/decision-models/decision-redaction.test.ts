import { describe, expect, it } from 'vitest';
import { capText, redactQuestions, redactSecrets, redactState } from './decision-redaction';

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

describe('capText keepEnds (F-1346)', () => {
  it('guarda cabeça + cauda no mesmo teto e redige antes de cortar (sem sufixo de segredo)', () => {
    const secret = `sk-${'s'.repeat(40)}`;
    // O segredo atravessa o ponto de corte da cauda: cortar antes de redigir
    // deixaria 'sssssssss' (o sufixo) passar pelos padrões.
    const out = capText(`${'a'.repeat(100)}${secret} ${'b'.repeat(10)}`, 40, { keepEnds: true });
    expect(out.startsWith('a'.repeat(20))).toBe(true);
    expect(out.endsWith(` ${'b'.repeat(10)}`)).toBe(true);
    expect(out).not.toMatch(/s{5}/);
  });
});

describe('capText corte simples (F-1620)', () => {
  const key = `sk-ant-api03-${'A1b2C3d4E5f6G7h8I9j0'.repeat(4)}`;
  const longestFragment = (text: string, secret: string): number => {
    let best = 0;
    for (let i = 0; i < secret.length; i++) {
      for (let j = i + best + 1; j <= secret.length; j++) {
        if (!text.includes(secret.slice(i, j))) break;
        best = j - i;
      }
    }
    return best;
  };

  it('keepTail: a cauda de um segredo cortado no começo da janela não sai', () => {
    // Antes: a janela começava no meio da chave e os últimos 39 caracteres saíam crus.
    const text = `${'x'.repeat(5_000)}export ANTHROPIC_API_KEY=${key}\n${'y'.repeat(5_960)}`;
    const out = capText(text, 6_000, { keepTail: true });
    expect(longestFragment(out, key)).toBeLessThan(8);
    expect(out.endsWith('y'.repeat(100))).toBe(true);
    expect(out.length).toBeLessThanOrEqual(6_000 + 40);
  });

  it('corte da cabeça: o prefixo de um token partido no fim da janela não sai', () => {
    const token = `ghp_${'Z9y8X7w6V5u4T3s2R1q0'.repeat(2)}`;
    const out = capText(`${'z'.repeat(3_990)}${token} fim`, 4_000);
    expect(out).not.toContain('ghp_');
    expect(longestFragment(out, token)).toBeLessThan(8);
    expect(out.startsWith('z'.repeat(100))).toBe(true);
  });

  it('JWT longo que cruza o corte é redigido na janela', () => {
    const jwt = `eyJ${'h'.repeat(30)}.${'p'.repeat(3_000)}.${'s'.repeat(40)}`;
    const out = capText(`${'a'.repeat(1_000)}${jwt}${'b'.repeat(500)}`, 2_000, { keepTail: true });
    expect(out).not.toContain('s'.repeat(40));
    expect(out).not.toContain('p'.repeat(50));
  });
});
