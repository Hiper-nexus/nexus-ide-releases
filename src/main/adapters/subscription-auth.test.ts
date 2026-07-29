import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agyKeychainBlobIsUsable,
  agyKeychainCredentialIsUsable,
  agyKeychainCredentialIsUsableAsync,
  claudeKeychainHas,
  claudeKeychainHasAsync,
  claudeOauthEmail,
  detectSubscriptionAuth,
  resetAgyKeychainCache,
  hasSubscriptionAuthForStatus,
  kimiCredentialsBlobIsUsable,
  refreshAgySubscriptionAuthCache,
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
  it('treats auth.method none as credentialless without injecting or suppressing env', () => {
    expect(
      resolveAuthStrategy({
        authMethod: 'none',
        hasStoredKey: false,
        subscriptionAuthed: false,
      }),
    ).toEqual({
      strategy: 'credentialless',
      injectKey: false,
      suppressKeyEnv: false,
    });
  });

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

describe('agyKeychainBlobIsUsable', () => {
  const wrap = (value: unknown) =>
    `go-keyring-base64:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`;

  it('accepts the nested shape the antigravity CLI actually writes', () => {
    expect(
      agyKeychainBlobIsUsable(
        wrap({
          auth_method: 'oauth',
          token: {
            access_token: 'ya29.tok',
            token_type: 'Bearer',
            refresh_token: 'rt',
            expiry: '2026-07-28T21:50:49.000Z',
          },
        }),
      ),
    ).toBe(true);
    // An expired access token still refreshes on spawn — refresh token counts.
    expect(
      agyKeychainBlobIsUsable(
        wrap({ auth_method: 'oauth', token: { refresh_token: 'rt' } }),
      ),
    ).toBe(true);
  });

  it('accepts flat payload shapes for keyring/CLI variants', () => {
    expect(
      agyKeychainBlobIsUsable(wrap({ auth_method: 'oauth', token: 'ya29.tok' })),
    ).toBe(true);
    // Raw (unwrapped) JSON is accepted for keyring variants that skip base64.
    expect(agyKeychainBlobIsUsable(JSON.stringify({ token: 'tok' }))).toBe(true);
    expect(
      agyKeychainBlobIsUsable(JSON.stringify({ access_token: 'tok' })),
    ).toBe(true);
  });

  it('rejects empty, tokenless and malformed payloads', () => {
    expect(agyKeychainBlobIsUsable('')).toBe(false);
    expect(agyKeychainBlobIsUsable('   ')).toBe(false);
    expect(agyKeychainBlobIsUsable(wrap({ auth_method: 'oauth' }))).toBe(false);
    expect(agyKeychainBlobIsUsable(wrap({ token: '' }))).toBe(false);
    expect(agyKeychainBlobIsUsable(wrap({ token: '   ' }))).toBe(false);
    // Nested object present but carrying no usable token.
    expect(
      agyKeychainBlobIsUsable(wrap({ token: { token_type: 'Bearer' } })),
    ).toBe(false);
    expect(
      agyKeychainBlobIsUsable(wrap({ token: { access_token: '  ' } })),
    ).toBe(false);
    expect(agyKeychainBlobIsUsable('go-keyring-base64:not-base64-json')).toBe(
      false,
    );
    expect(agyKeychainBlobIsUsable('plain text, not json')).toBe(false);
  });
});

describe('agyKeychainCredentialIsUsable', () => {
  afterEach(() => resetAgyKeychainCache());

  it('memoizes the keychain probe so per-model readiness spawns one process', () => {
    if (process.platform !== 'darwin') return;
    const nativeHome = tempHome();
    const exec = vi.fn(
      () =>
        `go-keyring-base64:${Buffer.from(
          JSON.stringify({ auth_method: 'oauth', token: 'tok' }),
          'utf8',
        ).toString('base64')}`,
    ) as unknown as typeof import('node:child_process').execFileSync;
    expect(
      agyKeychainCredentialIsUsable(exec, { nativeHome }),
    ).toBe(true);
    expect(
      agyKeychainCredentialIsUsable(exec, { nativeHome }),
    ).toBe(true);
    expect(
      agyKeychainCredentialIsUsable(exec, { nativeHome }),
    ).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('bypasses a stale negative cache at the authoritative spawn boundary', () => {
    if (process.platform !== 'darwin') return;
    const nativeHome = tempHome();
    const exec = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('item not found before OAuth completed');
      })
      .mockImplementationOnce(
        () =>
          `go-keyring-base64:${Buffer.from(
            JSON.stringify({ auth_method: 'oauth', token: 'fresh-token' }),
            'utf8',
          ).toString('base64')}`,
      ) as unknown as typeof import('node:child_process').execFileSync;

    expect(
      agyKeychainCredentialIsUsable(exec, { nativeHome }),
    ).toBe(false);
    expect(
      agyKeychainCredentialIsUsable(exec, {
        nativeHome,
        bypassCache: true,
      }),
    ).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('reuses one recent positive authoritative proof across adjacent spawn gates', () => {
    if (process.platform !== 'darwin') return;
    const nativeHome = tempHome();
    const exec = vi.fn(
      () =>
        `go-keyring-base64:${Buffer.from(
          JSON.stringify({ auth_method: 'oauth', token: 'live-token' }),
          'utf8',
        ).toString('base64')}`,
    ) as unknown as typeof import('node:child_process').execFileSync;

    expect(
      agyKeychainCredentialIsUsable(exec, {
        nativeHome,
        bypassCache: true,
      }),
    ).toBe(true);
    expect(
      agyKeychainCredentialIsUsable(exec, {
        nativeHome,
        bypassCache: true,
      }),
    ).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('probes AGY authority asynchronously and warms the short spawn proof', async () => {
    if (process.platform !== 'darwin') return;
    const nativeHome = tempHome();
    const validBlob = `go-keyring-base64:${Buffer.from(
      JSON.stringify({ auth_method: 'oauth', token: 'live-token' }),
      'utf8',
    ).toString('base64')}`;
    const asyncExec = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        queueMicrotask(() => callback(null, validBlob));
      },
    ) as unknown as typeof import('node:child_process').execFile;

    const proof = agyKeychainCredentialIsUsableAsync(asyncExec, {
      nativeHome,
      bypassCache: true,
    });
    expect(asyncExec).toHaveBeenCalledOnce();
    await expect(proof).resolves.toBe(true);

    const syncExec = vi.fn(() => {
      throw new Error('recent async proof should be reused');
    }) as unknown as typeof import('node:child_process').execFileSync;
    expect(
      agyKeychainCredentialIsUsable(syncExec, {
        nativeHome,
        bypassCache: true,
      }),
    ).toBe(true);
    expect(syncExec).not.toHaveBeenCalled();
  });

  it('binds the lookup to native HOME when Electron HOME is isolated', () => {
    if (process.platform !== 'darwin') return;
    const nativeHome = tempHome();
    const canonicalNativeHome = fs.realpathSync.native(nativeHome);
    const isolatedHome = tempHome();
    const exec = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        if (
          options.env?.HOME !== canonicalNativeHome ||
          options.env?.USERPROFILE !== canonicalNativeHome
        ) {
          throw new Error('wrong login keychain');
        }
        return `go-keyring-base64:${Buffer.from(
          JSON.stringify({ auth_method: 'oauth', token: 'tok' }),
          'utf8',
        ).toString('base64')}`;
      },
    ) as unknown as typeof import('node:child_process').execFileSync;
    const previousHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    try {
      expect(
        agyKeychainCredentialIsUsable(exec, { nativeHome }),
      ).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
        expect.objectContaining({
          env: expect.objectContaining({
            HOME: canonicalNativeHome,
            USERPROFILE: canonicalNativeHome,
          }),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('fails closed when the keychain lookup throws', () => {
    if (process.platform !== 'darwin') return;
    const exec = vi.fn(() => {
      throw new Error('SecKeychainSearchCopyNext: item not found');
    }) as unknown as typeof import('node:child_process').execFileSync;
    expect(agyKeychainCredentialIsUsable(exec)).toBe(false);
  });
});

describe('kimiCredentialsBlobIsUsable', () => {
  it('requires a live access token with a safe expiry window', () => {
    const now = 2_000_000_000;
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({
          access_token: '',
          refresh_token: '',
          expires_at: 0,
        }),
        now,
      ),
    ).toBe(false);
    expect(kimiCredentialsBlobIsUsable('{"kimi":1}', now)).toBe(false);
    // An expired access token WITH a refresh token is a live login: the CLI
    // refreshes on spawn. Treating it as logged out hid Kimi from the squad.
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({
          access_token: 'at-expired',
          refresh_token: 'rt-live',
          expires_at: now - 1,
        }),
        now,
      ),
    ).toBe(true);
    // Expired access token and no refresh token is still logged out.
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({
          access_token: 'at-expired',
          refresh_token: '',
          expires_at: now - 1,
        }),
        now,
      ),
    ).toBe(false);
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({
          access_token: '',
          refresh_token: 'rt-live',
          expires_at: now + 3_600,
        }),
        now,
      ),
    ).toBe(false);
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({
          access_token: 'at-nearly-expired',
          expires_at: now + 300,
        }),
        now,
      ),
    ).toBe(false);
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({
          access_token: 'at-live',
          expires_at: now + 301,
        }),
        now,
      ),
    ).toBe(true);
    expect(
      kimiCredentialsBlobIsUsable(
        JSON.stringify({
          access_token: 'at-live-ms',
          expires_at: (now + 3_600) * 1000,
        }),
        now,
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

  it('keeps AGY provider snapshots non-blocking and warms Keychain auth asynchronously', async () => {
    const home = tempHome();
    const model = 'gemini-3.6-flash-high';
    const asyncKeychainProbe = vi.fn(async () => true);

    expect(hasSubscriptionAuthForStatus('agy', model, home)).toBe(false);
    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe),
    ).resolves.toEqual({ value: true, cacheUpdated: true });
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(1);
    expect(hasSubscriptionAuthForStatus('agy', model, home)).toBe(true);

    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe),
    ).resolves.toEqual({ value: true, cacheUpdated: false });
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(1);
  });

  it('does not let a negative AGY status cache hide a login completed moments later', async () => {
    const home = tempHome();
    const asyncKeychainProbe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe),
    ).resolves.toEqual({ value: false, cacheUpdated: false });
    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe),
    ).resolves.toEqual({ value: true, cacheUpdated: true });
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(2);
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

  it('detects a managed AGY account via usable oauth_creds under GEMINI_CLI_HOME', () => {
    const home = tempHome();
    const geminiHome = tempHome();
    const prev = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = geminiHome;
    try {
      expect(
        detectSubscriptionAuth('agy', home, undefined, {
          probeAgyKeychain: false,
        }),
      ).toBe(false);
      // Install tree alone is not a live session.
      touch(geminiHome, 'antigravity');
      expect(
        detectSubscriptionAuth('agy', home, undefined, {
          probeAgyKeychain: false,
        }),
      ).toBe(false);
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
    expect(
      detectSubscriptionAuth('agy', home, undefined, {
        probeAgyKeychain: false,
      }),
    ).toBe(false);
  });

  it('detects AGY from the login keychain when ~/.gemini has no oauth files', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'google_accounts.json'),
      JSON.stringify({ active: null, old: ['user@example.com'] }),
    );
    // The antigravity CLI stores its session token in the keychain only.
    expect(
      detectSubscriptionAuth('agy', home, undefined, {
        agyKeychainProbe: () => true,
      }),
    ).toBe(true);
    expect(
      detectSubscriptionAuth('agy', home, undefined, {
        agyKeychainProbe: () => false,
      }),
    ).toBe(false);
    // Opt-out keeps a caller entirely off the Keychain path.
    expect(
      detectSubscriptionAuth('agy', home, undefined, {
        probeAgyKeychain: false,
        agyKeychainProbe: () => true,
      }),
    ).toBe(false);
  });

  it('uses native AGY keychain authority even when process HOME is isolated', () => {
    const isolatedHome = tempHome();
    expect(
      detectSubscriptionAuth('agy', isolatedHome, undefined, {
        agyKeychainProbe: () => true,
      }),
    ).toBe(true);
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
