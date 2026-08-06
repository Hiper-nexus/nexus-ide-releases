import { describe, expect, it } from 'vitest';
import { redactCommandLine, redactSecretText } from './command-redaction';

/**
 * Guards for the classes that reach a durable, human-readable surface (mission
 * narrative, memory projection) rather than a shell history line.
 */

describe('secret classes in a single line', () => {
  it.each([
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K'],
    ['Slack bot token', 'xoxb-1234567890-abcdefghijklmnop'],
    ['Google OAuth refresh', '1//0eXaMPLErefreshTOKENvalue123456'],
  ])('redacts a bare %s', (_label, secret) => {
    const result = redactCommandLine(`context ${secret} tail`);
    expect(result.command).not.toContain(secret);
    expect(result.redacted).toBe(true);
  });

  it('masks the password half of a connection string, keeping the host', () => {
    const result = redactCommandLine(
      'psql postgres://admin:hunter2@db.internal:5432/prod',
    );
    expect(result.command).not.toContain('hunter2');
    expect(result.command).toContain('db.internal:5432/prod');
    expect(result.command).toContain('admin');
  });

  it('does not clobber lowercase prose that merely looks key-shaped', () => {
    for (const benign of [
      'git status -sb',
      'ls -la ~/project',
      'echo akiaiosfodnn7example is lowercase prose',
      'curl https://example.com/path',
    ]) {
      const result = redactCommandLine(benign);
      expect(result.command).toBe(benign);
      expect(result.redacted).toBe(false);
    }
  });
});

describe('redactSecretText', () => {
  it('collapses an armoured private key block that no line pattern can match', () => {
    const pem = [
      'contexto antes',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAx7Vn9k2Qm5Hs8pLd3Rf6TgYb1WcZa0NvJhKu4EiOsPqMrXtA',
      'BvCwDxEyFzG0H1I2J3K4L5M6N7O8P9Q0R1S2T3U4V5W6X7Y8Z9a0b1c2d3e4f5g6',
      '-----END RSA PRIVATE KEY-----',
      'contexto depois',
    ].join('\n');

    const result = redactSecretText(pem);

    expect(result.text).not.toContain('MIIEowIBAAKCAQEA');
    expect(result.text).not.toContain('BvCwDxEyFzG0H1I2');
    expect(result.text).toContain('contexto antes');
    expect(result.text).toContain('contexto depois');
    expect(result.redacted).toBe(true);
  });

  it('redacts a key block truncated by a crash (no END marker)', () => {
    const result = redactSecretText(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n',
    );
    expect(result.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(result.redacted).toBe(true);
  });

  it('scrubs an env dump line by line instead of discarding the whole text', () => {
    const dump = [
      'DEPLOY NOTES',
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      'DATABASE_URL=postgres://svc:s3cr3tpw@db:5432/app',
      'HOME=/Users/dev',
    ].join('\n');

    const result = redactSecretText(dump);

    expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.text).not.toContain('s3cr3tpw');
    // The surrounding memory survives — masking, never wholesale discard.
    expect(result.text).toContain('DEPLOY NOTES');
    expect(result.text).toContain('HOME=/Users/dev');
    expect(result.text).not.toContain('[DENYLISTED]');
  });

  it('strips terminal control characters so raw PTY never lands verbatim', () => {
    const result = redactSecretText('\x1b[31mERRO\x1b[0m\x1b]0;title\x07done');
    expect(result.text).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
    expect(result.redacted).toBe(true);
  });

  it('never truncates a long benign line', () => {
    const long = `nota ${'a'.repeat(40_000)}`;
    const result = redactSecretText(long);
    expect(result.text).toHaveLength(long.length);
    expect(result.redacted).toBe(false);
  });

  it('stays linear on long benign text (no catastrophic backtracking)', () => {
    // Mission narrative is unbounded prose. An unbounded scheme repetition in
    // the URL-credential pattern made this ~780ms on 40k; the bounded form is
    // ~1ms. Bound is load-tolerant (parallel vitest) but still fails the old
    // quadratic path (multi-second on 80k).
    const long = `nota ${'a'.repeat(80_000)}`;
    const started = performance.now();
    redactSecretText(long);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('leaves ordinary prose byte-identical', () => {
    const prose = 'Missão concluída.\nO gate passou.\nSem pendências.';
    const result = redactSecretText(prose);
    expect(result.text).toBe(prose);
    expect(result.redacted).toBe(false);
  });
});
