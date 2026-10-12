import { describe, expect, it } from 'vitest';
import { auditSourceCode } from './source-audit';

describe('auditSourceCode', () => {
  it('redacts secret-like evidence while reporting the source line', () => {
    const result = auditSourceCode('const key = "sk-test-secret-value-123456";');

    const secret = result.findings.find((finding) => finding.message.includes('secret-like'));
    expect(secret?.line).toBe(1);
    expect(secret?.evidence).toContain('[REDACTED_SECRET]');
    expect(secret?.evidence).not.toContain('sk-test-secret-value-123456');
  });

  it('F-1331: never leaks the secret through the evidence of a neighbouring finding', () => {
    const secret = 'sk-test-secret-value-123456';
    const result = auditSourceCode(`const k = "${secret}";\neval(userInput);\nel.innerHTML = x;`);

    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    for (const finding of result.findings) {
      expect(finding.evidence).not.toContain(secret);
      // A window that starts mid-secret must not leak the tail either.
      expect(finding.evidence).not.toContain('secret-value-123456');
    }
    const exec = result.findings.find((finding) => finding.message.includes('execution sink'));
    expect(exec?.evidence).toContain('eval(');
    const html = result.findings.find((finding) => finding.message.includes('HTML sink'));
    expect(html?.category).not.toBe('override');
  });

  it('F-1331: redacts a secret cut by the start of the evidence window', () => {
    const secret = `sk-ant-api03-${'A'.repeat(40)}`;
    // The exec match sits 90 chars after the secret starts: its 80-char window
    // begins inside the secret, so only the tail ("AAAA…") is in the excerpt.
    const result = auditSourceCode(`${secret}${' '.repeat(37)}eval(userInput);`);

    const exec = result.findings.find((finding) => finding.message.includes('execution sink'));
    expect(exec?.evidence).toContain('eval(');
    expect(exec?.evidence).not.toContain('AAAAAAAAAA');
  });

  it('flags command execution and unsafe HTML sinks', () => {
    const result = auditSourceCode('eval(input); element.innerHTML = value;');

    expect(result.highestSeverity).toBe('high');
    expect(result.findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('execution sink'),
        expect.stringContaining('HTML sink'),
      ]),
    );
  });
});
