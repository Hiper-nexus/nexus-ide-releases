import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGY_CREDENTIAL_MANAGER_TARGET,
  agyCredentialManagerHas,
  agyKeychainBlobIsUsable,
  agyKeychainCredentialIsUsable,
  agyKeychainCredentialIsUsableAsync,
  claudeCliAuthStatusLoggedInAsync,
  claudeCliAuthStatusLoggedInSync,
  claudeKeychainHas,
  claudeKeychainHasAsync,
  claudeOauthEmail,
  detectSubscriptionAuth,
  detectSubscriptionAuthReadiness,
  openclaudeCredentialsFileIsUsable,
  resetAgyKeychainCache,
  hasSubscriptionAuthForStatus,
  kimiCredentialsBlobIsUsable,
  refreshAgySubscriptionAuthCache,
  refreshClaudeSubscriptionAuthCache,
  refreshOpenClaudeSubscriptionAuthCache,
  subscriptionAuthStatusIsUnknown,
  resetSubscriptionAuthCacheForTests,
  resolveAuthStrategy,
  warmKeychainOnlySubscriptionAuth,
} from './subscription-auth';

const tempDirs: string[] = [];

beforeEach(() => {
  // Tests with an explicit fixture home exercise the default config paths.
  // Individual override tests can opt in without inheriting the test runner's.
  vi.stubEnv('OPENCLAUDE_CONFIG_DIR', '');
  vi.stubEnv('XDG_CONFIG_HOME', '');
  vi.stubEnv('MUSE_AUTH_PATH', '');
  vi.stubEnv('GROK_HOME', '');
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('KIMI_CODE_HOME', '');
});

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
  vi.unstubAllEnvs();
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

describe('agyCredentialManagerHas', () => {
  const asExecSync = (fn: () => string) =>
    fn as unknown as typeof import('node:child_process').execFileSync;

  it('aceita a linha Destino: do cmdkey em PT-BR', () => {
    if (process.platform !== 'win32') return;
    const exec = vi.fn(
      () =>
        `Credenciais atualmente armazenadas para ${AGY_CREDENTIAL_MANAGER_TARGET}:\r\n\r\n    Destino: ${AGY_CREDENTIAL_MANAGER_TARGET}\r\n    Tipo: Genérico\r\n`,
    );
    expect(agyCredentialManagerHas(asExecSync(exec))).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      'cmdkey',
      [`/list:${AGY_CREDENTIAL_MANAGER_TARGET}`],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('aceita Target: em Windows em inglês e rejeita ausência', () => {
    if (process.platform !== 'win32') return;
    const present = vi.fn(
      () => `Currently stored credentials for ${AGY_CREDENTIAL_MANAGER_TARGET}:\n\n    Target: ${AGY_CREDENTIAL_MANAGER_TARGET}\n`,
    );
    expect(agyCredentialManagerHas(asExecSync(present))).toBe(true);
    const missing = vi.fn(() => 'Currently stored credentials for x:\n\n* NONE *\n');
    expect(agyCredentialManagerHas(asExecSync(missing))).toBe(false);
  });

  it('falha fechado quando o cmdkey erra', () => {
    if (process.platform !== 'win32') return;
    const exec = vi.fn(() => {
      throw new Error('cmdkey indisponível');
    });
    expect(agyCredentialManagerHas(asExecSync(exec))).toBe(false);
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

  it('treats only the exact AGY Keychain item-not-found result as absence', async () => {
    if (process.platform !== 'darwin') return;
    const nativeHome = tempHome();
    const itemNotFound = Object.assign(new Error('item not found'), {
      code: 44,
      killed: false,
      signal: null,
    });
    const asyncExec = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        queueMicrotask(() => callback(itemNotFound, ''));
      },
    ) as unknown as typeof import('node:child_process').execFile;

    await expect(
      agyKeychainCredentialIsUsableAsync(asyncExec, {
        nativeHome,
        bypassCache: true,
      }),
    ).resolves.toBe(false);
  });

  it('rejects an unavailable AGY Keychain probe instead of reporting logout', async () => {
    if (process.platform !== 'darwin') return;
    const nativeHome = tempHome();
    const unavailable = Object.assign(new Error('probe timed out'), {
      code: 'ETIMEDOUT',
      killed: true,
      signal: 'SIGKILL',
    });
    const asyncExec = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        queueMicrotask(() => callback(unavailable, ''));
      },
    ) as unknown as typeof import('node:child_process').execFile;

    await expect(
      agyKeychainCredentialIsUsableAsync(asyncExec, {
        nativeHome,
        bypassCache: true,
      }),
    ).rejects.toThrow('AGY Keychain proof is unavailable');
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

  it('reconhece a sessão do Devin no TOML de credenciais', () => {
    // Sem este case o switch caía no default `false`, a estratégia virava
    // `login-needed` e o gate pré-spawn recusava todo spawn governado — a CLI
    // aparecia logada em Configurações e nunca sentava um pane.
    const xdg = tempHome();
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdg;
    try {
      expect(detectSubscriptionAuth('devin', tempHome())).toBe(false);
      touch(xdg, 'devin', 'credentials.toml');
      fs.writeFileSync(
        path.join(xdg, 'devin', 'credentials.toml'),
        'windsurf_api_key = "sessao-viva"\n',
      );
      expect(detectSubscriptionAuth('devin', tempHome())).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    }
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
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe, {
        winCredentialHas: () => false,
      }),
    ).resolves.toEqual({ value: true, cacheUpdated: true });
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(1);
    expect(hasSubscriptionAuthForStatus('agy', model, home)).toBe(true);

    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe, {
        winCredentialHas: () => false,
      }),
    ).resolves.toEqual({ value: true, cacheUpdated: false });
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(1);
  });

  it('no Windows, a sessao do Credential Manager vale sem chamar a sonda', async () => {
    if (process.platform !== 'win32') return;
    const home = tempHome();
    const asyncKeychainProbe = vi.fn(async () => true);
    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe, {
        authoritative: true,
        winCredentialHas: () => true,
      }),
    ).resolves.toEqual({ value: true, cacheUpdated: true });
    expect(asyncKeychainProbe).not.toHaveBeenCalled();
    expect(hasSubscriptionAuthForStatus('agy', 'gemini-3.6-flash-high', home)).toBe(true);
  });

  it('refreshes Claude status after login despite a recent negative cache entry', async () => {
    const home = tempHome();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await refreshClaudeSubscriptionAuthCache(home, probe);

    await expect(refreshClaudeSubscriptionAuthCache(home, probe)).resolves.toEqual({
      value: true,
      cacheUpdated: true,
    });
    expect(hasSubscriptionAuthForStatus('claude', undefined, home)).toBe(true);
  });

  it('devolve o blob do arquivo quando ele é a prova da sessão', async () => {
    const home = tempHome();
    const credential = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'file-access-after-login',
        refreshToken: 'file-refresh-after-login',
      },
    });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      credential,
    );
    const probe = vi.fn(async () => 'keychain-should-not-run');

    await expect(
      refreshClaudeSubscriptionAuthCache(home, probe, { authoritative: true }),
    ).resolves.toEqual({
      value: true,
      cacheUpdated: true,
      credential,
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns the slim Keychain credential only to Main for fingerprinting', async () => {
    const home = tempHome();
    const credential = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-after-login',
        refreshToken: 'refresh-after-login',
      },
    });

    await expect(
      refreshClaudeSubscriptionAuthCache(
        home,
        async () => credential,
        { authoritative: true },
      ),
    ).resolves.toEqual({
      value: true,
      cacheUpdated: true,
      credential,
    });
  });

  it('recognizes newly written credentials before the next background refresh', async () => {
    const home = tempHome();
    await refreshClaudeSubscriptionAuthCache(home, async () => false);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'test-after-login' },
    }));
    expect(hasSubscriptionAuthForStatus('claude', undefined, home)).toBe(true);
  });

  it('warms OpenClaude Keychain proof independently without freezing cold snapshots', async () => {
    const home = tempHome();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(hasSubscriptionAuthForStatus('openclaude', undefined, home)).toBe(false);
    await refreshOpenClaudeSubscriptionAuthCache(home, probe);
    await expect(refreshOpenClaudeSubscriptionAuthCache(home, probe))
      .resolves.toEqual({ value: true, cacheUpdated: true });
    expect(hasSubscriptionAuthForStatus('openclaude', undefined, home)).toBe(true);
    expect(hasSubscriptionAuthForStatus('claude', undefined, home)).toBe(false);
  });

  it('rechecks an explicit OpenClaude auth observation after logout', async () => {
    const home = tempHome();
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await refreshOpenClaudeSubscriptionAuthCache(home, probe);
    await expect(refreshOpenClaudeSubscriptionAuthCache(home, probe, { authoritative: true }))
      .resolves.toEqual({ value: false, cacheUpdated: true });
    expect(hasSubscriptionAuthForStatus('openclaude', undefined, home)).toBe(false);
  });

  it('does not report an unavailable Claude Keychain as a missing login', async () => {
    const home = tempHome();
    await expect(refreshClaudeSubscriptionAuthCache(home, async () => {
      throw new Error('Keychain unavailable');
    })).rejects.toThrow('Keychain unavailable');
    expect(subscriptionAuthStatusIsUnknown('claude', home)).toBe(process.platform === 'darwin');
  });

  it('resolves the Muse Keychain session instead of parking it on unverified', () => {
    const home = tempHome();
    const authFile = path.join(home, '.config', 'muse', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({ providers: { meta: {
      mechanism: 'oauth', storage: 'keychain',
    } } }));

    // Item presente = sessão provada. Antes ficava «não verificado» com a CLI
    // logada e operacional (regressão de campo 21/09).
    expect(
      detectSubscriptionAuth('muse', home, undefined, {
        museKeychainProbe: () => true,
      }),
    ).toBe(true);

    // Item ausente: o arquivo sozinho não prova nada — segue indeterminado,
    // porque o segredo está fora do alcance desta leitura.
    expect(
      detectSubscriptionAuth('muse', home, undefined, {
        museKeychainProbe: () => false,
      }),
    ).toBe(false);

    // Sem delegação declarada não há o que consultar no Keychain.
    fs.writeFileSync(authFile, JSON.stringify({ providers: { meta: { user_email: 'test@example.com' } } }));
    expect(subscriptionAuthStatusIsUnknown('muse', home)).toBe(false);
  });

  it('does not let a negative AGY status cache hide a login completed moments later', async () => {
    const home = tempHome();
    const asyncKeychainProbe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe, {
        winCredentialHas: () => false,
      }),
    ).resolves.toEqual({ value: false, cacheUpdated: false });
    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe, {
        winCredentialHas: () => false,
      }),
    ).resolves.toEqual({ value: true, cacheUpdated: true });
    expect(asyncKeychainProbe).toHaveBeenCalledTimes(2);
  });

  it('does not cache an unavailable authoritative AGY probe as logout', async () => {
    const home = tempHome();
    const asyncKeychainProbe = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('Keychain unavailable'))
      .mockResolvedValueOnce(true);

    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe, {
        authoritative: true,
        winCredentialHas: () => false,
      }),
    ).rejects.toThrow('AGY Keychain proof is unavailable');
    await expect(
      refreshAgySubscriptionAuthCache(home, asyncKeychainProbe, {
        authoritative: true,
        winCredentialHas: () => false,
      }),
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

  it('detects OpenClaude only with a usable ~/.openclaude credentials token', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.openclaude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaude.json'), '{"theme":"dark"}');
    expect(detectSubscriptionAuth('openclaude', home)).toBe(false);
    expect(openclaudeCredentialsFileIsUsable(home)).toBe(false);
    fs.writeFileSync(
      path.join(home, '.openclaude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '' } }),
    );
    expect(detectSubscriptionAuth('openclaude', home)).toBe(false);
    fs.writeFileSync(
      path.join(home, '.openclaude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'oc-live' } }),
    );
    expect(detectSubscriptionAuth('openclaude', home)).toBe(true);
    expect(openclaudeCredentialsFileIsUsable(home)).toBe(true);
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

  it('detects Cursor Agent from cli-config identity written at login', () => {
    const home = tempHome();
    expect(detectSubscriptionAuth('cursor-agent', home)).toBe(false);
    const config = path.join(home, '.cursor', 'cli-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ version: 1 }));
    expect(detectSubscriptionAuth('cursor-agent', home)).toBe(false);
    fs.writeFileSync(
      config,
      JSON.stringify({
        authInfo: { email: 'admin@volarehost.com.br', authId: 'acc_1' },
      }),
    );
    expect(detectSubscriptionAuth('cursor-agent', home)).toBe(true);
  });

  it('não ressuscita Gemini CLI a partir dos arquivos do AGY', () => {
    const home = tempHome();
    expect(
      detectSubscriptionAuth('gemini', home, undefined, {
        probeAgyKeychain: false,
      }),
    ).toBe(false);
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'google_accounts.json'),
      JSON.stringify({ active: 'retornoja@gmail.com', old: [] }),
    );
    expect(detectSubscriptionAuth('gemini', home)).toBe(false);
  });

  it('detects Muse Spark only when auth.json holds a live token', () => {
    const home = tempHome();
    const authFile = path.join(home, '.config', 'muse', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        schema_version: 1,
        providers: { meta: { access_token: '', user_email: 'a@b.c' } },
      }),
    );
    expect(detectSubscriptionAuth('muse', home)).toBe(false);
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        schema_version: 1,
        providers: {
          meta: { access_token: 'atok', user_email: 'a@b.c' },
        },
      }),
    );
    expect(detectSubscriptionAuth('muse', home)).toBe(true);
  });

  it('detects oh-my-pi from a populated agent env, not an empty shell', () => {
    const home = tempHome();
    const envFile = path.join(home, '.omp', 'agent', '.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, '# comment\nZAI_API_KEY=\n');
    expect(detectSubscriptionAuth('omp', home)).toBe(false);
    fs.writeFileSync(envFile, 'ZAI_API_KEY=sk-live\n');
    expect(detectSubscriptionAuth('omp', home)).toBe(true);
  });

  it('detects Qoder from a nonempty .auth/user blob', () => {
    const home = tempHome();
    const user = path.join(home, '.qoder', '.auth', 'user');
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, '');
    expect(detectSubscriptionAuth('qoder', home)).toBe(false);
    fs.writeFileSync(user, 'encrypted-session-blob');
    expect(detectSubscriptionAuth('qoder', home)).toBe(true);
  });

  it('detects Prime Agent from any provider access token in auth.json', () => {
    const home = tempHome();
    const authFile = path.join(home, '.prime', 'agent', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(
      authFile,
      JSON.stringify({ anthropic: { type: 'oauth', access: '' } }),
    );
    expect(detectSubscriptionAuth('prime-agent', home)).toBe(false);
    fs.writeFileSync(
      authFile,
      JSON.stringify({ anthropic: { type: 'oauth', access: 'atok' } }),
    );
    expect(detectSubscriptionAuth('prime-agent', home)).toBe(true);
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

describe('warmKeychainOnlySubscriptionAuth', () => {
  it('warms the AGY keychain session into the sync status cache consumed by mission gates', async () => {
    const asyncKeychainProbe = vi.fn(async () => true);

    // Cold cache: the status view fails closed (AGY 1.1 keeps its token only
    // in the login keychain; file probes never see it).
    expect(hasSubscriptionAuthForStatus('agy', undefined, tempHome())).toBe(
      false,
    );

    await warmKeychainOnlySubscriptionAuth('agy', asyncKeychainProbe);

    // The same sync view the squad-readiness gate consumes now sees reality.
    expect(hasSubscriptionAuthForStatus('agy')).toBe(true);
  });

  it('leaves file/token providers out of the keychain warm', async () => {
    const asyncKeychainProbe = vi.fn(async () => true);

    await warmKeychainOnlySubscriptionAuth('codex', asyncKeychainProbe);

    expect(asyncKeychainProbe).not.toHaveBeenCalled();
  });
});

describe('claude CLI auth-status attestation', () => {
  const BIN = '/Users/test/.local/bin/claude';
  type SyncExec = typeof import('node:child_process').execFileSync;
  type AsyncExec = typeof import('node:child_process').execFile;
  const syncOk = (out: string) =>
    vi.fn(() => out) as unknown as SyncExec;

  it('trusts a loggedIn:true attestation from the CLI itself', () => {
    const execImpl = vi.fn(() => JSON.stringify({ loggedIn: true }));
    expect(
      claudeCliAuthStatusLoggedInSync(execImpl as unknown as SyncExec, BIN),
    ).toBe(true);
    expect(execImpl).toHaveBeenCalledTimes(1);
    expect(execImpl).toHaveBeenCalledWith(
      BIN,
      ['auth', 'status'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('rejects loggedIn:false, non-JSON, and exec failures as silent false', () => {
    expect(
      claudeCliAuthStatusLoggedInSync(syncOk('{"loggedIn":false}'), BIN),
    ).toBe(false);
    expect(claudeCliAuthStatusLoggedInSync(syncOk('not-json'), BIN)).toBe(false);
    expect(
      claudeCliAuthStatusLoggedInSync(
        vi.fn(() => {
          throw new Error('ETIMEDOUT');
        }) as unknown as SyncExec,
        BIN,
      ),
    ).toBe(false);
  });

  it('never spawns when no claude binary resolves', () => {
    const execImpl = vi.fn(() => '{"loggedIn":true}');
    expect(
      claudeCliAuthStatusLoggedInSync(execImpl as unknown as SyncExec, null),
    ).toBe(false);
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('async variant resolves the attestation without throwing', async () => {
    const ok = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        queueMicrotask(() => callback(null, JSON.stringify({ loggedIn: true })));
        return {};
      },
    ) as unknown as AsyncExec;
    await expect(claudeCliAuthStatusLoggedInAsync(ok, BIN)).resolves.toBe(true);
    const failing = vi.fn(() => {
      throw new Error('spawn ENOENT');
    }) as unknown as AsyncExec;
    await expect(claudeCliAuthStatusLoggedInAsync(failing, BIN)).resolves.toBe(false);
    await expect(claudeCliAuthStatusLoggedInAsync(ok, null)).resolves.toBe(false);
  });
});

describe('detectSubscriptionAuthReadiness', () => {
  it('devolve um dos cinco estados do contrato', () => {
    expect([
      'present',
      'incomplete',
      'missing',
      'unreadable',
      'no-credential',
    ]).toContain(detectSubscriptionAuthReadiness('codex'));
    expect([
      'present',
      'incomplete',
      'missing',
      'unreadable',
      'no-credential',
    ]).toContain(detectSubscriptionAuthReadiness('kimi'));
  });
});
