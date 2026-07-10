import { describe, expect, it } from 'vitest';
import { redactVisibleSecrets, sanitizeMcpResultOutput } from './mcp-result-output';

/** Synthetic secrets for redaction tests — never log these strings. */
const SECRETS = {
  sk: 'sk-testleakvalueabcdef1234567890',
  gemini: 'AIzaSyD-testleakvalueabcdef1234567',
  ghp: 'ghp_testleakvalueabcdef123456789012',
  gho: 'gho_testleakvalueabcdef123456789012',
  ghu: 'ghu_testleakvalueabcdef123456789012',
  ghs: 'ghs_testleakvalueabcdef123456789012',
  ghr: 'ghr_testleakvalueabcdef123456789012',
  npm: 'npm_testleakvalueabcdef123456789012',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  bearerToken: 'ya29.testleakvalueabcdefTOKEN',
  pemBody: 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC',
  urlPass: 'p4ssw0rdLeak99',
  envValue: 'sk-env-assignment-leak-1234567890',
  passwordValue: 'SuperSecretLeak99',
} as const;

describe('redactVisibleSecrets', () => {
  it('redacts each supported secret format while preserving labels and benign text', () => {
    const input = [
      'Dashboard title',
      `token budget is fine`,
      `password policy is strict`,
      `Bearer ${SECRETS.bearerToken}`,
      SECRETS.sk,
      SECRETS.gemini,
      SECRETS.ghp,
      SECRETS.gho,
      SECRETS.ghu,
      SECRETS.ghs,
      SECRETS.ghr,
      SECRETS.npm,
      SECRETS.jwt,
      `-----BEGIN PRIVATE KEY-----\n${SECRETS.pemBody}\n-----END PRIVATE KEY-----`,
      `https://user:${SECRETS.urlPass}@db.example.com/path`,
      `OPENAI_API_KEY=${SECRETS.envValue}`,
      `password=${SECRETS.passwordValue}`,
      `api_key: leaked-api-key-value-999`,
      `access_key = "ak-leak-999"`,
      `secret: s3cretValue`,
      `credential=cred-leak`,
      `auth: auth-leak-value`,
      `cookie: session=abc123def456`,
      `TOKEN=env-token-leak`,
    ].join('\n');

    const redacted = redactVisibleSecrets(input);

    expect(redacted).toContain('Dashboard title');
    expect(redacted).toContain('token budget is fine');
    expect(redacted).toContain('password policy is strict');
    expect(redacted).toContain('OPENAI_API_KEY=');
    expect(redacted).toContain('password=');
    expect(redacted).toContain('api_key:');
    expect(redacted).toMatch(/\[REDACTED/);

    for (const secret of Object.values(SECRETS)) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).not.toContain('leaked-api-key-value-999');
    expect(redacted).not.toContain('ak-leak-999');
    expect(redacted).not.toContain('s3cretValue');
    expect(redacted).not.toContain('cred-leak');
    expect(redacted).not.toContain('auth-leak-value');
    expect(redacted).not.toContain('session=abc123def456');
    expect(redacted).not.toContain('env-token-leak');
  });

  it('does not mutate the input string object wrapper usage and returns a new string when redacting', () => {
    const original = `keep ${SECRETS.sk}`;
    const copy = original;
    const redacted = redactVisibleSecrets(original);
    expect(original).toBe(copy);
    expect(original).toContain(SECRETS.sk);
    expect(redacted).not.toContain(SECRETS.sk);
    expect(redacted).not.toBe(original);
  });

  it('does not mistake a long three-label hostname for a JWT', () => {
    const hostname = 'longsubdomain.exampleproject.internaldomain';
    expect(redactVisibleSecrets(hostname)).toBe(hostname);
  });
});

describe('sanitizeMcpResultOutput', () => {
  it('redacts nested strings and secret-shaped keys without mutating the source', () => {
    const source = {
      title: 'Mission',
      nested: { note: `use ${SECRETS.sk}` },
      password: SECRETS.passwordValue,
      list: [SECRETS.jwt, 'token budget'],
    };
    const out = sanitizeMcpResultOutput(source) as typeof source;
    expect(source.nested.note).toContain(SECRETS.sk);
    expect(JSON.stringify(out)).not.toContain(SECRETS.sk);
    expect(JSON.stringify(out)).not.toContain(SECRETS.jwt);
    expect(JSON.stringify(out)).not.toContain(SECRETS.passwordValue);
    expect(JSON.stringify(out)).toContain('token budget');
    expect(JSON.stringify(out)).toContain('Mission');
  });
});
