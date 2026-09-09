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
  activeEmail: null as string | null,
  keychain: null as string | null,
  needsRefresh: vi.fn(
    (_blob: string, _now: number): { refreshToken: string } | null => null,
  ),
  refreshBlob: vi.fn(
    async (_blob: string, _now: number): Promise<string | null> => null,
  ),
}));

function oauthBlob(accessToken: string): string {
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
    claudeBlobNeedsRefresh: (blob: string, now: number) =>
      deps.needsRefresh(blob, now),
    forceRefreshClaudeOauthBlob: (blob: string, now: number) =>
      deps.refreshBlob(blob, now),
    refreshClaudeOauthBlob: (blob: string, now: number) =>
      deps.refreshBlob(blob, now),
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
    removeManagedHome: vi.fn(),
  };
});

import {
  accountHasFailoverCredential,
  activateAccount,
  activeClaudeAuthEnv,
  addActiveSessionAccount,
  clearClaudeRefreshFailure,
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
  setCooldown,
  startClaudeSubscriptionFreshness,
} from './account-store';
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
  deps.keychain = null;
  deps.needsRefresh.mockReset();
  deps.needsRefresh.mockReturnValue(null);
  deps.refreshBlob.mockReset();
  deps.refreshBlob.mockResolvedValue(null);
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

describe('read-back Keychain → vault (linhagem Claude nativa)', () => {
  it('activateAccount persiste a conta que SAI com o valor fresco ANTES de escrever a nova', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    const b = addClaudeAccount('Conta B', 'b@example.test', oauthBlob('b-live'));
    // O snapshot de A no vault apodreceu; o CLI rotacionou o Keychain sozinho.
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('a-stale'));
    deps.activeEmail = 'a@example.test'; // A é o login nativo atual
    deps.keychain = oauthBlob('a-fresh-rotated');
    deps.calls.length = 0;

    expect(activateAccount(b.id)).toBe(true);

    // A que sai foi persistida com o valor FRESCO do Keychain…
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-fresh-rotated'));
    // …ANTES da escrita do blob de B no Keychain (ordem importa).
    const syncIdx = deps.calls.indexOf(`setSecret:acctcred:${a.id}`);
    const writeIdx = deps.calls.indexOf('keychainWrite');
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(syncIdx);
    // E a troca se efetivou: o Keychain terminou com o blob de B.
    expect(deps.keychainWrites).toEqual([oauthBlob('b-live')]);
  });

  it('ensureSubscriptionActive com Keychain mais novo atualiza o vault e escreve o valor FRESCO', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-old'));
    deps.secrets.set(`acctcred:${a.id}`, oauthBlob('a-stale'));
    deps.activeEmail = 'a@example.test';
    deps.keychain = oauthBlob('a-fresh-rotated');
    deps.calls.length = 0;

    expect(ensureSubscriptionActive(a)).toBe(true);

    // Vault sincronizado com o Keychain…
    expect(deps.secrets.get(`acctcred:${a.id}`)).toBe(oauthBlob('a-fresh-rotated'));
    // …e o Keychain recebeu o valor FRESCO (não o snapshot velho do vault).
    expect(deps.keychainWrites).toEqual([oauthBlob('a-fresh-rotated')]);
    const syncIdx = deps.calls.indexOf(`setSecret:acctcred:${a.id}`);
    const writeIdx = deps.calls.indexOf('keychainWrite');
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(syncIdx);
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
    // …e a troca para B aconteceu normalmente (comportamento documentado:
    // melhor trocar com o blob do vault do que derrubar o activate).
    expect(deps.keychainWrites).toEqual([oauthBlob('b-live')]);
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
    const result = prepareAccountForSpawn('claude', a.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('entre novamente');
  });

  it('pick do failover pula a conta morta', () => {
    const a = addClaudeAccount('Conta B', 'b@example.test', deadBlob());
    deps.activeEmail = 'native@example.test';
    expect(accountHasFailoverCredential(a)).toBe(false);
  });

  it('secundária fresca sem refresh continua spawnável (presença vale)', () => {
    const a = addClaudeAccount('Conta B', 'b@example.test', freshBlob());
    deps.activeEmail = 'native@example.test';
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
    expect(accountHasFailoverCredential(a)).toBe(true);
    expect(prepareAccountForSpawn('claude', a.id).ok).toBe(true);
  });
});

describe('contrato de env OAuth de pane pinado', () => {
  it('não emite CLAUDE_CODE_OAUTH_REFRESH_TOKEN; emite TOKEN e SCOPES', () => {
    const a = addClaudeAccount('Conta A', 'a@example.test', oauthBlob('a-access'));
    // Outra conta é o login nativo → A é secundária e recebe env process-scoped.
    deps.activeEmail = 'someone-else@example.test';

    const result = prepareAccountForSpawn('claude', a.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('a-access');
    expect(result.authEnv.CLAUDE_CODE_OAUTH_SCOPES).toBe(
      'user:profile user:inference',
    );
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

describe('renovação morta veta failover no escuro', () => {
  /** Conta secundária: o login nativo é de outro e-mail. */
  function addSecondary(label: string, email: string, blob: string): Account {
    const account = addClaudeAccount(label, email, blob);
    deps.activeEmail = 'nativo@example.test';
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

  it('listAccountInfos não marca onCooldown nem needsRelogin na conta que é a sessão nativa viva', () => {
    const b = addSecondary('Conta B', 'retornoja@gmail.com', oauthBlob('retorno-access'));
    deps.activeEmail = 'retornoja@gmail.com';
    deps.keychain = oauthBlob('retorno-access');
    setCooldown(b.id, Date.now() + 15 * 60 * 1000, 'Error: 401');

    const info = listAccountInfos().find((i) => i.id === b.id);
    expect(info?.onCooldown).toBe(false);
    expect(info?.needsRelogin).toBe(false);
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
