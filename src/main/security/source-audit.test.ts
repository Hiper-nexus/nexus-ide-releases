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
