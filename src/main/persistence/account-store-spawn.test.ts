import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountDeps = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  activeCredential: JSON.stringify({
    claudeAiOauth: {
      accessToken: 'claude-access',
      refreshToken: 'claude-refresh',
      scopes: ['user:profile', 'user:inference'],
    },
  }),
  writeActiveCredential: vi.fn(() => true),
}));

function oauthCredential(accessToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: `refresh-${accessToken}`,
      scopes: ['user:profile', 'user:inference'],
    },
  });
}

vi.mock('./secrets-store', () => ({
  deleteSecret: (key: string) => accountDeps.secrets.delete(key),
  getSecret: (key: string) => accountDeps.secrets.get(key) ?? null,
  hasSecret: (key: string) => accountDeps.secrets.has(key),
  setSecret: (key: string, value: string) => {
    accountDeps.secrets.set(key, value);
    return { ok: true };
  },
}));

vi.mock('../adapters/claude-credential', () => ({
  activeClaudeEmail: () => 'operator@example.test',
  readActiveClaudeCredential: () => accountDeps.activeCredential,
  writeActiveClaudeCredential: accountDeps.writeActiveCredential,
}));

import {
  addAccount,
  addActiveClaudeAccount,
  initAccountStore,
  prepareAccountForSpawn,
  setCooldown,
} from './account-store';

describe('prepareAccountForSpawn', () => {
  beforeEach(() => {
    initAccountStore(null);
    accountDeps.secrets.clear();
    accountDeps.writeActiveCredential.mockReset();
    accountDeps.writeActiveCredential.mockReturnValue(true);
    accountDeps.activeCredential = oauthCredential('claude-access');
  });

  it('rejects an account owned by another provider', () => {
    const account = addAccount({
      adapterId: 'codex',
      label: 'Codex pessoal',
      mode: 'api-key',
      key: 'sk-codex',
    });

    const result = prepareAccountForSpawn('claude', account.id);

    expect(result).toEqual({
      ok: false,
      error: 'selected account does not belong to this provider',
    });
  });

  it('rejects an account that is still cooling down', () => {
    const account = addAccount({
      adapterId: 'claude',
      label: 'Claude limite',
      mode: 'api-key',
      key: 'sk-ant-test',
    });
    setCooldown(account.id, 20_000, 'quota');

    const result = prepareAccountForSpawn('claude', account.id, 10_000);

    expect(result).toEqual({
      ok: false,
      error: 'selected account "Claude limite" is cooling down',
    });
  });

  it('rejects an api-key account without its own stored credential', () => {
    const account = addAccount({
      adapterId: 'claude',
      label: 'Sem key',
      mode: 'api-key',
    });

    const result = prepareAccountForSpawn('claude', account.id);

    expect(result).toEqual({
      ok: false,
      error: 'selected account "Sem key" has no stored API credential',
    });
  });

  it('returns the exact api key belonging to the selected account', () => {
    const account = addAccount({
      adapterId: 'claude',
      label: 'Claude key',
      mode: 'api-key',
      key: 'sk-selected',
    });

    const result = prepareAccountForSpawn('claude', account.id);

    expect(result).toEqual({
      ok: true,
      account,
      apiKey: 'sk-selected',
      authEnv: {},
    });
  });

  it('returns process-scoped OAuth without swapping the global keychain slot', () => {
    const account = addActiveClaudeAccount('Claude Max');
    expect(account).not.toBeNull();

    const result = prepareAccountForSpawn('claude', account!.id);

    expect(result).toMatchObject({
      ok: true,
      account,
      apiKey: null,
      authEnv: {
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-access',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-claude-access',
        CLAUDE_CODE_OAUTH_SCOPES: 'user:profile user:inference',
      },
    });
    expect(accountDeps.writeActiveCredential).not.toHaveBeenCalled();
  });

  it('keeps two concurrent pane preparations isolated to their selected accounts', () => {
    accountDeps.activeCredential = oauthCredential('oauth-personal');
    const personal = addActiveClaudeAccount('Pessoal');
    accountDeps.activeCredential = oauthCredential('oauth-work');
    const work = addActiveClaudeAccount('Trabalho');

    const personalSpawn = prepareAccountForSpawn('claude', personal!.id);
    const workSpawn = prepareAccountForSpawn('claude', work!.id);

    expect(personalSpawn).toMatchObject({
      ok: true,
      authEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-personal' },
    });
    expect(workSpawn).toMatchObject({
      ok: true,
      authEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-work' },
    });
    expect(accountDeps.writeActiveCredential).not.toHaveBeenCalled();
  });
});
