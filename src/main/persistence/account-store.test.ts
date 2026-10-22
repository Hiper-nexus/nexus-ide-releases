import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from './db';

/**
 * Read-back Keychain nativo → vault para a linhagem Claude (NEXUS-UI-BUGS-001 §1).
 * O CLI real rotaciona o refresh_token sozinho na entrada "Claude Code-credentials"
 * do Keychain; sem read-back o snapshot do vault apodrece e a troca de conta
 * ("Usar") reinstala credencial morta por cima da sessão viva — a perda de login
 * no meio da sessão. Estes testes cobrem o espelhamento do padrão file-backed
 * (readBackFresherAuth) para o caminho Claude e o novo contrato de env dos panes
 * pinados (sem CLAUDE_CODE_OAUTH_REFRESH_TOKEN — terceiro ator da corrida de
 * rotação eliminado; recuperação via cooldown 'auth' do limit-detector + respawn
 * do failover, que re-materializa env fresca do vault).
 */

const deps = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  /** Log ordenado cross-module: `setSecret:<key>` / `keychainWrite`. */
  calls: [] as string[],
  /** Blobs escritos no Keychain nativo, em ordem. */
  keychainWrites: [] as string[],
  cachedSecrets: new Set<string>(),
  failSecretWrites: false,
  activeEmail: null as string | null | undefined,
  serverEmail: null as string | null,
  keychain: null as string | null,
  managedProfiles: new Map<string, string>(),
  /** Escopos cujo item de Keychain existe mas a leitura foi negada/travada. */
  lockedScopes: new Set<string>(),
  failManagedMaterialize: false,
  needsRefresh: vi.fn(
    (_blob: string, _now: number): { refreshToken: string } | null => null,
  ),
  refreshBlob: vi.fn(
    async (_blob: string, _now: number): Promise<string | null> => null,
  ),
  probeClaudeIdentity: vi.fn(
    async (_blob: string | null, _email: string | undefined) =>
      'match' as 'match' | 'mismatch' | 'auth-expired' | 'unavailable',
  ),
  resolveClaudeProfile: vi.fn(async (): Promise<{ email: string; accountUuid: string } | null> => null),
  /** Run da CLI no escopo gerenciado (F-639): o teste decide se ela renovou. */
  probeClaudeCliUsage: vi.fn(async (_opts?: { env?: Record<string, string> }) => ({ windows: null })),
}));

function oauthBlob(accessToken: string, expiresAt?: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: `refresh-${accessToken}`,
      scopes: ['user:profile', 'user:inference'],
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  });
}

function expiresAtOf(blob: string): number {
  try {
    const value = JSON.parse(blob)?.claudeAiOauth?.expiresAt;
    return typeof value === 'number' ? value : 0;
  } catch {
    return 0;
  }
}

vi.mock('./secrets-store', () => ({
  deleteSecret: (key: string) => {
    deps.secrets.delete(key);
    deps.cachedSecrets.delete(key);
    return { ok: true };
  },
  getSecret: (key: string) => {
    const value = deps.secrets.get(key) ?? null;
    if (value !== null) deps.cachedSecrets.add(key);
    return value;
  },
  hasCachedSecret: (key: string) => deps.cachedSecrets.has(key),
  hasSecret: (key: string) => deps.secrets.has(key),
  setSecret: (key: string, value: string) => {
    deps.calls.push(`setSecret:${key}`);
    if (deps.failSecretWrites) {
      return { ok: false, error: 'vault indisponível' };
    }
    deps.secrets.set(key, value);
    deps.cachedSecrets.add(key);
    return { ok: true };
  },
}));

vi.mock('../adapters/claude-credential', () => ({
  activeClaudeEmail: () => deps.activeEmail,
  CLAUDE_KEYCHAIN_SERVICE: 'Claude Code-credentials',
  invalidateClaudeCredentialCache: vi.fn(),
  readActiveClaudeCredential: () => deps.keychain,
  readActiveClaudeCredentialSlim: () => deps.keychain,
  slimClaudeCredentialBlob: (blob: string) => blob,
  claudeCredentialBlobIsUsable: (blob: string | null | undefined) =>
    Boolean(blob && String(blob).includes('accessToken')),
  writeActiveClaudeCredential: (blob: string) => {
    deps.calls.push('keychainWrite');
    deps.keychainWrites.push(blob);
    deps.keychain = blob;
    return true;
  },
}));

vi.mock('../quota/claude-oauth-refresh', async () => {
  // Lógica pura do helper de vivacidade é real (testada no próprio módulo);
  // só o refresh de rede fica sob controle do teste.
  const actual = await vi.importActual<
    typeof import('../quota/claude-oauth-refresh')
  >('../quota/claude-oauth-refresh');
  return {
    claudeBlobIsExpiredUnhealable: actual.claudeBlobIsExpiredUnhealable,
    claudeBlobIsRenewable: actual.claudeBlobIsRenewable,
    claudeAccessTokenExpired: actual.claudeAccessTokenExpired,
    claudeBlobNeedsRefresh: (blob: string, now: number) =>
      deps.needsRefresh(blob, now),
    forceRefreshClaudeOauthBlob: (blob: string, now: number) =>
      deps.refreshBlob(blob, now),
    refreshClaudeOauthBlob: (blob: string, now: number) =>
      deps.refreshBlob(blob, now),
  };
});

const agyKeyring = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock('../adapters/agy-windows-keyring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/agy-windows-keyring')>();
  return {
    ...actual,
    invalidateAgyWindowsKeyringCache: (...args: []) => {
      agyKeyring.invalidate(...args);
      actual.invalidateAgyWindowsKeyringCache(...args);
    },
  };
});

vi.mock('../adapters/managed-credentials', async () => {
  const actual = await vi.importActual<typeof import('../adapters/managed-credentials')>(
    '../adapters/managed-credentials',
  );
  return {
    ...actual,
    materializeManagedHome: vi.fn(() => '/tmp/managed/test'),
    captureNativeAuth: vi.fn(() => null),
    // F-1580: a real lê ~/.gemini da máquina de quem roda o teste.
    agyWindowsUnreadableSessionReason: vi.fn(() => null),
    removeManagedHome: vi.fn(),
  };
});

vi.mock('../quota/claude-oauth-usage', () => ({
  managedClaudeCliEnv: (directory: string) => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: directory }),
  probeClaudeCliUsage: deps.probeClaudeCliUsage,
}));

vi.mock('../adapters/managed-claude-auth', () => ({
  CLAUDE_MANAGED_AUTH_ENV: 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  managedClaudeAuthDirectory: (id: string) => `/tmp/claude/${id}/auth`,
  hasManagedClaudeAuth: (id: string) => deps.managedProfiles.has(id),
  managedClaudeAuthHasCredential: (id: string) => Boolean(deps.managedProfiles.get(id)),
  managedClaudeScopeKeychainReadable: async (id: string) => !deps.lockedScopes.has(id),
  readManagedClaudeAuth: (id: string) => deps.managedProfiles.get(id) || null,
  readManagedClaudeAuthAsync: async (id: string) => deps.managedProfiles.get(id) || null,
  removeManagedClaudeAuth: (id: string) => deps.managedProfiles.delete(id),
  // Mesma regra da produção: maior expiresAt vence, empate fica com o primeiro.
  freshestClaudeCredential: (...blobs: Array<string | null>) => blobs.reduce<string | null>(
    (best, blob) => blob && (!best || expiresAtOf(blob) > expiresAtOf(best)) ? blob : best, null),
  materializeManagedClaudeAuth: (id: string, blob: string, options?: { replace?: boolean }) => {
    if (deps.failManagedMaterialize) throw new Error('managed Claude store unavailable');
    if (!deps.managedProfiles.has(id) || options?.replace) deps.managedProfiles.set(id, blob);
    return { blob: deps.managedProfiles.get(id)!, directory: `/tmp/claude/${id}/auth`,
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${id}/auth` } };
  },
}));

vi.mock('../quota/claude-native-account', () => ({
  probeClaudeCredentialIdentity: deps.probeClaudeIdentity,
  resolveClaudeCredentialProfile: deps.resolveClaudeProfile,
}));

import {
  accountHasFailoverCredential,
  activateAccount,
  activeClaudeAuthEnv,
  addActiveSessionAccount,
  addAccount,
  addActiveSessionAccountAuthoritative,
  clearClaudeRefreshFailure,
  clearRefutedAuthCooldown,
  CLAUDE_REFRESH_FAILURE_SKIP_MS,
  ensureFreshClaudeSubscription,
  ensureSubscriptionActive,
  hasRecentClaudeRefreshFailure,
  initAccountStore,
  isAuthCooldownReason,
  listAccounts,
  listAccountInfos,
  onAccountsChange,
  prepareAccountForSpawn,
  prepareAgyNativeLogin,
  removeAccount,
  restoreAgyNativeLogin,
  setCooldown,
  startClaudeSubscriptionFreshness,
  verifyManagedClaudeAccountForSpawn,
} from './account-store';
import {
  AGY_WINDOWS_LEFTOVER_SESSION_REASON,
  agyWindowsUnreadableSessionReason,
  captureNativeAuth,
} from '../adapters/managed-credentials';
import type { Account } from '../../shared/account-types';

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

/** Cria uma conta Claude de assinatura como se fosse a sessão nativa do momento. */
function addClaudeAccount(label: string, email: string, blob: string): Account {
  deps.activeEmail = email;
  deps.keychain = blob;
  const account = addActiveSessionAccount('claude', label);
  expect(account).not.toBeNull();
  return account!;
}

beforeEach(() => {
  openDb = makeDb();
  initAccountStore(openDb);
  deps.secrets.clear();
  deps.cachedSecrets.clear();
  deps.failSecretWrites = false;
  deps.calls.length = 0;
  deps.keychainWrites.length = 0;
  deps.activeEmail = null;
  deps.serverEmail = null;
  deps.keychain = null;
  deps.managedProfiles.clear();
  deps.lockedScopes.clear();
  deps.failManagedMaterialize = false;
  deps.needsRefresh.mockReset();
  deps.needsRefresh.mockReturnValue(null);
  deps.refreshBlob.mockReset();
  deps.refreshBlob.mockResolvedValue(null);
  deps.probeClaudeIdentity.mockReset();
  deps.probeClaudeIdentity.mockResolvedValue('match');
  deps.probeClaudeCliUsage.mockReset();
  deps.probeClaudeCliUsage.mockResolvedValue({ windows: null });
  deps.resolveClaudeProfile.mockReset();
  deps.resolveClaudeProfile.mockImplementation(async () => {
    const email = deps.serverEmail ?? deps.activeEmail;
    return email ? { email, accountUuid: 'test-account-uuid' } : null;
  });
});

afterEach(() => {
  initAccountStore(null);
  try {
    openDb?.close();
  } catch {
    // DB já fechado pelo próprio teste.
  }
  openDb = null;
});

describe('Muse API account persistence', () => {
  it('reads a saved Meta API account back after registry reload and prepares that exact key', () => {
    const account = addAccount({ adapterId: 'muse', label: 'Meta API', mode: 'api-key', key: 'synthetic-meta-key' });
    expect(deps.secrets.get(`acctkey:${account.id}`)).toBe('synthetic-meta-key');
    initAccountStore(openDb);
    expect(listAccountInfos().find((entry) => entry.id === account.id)).toMatchObject({ hasCredential: true, active: true });
    expect(prepareAccountForSpawn('muse', account.id)).toMatchObject({ ok: true, apiKey: 'synthetic-meta-key' });
    expect(deps.keychainWrites).toEqual([]);
  });

  it('does not create a Muse account or report saved when the vault refuses persistence', () => {
    deps.failSecretWrites = true;
    expect(() => addAccount({ adapterId: 'muse', label: 'Meta API', mode: 'api-key', key: 'synthetic-meta-key' })).toThrow('vault indisponível');
    expect(listAccounts('muse')).toEqual([]);
    expect(deps.secrets.size).toBe(0);
  });
});

describe('read-back Keychain → vault (linhagem Claude nativa)', () => {
  it('prepara perfil renovável por conta e persiste a renovação da CLI sem outro refresh HTTP', async () => {
    const account = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-old'));
    deps.activeEmail = 'native@example.test';
    deps.keychain = oauthBlob('native');
    const prepared = prepareAccountForSpawn('claude', account.id);
    expect(prepared).toMatchObject({ ok: true, authEnv: {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${account.id}/auth`,
    } });
    if (!prepared.ok) throw new Error('spawn must be prepared');
    expect(prepared.authEnv).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    deps.managedProfiles.set(account.id, oauthBlob('b-renewed-by-cli'));
    deps.needsRefresh.mockReturnValue({ refreshToken: 'old' });
    await ensureFreshClaudeSubscription(account.id);
    expect(deps.secrets.get(`acctcred:${account.id}`)).toBe(oauthBlob('b-renewed-by-cli'));
    expect(deps.refreshBlob).not.toHaveBeenCalled();
  });

  it('read-back assíncrono não recria a credencial de uma conta removida', async () => {
    const account = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('old'));
    prepareAccountForSpawn('claude', account.id);
    deps.managedProfiles.set(account.id, oauthBlob('new'));
    const pending = ensureFreshClaudeSubscription(account.id);
    removeAccount(account.id);
    await pending;
    expect(deps.secrets.has(`acctcred:${account.id}`)).toBe(false);
  });
  it('read-back gerenciado não reescreve o cofre quando a credencial existe mas o decrypt falhou', async () => {
    const account = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('old'));
    prepareAccountForSpawn('claude', account.id);
    deps.managedProfiles.set(account.id, oauthBlob('renewed'));
    deps.secrets.set(`acctcred:${account.id}`, null as unknown as string);
    deps.calls.length = 0;
    await ensureFreshClaudeSubscription(account.id);
    expect(deps.calls).not.toContain(`setSecret:acctcred:${account.id}`);
  });
  it('seleciona B e volta a A sem substituir o login nativo nem perder snapshots', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-live'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-live'));
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('a-live');

    expect(activateAccount(b.id)).toBe(true);
    expect(deps.keychain).toBe(oauthBlob('a-live'));
    expect(prepareAccountForSpawn('claude', b.id)).toMatchObject({
      ok: true,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${b.id}/auth` },
    });
    expect(activateAccount(a.id)).toBe(true);
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-live'));
    expect(deps.secrets.get(`acctcred:${b.id}`)).toBe(oauthBlob('b-live'));
    expect(deps.keychainWrites).toEqual([]);
  });

  it('token conhecido de B vence e-mail antigo de A ao preparar e consultar A', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-live'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-live'));
    // Estado que uma versão antiga deixava ao trocar só o Keychain.
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('b-live');

    expect(prepareAccountForSpawn('claude', a.id, undefined, { isolatedHome: true }))
      .toMatchObject({ ok: true, authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${a.id}/auth` } });
    expect(prepareAccountForSpawn('claude', a.id))
      .toMatchObject({ ok: true, authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${a.id}/auth` } });
    expect(deps.managedProfiles.get(a.id)).toBe(oauthBlob('a-live'));
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-live'));
    expect(deps.secrets.get(`acctcred:${b.id}`)).toBe(oauthBlob('b-live'));
  });

  it('does not save a native Keychain token into a misbound vault row without profile proof', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-original'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-original'));
    const poisoned = oauthBlob('b-poisoned');
    const rotated = JSON.stringify({ claudeAiOauth: {
      accessToken: 'b-rotated', refreshToken: 'refresh-b-poisoned',
      scopes: ['user:profile', 'user:inference'],
    } });
    deps.secrets.set(`acctcred:${a.id}`, poisoned);
    deps.activeEmail = 'a@example.test';
    deps.keychain = rotated;
    deps.calls.length = 0;

    expect(activateAccount(b.id)).toBe(true);
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(poisoned);
    expect(deps.calls).not.toContain(`setSecret:acctcred:${a.id}`);
  });

  it('salvar B com e-mail antigo de A atualiza somente o snapshot que possui o token', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-live'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-live'));
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('b-live');

    const captured = addActiveSessionAccount('claude', 'reautenticada');
    expect(captured?.id).toBe(b.id);
    expect(captured?.email).toBe('b@example.test');
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-live'));
  });

  it('persiste a renovação nativa só depois de confirmar o perfil mesmo com metadado antigo', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-live'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-live'));
    const renewed = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'b-renewed', refreshToken: 'refresh-b-live',
        scopes: ['user:profile', 'user:inference'],
      },
    });
    deps.activeEmail = 'a@example.test';
    deps.keychain = renewed;

    expect(await verifyManagedClaudeAccountForSpawn(b.id)).toBe('match');
    expect(deps.keychain).toBe(renewed);
    expect(deps.secrets.get(`acctcred:${b.id}`)).toBe(renewed);
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-live'));
  });

  it('activateAccount preserva o refresh nativo sem copiar um token não verificado', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-live'));
    // O snapshot de A no vault apodreceu; o CLI rotacionou o Keychain sozinho.
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('a-stale'));
    deps.activeEmail = 'a@example.test'; // A é o login nativo atual
    deps.keychain = oauthBlob('a-fresh-rotated');
    deps.calls.length = 0;

    expect(activateAccount(b.id)).toBe(true);

    // A seleção não grava uma identidade inferida só por metadados locais.
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-stale'));
    expect(deps.keychain).toBe(oauthBlob('a-fresh-rotated'));
    expect(deps.keychainWrites).toEqual([]);
    expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('match');
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-fresh-rotated'));
  });

  it('decrypt que falhou com a chave presente NÃO força reescrita no Keychain', () => {
    // Cenário do modal "Chaves Não Encontradas": o vault TEM a chave, mas o
    // decrypt devolve null porque o Keychain está capenga neste instante. A
    // igualdade estrita `null === blob` falhava e o sync insistia num
    // setSecret → encryptString → SecItemAdd — exatamente o que levanta o modal
    // do macOS com o botão que apaga o keychain.
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('a-live');
    // Chave presente no índice, valor ilegível (decrypt falhou).
    deps.secrets.set(`acctcred:${a.id}`, null as unknown as string);
    deps.calls.length = 0;

    ensureSubscriptionActive(a);

    expect(deps.calls).not.toContain(`setSecret:acctcred:${a.id}`);
    // O snapshot (ilegível agora) fica até um read-back conseguir confirmar.
    expect(deps.secrets.has(`acctcred:${a.id}`)).toBe(true);
  });

  it('ensureSubscriptionActive não escreve no Keychain Claude sem prova assíncrona', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('a-stale'));
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('a-fresh-rotated');
    deps.calls.length = 0;

    expect(ensureSubscriptionActive(a)).toBe(false);
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-stale'));
    expect(deps.keychainWrites).toEqual([]);
    expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('match');
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-fresh-rotated'));
    expect(deps.keychainWrites).toEqual([]);
  });

  it('Keychain ilegível é fail-safe: não quebra o activate e preserva o snapshot do vault', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-live'));
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('a-stale'));
    deps.activeEmail = 'a@example.test';
    deps.keychain = null; // Keychain bloqueado / entrada ausente
    deps.calls.length = 0;

    expect(activateAccount(b.id)).toBe(true);

    // Nada de gravar leitura falha por cima do snapshot: vault de A intacto…
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-stale'));
    expect(deps.calls).not.toContain(`setSecret:acctcred:${a.id}`);
    // B continua selecionável usando seu snapshot; nenhum login global é escrito.
    expect(deps.keychainWrites).toEqual([]);
  });

  it('sweeper não faz read-back implícito da conta nativa', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('a-stale'));
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('a-fresh-rotated');

    const stop = startClaudeSubscriptionFreshness(60_000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      // O sweeper nunca consulta/escreve a linhagem nativa. O read-back fica
      // restrito aos fluxos explícitos de ativação/spawn.
      expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(
        oauthBlob('a-stale'),
      );
      expect(deps.needsRefresh).not.toHaveBeenCalled();
      expect(deps.refreshBlob).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('cold boot ignora credencial ainda não desbloqueada no cache', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    deps.cachedSecrets.delete(`acctcred:${a.id}`);
    deps.activeEmail = 'someone-else@example.test';
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-a-old' });

    const stop = startClaudeSubscriptionFreshness(60_000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deps.needsRefresh).not.toHaveBeenCalled();
      expect(deps.refreshBlob).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('sweeper continua renovando conta SECUNDÁRIA (read-back não atrapalha o refresh)', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    deps.activeEmail = 'someone-else@example.test'; // A virou secundária
    const renewed = oauthBlob('a-renewed');
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-a-old' });
    deps.refreshBlob.mockResolvedValue(renewed);

    const stop = startClaudeSubscriptionFreshness(60_000);
    try {
      await vi.waitFor(() => {
        expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(renewed);
      });
    } finally {
      stop();
    }
  });
});

describe('addActiveSessionAccount não duplica o mesmo assinante', () => {
  it('targeted Claude re-login uses live provider proof even when another row holds its token', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-old'));
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('b-new'));
    deps.activeEmail = 'a@example.test'; // stale local metadata
    deps.serverEmail = 'b@example.test';
    deps.keychain = oauthBlob('b-new');

    const saved = await addActiveSessionAccountAuthoritative('claude', 'Conta B', b.id);

    expect(saved?.id).toBe(b.id);
    expect(deps.secrets.get(`acctcred:${b.id}`)).toBe(oauthBlob('b-new'));
    expect(deps.resolveClaudeProfile).toHaveBeenCalledWith(oauthBlob('b-new'));
  });

  it('new Claude capture updates B even when poisoned A has B’s current token', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-old'));
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('b-new'));
    deps.keychain = oauthBlob('b-new');
    deps.activeEmail = 'a@example.test'; // stale local metadata
    deps.serverEmail = 'b@example.test';

    const saved = await addActiveSessionAccountAuthoritative('claude', 'Conta B');

    expect(saved?.id).toBe(b.id);
    expect(deps.secrets.get(`acctcred:${b.id}`)).toBe(oauthBlob('b-new'));
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('b-new'));
  });

  it('failed targeted Claude materialization keeps the identity-mismatch cooldown', async () => {
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-old'));
    setCooldown(b.id, Date.now() + 60_000, 'oauth identity mismatch — previous proof');
    deps.managedProfiles.set(b.id, oauthBlob('b-old'));
    deps.keychain = oauthBlob('b-new');
    deps.activeEmail = 'b@example.test';
    deps.failManagedMaterialize = true;

    await expect(addActiveSessionAccountAuthoritative('claude', 'Conta B', b.id))
      .rejects.toThrow('managed Claude store unavailable');
    expect(deps.secrets.get(`acctcred:${b.id}`)).toBe(oauthBlob('b-old'));
    expect(listAccounts('claude').find((account) => account.id === b.id)?.lastError)
      .toMatch(/identity mismatch/);
  });
  it('re-login da mesma conta atualiza o blob e reativa — não cria 2ª linha', () => {
    const a = addClaudeAccount('Trabalho', 'a@example.test', oauthBlob('a-old'));
    // Operador re-loga a MESMA conta; o CLI rotacionou o blob.
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('a-rotated');

    const again = addActiveSessionAccount('claude', 'a@example.test');

    expect(again).not.toBeNull();
    expect(again!.id).toBe(a.id); // mesma entrada, não uma nova
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-rotated'));
    expect(
      [...deps.secrets.keys()].filter((k) => k.startsWith('acctcred:')).length,
    ).toBe(1);
  });

  it('e-mail difere em caixa/ espaço: ainda é a mesma conta', () => {
    const a = addClaudeAccount('Trabalho', 'a@example.test', oauthBlob('a-old'));
    deps.activeEmail = '  A@Example.TEST ';
    deps.keychain = oauthBlob('a-rotated');

    const again = addActiveSessionAccount('claude', 'qualquer');

    expect(again!.id).toBe(a.id);
  });

  it('segunda conta REAL entra como nova linha e vira a ativa', () => {
    const a = addClaudeAccount('Trabalho', 'a@example.test', oauthBlob('a-old'));
    deps.activeEmail = 'b@example.test';
    deps.keychain = oauthBlob('b-live');

    const b = addActiveSessionAccount('claude', 'Pessoal');

    expect(b).not.toBeNull();
    expect(b!.id).not.toBe(a.id);
    expect(
      [...deps.secrets.keys()].filter((k) => k.startsWith('acctcred:')).length,
    ).toBe(2);
  });

  it('entrada antiga sem e-mail ganha a identidade no re-login da mesma sessão', () => {
    // Conta legada gravada sem email no capture (keychain vivo, sem identidade).
    deps.keychain = oauthBlob('same-session');
    const legacy = addActiveSessionAccount('claude', 'Conta claude');
    expect(legacy).not.toBeNull();
    expect(legacy!.email).toBeUndefined();
    // Mesma SESSÃO re-logada, agora com e-mail detectável: o blob no keychain
    // não mudou, então o caminho "sem e-mail na entrada → compara blob" casa.
    deps.activeEmail = 'who@example.test';
    const again = addActiveSessionAccount('claude', 'who@example.test');
    expect(again!.id).toBe(legacy!.id);
    expect(again!.email).toBe('who@example.test');
  });

  it('reautenticação direcionada atualiza exatamente a linha clicada', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-old'));

    // Re-login completo de B: access e refresh rodaram, portanto nenhuma
    // igualdade de token consegue descobrir o dono. O accountId da ação é a
    // autoridade que impede o motor de atualizar a primeira linha por acaso.
    deps.activeEmail = 'b@example.test';
    deps.keychain = oauthBlob('b-completely-new');
    const refreshed = await addActiveSessionAccountAuthoritative(
      'claude',
      'nome ignorado',
      b.id,
    );

    expect(refreshed?.id).toBe(b.id);
    expect(refreshed?.label).toBe('Conta B');
    expect(deps.secrets.get(`acctcred:${b.id}`)).toBe(
      oauthBlob('b-completely-new'),
    );
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-old'));
  });

  it('reautenticação direcionada recusa login comprovado de outra linha', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-live'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-dead'));

    // O operador clicou "Entrar novamente" em B, mas concluiu OAuth de A.
    // Duplicar A sobre B destruiria a multi-conta e faria as duas linhas
    // exibirem a mesma cota.
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('a-live');
    deps.probeClaudeIdentity.mockResolvedValueOnce('mismatch');
    await expect(addActiveSessionAccountAuthoritative('claude', 'Conta B', b.id))
      .rejects.toThrow(/outra conta Claude.*Conta B/);
    expect(deps.secrets.get(`acctcred:${b.id}`)).toBe(oauthBlob('b-dead'));
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-live'));
  });

  it('rejects a new Codex workspace with the target email during targeted relogin', () => {
    const blob = (subject: string) => JSON.stringify({ tokens: {
      account_id: subject, access_token: `access-${subject}`, refresh_token: `refresh-${subject}`,
    } });
    vi.mocked(captureNativeAuth).mockReturnValueOnce({ blob: blob('workspace-a'), email: 'same@example.test', authRelativePath: 'auth.json' });
    const target = addActiveSessionAccount('codex', 'Work')!;
    vi.mocked(captureNativeAuth).mockReturnValueOnce({ blob: blob('workspace-b'), email: 'same@example.test', authRelativePath: 'auth.json' });
    expect(() => addActiveSessionAccount('codex', 'Work', target.id)).toThrow(/identidade|conta/i);
    expect(deps.secrets.get(`acctcred:${target.id}`)).toBe(blob('workspace-a'));
  });

  it('captura explícita do AGY descarta a leitura memoizada da vaga antes de capturar (L3)', () => {
    const order: string[] = [];
    agyKeyring.invalidate.mockReset().mockImplementation(() => { order.push('invalidate'); });
    vi.mocked(captureNativeAuth).mockImplementationOnce(() => {
      order.push('capture');
      return null;
    });
    addActiveSessionAccount('agy', 'AGY');
    expect(order).toEqual(['invalidate', 'capture']);
  });

  it('AGY no Windows com sobra de outro formato recusa salvar e diz o que fazer (F-1580)', () => {
    vi.mocked(captureNativeAuth).mockReturnValueOnce(null);
    vi.mocked(agyWindowsUnreadableSessionReason).mockReturnValueOnce(
      AGY_WINDOWS_LEFTOVER_SESSION_REASON,
    );
    expect(() => addActiveSessionAccount('agy', 'AGY')).toThrow(/Conectar minha conta/);
    expect(listAccounts('agy')).toEqual([]);
  });

  it('reautenticação direcionada recusa accountId de outro provider', () => {
    const claude = addClaudeAccount(
      'Claude',
      'a@example.test',
      oauthBlob('a-live'),
    );
    expect(() =>
      addActiveSessionAccount('codex', 'Codex', claude.id),
    ).toThrow(/não existe mais/);
  });
});

describe('F-511: secundária com token morto não queima sessão', () => {
  /** Vault com access expirado e SEM refresh: ninguém renova (caso de campo). */
  function deadBlob(): string {
    return JSON.stringify({
      claudeAiOauth: { accessToken: 'dead', expiresAt: Date.now() - 60_000 },
    });
  }

  function freshBlob(): string {
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: 'live',
        expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      },
    });
  }

  afterEach(() => {
    for (const a of listAccounts('claude')) clearClaudeRefreshFailure(a.id);
  });

  it('prepare recusa secundária vencida-sem-refresh com motivo acionável', () => {
    const a = addClaudeAccount('Conta B', 'b@example.test', deadBlob());
    deps.activeEmail = 'native@example.test'; // B é secundária
    deps.keychain = oauthBlob('native-access');
    const result = prepareAccountForSpawn('claude', a.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('entre novamente');
  });

  it('pick do failover pula a conta morta', () => {
    const a = addClaudeAccount('Conta B', 'b@example.test', deadBlob());
    deps.activeEmail = 'native@example.test';
    deps.keychain = oauthBlob('native-access');
    expect(accountHasFailoverCredential(a)).toBe(false);
  });

  it('secundária fresca sem refresh continua spawnável (presença vale)', () => {
    const a = addClaudeAccount('Conta B', 'b@example.test', freshBlob());
    deps.activeEmail = 'native@example.test';
    deps.keychain = oauthBlob('native-access');
    expect(accountHasFailoverCredential(a)).toBe(true);
    expect(prepareAccountForSpawn('claude', a.id).ok).toBe(true);
  });

  it('secundária vencida COM refresh não é recusada (failover cura no pin)', () => {
    const withRefresh = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stale',
        refreshToken: 'refresh-stale',
        expiresAt: Date.now() - 60_000,
      },
    });
    const a = addClaudeAccount('Conta B', 'b@example.test', withRefresh);
    deps.activeEmail = 'native@example.test';
    deps.keychain = oauthBlob('native-access');
    expect(accountHasFailoverCredential(a)).toBe(true);
    expect(prepareAccountForSpawn('claude', a.id).ok).toBe(true);
  });
});

describe('contrato de env OAuth de pane pinado', () => {
  it('não emite tokens no env da conta gerenciada; conserva OAuth renovável no perfil', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-access'));
    // Outra conta é o login nativo → A é secundária e recebe env process-scoped.
    deps.activeEmail = 'someone-else@example.test';
    deps.keychain = oauthBlob('native-access');

    const result = prepareAccountForSpawn('claude', a.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(`/tmp/claude/${a.id}/auth`);
    expect(result.authEnv).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(JSON.parse(deps.managedProfiles.get(a.id)!).claudeAiOauth.refreshToken).toBe('refresh-a-access');
    expect(result.authEnv).not.toHaveProperty('CLAUDE_CODE_OAUTH_REFRESH_TOKEN');

    // O env da sessão ativa (lido do Keychain) segue o mesmo contrato.
    deps.keychain = oauthBlob('native-access');
    const activeEnv = activeClaudeAuthEnv();
    expect(activeEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('native-access');
    expect(activeEnv?.CLAUDE_CODE_OAUTH_SCOPES).toBe(
      'user:profile user:inference',
    );
    expect(activeEnv).not.toHaveProperty('CLAUDE_CODE_OAUTH_REFRESH_TOKEN');
  });
});

describe('F-645: a conta que é o login nativo tem um dono só da linhagem', () => {
  it('prova o store nativo, ignora a cópia gerenciada antiga e não semeia outra', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-vault'));
    deps.managedProfiles.set(a.id, oauthBlob('a-stale-scope'));
    deps.keychain = oauthBlob('a-native-rotated');
    const verified = vi.fn();

    expect(await verifyManagedClaudeAccountForSpawn(a.id, verified)).toBe('match');
    expect(deps.probeClaudeIdentity).toHaveBeenCalledWith(
      oauthBlob('a-native-rotated'), 'a@example.test',
    );
    expect(verified).toHaveBeenCalledWith(oauthBlob('a-native-rotated'));
    expect(deps.probeClaudeCliUsage).not.toHaveBeenCalled();

    expect(prepareAccountForSpawn('claude', a.id)).toMatchObject({ ok: true, authEnv: {} });
    expect(deps.managedProfiles.get(a.id)).toBe(oauthBlob('a-stale-scope'));
  });

  it('access token nativo vencido: a CLI nativa renova e a prova é no token novo', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-native'));
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-a-native' });
    deps.probeClaudeIdentity
      .mockResolvedValueOnce('auth-expired')
      .mockResolvedValueOnce('match');
    deps.probeClaudeCliUsage.mockImplementationOnce(async () => {
      deps.keychain = oauthBlob('a-native-renewed');
      return { windows: null };
    });

    expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('match');
    // Run nativo: sem env de escopo, a CLI renova o próprio store — e no
    // perfil nativo de verdade, sem herdar config dir/token do Main (F-1637).
    expect(deps.probeClaudeCliUsage).toHaveBeenCalledWith({ nativeProfile: true });
    expect(deps.probeClaudeIdentity).toHaveBeenLastCalledWith(
      oauthBlob('a-native-renewed'), 'a@example.test',
    );
    expect(deps.managedProfiles.has(a.id)).toBe(false);
  });

  it('store nativo ilegível não vira "sessão expirada" nem cai no vault', async () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-native'));
    deps.keychain = null;

    expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('unavailable');
    expect(deps.probeClaudeCliUsage).not.toHaveBeenCalled();
  });
});

describe('renovação morta veta failover no escuro', () => {
  /** Conta secundária: o login nativo é de outro e-mail. */
  function addSecondary(label: string, email: string, blob: string): Account {
    const account = addClaudeAccount(label, email, blob);
    deps.activeEmail = 'nativo@example.test';
    deps.keychain = oauthBlob('native-access');
    clearClaudeRefreshFailure(account.id);
    return account;
  }

  afterEach(() => {
    // Mapa modular sobrevive entre testes do arquivo: limpa o que marcamos.
    const marked = (deps as Record<string, unknown>).marked as
      | Account[]
      | undefined;
    for (const account of marked ?? []) {
      clearClaudeRefreshFailure(account.id);
    }
    delete (deps as Record<string, unknown>).marked;
  });

  it('does not persist a managed Claude readback that proves another account', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('saved'));
    deps.managedProfiles.set(a.id, oauthBlob('wrong-scope'));
    deps.calls.length = 0;
    deps.probeClaudeIdentity.mockResolvedValueOnce('mismatch');

    expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('saved'));
    expect(deps.calls).not.toContain(`setSecret:acctcred:${a.id}`);
  });

  it('does not persist a refreshed vault token until its provider profile matches', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('saved'));
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValueOnce(oauthBlob('wrong-renewal'));
    deps.probeClaudeIdentity.mockResolvedValueOnce('mismatch');
    deps.calls.length = 0;

    expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('saved'));
    expect(deps.calls).not.toContain(`setSecret:acctcred:${a.id}`);
  });

  it('Reserva com access token vencido renova pelo refresh token e sai de «sessão expirada»', async () => {
    // Campo: a conta foi para a Reserva, o app dormiu além da vida do access
    // token e a prova pré-refresh (exigia 'match') nunca passava — dead-end.
    const a = addSecondary('Conta Adm', 'adm@example.test', oauthBlob('expired'));
    setCooldown(a.id, Date.now() + 12 * 60 * 60 * 1000, 'oauth session expired — sonda de quota');
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-expired' });
    deps.refreshBlob.mockResolvedValueOnce(oauthBlob('renewed'));
    deps.probeClaudeIdentity.mockImplementation(async (blob) =>
      blob === oauthBlob('renewed') ? 'match' : 'auth-expired');
    expect(listAccountInfos().find((i) => i.id === a.id)?.needsRelogin).toBe(true);

    expect(await ensureFreshClaudeSubscription(a.id)).toBe(true);
    expect(deps.refreshBlob).toHaveBeenCalledWith(oauthBlob('expired'), expect.any(Number));
    // A prova acontece no token NOVO antes de ele entrar no cofre.
    expect(deps.probeClaudeIdentity).toHaveBeenLastCalledWith(
      oauthBlob('renewed'), 'adm@example.test', expect.anything(),
    );
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('renewed'));
    expect(listAccountInfos().find((i) => i.id === a.id)?.needsRelogin).toBe(false);
    expect(deps.keychainWrites).toEqual([]);
  });

  it('Reserva só no cofre: o spawn renova pelo refresh token e prova a conta no token novo (F-1637)', async () => {
    // Antes o spawn só tentava renovar com escopo gerenciado ou login nativo;
    // a conta só no cofre ia direto para "expirou — entre novamente".
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('expired'));
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-expired' });
    deps.refreshBlob.mockResolvedValueOnce(oauthBlob('renewed'));
    deps.probeClaudeIdentity.mockImplementation(async (blob) =>
      blob === oauthBlob('renewed') ? 'match' : 'auth-expired');
    const verified = vi.fn();

    expect(await verifyManagedClaudeAccountForSpawn(a.id, verified)).toBe('match');
    expect(verified).toHaveBeenCalledWith(oauthBlob('renewed'));
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('renewed'));
    expect(deps.probeClaudeCliUsage).not.toHaveBeenCalled();
    expect(deps.keychainWrites).toEqual([]);
  });

  it('o login nativo nunca é renovado por HTTP pelo spawn, e a CLI roda no perfil nativo', async () => {
    const a = addClaudeAccount('Conta Nativa', 'nativa@example.test', oauthBlob('native-expired'));
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-native-expired' });
    deps.refreshBlob.mockResolvedValue(oauthBlob('rotated-by-nexus'));
    deps.probeClaudeIdentity.mockResolvedValue('auth-expired');

    expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
    expect(deps.refreshBlob).not.toHaveBeenCalled();
    // Sem herdar config dir ou token de outra conta do processo Main (F-1416).
    expect(deps.probeClaudeCliUsage).toHaveBeenCalledWith(expect.objectContaining({ nativeProfile: true }));
  });

  it('token renovado sem prova de identidade nunca chega ao cofre', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('expired'));
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-expired' });
    deps.refreshBlob.mockResolvedValueOnce(oauthBlob('fresh'));
    deps.probeClaudeIdentity.mockResolvedValue('auth-expired');

    expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
    expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
    // Sem escopo gerenciado não há CLI dona da renovação para chamar.
    expect(deps.probeClaudeCliUsage).not.toHaveBeenCalled();
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('expired'));
  });

  it.each([
    ['o login nativo', (_a: Account) => {
      deps.keychain = oauthBlob('shared');
    }],
    ['outra linha do cofre', (_a: Account) => {
      const sibling = addSecondary('Conta Irmã', 'irma@example.test', oauthBlob('irma'));
      deps.secrets.set(`acctcred:${sibling.id}`, oauthBlob('shared'));
    }],
  ])('não rotaciona token vencido sem prova cuja linhagem também está n%s', async (_where, share) => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b'));
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('shared'));
    share(a);
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-shared' });
    deps.refreshBlob.mockResolvedValue(oauthBlob('fresh'));
    deps.probeClaudeIdentity.mockResolvedValue('auth-expired');

    expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
    // Rotacionar consumiria o refresh token de quem também o carrega (F-615).
    expect(deps.refreshBlob).not.toHaveBeenCalled();
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('shared'));
  });

  it('preservar a sessão nativa grava o blob vivo na linha existente e limpa «sessão expirada»', async () => {
    // A conta já está no cofre com token velho, escopo gerenciado velho e a
    // marca de sessão expirada; o login nativo dela rotacionou o token.
    const a = addSecondary('Conta Adm', 'adm@example.test', oauthBlob('adm-old'));
    (deps as Record<string, unknown>).marked = [a];
    setCooldown(a.id, Date.now() + 12 * 60 * 60 * 1000, 'oauth session expired — sonda de quota');
    deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-adm-old' });
    await ensureFreshClaudeSubscription(a.id); // refresh real falha → marca
    expect(hasRecentClaudeRefreshFailure(a.id)).toBe(true);
    deps.managedProfiles.set(a.id, oauthBlob('adm-old'));

    deps.activeEmail = 'adm@example.test';
    deps.keychain = oauthBlob('adm-rotated');
    const saved = await addActiveSessionAccountAuthoritative('claude', 'Conta Adm');

    expect(saved?.id).toBe(a.id);
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('adm-rotated'));
    expect(deps.managedProfiles.get(a.id)).toBe(oauthBlob('adm-rotated'));
    expect(hasRecentClaudeRefreshFailure(a.id)).toBe(false);
    expect(listAccountInfos().find((i) => i.id === a.id)?.needsRelogin).toBe(false);
  });

  describe('F-639: access token vencido no escopo gerenciado', () => {
    function addManagedExpired(): Account {
      const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-expired'));
      deps.managedProfiles.set(a.id, oauthBlob('b-expired'));
      deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-b-expired' });
      return a;
    }

    it('deixa a CLI renovar no escopo da conta e prova a identidade no token novo', async () => {
      const a = addManagedExpired();
      deps.probeClaudeIdentity
        .mockResolvedValueOnce('auth-expired')
        .mockResolvedValueOnce('match');
      deps.probeClaudeCliUsage.mockImplementationOnce(async () => {
        deps.managedProfiles.set(a.id, oauthBlob('b-renewed-by-cli'));
        return { windows: null };
      });
      const verified = vi.fn();

      expect(await verifyManagedClaudeAccountForSpawn(a.id, verified)).toBe('match');
      expect(deps.probeClaudeCliUsage).toHaveBeenCalledTimes(1);
      expect(deps.probeClaudeCliUsage.mock.calls[0]?.[0]?.env).toEqual({
        CLAUDE_SECURESTORAGE_CONFIG_DIR: `/tmp/claude/${a.id}/auth`,
      });
      expect(deps.probeClaudeIdentity).toHaveBeenLastCalledWith(
        oauthBlob('b-renewed-by-cli'), 'b@example.test',
      );
      expect(verified).toHaveBeenCalledWith(oauthBlob('b-renewed-by-cli'));
      // A CLI é o único ator da rotação: nada de refresh HTTP do Nexus.
      expect(deps.refreshBlob).not.toHaveBeenCalled();
    });

    it('pede login e marca «sessão expirada» quando a própria CLI recusou a sessão', async () => {
      const a = addManagedExpired();
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      deps.probeClaudeCliUsage.mockResolvedValue({ windows: null, failure: 'auth-expired' } as never);

      expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
      expect(deps.probeClaudeCliUsage).toHaveBeenCalledTimes(1);
      // A prova chega ao painel: a linha oferece «Entrar novamente» nela.
      expect(listAccountInfos().find((i) => i.id === a.id)?.needsRelogin).toBe(true);
      expect(deps.refreshBlob).not.toHaveBeenCalled();
    });

    // F-1637: conta b "Em uso" e "conectado" no painel, pane recusado com
    // "A sessão de “conta b” expirou". O escopo tinha access token vencido
    // pelo relógio e refresh token vivo; o run da CLI não renovou nem recusou.
    // A cota (F-1416) chamou isso de leitura indisponível; o spawn chamava de
    // sessão perdida. Só o relógio nunca prova re-login.
    it('CLI que não renovou nem recusou não prova sessão morta: o pane abre e a CLI dele renova', async () => {
      const a = addManagedExpired();
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      const verified = vi.fn();

      expect(await verifyManagedClaudeAccountForSpawn(a.id, verified)).toBe('renewable');
      expect(verified).toHaveBeenCalledWith(oauthBlob('b-expired'));
      expect(deps.probeClaudeCliUsage).toHaveBeenCalledTimes(1);
      // A linhagem é da CLI do escopo: o Nexus não rotaciona nada por HTTP.
      expect(deps.refreshBlob).not.toHaveBeenCalled();
      expect(listAccountInfos().find((i) => i.id === a.id)?.needsRelogin).toBe(false);
    });

    // Revisão independente do F-1637: o relógio não prova de QUEM é o token.
    // Só a linhagem que o cofre provou para esta conta pode abrir sem prova.
    it('escopo com linhagem diferente da do cofre nunca abre como renovável', async () => {
      const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-vault', 1_000));
      deps.managedProfiles.set(a.id, oauthBlob('x-other-account', 2_000));
      deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-x-other-account' });
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      const verified = vi.fn();

      expect(await verifyManagedClaudeAccountForSpawn(a.id, verified)).toBe('auth-expired');
      expect(verified).not.toHaveBeenCalled();
      // Sem prova de sessão morta: nenhuma marca de 12 h.
      expect(listAccounts('claude').find((i) => i.id === a.id)?.cooldownUntil).toBeUndefined();
    });

    it.each([
      ['a quarentena de identidade', 'oauth identity mismatch — sonda de quota', 12 * 60 * 60 * 1000],
      ['um limite de uso de 3 dias', 'usage limit reached', 3 * 24 * 60 * 60 * 1000],
    ])('a marca do spawn não sobrescreve %s', async (_case, reason, span) => {
      const a = addManagedExpired();
      const until = Date.now() + span;
      setCooldown(a.id, until, reason);
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      deps.probeClaudeCliUsage.mockResolvedValue({ windows: null, failure: 'auth-expired' } as never);

      expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
      const row = listAccounts('claude').find((i) => i.id === a.id);
      expect(row?.lastError).toBe(reason);
      expect(row?.cooldownUntil).toBe(until);
    });

    it('recusa da CLI sobre o escopo não prova nada sobre a outra linhagem, viva, do cofre', async () => {
      const a = addSecondary('Conta B', 'b@example.test', oauthBlob('vault-live', 2_000));
      deps.managedProfiles.set(a.id, oauthBlob('scope-dead', 1_000));
      deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-vault-live' });
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      deps.probeClaudeCliUsage.mockResolvedValue({ windows: null, failure: 'auth-expired' } as never);
      (deps as Record<string, unknown>).marked = [a];

      await verifyManagedClaudeAccountForSpawn(a.id);
      expect(listAccounts('claude').find((i) => i.id === a.id)?.cooldownUntil).toBeUndefined();
    });

    it('recusa da CLI com o escopo ilegível depois do run não é prova', async () => {
      const a = addManagedExpired();
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      deps.probeClaudeCliUsage.mockImplementationOnce(async () => {
        deps.managedProfiles.set(a.id, ''); // Keychain do escopo negado
        return { windows: null, failure: 'auth-expired' } as never;
      });

      await verifyManagedClaudeAccountForSpawn(a.id);
      expect(listAccounts('claude').find((i) => i.id === a.id)?.cooldownUntil).toBeUndefined();
    });

    // Segunda revisão: o arquivo-espelho do escopo continua legível com o
    // Keychain travado, e a CLI no macOS lê o Keychain — recusa sem prova.
    it('recusa da CLI com o Keychain do escopo travado não é prova, mesmo com o arquivo legível', async () => {
      const a = addManagedExpired();
      deps.lockedScopes.add(a.id);
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      deps.probeClaudeCliUsage.mockResolvedValue({ windows: null, failure: 'auth-expired' } as never);

      await verifyManagedClaudeAccountForSpawn(a.id);
      expect(listAccounts('claude').find((i) => i.id === a.id)?.cooldownUntil).toBeUndefined();
    });

    it('a quarentena de identidade sobrevive ao fim do próprio cooldown', async () => {
      const a = addManagedExpired();
      setCooldown(a.id, Date.now() - 1, 'oauth identity mismatch — sonda de quota');
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      deps.probeClaudeCliUsage.mockResolvedValue({ windows: null, failure: 'auth-expired' } as never);

      await verifyManagedClaudeAccountForSpawn(a.id);
      expect(listAccounts('claude').find((i) => i.id === a.id)?.lastError)
        .toBe('oauth identity mismatch — sonda de quota');
    });

    it('401 sobre token ainda no prazo, sem refresh token, não marca sessão morta', async () => {
      const a = addSecondary('Conta B', 'b@example.test', JSON.stringify({
        claudeAiOauth: { accessToken: 'setup-token', expiresAt: Date.now() + 300 * 86_400_000, scopes: ['user:inference'] },
      }));
      deps.managedProfiles.set(a.id, deps.secrets.get(`acctcred:${a.id}`)!);
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');

      expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
      expect(listAccounts('claude').find((i) => i.id === a.id)?.cooldownUntil).toBeUndefined();
    });

    it('linhagem do escopo compartilhada com o login nativo nunca abre como renovável', async () => {
      const a = addManagedExpired();
      deps.managedProfiles.set(a.id, oauthBlob('shared'));
      deps.keychain = oauthBlob('shared');
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');

      // A CLI do pane renovaria a cópia e derrubaria o login nativo (F-645).
      expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
    });

    it('sem refresh token no prazo é re-login de verdade: marca a conta', async () => {
      const a = addSecondary('Conta B', 'b@example.test', JSON.stringify({
        claudeAiOauth: { accessToken: 'b-dead', expiresAt: 1_000, scopes: ['user:inference'] },
      }));
      deps.managedProfiles.set(a.id, deps.secrets.get(`acctcred:${a.id}`)!);
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');

      expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
      expect(deps.probeClaudeCliUsage).not.toHaveBeenCalled();
      expect(listAccountInfos().find((i) => i.id === a.id)?.needsRelogin).toBe(true);
    });

    it('renovação HTTP que acabou de falhar não abre o pane como renovável', async () => {
      const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-expired'));
      (deps as Record<string, unknown>).marked = [a];
      deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-b-expired' });
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      await ensureFreshClaudeSubscription(a.id); // refresh real falha → marca
      expect(hasRecentClaudeRefreshFailure(a.id)).toBe(true);
      deps.managedProfiles.set(a.id, oauthBlob('b-expired'));

      expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
    });

    it('renovação que devolve outra conta é mismatch, nunca match', async () => {
      const a = addManagedExpired();
      deps.probeClaudeIdentity
        .mockResolvedValueOnce('auth-expired')
        .mockResolvedValueOnce('mismatch');
      deps.probeClaudeCliUsage.mockImplementationOnce(async () => {
        deps.managedProfiles.set(a.id, oauthBlob('other-account'));
        return { windows: null };
      });
      const verified = vi.fn();

      expect(await verifyManagedClaudeAccountForSpawn(a.id, verified)).toBe('mismatch');
      expect(verified).not.toHaveBeenCalled();
    });

    it('sem refresh token não há o que a CLI renovar: nenhum run', async () => {
      const a = addManagedExpired();
      deps.needsRefresh.mockReturnValue(null);
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');

      expect(await verifyManagedClaudeAccountForSpawn(a.id)).toBe('auth-expired');
      expect(deps.probeClaudeCliUsage).not.toHaveBeenCalled();
    });

    it('escopo vencido com a MESMA linhagem do cofre continua só da CLI', async () => {
      const a = addManagedExpired();
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');
      deps.refreshBlob.mockResolvedValue(oauthBlob('nexus-rotated'));

      expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
      expect(deps.refreshBlob).not.toHaveBeenCalled();
    });

    it.each([
      ['outra linhagem, mais velha', oauthBlob('scope-old', 1_000)],
      ['nenhuma credencial', ''],
    ])('escopo vencido com %s: o cofre renova a própria linhagem por HTTP', async (_case, scope) => {
      const a = addSecondary('Conta Adm', 'adm@example.test', oauthBlob('vault-new', 2_000));
      deps.managedProfiles.set(a.id, scope);
      setCooldown(a.id, Date.now() + 12 * 60 * 60 * 1000, 'oauth session expired — sonda de quota');
      deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-vault-new' });
      deps.refreshBlob.mockResolvedValueOnce(oauthBlob('vault-renewed'));
      deps.probeClaudeIdentity.mockImplementation(async (blob) =>
        blob === oauthBlob('vault-renewed') ? 'match' : 'auth-expired');

      expect(await ensureFreshClaudeSubscription(a.id)).toBe(true);
      expect(deps.refreshBlob).toHaveBeenCalledWith(oauthBlob('vault-new', 2_000), expect.any(Number));
      expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('vault-renewed'));
      expect(listAccountInfos().find((i) => i.id === a.id)?.needsRelogin).toBe(false);
    });

    it('escopo com OUTRA linhagem mais NOVA que o cofre não deixa o Nexus rotacionar o cofre', async () => {
      const a = addSecondary('Conta Adm', 'adm@example.test', oauthBlob('vault-old', 1_000));
      deps.managedProfiles.set(a.id, oauthBlob('scope-new', 2_000));
      deps.needsRefresh.mockReturnValue({ refreshToken: 'refresh-vault-old' });
      deps.probeClaudeIdentity.mockResolvedValue('auth-expired');

      expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
      expect(deps.refreshBlob).not.toHaveBeenCalled();
    });

    it('read-back provado do escopo tira a conta de «sessão expirada»', async () => {
      const a = addManagedExpired();
      setCooldown(a.id, Date.now() + 12 * 60 * 60 * 1000, 'oauth session expired — sonda de quota');
      deps.managedProfiles.set(a.id, oauthBlob('b-renewed-by-cli'));

      expect(await ensureFreshClaudeSubscription(a.id)).toBe(true);
      expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('b-renewed-by-cli'));
      expect(listAccountInfos().find((i) => i.id === a.id)?.needsRelogin).toBe(false);
      expect(deps.refreshBlob).not.toHaveBeenCalled();
    });
  });

  it('identidade nativa ilegível fecha a guarda: não renova sem saber se é o login nativo (M1)', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(oauthBlob('b-access-2'));
    // ~/.claude.json presente mas acima do teto, instável ou JSON pela metade.
    deps.activeEmail = undefined;
    expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
    expect(deps.refreshBlob).not.toHaveBeenCalled();
    // Sem arquivo (nenhum login nativo) a renovação segue normal.
    deps.activeEmail = null;
    expect(await ensureFreshClaudeSubscription(a.id)).toBe(true);
  });

  it('falha real de refresh marca a conta (skips não marcam)', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    (deps as Record<string, unknown>).marked = [a];
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(null);

    expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
    expect(hasRecentClaudeRefreshFailure(a.id)).toBe(true);
  });

  it('sucesso do refresh emite onChanged quando havia marca (cura visível)', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    (deps as Record<string, unknown>).marked = [a];
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(null);
    const seen: number[] = [];
    const off = onAccountsChange(() => {
      seen.push(1);
    });
    try {
      expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
      expect(seen).toHaveLength(1);
      deps.refreshBlob.mockResolvedValue(oauthBlob('b-access-2'));
      expect(await ensureFreshClaudeSubscription(a.id)).toBe(true);
      expect(hasRecentClaudeRefreshFailure(a.id)).toBe(false);
      expect(seen).toHaveLength(2);
    } finally {
      off();
    }
  });

  it('sucesso do refresh limpa a marca', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    (deps as Record<string, unknown>).marked = [a];
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(null);
    expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
    expect(hasRecentClaudeRefreshFailure(a.id)).toBe(true);

    deps.refreshBlob.mockResolvedValue(oauthBlob('b-access-2'));
    expect(await ensureFreshClaudeSubscription(a.id)).toBe(true);
    expect(hasRecentClaudeRefreshFailure(a.id)).toBe(false);
  });

  it('refresh que cura com cooldown de auth JÁ expirado ainda emite (clearCooldown no-op)', async () => {
    // CodeRabbit (F-512): o `clearCooldown` só emite quando havia cooldown
    // vivo. Com o cooldown de auth já vencido ele é no-op, mas a marca de
    // refresh-failure mudou de estado — sem o emit o badge fica pendurado.
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    (deps as Record<string, unknown>).marked = [a];
    setCooldown(a.id, Date.now() - 1, 'Error: 401');
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(null);
    const seen: number[] = [];
    const off = onAccountsChange(() => {
      seen.push(1);
    });
    try {
      expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
      expect(hasRecentClaudeRefreshFailure(a.id)).toBe(true);
      const before = seen.length;
      deps.refreshBlob.mockResolvedValue(oauthBlob('b-access-2'));
      expect(await ensureFreshClaudeSubscription(a.id)).toBe(true);
      expect(hasRecentClaudeRefreshFailure(a.id)).toBe(false);
      expect(seen.length).toBe(before + 1);
    } finally {
      off();
    }
  });

  it('prepare recusa secundária com renovação falhando (motivo acionável)', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    (deps as Record<string, unknown>).marked = [a];
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(null);
    await ensureFreshClaudeSubscription(a.id);

    const result = prepareAccountForSpawn('claude', a.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/renovação de token falhando/);
  });

  it('re-login (blob fresco do CLI) limpa a marca e o prepare volta a ok', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    (deps as Record<string, unknown>).marked = [a];
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(null);
    await ensureFreshClaudeSubscription(a.id);
    expect(hasRecentClaudeRefreshFailure(a.id)).toBe(true);

    // Re-login: a sessão nativa agora é a conta B com blob fresco.
    deps.activeEmail = 'b@example.test';
    deps.keychain = oauthBlob('b-access-fresh');
    addActiveSessionAccount('claude', 'Conta B');
    deps.activeEmail = 'nativo@example.test';

    expect(hasRecentClaudeRefreshFailure(a.id)).toBe(false);
    expect(prepareAccountForSpawn('claude', a.id).ok).toBe(true);
  });

  it('listAccountInfos projeta needsRelogin e a marca emite onChanged só na transição', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    (deps as Record<string, unknown>).marked = [a];
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(null);
    const seen: number[] = [];
    const off = onAccountsChange(() => {
      seen.push(1);
    });
    try {
      expect(
        listAccountInfos().find((i) => i.id === a.id)?.needsRelogin,
      ).toBe(false);
      expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
      expect(
        listAccountInfos().find((i) => i.id === a.id)?.needsRelogin,
      ).toBe(true);
      expect(seen).toHaveLength(1);
      // Segunda falha seguida não re-emite (anti-spam do sweeper de 15min).
      expect(await ensureFreshClaudeSubscription(a.id)).toBe(false);
      expect(seen).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('marca expira após a janela (TTL)', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    (deps as Record<string, unknown>).marked = [a];
    deps.needsRefresh.mockReturnValue({ refreshToken: 'rt-b' });
    deps.refreshBlob.mockResolvedValue(null);
    await ensureFreshClaudeSubscription(a.id);
    expect(hasRecentClaudeRefreshFailure(a.id)).toBe(true);

    const later = Date.now() + CLAUDE_REFRESH_FAILURE_SKIP_MS + 1000;
    expect(hasRecentClaudeRefreshFailure(a.id, later)).toBe(false);
    expect(prepareAccountForSpawn('claude', a.id, later).ok).toBe(true);
  });

  it('isAuthCooldownReason identifica variações de erro de autenticação', () => {
    expect(isAuthCooldownReason('Error: 401')).toBe(true);
    expect(isAuthCooldownReason('401 Unauthorized')).toBe(true);
    expect(isAuthCooldownReason('oauth token expired')).toBe(true);
    expect(isAuthCooldownReason('rate limit exceeded')).toBe(false);
    expect(isAuthCooldownReason('insufficient_quota')).toBe(false);
  });

  it('clears only an auth cooldown proven healthy by the same provider', () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    setCooldown(a.id, Date.now() + 60000, 'oauth session expired');
    expect(clearRefutedAuthCooldown(a.id, 'grok')).toBe(false);
    expect(clearRefutedAuthCooldown(a.id, 'claude')).toBe(true);
    expect(listAccountInfos().find(i => i.id === a.id)?.needsRelogin).toBe(false);
  });

  it('does not erase a global quota block when a later tier auth error changes lastError', () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    const until = Date.now() + 60000;
    setCooldown(a.id, until, 'rate limit exceeded');
    setCooldown(a.id, until, 'oauth session expired', 'tier:opus');
    expect(clearRefutedAuthCooldown(a.id, 'claude')).toBe(false);
    expect(listAccounts().find(i => i.id === a.id)?.cooldownUntil).toBe(until);
  });

  it('listAccountInfos projeta needsRelogin: true e onCooldown: false para erro 401', () => {
    const a = addSecondary('Conta Adm', 'adm@example.test', oauthBlob('adm-access'));
    setCooldown(a.id, Date.now() + 15 * 60 * 1000, 'Error: 401');

    const info = listAccountInfos().find((i) => i.id === a.id);
    expect(info?.onCooldown).toBe(false);
    expect(info?.needsRelogin).toBe(true);
  });

  it('erro 401 cujo cooldown terminou não deixa a conta expirada para sempre', () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    setCooldown(a.id, Date.now() - 1, 'Error: 401');

    const info = listAccountInfos().find((i) => i.id === a.id);
    expect(info?.onCooldown).toBe(false);
    expect(info?.needsRelogin).toBe(false);
  });

  it('refresh forçado após 401 cura só a conta afetada e limpa o erro persistido', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    setCooldown(a.id, Date.now() + 15 * 60 * 1000, 'Error: 401');
    deps.refreshBlob.mockResolvedValueOnce(oauthBlob('b-access-renewed'));

    expect(
      await ensureFreshClaudeSubscription(
        a.id,
        Date.now(),
        deps.refreshBlob,
        { force: true },
      ),
    ).toBe(true);

    const info = listAccountInfos().find((item) => item.id === a.id);
    expect(info?.needsRelogin).toBe(false);
    expect(info?.lastError).toBe('credencial Claude renovada');
    expect(deps.keychainWrites).toHaveLength(0);
  });

  it('refresh concluído não apaga um cooldown de quota criado durante o await', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    setCooldown(a.id, Date.now() + 15 * 60 * 1000, 'Error: 401');
    let finishRefresh: ((blob: string) => void) | undefined;
    const refreshPending = new Promise<string>((resolve) => {
      finishRefresh = resolve;
    });
    const refresh = vi.fn(() => refreshPending);

    const healing = ensureFreshClaudeSubscription(
      a.id,
      Date.now(),
      refresh,
      { force: true },
    );
    setCooldown(a.id, Date.now() + 30 * 60 * 1000, 'rate limit exceeded');
    finishRefresh?.(oauthBlob('b-access-renewed'));

    expect(await healing).toBe(true);
    const info = listAccountInfos().find((item) => item.id === a.id);
    expect(info?.onCooldown).toBe(true);
    expect(info?.lastError).toBe('rate limit exceeded');
  });

  it('falha ao persistir o token renovado mantém a conta bloqueada', async () => {
    const a = addSecondary('Conta B', 'b@example.test', oauthBlob('b-access'));
    setCooldown(a.id, Date.now() + 15 * 60 * 1000, 'Error: 401');
    deps.failSecretWrites = true;
    deps.refreshBlob.mockResolvedValueOnce(oauthBlob('b-access-renewed'));

    expect(
      await ensureFreshClaudeSubscription(
        a.id,
        Date.now(),
        deps.refreshBlob,
        { force: true },
      ),
    ).toBe(false);

    const info = listAccountInfos().find((item) => item.id === a.id);
    expect(info?.needsRelogin).toBe(true);
    expect(info?.lastError).toBe('Error: 401');
  });

  it('native account metadata cannot clear a confirmed authentication failure', () => {
    const b = addSecondary('Conta B', 'retornoja@gmail.com', oauthBlob('retorno-access'));
    deps.activeEmail = 'retornoja@gmail.com';
    deps.keychain = oauthBlob('retorno-access');
    setCooldown(b.id, Date.now() + 15 * 60 * 1000, 'Error: 401');

    const info = listAccountInfos().find((i) => i.id === b.id);
    expect(info?.onCooldown).toBe(false);
    expect(info?.needsRelogin).toBe(true);
  });

  it('native identity metadata cannot clear a real quota cooldown', async () => {
    const account = addSecondary('Conta B', 'native@example.test', oauthBlob('native'));
    deps.activeEmail = 'native@example.test';
    deps.keychain = oauthBlob('native');
    const until = Date.now() + 60_000;
    setCooldown(account.id, until, 'rate limit quota exhausted');
    expect(listAccountInfos().find((item) => item.id === account.id)?.onCooldown).toBe(true);
    await Promise.resolve();
    expect(listAccountInfos().find((item) => item.id === account.id)?.cooldownUntil).toBe(until);
  });

  it('addActiveSessionAccount para conta existente limpa cooldown e erros antigos', () => {
    const b = addSecondary('Conta B', 'b@example.test', oauthBlob('b-old'));
    setCooldown(b.id, Date.now() + 15 * 60 * 1000, 'Error: 401');

    deps.activeEmail = 'b@example.test';
    deps.keychain = oauthBlob('b-fresh');
    const refreshed = addActiveSessionAccount('claude', 'Conta B');

    expect(refreshed?.id).toBe(b.id);
    expect(refreshed?.cooldownUntil).toBeUndefined();
    expect(refreshed?.lastError).toBeUndefined();
  });

  it('activateAccount limpa auth cooldown da conta ativada', () => {
    const adm = addSecondary('Conta Adm', 'adm@example.test', oauthBlob('adm-access'));
    setCooldown(adm.id, Date.now() + 15 * 60 * 1000, 'Error: 401');

    expect(activateAccount(adm.id)).toBe(true);
    const info = listAccountInfos().find((i) => i.id === adm.id);
    expect(info?.onCooldown).toBe(false);
    expect(info?.needsRelogin).toBe(false);
  });
});

describe('F-1580: login AGY no Windows devolve a sobra de ~/.gemini se for cancelado', () => {
  const homes: string[] = [];
  function homeWithLeftover(): { home: string; file: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-login-'));
    homes.push(home);
    const file = path.join(home, '.gemini', 'oauth_creds.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"access_token":"gemini-cli"}');
    return { home, file };
  }

  afterEach(() => {
    vi.mocked(captureNativeAuth).mockReset().mockReturnValue(null);
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  it('a sobra não vai para o cofre, sai para o login e volta no cancelamento', () => {
    const { home, file } = homeWithLeftover();
    expect(prepareAgyNativeLogin(home, 'win32')).toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(listAccounts('agy')).toEqual([]);
    expect(restoreAgyNativeLogin()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"access_token":"gemini-cli"}');
    // Devolvida uma vez: o próximo cancelamento não tem o que devolver.
    expect(restoreAgyNativeLogin()).toBe(false);
  });

  it('login concluído (sessão nova na vaga) deixa a sobra apagada', () => {
    const { home, file } = homeWithLeftover();
    prepareAgyNativeLogin(home, 'win32');
    vi.mocked(captureNativeAuth).mockReturnValueOnce({
      blob: '{"token":{"refresh_token":"r"},"id_token":"h.e.s"}',
      authRelativePath: 'oauth_creds.json',
    });
    expect(restoreAgyNativeLogin()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('fora do Windows o preparo segue como antes (sem guardar sobra)', () => {
    const { home, file } = homeWithLeftover();
    expect(prepareAgyNativeLogin(home, 'darwin')).toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(restoreAgyNativeLogin()).toBe(false);
  });
});
