import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasCachedSecret: vi.fn<(key: string) => boolean>(),
  getSecret: vi.fn<(key: string) => string | null>(),
  getKey: vi.fn<(adapterId: string) => string | null>(),
  getAccount: vi.fn(),
  claudeOAuthAccessToken: vi.fn(),
  loadLauncherProviderKey: vi.fn(),
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

import { resolveClaudeToken } from './provider-usage-auth';

const tempHomes: string[] = [];

function credentialBlob(token: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('resolveClaudeToken boot safety', () => {
  it('uses only an already-decrypted account cache entry', () => {
    const calls: string[] = [];
    mocks.hasCachedSecret.mockImplementation((key) => {
      calls.push(`cached:${key}`);
      return true;
    });
    mocks.getSecret.mockImplementation((key) => {
      calls.push(`get:${key}`);
      return credentialBlob('cached-account-token');
    });
    mocks.claudeOAuthAccessToken.mockImplementation(() => {
      throw new Error('native Keychain/decrypt path must not run');
    });

    expect(resolveClaudeToken('claude-account')).toBe('cached-account-token');
    expect(calls).toEqual([
      'cached:acctcred:claude-account',
      'get:acctcred:claude-account',
    ]);
    expect(mocks.claudeOAuthAccessToken).not.toHaveBeenCalled();
    expect(mocks.getAccount).not.toHaveBeenCalled();
  });

  it('fails closed on a cold account cache without entering decryption or native sync', () => {
    mocks.hasCachedSecret.mockReturnValue(false);
    mocks.getSecret.mockImplementation(() => {
      throw new Error('cold vault decrypt must not run');
    });
    mocks.claudeOAuthAccessToken.mockImplementation(() => {
      throw new Error('native Keychain sync must not run');
    });

    expect(resolveClaudeToken('cold-account')).toBeNull();
    expect(mocks.hasCachedSecret).toHaveBeenCalledWith(
      'acctcred:cold-account',
    );
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.claudeOAuthAccessToken).not.toHaveBeenCalled();
    expect(mocks.getAccount).not.toHaveBeenCalled();
  });

  it('reads the unpinned token from ~/.claude/.credentials.json only', () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-claude-quota-auth-'),
    );
    tempHomes.push(home);
    const credentialFile = path.join(home, '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
    fs.writeFileSync(credentialFile, credentialBlob('file-token'), {
      mode: 0o600,
    });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    mocks.claudeOAuthAccessToken.mockImplementation(() => {
      throw new Error('native Keychain path must not run');
    });

    expect(resolveClaudeToken()).toBe('file-token');
    expect(mocks.hasCachedSecret).not.toHaveBeenCalled();
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.claudeOAuthAccessToken).not.toHaveBeenCalled();
    expect(mocks.getAccount).not.toHaveBeenCalled();
  });
});
