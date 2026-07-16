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

  it('removes terminal control characters before persistence', () => {
    const result = redactCommandLine('echo safe\x1b]133;D;0\x07');
    expect(result.command).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(result.redacted).toBe(true);
  });

  it('redacts Gemini/Google keys in a header value', () => {
    const key = 'AIza' + 'B'.repeat(35);
    const result = redactCommandLine(
      `curl -H "x-goog-api-key: ${key}" https://generativelanguage.googleapis.com`,
    );
    expect(result.command).not.toContain(key);
    expect(result.redacted).toBe(true);
  });

  it('redacts Groq (gsk_) and xAI (xai-) keys', () => {
    const groq = 'gsk_' + 'a'.repeat(40);
    const xai = 'xai-' + 'b'.repeat(40);
    const result = redactCommandLine(`llm --key ${groq} ; other --token ${xai}`);
    expect(result.command).not.toContain(groq);
    expect(result.command).not.toContain(xai);
  });

  it('redacts a bare pasted xAI key', () => {
    const xai = 'xai-' + 'c'.repeat(40);
    const result = redactCommandLine(`export FOO=1 && echo ${xai}`);
    expect(result.command).not.toContain(xai);
  });

  it('redacts GLM/z.ai dot-delimited keys', () => {
    const glm = 'a'.repeat(32) + '.' + 'Zk9xQ2mP1nR7wLtY';
    const result = redactCommandLine(`glm-cli --base-url x ${glm}`);
    expect(result.command).not.toContain(glm);
  });

  it('still leaves benign commands untouched with the new rules', () => {
    for (const cmd of ['git status -sb', 'npm run build', 'ls -la ~/project']) {
      const r = redactCommandLine(cmd);
      expect(r.command).toBe(cmd);
      expect(r.redacted).toBe(false);
    }
  });

  it('does not over-redact benign --key / -key flags and prose', () => {
    for (const cmd of [
      'sort --key=2 data.txt',
      'openssl rsa -key priv.pem -out pub.pem',
      'echo authorization: read the docs',
    ]) {
      const r = redactCommandLine(cmd);
      expect(r.command).toBe(cmd);
      expect(r.redacted).toBe(false);
    }
  });

  it('still redacts a secret-shaped opaque header value', () => {
    const r = redactCommandLine('curl -H "x-api-key: 0123456789abcdefXYZ" https://api');
    expect(r.command).not.toContain('0123456789abcdefXYZ');
  });
});
