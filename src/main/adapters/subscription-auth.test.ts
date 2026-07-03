import { describe, expect, it } from 'vitest';
import { resolveAuthStrategy } from './subscription-auth';

/**
 * Subscription-first directive: signed-in subscription/OAuth ALWAYS wins;
 * the API key is only the fallback when no subscription session exists.
 */

describe('resolveAuthStrategy', () => {
  it('subscription session wins even when a key is stored (and suppresses key env)', () => {
    const decision = resolveAuthStrategy({
      authMethod: 'oauth',
      hasStoredKey: true,
      subscriptionAuthed: true,
    });
    expect(decision.strategy).toBe('subscription');
    expect(decision.injectKey).toBe(false);
    expect(decision.suppressKeyEnv).toBe(true);
  });

  it('falls back to the API key when the subscription is not signed in', () => {
    const decision = resolveAuthStrategy({
      authMethod: 'oauth',
      hasStoredKey: true,
      subscriptionAuthed: false,
    });
    expect(decision.strategy).toBe('api-key');
    expect(decision.injectKey).toBe(true);
    expect(decision.suppressKeyEnv).toBe(false);
  });

  it('asks for login when neither subscription nor key exists', () => {
    const decision = resolveAuthStrategy({
      authMethod: 'subscription',
      hasStoredKey: false,
      subscriptionAuthed: false,
    });
    expect(decision.strategy).toBe('login-needed');
    expect(decision.injectKey).toBe(false);
  });

  it('device_code CLIs behave like subscription CLIs', () => {
    expect(
      resolveAuthStrategy({
        authMethod: 'device_code',
        hasStoredKey: true,
        subscriptionAuthed: true,
      }).strategy,
    ).toBe('subscription');
  });

  it('pure api_key CLIs inject the key and never suppress', () => {
    const decision = resolveAuthStrategy({
      authMethod: 'api_key',
      hasStoredKey: true,
      subscriptionAuthed: true, // irrelevant for api_key CLIs
    });
    expect(decision.strategy).toBe('api-key');
    expect(decision.injectKey).toBe(true);
    expect(decision.suppressKeyEnv).toBe(false);
  });

  it('api_key CLI without a key reports login-needed', () => {
    expect(
      resolveAuthStrategy({
        authMethod: 'api_key',
        hasStoredKey: false,
        subscriptionAuthed: false,
      }).strategy,
    ).toBe('login-needed');
  });
});
