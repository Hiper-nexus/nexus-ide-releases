import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from './db';

const accountDeps = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  managedClaude: new Map<string, string>(),
  deleteFailures: new Set<string>(),
  activeEmail: 'operator@example.test' as string | null,
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

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

function codexCapture(
  email: string,
  accountId: string,
  accessToken: string,
) {
  return {
    blob: JSON.stringify({
      tokens: {
        id_token: jwt({ email, sub: `user-${email}` }),
        access_token: accessToken,
        refresh_token: `refresh-${accessToken}`,
        account_id: accountId,
      },
    }),
    email,
    authRelativePath: 'auth.json',
  };
}

function kimiCapture(userId: string, tokenId: string) {
  return {
    blob: JSON.stringify({
      access_token: jwt({ user_id: userId, sub: userId, token_id: tokenId }),
      refresh_token: jwt({
        user_id: userId,
        sub: userId,
        token_id: `refresh-${tokenId}`,
      }),
      expires_at: 4_102_444_800,
    }),
    authRelativePath: 'credentials/kimi-code.json',
  };
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
  activeClaudeEmail: () => accountDeps.activeEmail,
  CLAUDE_KEYCHAIN_SERVICE: 'Claude Code-credentials',
  invalidateClaudeCredentialCache: vi.fn(),
  readActiveClaudeCredential: () => accountDeps.activeCredential,
  readActiveClaudeCredentialSlim: () => accountDeps.activeCredential,
  slimClaudeCredentialBlob: (blob: string) => blob,
  claudeCredentialBlobIsUsable: (blob: string | null | undefined) =>
    Boolean(blob && blob.includes('accessToken')),
  writeActiveClaudeCredential: accountDeps.writeActiveCredential,
}));

const managedDeps = vi.hoisted(() => ({
  homes: new Map<string, string>(),
  materialize: vi.fn((adapterId: string, accountId: string, _blob: string) => {
    const home = `/tmp/managed/${adapterId}/${accountId}/home`;
    managedDeps.homes.set(`${adapterId}:${accountId}`, home);
    return home;
  }),
  capture: vi.fn(
    (_adapterId?: string): null | {
      blob: string;
      email?: string;
      authRelativePath: string;
    } => null,
  ),
}));

vi.mock('../adapters/managed-credentials', async () => {
  const actual = await vi.importActual<typeof import('../adapters/managed-credentials')>(
    '../adapters/managed-credentials',
  );
  return {
    ...actual,
    materializeManagedHome: (
      adapterId: Parameters<typeof actual.materializeManagedHome>[0],
      accountId: string,
      blob: string,
    ) => managedDeps.materialize(adapterId, accountId, blob),
    captureNativeAuth: (adapterId: string) => managedDeps.capture(adapterId),
    removeManagedHome: vi.fn(),
  };
});

vi.mock('../adapters/managed-claude-auth', () => ({
  hasManagedClaudeAuth: (id: string) => accountDeps.managedClaude.has(id),
  readManagedClaudeAuth: (id: string) => accountDeps.managedClaude.get(id) ?? null,
  readManagedClaudeAuthAsync: async (id: string) => accountDeps.managedClaude.get(id) ?? null,
  removeManagedClaudeAuth: (id: string) => accountDeps.managedClaude.delete(id),
  freshestClaudeCredential: (...blobs: Array<string | null>) => blobs.find(Boolean) ?? null,
  materializeManagedClaudeAuth: (id: string, blob: string, options?: { replace?: boolean }) => {
    if (!accountDeps.managedClaude.has(id) || options?.replace) accountDeps.managedClaude.set(id, blob);
    return { blob: accountDeps.managedClaude.get(id)!, directory: `/tmp/claude/${id}/auth`,
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${id}/auth` } };
  },
}));

import {
  addAccount,
  addActiveClaudeAccount,
  addActiveSessionAccount,
  adoptNativeAccountForFailover,
  getAccount,
  initAccountStore,
  isAccountStoreReadOnly,
  listAccounts,
  pickAvailableForFailover,
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
    accountDeps.managedClaude.clear();
    accountDeps.deleteFailures.clear();
    accountDeps.activeEmail = 'operator@example.test';
    accountDeps.writeActiveCredential.mockReset();
    accountDeps.writeActiveCredential.mockReturnValue(true);
    accountDeps.activeCredential = oauthCredential('claude-access');
    managedDeps.homes.clear();
    managedDeps.materialize.mockClear();
    managedDeps.capture.mockReset();
    managedDeps.capture.mockReturnValue(null);
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

  it.each([
    'claude',
    'codex',
    'grok',
    'kimi',
    'opencode',
    'openclaude',
    'aider',
    'glm',
    'glm-flash',
    'longcat',
  ])('keeps N API-key credentials independent for %s', (adapterId) => {
    const first = addAccount({
      adapterId,
      label: 'Conta A',
      mode: 'api-key',
      key: `key-${adapterId}-a`,
    });
    const second = addAccount({
      adapterId,
      label: 'Conta B',
      mode: 'api-key',
      key: `key-${adapterId}-b`,
    });

    expect(prepareAccountForSpawn(adapterId, first.id)).toMatchObject({
      ok: true,
      account: { id: first.id },
      apiKey: `key-${adapterId}-a`,
    });
    expect(prepareAccountForSpawn(adapterId, second.id)).toMatchObject({
      ok: true,
      account: { id: second.id },
      apiKey: `key-${adapterId}-b`,
    });
  });

  it('conta gerenciada recebe armazenamento renovável sem token fixo nem escrita no Keychain nativo', () => {
    const account = addActiveClaudeAccount('Claude Max');
    expect(account).not.toBeNull();
    expect(account?.email).toBe('operator@example.test');

    const result = prepareAccountForSpawn('claude', account!.id);

    expect(result).toMatchObject({ ok: true, account, apiKey: null,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${account!.id}/auth` } });
    expect(accountDeps.writeActiveCredential).not.toHaveBeenCalled();
  });

  it('HOME isolado mantém o mesmo diretório de autenticação renovável da conta', () => {
    const account = addActiveClaudeAccount('Claude Max');
    expect(account).not.toBeNull();

    const result = prepareAccountForSpawn('claude', account!.id, undefined, {
      isolatedHome: true,
    });

    expect(result).toMatchObject({
      ok: true,
      account,
      apiKey: null,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${account!.id}/auth` },
    });
    expect(accountDeps.writeActiveCredential).not.toHaveBeenCalled();
  });

  it('conta SECUNDÁRIA recebe perfil renovável sem trocar o slot nativo do keychain', () => {
    const account = addActiveClaudeAccount('Claude Max');
    expect(account).not.toBeNull();
    // O login nativo mudou para outra conta — a do vault vira secundária.
    accountDeps.activeEmail = 'someone-else@example.test';
    accountDeps.activeCredential = oauthCredential('other-native');

    const result = prepareAccountForSpawn('claude', account!.id);

    expect(result).toMatchObject({
      ok: true,
      account,
      apiKey: null,
      authEnv: {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${account!.id}/auth`,
      },
    });
    // Refresh token nunca sai do vault para o env do pane (ver claudeAuthEnvFromBlob).
    if (!result.ok) throw new Error('expected ok spawn preparation');
    expect(result.authEnv).not.toHaveProperty('CLAUDE_CODE_OAUTH_REFRESH_TOKEN');
    expect(result.authEnv).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(accountDeps.writeActiveCredential).not.toHaveBeenCalled();
  });

  it('keeps two concurrent pane preparations isolated to their selected accounts', () => {
    accountDeps.activeCredential = oauthCredential('oauth-personal');
    accountDeps.activeEmail = 'personal@example.test';
    const personal = addActiveClaudeAccount('Pessoal');
    accountDeps.activeCredential = oauthCredential('oauth-work');
    accountDeps.activeEmail = 'work@example.test';
    const work = addActiveClaudeAccount('Trabalho');
    // Contas distintas (e-mails distintos) permanecem entradas distintas —
    // o dedupe por e-mail do addActiveSessionAccount não pode colapsá-las.
    expect(work!.id).not.toBe(personal!.id);
    // Nenhuma das duas é o login nativo atual → ambas process-scoped.
    accountDeps.activeEmail = 'someone-else@example.test';
    accountDeps.activeCredential = oauthCredential('other-native');

    const personalSpawn = prepareAccountForSpawn('claude', personal!.id);
    const workSpawn = prepareAccountForSpawn('claude', work!.id);

    expect(personalSpawn).toMatchObject({
      ok: true,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${personal!.id}/auth` },
    });
    expect(workSpawn).toMatchObject({
      ok: true,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${work!.id}/auth` },
    });
    expect(accountDeps.managedClaude.get(personal!.id)).toBe(oauthCredential('oauth-personal'));
    expect(accountDeps.managedClaude.get(work!.id)).toBe(oauthCredential('oauth-work'));
    expect(accountDeps.writeActiveCredential).not.toHaveBeenCalled();
  });

  it('prepares Codex subscription accounts with managed CODEX_HOME', () => {
    managedDeps.capture.mockReturnValue({
      blob: JSON.stringify({
        tokens: {
          id_token: 'x',
          access_token: 'codex-a',
          refresh_token: 'r',
          account_id: '1',
        },
      }),
      email: 'codex@example.test',
      authRelativePath: 'auth.json',
    });
    const account = addActiveSessionAccount('codex', 'Codex Work');
    expect(account).not.toBeNull();
    expect(account?.email).toBe('codex@example.test');

    const result = prepareAccountForSpawn('codex', account!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authEnv.CODEX_HOME).toContain('codex');
    expect(result.authEnv.CODEX_HOME).toContain(account!.id);
    expect(managedDeps.materialize).toHaveBeenCalled();
  });

  it('keeps two Codex workspaces independent even when their email is the same', () => {
    const firstCapture = codexCapture(
      'codex@example.test',
      'chatgpt-workspace-a',
      'codex-access-a',
    );
    const secondCapture = codexCapture(
      'codex@example.test',
      'chatgpt-workspace-b',
      'codex-access-b',
    );
    managedDeps.capture
      .mockReturnValueOnce(firstCapture)
      .mockReturnValueOnce(secondCapture);

    const first = addActiveSessionAccount('codex', 'Codex A');
    const second = addActiveSessionAccount('codex', 'Codex B');

    expect(first && second).toBeTruthy();
    expect(second!.id).not.toBe(first!.id);
    expect(listAccounts('codex')).toHaveLength(2);

    const firstSpawn = prepareAccountForSpawn('codex', first!.id);
    const secondSpawn = prepareAccountForSpawn('codex', second!.id);
    expect(firstSpawn).toMatchObject({
      ok: true,
      authEnv: { CODEX_HOME: expect.stringContaining(first!.id) },
    });
    expect(secondSpawn).toMatchObject({
      ok: true,
      authEnv: { CODEX_HOME: expect.stringContaining(second!.id) },
    });
    expect(managedDeps.materialize).toHaveBeenCalledWith(
      'codex',
      first!.id,
      firstCapture.blob,
    );
    expect(managedDeps.materialize).toHaveBeenCalledWith(
      'codex',
      second!.id,
      secondCapture.blob,
    );
  });

  it('updates a rotated Codex credential with the same provider account id', () => {
    managedDeps.capture
      .mockReturnValueOnce(
        codexCapture('codex@example.test', 'chatgpt-workspace-a', 'old'),
      )
      .mockReturnValueOnce(
        codexCapture('codex@example.test', 'chatgpt-workspace-a', 'rotated'),
      );

    const first = addActiveSessionAccount('codex', 'Codex');
    const refreshed = addActiveSessionAccount('codex', 'Codex novamente');

    expect(refreshed!.id).toBe(first!.id);
    expect(listAccounts('codex')).toHaveLength(1);
  });

  it('dedupes token rotation but keeps distinct Kimi subjects without inventing email', () => {
    managedDeps.capture
      .mockReturnValueOnce(kimiCapture('kimi-user-a', 'old'))
      .mockReturnValueOnce(kimiCapture('kimi-user-a', 'rotated'))
      .mockReturnValueOnce(kimiCapture('kimi-user-b', 'other'));

    const first = addActiveSessionAccount('kimi', 'Kimi A');
    const refreshed = addActiveSessionAccount('kimi', 'Kimi A novamente');
    const second = addActiveSessionAccount('kimi', 'Kimi B');

    expect(refreshed!.id).toBe(first!.id);
    expect(second!.id).not.toBe(first!.id);
    expect(first!.email).toBeUndefined();
    expect(second!.email).toBeUndefined();
    expect(listAccounts('kimi')).toHaveLength(2);
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

describe('adoptNativeAccountForFailover (conta 1 morta → login nativo vivo)', () => {
  beforeEach(() => {
    openDb = makeDb();
    initAccountStore(openDb);
    accountDeps.secrets.clear();
    accountDeps.deleteFailures.clear();
    accountDeps.activeEmail = 'operator@example.test';
    accountDeps.activeCredential = oauthCredential('claude-access');
    accountDeps.writeActiveCredential.mockReset();
    accountDeps.writeActiveCredential.mockReturnValue(true);
    managedDeps.homes.clear();
    managedDeps.materialize.mockClear();
    managedDeps.capture.mockReset();
    managedDeps.capture.mockReturnValue(null);
  });

  afterEach(() => {
    initAccountStore(null);
    try {
      openDb?.close();
    } catch {
      // fail-closed tests may close the db
    }
    openDb = null;
  });

  it('não adota o Keychain quando ele é a mesma identidade que acabou', () => {
    const adm = addActiveClaudeAccount('adm');
    expect(adm).not.toBeNull();
    expect(adoptNativeAccountForFailover('claude', adm!.id)).toBeNull();
  });

  it('adota o login nativo de outro e-mail quando o vault não tem irmã', () => {
    accountDeps.activeEmail = 'adm@example.test';
    accountDeps.activeCredential = oauthCredential('adm-token');
    const adm = addActiveClaudeAccount('adm');
    expect(adm).not.toBeNull();

    accountDeps.activeEmail = 'pessoal@example.test';
    accountDeps.activeCredential = oauthCredential('pessoal-token');

    const adopted = adoptNativeAccountForFailover('claude', adm!.id);
    expect(adopted?.email).toBe('pessoal@example.test');
    expect(adopted?.id).not.toBe(adm!.id);
    expect(prepareAccountForSpawn('claude', adopted!.id).ok).toBe(true);
  });

  it('pick de failover prefere a irmã do vault com blob, não a casca', () => {
    accountDeps.activeEmail = 'adm@example.test';
    accountDeps.activeCredential = oauthCredential('adm-token');
    const adm = addActiveClaudeAccount('adm');
    accountDeps.activeEmail = 'pessoal@example.test';
    accountDeps.activeCredential = oauthCredential('pessoal-token');
    const pessoal = addActiveClaudeAccount('pessoal');
    expect(adm && pessoal).toBeTruthy();
    setCooldown(
      adm!.id,
      Date.now() + 15 * 60 * 1000,
      '401 OAuth access token has expired',
    );
    expect(pickAvailableForFailover('claude', adm!.id).account?.id).toBe(
      pessoal!.id,
    );
  });
});
