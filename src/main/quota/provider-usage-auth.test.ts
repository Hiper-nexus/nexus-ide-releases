import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasCachedSecret: vi.fn<(key: string) => boolean>(),
  getSecret: vi.fn<(key: string) => string | null>(),
  getKey: vi.fn<(adapterId: string) => string | null>(),
  getAccount: vi.fn(),
  claudeOAuthAccessToken: vi.fn(),
  loadLauncherProviderKey: vi.fn(),
  nativeCredential: vi.fn(),
}));

vi.mock('../persistence/secrets-store', () => ({
  hasCachedSecret: mocks.hasCachedSecret,
  getSecret: mocks.getSecret,
  getKey: mocks.getKey,
}));

vi.mock('../persistence/account-store', () => ({
  getAccount: mocks.getAccount,
  // Regression sentinel: the former quota path called this account-store
  // helper, which can synchronously read/synchronise the native Keychain and
  // decrypt a cold vault entry.
  claudeOAuthAccessToken: mocks.claudeOAuthAccessToken,
}));

vi.mock('../adapters/launcher-provider-manager', () => ({
  loadLauncherProviderKey: mocks.loadLauncherProviderKey,
}));

vi.mock('../adapters/native-oauth-keychain', () => ({ readNativeOAuthCredential: mocks.nativeCredential }));

import {
  resolveClaudeToken, resolveCodexAuthCandidates, resolveProviderApiKeyCandidates,
  resolveGrokAccessTokenCandidates, resolveKimiAccessTokenCandidates,
  resolveKimiOauthCreds, resolveGeminiOauthCreds,
} from './provider-usage-auth';

const tempHomes: string[] = [];

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-quota-isolated-'));
  tempHomes.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
    'ZAI_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'LONGCAT_API_KEY', 'KIMI_MODEL_API_KEY',
    'KIMI_API_KEY', 'KIMI_CODING_API_KEY', 'MOONSHOT_API_KEY']) vi.stubEnv(key, '');
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
  it('resolves pinned vault account token directly', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });
    mocks.getSecret.mockImplementation((key) => {
      if (key === 'acctcred:claude-account') return credentialBlob('cached-account-token');
      return null;
    });

    expect(await resolveClaudeToken('claude-account')).toBe('cached-account-token');
    expect(mocks.getSecret).toHaveBeenCalledWith('acctcred:claude-account');
    expect(mocks.claudeOAuthAccessToken).not.toHaveBeenCalled();
  });

  it('fails closed on a missing account secret without entering Keychain', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });
    mocks.getSecret.mockReturnValue(null);

    expect(await resolveClaudeToken('cold-account')).toBeNull();
    expect(mocks.getSecret).toHaveBeenCalledWith('acctcred:cold-account');
    expect(mocks.claudeOAuthAccessToken).not.toHaveBeenCalled();
    expect(mocks.nativeCredential).not.toHaveBeenCalled();
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
});

describe('multi-account credential scoping', () => {
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
  it('never substitutes the system Codex session for a different pinned email, but adopts when email matches', () => {
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
    expect(resolveCodexAuthCandidates('matching-account')).toHaveLength(1);
    expect(resolveCodexAuthCandidates('matching-account')[0].accessToken).toBe('system-user');
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
