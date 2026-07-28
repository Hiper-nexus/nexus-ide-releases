import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claudeKeychainHas,
  claudeKeychainHasAsync,
  claudeOauthEmail,
  detectSubscriptionAuth,
  hasSubscriptionAuthForStatus,
  kimiCredentialsBlobIsUsable,
  refreshClaudeSubscriptionAuthCache,
  resetSubscriptionAuthCacheForTests,
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
  resetSubscriptionAuthCacheForTests();
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

describe('kimiCredentialsBlobIsUsable', () => {
  it('rejects empty shells and accepts a live access or refresh token', () => {
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({
          access_token: '',
          refresh_token: '',
          expires_at: 0,
        }),
      ),
    ).toBe(false);
    expect(kimiCredentialsBlobIsUsable('{"kimi":1}')).toBe(false);
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({ access_token: 'at-live', refresh_token: '' }),
      ),
    ).toBe(true);
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({ access_token: '', refresh_token: 'rt-live' }),
      ),
    ).toBe(true);
  });
});

describe('detectSubscriptionAuth', () => {
  it('keeps the cold provider-status path out of the synchronous Keychain', () => {
    const home = tempHome();
    const syncKeychainProbe = vi.fn(() => true);

    expect(
      detectSubscriptionAuth('claude', home, undefined, {
        probeClaudeKeychain: false,
        claudeKeychainProbe: syncKeychainProbe,
      }),
    ).toBe(false);
    expect(syncKeychainProbe).not.toHaveBeenCalled();
    expect(hasSubscriptionAuthForStatus('claude', undefined, home)).toBe(false);
  });

  it('warms a Keychain-only Claude status asynchronously without poisoning the cold cache', async () => {
    const home = tempHome();
    const asyncKeychainProbe = vi.fn(async () => true);

    // A cold status read fails closed but does not cache `false`; the
    // authoritative/background probe can still establish the native session.
    expect(hasSubscriptionAuthForStatus('claude', undefined, home)).toBe(false);
    await expect(
      refreshClaudeSubscriptionAuthCache(home, asyncKeychainProbe),
    ).resolves.toEqual({ value: true, cacheUpdated: true });
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(1);
    expect(hasSubscriptionAuthForStatus('claude', undefined, home)).toBe(true);

    // The warm cache prevents a second Keychain process during the TTL.
    await expect(
      refreshClaudeSubscriptionAuthCache(home, asyncKeychainProbe),
    ).resolves.toEqual({ value: true, cacheUpdated: false });
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent background Keychain refreshes', async () => {
    const home = tempHome();
    let resolveProbe!: (value: boolean) => void;
    const asyncKeychainProbe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const first = refreshClaudeSubscriptionAuthCache(
      home,
      asyncKeychainProbe,
    );
    const second = refreshClaudeSubscriptionAuthCache(
      home,
      asyncKeychainProbe,
    );
    await Promise.resolve();
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(1);
    resolveProbe(false);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: false, cacheUpdated: true },
      { value: false, cacheUpdated: true },
    ]);
  });

  it.runIf(process.platform === 'darwin')(
    'bounds the fallback Claude Keychain presence probe',
    () => {
      const execImpl = ((..._args: unknown[]) =>
        Buffer.alloc(0)) as typeof import('node:child_process').execFileSync;
      const bounded = vi.fn(execImpl);
      expect(
        claudeKeychainHas(
          bounded as unknown as typeof import('node:child_process').execFileSync,
        ),
      ).toBe(true);
      expect(bounded).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        expect.objectContaining({
          timeout: 5_000,
          killSignal: 'SIGKILL',
        }),
      );
    },
  );

  it.runIf(process.platform === 'darwin')(
    'uses a bounded asynchronous process for the provider-status Keychain refresh',
    async () => {
      const execImpl = vi.fn(
        (
          _file: string,
          _args: readonly string[],
          _options: Record<string, unknown>,
          callback: (error: Error | null) => void,
        ) => {
          queueMicrotask(() => callback(null));
          return {};
        },
      );

      await expect(
        claudeKeychainHasAsync(
          execImpl as unknown as typeof import('node:child_process').execFile,
        ),
      ).resolves.toBe(true);
      expect(execImpl).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        expect.objectContaining({
          timeout: 5_000,
          killSignal: 'SIGKILL',
        }),
        expect.any(Function),
      );
    },
  );

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

  it('does not treat an empty Kimi credentials shell as authenticated', () => {
    const home = tempHome();
    const creds = path.join(
      home,
      '.kimi-code',
      'credentials',
      'kimi-code.json',
    );
    const oauthMarker = path.join(home, '.kimi-code', 'oauth', 'kimi-code');
    fs.mkdirSync(path.dirname(creds), { recursive: true });
    fs.mkdirSync(path.dirname(oauthMarker), { recursive: true });
    fs.writeFileSync(oauthMarker, '');
    fs.writeFileSync(
      creds,
      JSON.stringify({
        access_token: '',
        refresh_token: '',
        expires_at: 0,
        scope: 'kimi-code',
        token_type: 'Bearer',
        expires_in: 0,
      }),
    );
    expect(detectSubscriptionAuth('kimi', home)).toBe(false);
    fs.writeFileSync(
      creds,
      JSON.stringify({
        access_token: 'at-live',
        refresh_token: 'rt-live',
        expires_at: 9_999_999_999,
        scope: 'kimi-code',
        token_type: 'Bearer',
        expires_in: 900,
      }),
    );
    expect(detectSubscriptionAuth('kimi', home)).toBe(true);
  });

  it('detects OMP only from exact provider/model vault metadata', () => {
    const home = tempHome();
    const databasePath = path.join(home, '.omp', 'agent', 'agent.db');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    try {
      database.exec(`
        CREATE TABLE auth_credentials (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          credential_type TEXT NOT NULL,
          data TEXT NOT NULL,
          disabled_cause TEXT
        )
      `);
      database
        .prepare(
          `INSERT INTO auth_credentials
             (id, provider, credential_type, data, disabled_cause)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(1, 'anthropic', 'oauth', 'secret-must-not-be-read', 'disabled');
      expect(
        detectSubscriptionAuth(
          'omp',
          home,
          'anthropic/claude-sonnet-4-6',
        ),
      ).toBe(false);
      database
        .prepare(
          `INSERT INTO auth_credentials
             (id, provider, credential_type, data, disabled_cause)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(2, 'openai-codex', 'oauth', 'another-secret', null);
      expect(
        detectSubscriptionAuth('omp', home, 'openai-codex/gpt-5.5'),
      ).toBe(true);
      expect(
        detectSubscriptionAuth('omp-rpc', home, 'openai-codex/gpt-5.5'),
      ).toBe(true);
      // A valid Codex credential is not blanket readiness for Anthropic/xAI.
      expect(
        detectSubscriptionAuth(
          'omp',
          home,
          'anthropic/claude-sonnet-4-6',
        ),
      ).toBe(false);
      expect(
        detectSubscriptionAuth('omp', home, 'xai/grok-4.5'),
      ).toBe(false);
      database
        .prepare(
          `INSERT INTO auth_credentials
             (id, provider, credential_type, data, disabled_cause)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(3, 'xai-oauth', 'oauth', 'synthetic-row-data', null);
      expect(
        detectSubscriptionAuth('omp', home, 'xai-oauth/grok-4.5'),
      ).toBe(true);
      // The distinct API-key selector is not authorized by xai-oauth.
      expect(
        detectSubscriptionAuth('omp', home, 'xai/grok-4.5'),
      ).toBe(false);
      // Missing/malformed model cannot fall back to "any vault row".
      expect(detectSubscriptionAuth('omp', home)).toBe(false);
      expect(detectSubscriptionAuth('omp', home, 'malformed')).toBe(false);
    } finally {
      database.close();
    }
  });

  it('fails closed when an OMP database has an unknown schema', () => {
    const home = tempHome();
    touch(home, '.omp', 'agent', 'agent.db');
    expect(
      detectSubscriptionAuth(
        'omp',
        home,
        'anthropic/claude-sonnet-4-6',
      ),
    ).toBe(false);
  });

  it('honors only release-pinned broker aliases', () => {
    const home = tempHome();
    const databasePath = path.join(home, '.omp', 'agent', 'agent.db');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    try {
      database.exec(`
        CREATE TABLE auth_credentials (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          credential_type TEXT NOT NULL,
          data TEXT NOT NULL,
          disabled_cause TEXT
        )
      `);
      database
        .prepare(
          `INSERT INTO auth_credentials
             (provider, credential_type, data, disabled_cause)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          'openai-codex-device',
          'oauth',
          'secret-must-not-be-read',
          null,
        );
      expect(
        detectSubscriptionAuth('omp', home, 'openai-codex/gpt-5.5'),
      ).toBe(true);
      expect(
        detectSubscriptionAuth('omp', home, 'openai/gpt-5.5'),
      ).toBe(false);
      expect(
        detectSubscriptionAuth('omp', home, 'future/gpt-5.5'),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it('treats only release-pinned local OMP providers as credentialless', () => {
    const home = tempHome();
    expect(
      detectSubscriptionAuth('omp', home, 'ollama/qwen2.5-coder'),
    ).toBe(true);
    expect(
      detectSubscriptionAuth('omp', home, 'future-local/model'),
    ).toBe(false);
  });

  it('detects a managed AGY account via usable oauth_creds under GEMINI_CLI_HOME', () => {
    const home = tempHome();
    const geminiHome = tempHome();
    const prev = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = geminiHome;
    try {
      expect(detectSubscriptionAuth('agy', home)).toBe(false);
      // Install tree alone is not a live session.
      touch(geminiHome, 'antigravity');
      expect(detectSubscriptionAuth('agy', home)).toBe(false);
      fs.writeFileSync(
        path.join(geminiHome, 'oauth_creds.json'),
        JSON.stringify({ access_token: 'at', refresh_token: 'rt' }),
      );
      expect(detectSubscriptionAuth('agy', home)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prev;
    }
  });

  it('rejects AGY when google_accounts.active is null (logged out)', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'google_accounts.json'),
      JSON.stringify({ active: null, old: ['user@example.com'] }),
    );
    touch(path.join(home, '.gemini'), 'antigravity');
    expect(detectSubscriptionAuth('agy', home)).toBe(false);
  });

  it('fails closed for a custom adapter without an auth detector', () => {
    expect(detectSubscriptionAuth('unknown-provider', tempHome())).toBe(false);
  });

  it('reads Claude email as identity only — not a live session', () => {
    const home = tempHome();
    expect(claudeOauthEmail(home)).toBeNull();
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'user@example.com' },
      }),
    );
    expect(claudeOauthEmail(home)).toBe('user@example.com');
    // Email survives OAuth expiry; it must not prove a live subscription.
    expect(
      detectSubscriptionAuth('claude', home, undefined, {
        probeClaudeKeychain: false,
      }),
    ).toBe(false);
  });

  it('treats credentials file with accessToken as a live Claude session', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-ant-oat01-file' },
      }),
    );
    expect(
      detectSubscriptionAuth('claude', home, undefined, {
        probeClaudeKeychain: false,
      }),
    ).toBe(true);
  });

  it('rejects empty credentials file as not live', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '' } }),
    );
    expect(
      detectSubscriptionAuth('claude', home, undefined, {
        probeClaudeKeychain: false,
      }),
    ).toBe(false);
  });
});
