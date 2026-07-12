import { describe, expect, it } from 'vitest';
import { detectLimit } from './limit-detector';

describe('detectLimit', () => {
  it('detects Claude usage-limit messages as rate-limit', () => {
    const hit = detectLimit("Claude usage limit reached. Your limit will reset at 3pm.");
    expect(hit?.kind).toBe('rate-limit');
  });

  it('detects HTTP 429 / rate_limit', () => {
    expect(detectLimit('Error: 429 Too Many Requests')?.kind).toBe('rate-limit');
    expect(detectLimit('{"type":"rate_limit_error"}')?.kind).toBe('rate-limit');
  });

  it('detects real provider spellings without an error prefix', () => {
    // Código de erro da OpenAI (separador underscore, sem "429" junto).
    expect(detectLimit('rate_limit_exceeded')?.kind).toBe('rate-limit');
    // Classe de exceção dos SDKs (CamelCase).
    expect(detectLimit('openai.RateLimitError')?.kind).toBe('rate-limit');
  });

  it('ignores rate-limit guidance echoed from a squad prompt', () => {
    expect(
      detectLimit('RATE LIMIT: em rate limit, re-roteie para outra CLI e siga.'),
    ).toBeNull();
    expect(detectLimit('Documente como tratar rate limit no provider.')).toBeNull();
  });

  it('detects credit/quota exhaustion as quota (long cooldown)', () => {
    const hit = detectLimit('Your credit balance is too low to run this request.');
    expect(hit?.kind).toBe('quota');
    expect(hit!.cooldownMs).toBeGreaterThan(6 * 60 * 60 * 1000);
  });

  it('detects insufficient_quota and 402', () => {
    expect(detectLimit('insufficient_quota')?.kind).toBe('quota');
    expect(detectLimit('HTTP 402 payment required')?.kind).toBe('quota');
  });

  it('detects auth errors', () => {
    expect(detectLimit('401 authentication_error')?.kind).toBe('auth');
    expect(detectLimit('invalid api key provided')?.kind).toBe('auth');
  });

  it('detects Codex/ChatGPT and Grok limit signatures', () => {
    expect(
      detectLimit('codex: ChatGPT usage limit reached — try again later')?.kind,
    ).toBe('rate-limit');
    expect(detectLimit('Grok rate limit exceeded, try later')?.kind).toBe(
      'rate-limit',
    );
    expect(detectLimit('tokens per minute exceeded')?.kind).toBe('rate-limit');
    expect(
      detectLimit('error: session expired, please re-authenticate')?.kind,
    ).toBe('auth');
  });

  it('does not false-positive on docs or agent prose', () => {
    expect(detectLimit('Codex has no usage limit in free tier docs')).toBeNull();
    expect(detectLimit('Please log in to GitHub to continue the OAuth flow')).toBeNull();
    expect(detectLimit('server busy is a metaphor here')).toBeNull();
  });

  it('parses an explicit retry window to size the cooldown', () => {
    const hit = detectLimit('rate limit — try again in 42 minutes');
    expect(hit?.cooldownMs).toBe(42 * 60 * 1000);
  });

  it('returns null for normal output', () => {
    expect(detectLimit('Building the project... done. All tests passed.')).toBeNull();
    expect(detectLimit('Here is the code you asked for:')).toBeNull();
  });

  it('prioritises quota over generic rate-limit when both could match', () => {
    const hit = detectLimit('rate limited: insufficient_quota, out of credits');
    expect(hit?.kind).toBe('quota');
  });
});
