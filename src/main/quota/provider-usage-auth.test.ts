import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasCachedSecret: vi.fn<(key: string) => boolean>(),
  getSecret: vi.fn<(key: string) => string | null>(),
  setSecret: vi.fn<(key: string, value: string) => void>(),
  getKey: vi.fn<(adapterId: string) => string | null>(),
  getAccount: vi.fn(),
  claudeOAuthAccessToken: vi.fn(),
  loadLauncherProviderKey: vi.fn(),
  nativeCredential: vi.fn(),
  hasManagedClaudeAuth: vi.fn(() => false),
  readManagedClaudeAuthAsync: vi.fn(async () => null as string | null),
  fileSubscriptionAuthEnv: vi.fn(),
  getActiveAccount: vi.fn(),
  codexCliUsage: vi.fn(),
  verifiedNativeClaudeToken: vi.fn(async () => null as string | null),
  probeClaudeCredentialIdentity: vi.fn<() => Promise<'match' | 'mismatch' | 'auth-expired' | 'unavailable'>>(async () => 'match'),
}));

vi.mock('../persistence/secrets-store', () => ({
  hasCachedSecret: mocks.hasCachedSecret,
  getSecret: mocks.getSecret,
  setSecret: mocks.setSecret,
  getKey: mocks.getKey,
}));

vi.mock('../persistence/account-store', () => ({
  getAccount: mocks.getAccount,
  getActiveAccount: mocks.getActiveAccount,
  fileSubscriptionAuthEnv: mocks.fileSubscriptionAuthEnv,
  // Regression sentinel: the former quota path called this account-store
  // helper, which can synchronously read/synchronise the native Keychain and
  // decrypt a cold vault entry.
  claudeOAuthAccessToken: mocks.claudeOAuthAccessToken,
}));
vi.mock('./codex-cli-usage', () => ({ probeCodexCliUsage: mocks.codexCliUsage }));
vi.mock('./claude-native-account', () => ({
  resolveVerifiedNativeClaudeToken: mocks.verifiedNativeClaudeToken,
  probeClaudeCredentialIdentity: mocks.probeClaudeCredentialIdentity,
}));

vi.mock('../adapters/launcher-provider-manager', () => ({
  loadLauncherProviderKey: mocks.loadLauncherProviderKey,
}));

vi.mock('../adapters/native-oauth-keychain', () => ({ readNativeOAuthCredential: mocks.nativeCredential }));
vi.mock('../adapters/managed-claude-auth', () => ({
  hasManagedClaudeAuth: mocks.hasManagedClaudeAuth,
  readManagedClaudeAuthAsync: mocks.readManagedClaudeAuthAsync,
}));

import {
  fetchCodexAccountUsage, resolveClaudeToken, resolveCodexAuthCandidates, resolveProviderApiKeyCandidates,
  resolveGrokAccessTokenCandidates, resolveKimiAccessTokenCandidates,
  resolveKimiOauthCreds, resolveGeminiOauthCreds, persistKimiRotatedCreds,
  parseGeminiOauthBlob,
} from './provider-usage-auth';
import { discoveredModelStateFor, resetModelDiscoveryForTests } from '../adapters/model-discovery';

const tempHomes: string[] = [];

beforeEach(() => {
  mocks.probeClaudeCredentialIdentity.mockReset().mockResolvedValue('match');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-quota-isolated-'));
  tempHomes.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
    'ZAI_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'LONGCAT_API_KEY', 'KIMI_MODEL_API_KEY',
    'KIMI_API_KEY', 'KIMI_CODING_API_KEY', 'MOONSHOT_API_KEY', 'MINIMAX_API_KEY']) vi.stubEnv(key, '');
});

function credentialBlob(token: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('resolveClaudeToken boot safety', () => {
  it('does not expose a pinned OAuth token before the account-owned identity probe', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'first@example.test' });
    mocks.getSecret.mockReturnValue(credentialBlob('second-account-token'));
    mocks.probeClaudeCredentialIdentity.mockResolvedValue('mismatch');
    expect(await resolveClaudeToken('first-account')).toBeNull();
  });
  it('resolves pinned vault account token directly', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.getSecret.mockImplementation((key) => {
      if (key === 'acctcred:claude-account') return credentialBlob('cached-account-token');
      return null;
    });

    expect(await resolveClaudeToken('claude-account')).toBe('cached-account-token');
    expect(mocks.getSecret).toHaveBeenCalledWith('acctcred:claude-account');
    expect(mocks.claudeOAuthAccessToken).not.toHaveBeenCalled();
  });

  it('fails closed on a missing account secret without entering Keychain', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.getSecret.mockReturnValue(null);

    expect(await resolveClaudeToken('cold-account')).toBeNull();
    expect(mocks.getSecret).toHaveBeenCalledWith('acctcred:cold-account');
    expect(mocks.claudeOAuthAccessToken).not.toHaveBeenCalled();
    expect(mocks.nativeCredential).not.toHaveBeenCalled();
  });

  it('does not rotate a saved Claude refresh token from the quota resolver', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.getSecret.mockReturnValue(JSON.stringify({ claudeAiOauth: {
      accessToken: 'expired', refreshToken: 'refresh-only', expiresAt: 1,
    } }));
    expect(await resolveClaudeToken('saved-account')).toBeNull();
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.verifiedNativeClaudeToken).not.toHaveBeenCalled();
  });

  it('prefers the unpinned file-backed token without probing Keychain', async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-quota-claude-file-'),
    );
    tempHomes.push(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }),
    );

    expect(await resolveClaudeToken()).toBe('file-token');
    expect(mocks.nativeCredential).not.toHaveBeenCalled();
  });

  it('não renova nem regrava o arquivo nativo vencido: a CLI é dona do refresh', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-quota-claude-native-'));
    tempHomes.push(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const credPath = path.join(home, '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    const original = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stale-access',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 60_000,
      },
    });
    fs.writeFileSync(credPath, original);
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    expect(await resolveClaudeToken()).toBe('stale-access');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(credPath, 'utf8')).toBe(original);
  });
});

describe('multi-account credential scoping', () => {
  it('does not borrow the native Claude credential for an expired managed account', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.hasManagedClaudeAuth.mockReturnValue(true);
    mocks.readManagedClaudeAuthAsync.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: 'expired', expiresAt: 1 } }));
    mocks.verifiedNativeClaudeToken.mockResolvedValueOnce('verified-native');
    expect(await resolveClaudeToken('managed-owner')).toBeNull();
    expect(mocks.verifiedNativeClaudeToken).not.toHaveBeenCalled();
  });
  it('only runs the saved-account Codex CLI when a durable matching home was prepared', async () => {
    mocks.getAccount.mockReturnValue({ id: 'acct-a', adapterId: 'codex', mode: 'subscription' });
    mocks.getSecret.mockReturnValue('{"tokens":{"account_id":"a","access_token":"fixture"}}');
    mocks.fileSubscriptionAuthEnv.mockReturnValue({ CODEX_HOME: '/managed/codex/acct-a/home' });
    mocks.codexCliUsage.mockImplementation(async ({ authFile }) => authFile === '/managed/codex/acct-a/home/auth.json'
      ? { windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.6, source: 'provider-api', confidence: 'high' }] } : { windows: null });
    expect((await fetchCodexAccountUsage('acct-a')).windows?.[0].usedRatio).toBe(0.6);
    mocks.fileSubscriptionAuthEnv.mockReturnValue(null);
    expect((await fetchCodexAccountUsage('acct-a')).hint).toBe('no-credential');
    mocks.getAccount.mockReturnValue({ adapterId: 'codex', mode: 'api-key' });
    expect((await fetchCodexAccountUsage('acct-a')).hint).toBe('no-credential');
  });
  it('F-990 (PRV-03): a listagem do model/list da conta ATIVA vira a oferta do Codex; a de outra conta não', async () => {
    resetModelDiscoveryForTests();
    mocks.getAccount.mockReturnValue({ id: 'acct-a', adapterId: 'codex', mode: 'subscription' });
    mocks.getSecret.mockReturnValue('{"tokens":{"account_id":"a","access_token":"fixture"}}');
    mocks.fileSubscriptionAuthEnv.mockReturnValue({ CODEX_HOME: '/managed/codex/acct-a/home' });
    mocks.codexCliUsage.mockResolvedValue({
      windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.1, source: 'provider-api', confidence: 'high' }],
      models: { ids: ['x-sol', 'x-luna'], defaultModel: 'x-sol', effortsByModel: {}, hidden: [], upgrades: {} },
    });
    mocks.getActiveAccount.mockReturnValue({ id: 'acct-b' });
    await fetchCodexAccountUsage('acct-a');
    expect(discoveredModelStateFor('codex').status).toBe('absent');
    mocks.getActiveAccount.mockReturnValue({ id: 'acct-a' });
    await fetchCodexAccountUsage('acct-a');
    expect(discoveredModelStateFor('codex')).toEqual({
      status: 'ok', models: ['x-sol', 'x-luna'], lastGood: ['x-sol', 'x-luna'], defaultModel: 'x-sol',
    });
    resetModelDiscoveryForTests();
  });
  function writeAuth(home: string, relative: string, blob: string): void {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, blob);
  }

  function session(adapter: string, subject: string, token: string, day: number): string {
    return JSON.stringify(adapter === 'codex'
      ? { email: 'same@example.test', tokens: { access_token: token, account_id: subject }, last_refresh: `2026-09-${day}T00:00:00Z` }
      : { issuer: { email: 'same@example.test', user_id: subject, key: token, create_time: `2026-09-${day}T00:00:00Z` } });
  }

  it.each(['codex', 'grok'])('%s quota follows native renewal of the same saved identity', (adapterId) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-renewed-'));
    tempHomes.push(home); vi.spyOn(os, 'homedir').mockReturnValue(home);
    mocks.getAccount.mockReturnValue({ adapterId, email: 'same@example.test' });
    mocks.getSecret.mockImplementation((key) => key === 'acctcred:acct-a' ? session(adapterId, 'owner-a', 'old', 10) : null);
    writeAuth(home, `.${adapterId}/auth.json`, session(adapterId, 'owner-a', 'fresh', 21));
    const candidates = adapterId === 'codex'
      ? resolveCodexAuthCandidates('acct-a').map((auth) => auth.accessToken)
      : resolveGrokAccessTokenCandidates('acct-a');
    expect(candidates[0]).toBe('fresh');
  });

  it.each(['codex', 'grok'])('%s quota reads its refreshed managed credential without borrowing another native subject', (adapterId) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-managed-'));
    tempHomes.push(home); vi.spyOn(os, 'homedir').mockReturnValue(home);
    mocks.getAccount.mockReturnValue({ adapterId, email: 'same@example.test' });
    mocks.getSecret.mockImplementation((key) => key === 'acctcred:acct-a' ? session(adapterId, 'owner-a', 'old', 10) : null);
    writeAuth(home, `.${adapterId}/auth.json`, session(adapterId, 'owner-b', 'other-account', 21));
    writeAuth(home, `.nexus/managed-accounts/${adapterId}/acct-a/home/auth.json`, session(adapterId, 'owner-a', 'managed-fresh', 20));
    const candidates = adapterId === 'codex'
      ? resolveCodexAuthCandidates('acct-a').map((auth) => auth.accessToken)
      : resolveGrokAccessTokenCandidates('acct-a');
    expect(candidates[0]).toBe('managed-fresh');
    expect(candidates).not.toContain('other-account');
  });

  it('does not lend the native Codex session to an account with no identity or credential', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-no-identity-'));
    tempHomes.push(home); vi.spyOn(os, 'homedir').mockReturnValue(home);
    mocks.getAccount.mockReturnValue({ adapterId: 'codex' });
    mocks.getSecret.mockReturnValue(null);
    writeAuth(home, '.codex/auth.json', session('codex', 'owner-b', 'other-account', 21));
    expect(resolveCodexAuthCandidates('acct-a')).toEqual([]);
  });

  it('reads managed Claude auth without becoming a second refresh actor', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.hasManagedClaudeAuth.mockReturnValue(true);
    mocks.readManagedClaudeAuthAsync.mockResolvedValue(credentialBlob('scoped-token'));
    mocks.getSecret.mockReturnValue(credentialBlob('stale-vault-token'));
    expect(await resolveClaudeToken('managed-claude')).toBe('scoped-token');
    expect(mocks.readManagedClaudeAuthAsync).toHaveBeenCalledWith('managed-claude');
    expect(mocks.claudeOAuthAccessToken).not.toHaveBeenCalled();
  });
  it.each([
    ['glm', 'https://api.z.ai'],
    ['glm-flash', 'https://api.z.ai'],
    ['longcat', 'https://api.longcat.chat'],
  ])('reads declared environment auth token for %s matching %s only', (adapterId, matchingBaseUrl) => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'opaque-test-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com');
    expect(resolveProviderApiKeyCandidates(adapterId).length).toBe(0);
    vi.stubEnv('ANTHROPIC_BASE_URL', matchingBaseUrl);
    expect(resolveProviderApiKeyCandidates(adapterId)).toEqual(['opaque-test-token']);
  });
  it('reads MiniMax key from its vault or dedicated environment only', () => {
    vi.stubEnv('MINIMAX_API_KEY', 'minimax-subscription-key');
    expect(resolveProviderApiKeyCandidates('minimax-code')).toEqual(['minimax-subscription-key']);
    // The launcher `minimax` route stores the same Token Plan Subscription Key.
    mocks.getKey.mockImplementation((id) => id === 'minimax' ? 'vault-minimax-key' : null);
    mocks.loadLauncherProviderKey.mockImplementation((id: string) => id === 'minimax' ? 'launcher-minimax-key' : null);
    expect(resolveProviderApiKeyCandidates('minimax-code')).toEqual([
      'vault-minimax-key', 'launcher-minimax-key', 'minimax-subscription-key',
    ]);
    mocks.getKey.mockReset();
    mocks.loadLauncherProviderKey.mockReset();
    mocks.getAccount.mockReturnValue({ adapterId: 'minimax-code' });
    mocks.getSecret.mockReturnValue(null);
    expect(resolveProviderApiKeyCandidates('minimax-code', 'missing-account')).toEqual([]);
  });
  it('never substitutes the system Codex session for a missing pinned credential, even when email matches', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-quota-identity-'));
    tempHomes.push(home); vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ email: 'retornoja@gmail.com', tokens: { access_token: 'system-user', account_id: 'system-id' } }));
    mocks.getAccount.mockImplementation((id) => {
      if (id === 'different-account') return { adapterId: 'codex', email: 'other@example.com' };
      if (id === 'matching-account') return { adapterId: 'codex', email: 'retornoja@gmail.com' };
      return null;
    });
    mocks.getSecret.mockReturnValue(null);
    expect(resolveCodexAuthCandidates('different-account')).toEqual([]);
    expect(resolveCodexAuthCandidates('matching-account')).toEqual([]);
    expect(resolveCodexAuthCandidates()).toHaveLength(1);
  });

  it.each(['glm', 'glm-flash', 'longcat', 'grok', 'kimi', 'opencode'])('does not assign global % to a pinned %s account', (adapterId) => {
    mocks.getAccount.mockReturnValue({ adapterId });
    mocks.hasCachedSecret.mockReturnValue(false);
    mocks.loadLauncherProviderKey.mockReturnValue('global-other-account-key');
    expect(resolveProviderApiKeyCandidates(adapterId, 'missing-account-key')).toEqual([]);
  });

  it('keeps all OAuth account probes bound to the requested provider', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'wrong-provider' });
    mocks.hasCachedSecret.mockReturnValue(true);
    mocks.getSecret.mockReturnValue(JSON.stringify({ access_token: 'unrelated-token', refresh_token: 'unrelated-refresh' }));
    expect(await resolveClaudeToken('wrong-account')).toBeNull();
    expect(resolveGrokAccessTokenCandidates('wrong-account')).toEqual([]);
    expect(resolveKimiAccessTokenCandidates('wrong-account')).toEqual([]);
    expect(resolveKimiOauthCreds('wrong-account')).toBeNull();
    expect(resolveGeminiOauthCreds('wrong-account')).toBeNull();
  });
});

describe('persistKimiRotatedCreds', () => {
  it('reescreve o blob vault preservando campos extras (email, label)', () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'kimi' });
    mocks.hasCachedSecret.mockReturnValue(true);
    mocks.getSecret.mockReturnValue(
      JSON.stringify({
        access_token: 'old-at',
        refresh_token: 'old-rt',
        expires_at: 1,
        email: 'op@x.com',
      }),
    );
    persistKimiRotatedCreds('acct-1', {
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      expiresIn: 900,
    }, 1_000_000);
    expect(mocks.setSecret).toHaveBeenCalledWith(
      'acctcred:acct-1',
      expect.any(String),
    );
    const written = JSON.parse(mocks.setSecret.mock.calls[0][1]);
    expect(written.access_token).toBe('new-at');
    expect(written.refresh_token).toBe('new-rt');
    expect(written.expires_at).toBe(1900);
    expect(written.email).toBe('op@x.com');
  });

  it('não escreve nada em conta de outro provider', () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'grok' });
    persistKimiRotatedCreds('acct-9', { accessToken: 'x' });
    expect(mocks.setSecret).not.toHaveBeenCalled();
  });
});

describe('parseGeminiOauthBlob', () => {
  it('lê o arquivo plano e o blob do Gerenciador de Credenciais', () => {
    expect(parseGeminiOauthBlob(JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      expiry_date: 50,
    }))).toEqual({ accessToken: 'at', refreshToken: 'rt', expiryDate: 50 });
    expect(parseGeminiOauthBlob(JSON.stringify({
      token: {
        access_token: 'at2',
        refresh_token: 'rt2',
        expiry: '2026-09-21T12:00:00.000Z',
      },
    }))).toEqual({
      accessToken: 'at2',
      refreshToken: 'rt2',
      expiryDate: Date.parse('2026-09-21T12:00:00.000Z'),
    });
    expect(parseGeminiOauthBlob('não é json')).toBeNull();
  });
});
