import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from './db';

const accountDeps = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  deleteFailures: new Set<string>(),
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
  deleteSecret: (key: string) => {
    if (accountDeps.deleteFailures.has(key)) {
      return { ok: false, error: 'vault unavailable' };
    }
    accountDeps.secrets.delete(key);
    return { ok: true };
  },
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
  getAccount,
  initAccountStore,
  isAccountStoreReadOnly,
  listAccounts,
  prepareAccountForSpawn,
  removeAccount,
  renameAccount,
  setCooldown,
} from './account-store';

function makeDb(): Db {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id             TEXT PRIMARY KEY,
      adapter_id     TEXT NOT NULL,
      label          TEXT NOT NULL,
      mode           TEXT NOT NULL,
      upstream       TEXT NOT NULL DEFAULT 'anthropic',
      email          TEXT,
      cooldown_until INTEGER,
      last_error     TEXT,
      active          INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL
    );
  `);
  return db as unknown as Db;
}

let openDb: Db | null = null;

describe('prepareAccountForSpawn', () => {
  beforeEach(() => {
    openDb = makeDb();
    initAccountStore(openDb);
    accountDeps.secrets.clear();
    accountDeps.deleteFailures.clear();
    accountDeps.writeActiveCredential.mockReset();
    accountDeps.writeActiveCredential.mockReturnValue(true);
    accountDeps.activeCredential = oauthCredential('claude-access');
  });

  afterEach(() => {
    try {
      openDb?.close();
    } catch {
      // A fail-closed test may close it before cleanup.
    }
    openDb = null;
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

  it('persists account metadata before returning success', () => {
    const account = addAccount({
      adapterId: 'claude',
      label: 'Durable account',
      mode: 'api-key',
      key: 'sk-durable',
    });

    const row = openDb!
      .prepare('SELECT label, active FROM accounts WHERE id = ?')
      .get(account.id) as { label: string; active: number };
    expect(row).toEqual({ label: 'Durable account', active: 1 });
  });

  it('fails closed without SQLite and does not create a memory-only account', () => {
    initAccountStore(null);

    expect(() =>
      addAccount({
        adapterId: 'claude',
        label: 'Memory only',
        mode: 'api-key',
        key: 'sk-memory',
      }),
    ).toThrow(/read-only.*SQLite.*unavailable/i);

    expect(isAccountStoreReadOnly()).toBe(true);
    expect(listAccounts()).toEqual([]);
    expect(accountDeps.secrets.size).toBe(0);
  });

  it('keeps the last durable account state when a write fails', () => {
    const account = addAccount({
      adapterId: 'claude',
      label: 'Original',
      mode: 'api-key',
      key: 'sk-original',
    });
    openDb!.close();
    openDb = null;

    expect(() => renameAccount(account.id, 'Memory-only rename')).toThrow(
      /failed to persist/i,
    );

    expect(isAccountStoreReadOnly()).toBe(true);
    expect(getAccount(account.id)?.label).toBe('Original');
  });

  it('does not publish an account or retain its secret when SQLite add fails', () => {
    openDb!.close();
    openDb = null;

    expect(() =>
      addAccount({
        adapterId: 'claude',
        label: 'Rejected add',
        mode: 'api-key',
        key: 'sk-rejected',
      }),
    ).toThrow(/failed to persist/i);

    expect(listAccounts()).toEqual([]);
    expect(accountDeps.secrets.size).toBe(0);
  });

  it('does not remove the cached durable account when deletion fails', () => {
    const account = addAccount({
      adapterId: 'claude',
      label: 'Keep account',
      mode: 'api-key',
      key: 'sk-keep',
    });
    openDb!.close();
    openDb = null;

    expect(() => removeAccount(account.id)).toThrow(/failed to persist/i);
    expect(getAccount(account.id)?.label).toBe('Keep account');
    expect(accountDeps.secrets.has(`acctkey:${account.id}`)).toBe(true);
  });

  it('does not remove SQLite metadata when credential deletion fails', () => {
    const account = addAccount({
      adapterId: 'claude',
      label: 'Credential must remain',
      mode: 'api-key',
      key: 'sk-keep',
    });
    accountDeps.deleteFailures.add(`acctkey:${account.id}`);

    expect(() => removeAccount(account.id)).toThrow(/vault unavailable/i);

    expect(getAccount(account.id)).toEqual(account);
    expect(
      openDb!.prepare('SELECT id FROM accounts WHERE id = ?').get(account.id),
    ).toEqual({ id: account.id });
    expect(accountDeps.secrets.get(`acctkey:${account.id}`)).toBe('sk-keep');
  });

  it('preserves already-hydrated account reads when reinitialized without SQLite', () => {
    const account = addAccount({
      adapterId: 'claude',
      label: 'Cached account',
      mode: 'api-key',
      key: 'sk-cached',
    });

    initAccountStore(null);

    expect(isAccountStoreReadOnly()).toBe(true);
    expect(getAccount(account.id)?.label).toBe('Cached account');
  });
});
