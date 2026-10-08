import { describe, expect, it } from 'vitest';
import { redactCommandLine, redactSecretText, redactTerminalText } from './secret-redaction';

/**
 * F-1016: segredos opacos sem prefixo conhecido (`STRIPE_KEY=rk_live_…`, chave
 * do age, base64 cru numa variável `*_KEY`) passavam inteiros pelo redator.
 */
describe('F-1016: segredos opacos sem prefixo conhecido', () => {
  // Montadas por partes: nenhum scanner de segredo confunde o fixture com chave real.
  const restricted = 'rk_' + 'live_51HabcdefghijKLMNOPQRstuvWX';
  const secretKey = 'sk_' + 'test_9xQ2mP1nR7wLtYzK4vB8cD3f';
  const age = 'AGE-SECRET-' + 'KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQY';
  const base64 = 'q8Zp3Lw9Xv2Rt7Yb1Nc4Md6Kf0Hj5Gs+aB/cD==';

  it.each([
    ['chave restrita da Stripe num NOME=valor', `STRIPE_KEY=${restricted} node server.js`, restricted],
    ['chave secreta da Stripe solta', `curl -u ${secretKey}: https://api.stripe.com`, secretKey],
    ['chave secreta do age', `echo ${age} > key.txt`, age],
    ['base64 cru numa variável *_KEY', `SIGNING_KEY=${base64} ./deploy`, base64],
    ['base64 entre aspas numa variável KEY_*', `export STRIPE_KEY_LIVE="${base64}"`, base64],
  ])('redige %s', (_label, line, secret) => {
    const result = redactCommandLine(line, { denylist: [] });
    expect(result.command).not.toContain(secret);
    expect(result.redacted).toBe(true);
    expect(redactSecretText(`linha 1\n${line}`).text).not.toContain(secret);
    expect(redactTerminalText(`$ ${line}`)).not.toContain(secret);
  });

  it('não mexe em palavras, hashes nem nomes KEY com valor comum', () => {
    for (const benign of [
      'sort --key=2 data.txt',
      'SORT_KEY=2 npm test',
      'CACHE_KEY=user-profile-settings npm start',
      'MONKEY=Zp3Lw9Xv2Rt7Yb1Nc4Md6Kf0 node a.js',
      'PRIMARY_KEY=id_customer_order_line node seed.js',
      'git show 3f9a2c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
      'o risk_live_report e o desk_test_runner_old são nomes de arquivo',
      'leia a doc do AGE-SECRET-KEY-1 no README',
      'KEY_PATH=./config/keys/production.pem node app.js',
    ]) {
      const result = redactCommandLine(benign);
      expect(result.command).toBe(benign);
      expect(result.redacted).toBe(false);
    }
  });
});
