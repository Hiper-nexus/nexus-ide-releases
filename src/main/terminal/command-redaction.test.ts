import { describe, expect, it } from 'vitest';
import { redactCommandLine } from './command-redaction';

describe('redactCommandLine', () => {
  it('redacts bearer tokens and sk- keys', () => {
    const result = redactCommandLine(
      'curl -H "Authorization: Bearer abcd.efgh" https://api.example',
    );
    expect(result.command).not.toContain('abcd.efgh');
    expect(result.command).toContain('[REDACTED]');
    expect(result.secretHits).toBeGreaterThan(0);
    expect(result.redacted).toBe(true);
  });

  it('redacts --token flags and ENV= assignments', () => {
    const result = redactCommandLine(
      'tool --token supersecret OPENAI_API_KEY=sk-abcdefghijklmnopqrst',
    );
    expect(result.command).not.toContain('supersecret');
    expect(result.command).not.toMatch(/sk-abc/);
    expect(result.redacted).toBe(true);
  });

  it('denylists history/env dumps', () => {
    expect(redactCommandLine('history | tail').denylisted).toBe(true);
    expect(redactCommandLine('env').command).toBe('[DENYLISTED]');
  });

  it('leaves benign commands untouched', () => {
    const result = redactCommandLine('git status -sb');
    expect(result).toMatchObject({
      command: 'git status -sb',
      redacted: false,
      denylisted: false,
      secretHits: 0,
    });
  });
});
