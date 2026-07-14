import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeOauthEmail,
  detectSubscriptionAuth,
  resolveAuthStrategy,
} from './subscription-auth';

const tempDirs: string[] = [];

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-provider-auth-'));
  tempDirs.push(home);
  return home;
}

function touch(home: string, ...segments: string[]): void {
  const file = path.join(home, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

  it('api_key CLI with its OWN login session is honored as subscription (codex/grok)', () => {
    // Regression: codex (auth.method api_key, but signed in via ChatGPT) and
    // grok (~/.grok/auth.json) used to show a false "login pendente" because the
    // api_key branch short-circuited before checking subscriptionAuthed. A live
    // CLI-managed session must win regardless of the declared auth.method, and
    // we must NOT inject a key over it.
    const decision = resolveAuthStrategy({
      authMethod: 'api_key',
      hasStoredKey: true,
      subscriptionAuthed: true,
    });
    expect(decision.strategy).toBe('subscription');
    expect(decision.injectKey).toBe(false);
    expect(decision.suppressKeyEnv).toBe(true);
  });

  it('api_key CLI with a stored key but NO session uses the key', () => {
    const decision = resolveAuthStrategy({
      authMethod: 'api_key',
      hasStoredKey: true,
      subscriptionAuthed: false,
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

describe('detectSubscriptionAuth', () => {
  it('does not invent a subscription session for API-key-only Aider', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.aider'), { recursive: true });
    expect(detectSubscriptionAuth('aider', home)).toBe(false);
  });

  it('detects OpenCode only when its official auth artifact exists', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.local', 'share', 'opencode'), {
      recursive: true,
    });
    expect(detectSubscriptionAuth('opencode', home)).toBe(false);
    touch(home, '.local', 'share', 'opencode', 'auth.json');
    expect(detectSubscriptionAuth('opencode', home)).toBe(true);
  });

  it('does not treat a merely installed Grok directory as authenticated', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    expect(detectSubscriptionAuth('grok', home)).toBe(false);
    touch(home, '.grok', 'auth.json');
    expect(detectSubscriptionAuth('grok', home)).toBe(true);
  });

  it('detects a managed AGY account via GEMINI_CLI_HOME (custom home)', () => {
    const home = tempHome();
    const geminiHome = tempHome();
    const prev = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = geminiHome;
    try {
      // Nothing in the real home nor the custom home yet.
      expect(detectSubscriptionAuth('agy', home)).toBe(false);
      // The managed account's auth artifact lands under $GEMINI_CLI_HOME.
      touch(geminiHome, 'antigravity');
      expect(detectSubscriptionAuth('agy', home)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prev;
    }
  });

  it('fails closed for a custom adapter without an auth detector', () => {
    expect(detectSubscriptionAuth('unknown-provider', tempHome())).toBe(false);
  });

  it('reads Claude email from ~/.claude.json oauthAccount (file-backed login)', () => {
    const home = tempHome();
    expect(claudeOauthEmail(home)).toBeNull();
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'user@example.com' },
      }),
    );
    expect(claudeOauthEmail(home)).toBe('user@example.com');
    // File-backed account alone is enough even if Keychain probe fails.
    expect(detectSubscriptionAuth('claude', home)).toBe(true);
  });
});
