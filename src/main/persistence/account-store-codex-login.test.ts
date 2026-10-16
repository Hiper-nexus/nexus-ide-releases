import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './db';

/**
 * Multi-conta Codex: entrar numa conta não pode expirar a outra.
 *
 * Medido no Codex 0.162 com auth sintética e o endpoint de revogação
 * redirecionado para um servidor local: `codex login --device-auth` revoga
 * (POST /oauth/revoke) e apaga o auth.json que encontra ANTES de mostrar o
 * código do device flow, mesmo que o login seja cancelado em seguida; com o
 * CODEX_HOME vazio, nada é revogado. O terminal de login do Nexus roda no
 * ~/.codex nativo, onde mora a mesma linhagem (mesmo refresh token) que o
 * Nexus guardou no cofre e no home gerenciado da conta.
 *
 * Tudo aqui é sintético: tokens inventados, HOME temporário, cofre em memória.
 */

const deps = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  /** Cofre presente mas ilegível (decrypt negado). */
  unreadable: new Set<string>(),
}));

vi.mock('./secrets-store', () => ({
  deleteSecret: (key: string) => {
    deps.secrets.delete(key);
    return { ok: true };
  },
  getSecret: (key: string) => (deps.unreadable.has(key) ? null : deps.secrets.get(key) ?? null),
  hasCachedSecret: (key: string) => deps.secrets.has(key),
  hasSecret: (key: string) => deps.secrets.has(key),
  setSecret: (key: string, value: string) => {
    deps.secrets.set(key, value);
    return { ok: true };
  },
}));

vi.mock('../adapters/claude-credential', () => ({
  activeClaudeEmail: () => null,
  CLAUDE_KEYCHAIN_SERVICE: 'Claude Code-credentials',
  claudeCredentialBlobIsUsable: () => false,
  invalidateClaudeCredentialCache: vi.fn(),
  readActiveClaudeCredential: () => null,
  readActiveClaudeCredentialSlim: () => null,
  slimClaudeCredentialBlob: (blob: string) => blob,
}));

vi.mock('../quota/claude-native-account', () => ({
  probeClaudeCredentialIdentity: vi.fn(async () => 'unavailable'),
  resolveClaudeCredentialProfile: vi.fn(async () => null),
}));

import {
  addActiveSessionAccount,
  initAccountStore,
  listAccounts,
  prepareCodexNativeLogin,
  restoreCodexNativeLogin,
} from './account-store';

const CRED = 'acctcred:';

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

/** auth.json do Codex com a forma real; `issuedAt` é o `last_refresh`. */
function codexAuth(email: string, accountId: string, refreshToken: string, issuedAt: number): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
      access_token: jwt({ exp: Math.floor(issuedAt / 1000) + 3600 }),
      refresh_token: refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date(issuedAt).toISOString(),
  });
}

const T0 = Date.UTC(2026, 9, 1);
const A0 = codexAuth('admin@volarehost.example', 'acct-admin', 'rt-admin-0', T0);
const A1 = codexAuth('admin@volarehost.example', 'acct-admin', 'rt-admin-1', T0 + 60_000);
const A2 = codexAuth('admin@volarehost.example', 'acct-admin', 'rt-admin-2', T0 + 120_000);
const B0 = codexAuth('retornoja@example.invalid', 'acct-retorno', 'rt-retorno-0', T0 + 30_000);

let home = '';
let db: Database.Database | null = null;

function nativeAuthFile(): string {
  return path.join(home, '.codex', 'auth.json');
}

function managedAuthFile(accountId: string): string {
  return path.join(home, '.nexus', 'managed-accounts', 'codex', accountId, 'home', 'auth.json');
}

function writeNative(blob: string): void {
  fs.mkdirSync(path.dirname(nativeAuthFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(nativeAuthFile(), blob, { mode: 0o600 });
}

function refreshTokenOf(blob: string): string {
  return (JSON.parse(blob) as { tokens: { refresh_token: string } }).tokens.refresh_token;
}

/**
 * O que o `codex login` faz no ~/.codex (comportamento medido do 0.162):
 * revoga no servidor e apaga o login que encontrar, depois grava o novo.
 */
function codexLogin(next: string, revoked: string[]): void {
  try {
    revoked.push(refreshTokenOf(fs.readFileSync(nativeAuthFile(), 'utf8')));
    fs.unlinkSync(nativeAuthFile());
  } catch {
    // Vaga vazia: nada para revogar.
  }
  writeNative(next);
}

/** Conta salva pelo caminho real (sessão nativa → cofre + home gerenciado). */
function saveNativeAs(blob: string, label: string): string {
  writeNative(blob);
  const account = addActiveSessionAccount('codex', label);
  if (!account) throw new Error('sessão Codex não foi salva');
  return account.id;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-login-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  deps.secrets.clear();
  deps.unreadable.clear();
  db = new Database(':memory:');
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
      active         INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL
    );
  `);
  initAccountStore(db as unknown as Db);
  // Estado de módulo de um teste anterior não pode vazar para este.
  restoreCodexNativeLogin();
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    db?.close();
  } catch {
    // Já fechado.
  }
  db = null;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('login de outra conta Codex no terminal do Nexus', () => {
  it('logar na conta B não revoga a conta A já salva, e A fica com a renovação mais nova', () => {
    const adminId = saveNativeAs(A0, 'admin@volarehost.example');
    // A CLI do operador renovou a sessão depois do snapshot: o cofre e o home
    // gerenciado ainda guardam o refresh token anterior.
    writeNative(A1);

    expect(prepareCodexNativeLogin()).toEqual({ ok: true });
    const revoked: string[] = [];
    codexLogin(B0, revoked);
    // A vaga saiu vazia: o `codex login` não encontrou o que revogar. Antes,
    // ele revogava `rt-admin-1`, a mesma linhagem que o Nexus guardou de A.
    expect(revoked).toEqual([]);
    // E a cópia que A guarda é a renovação mais nova, não a consumida.
    expect(deps.secrets.get(CRED + adminId)).toBe(A1);
    expect(fs.readFileSync(managedAuthFile(adminId), 'utf8')).toBe(A1);

    const retornoId = addActiveSessionAccount('codex', 'retornoja@example.invalid')!.id;
    expect(retornoId).not.toBe(adminId);
    expect(listAccounts('codex')).toHaveLength(2);
    expect(refreshTokenOf(deps.secrets.get(CRED + adminId)!)).toBe('rt-admin-1');
    expect(refreshTokenOf(fs.readFileSync(managedAuthFile(adminId), 'utf8'))).toBe('rt-admin-1');
    expect(refreshTokenOf(deps.secrets.get(CRED + retornoId)!)).toBe('rt-retorno-0');

    // Login concluído: a devolução nunca sobrescreve a sessão nova.
    expect(restoreCodexNativeLogin()).toBe(true);
    expect(fs.readFileSync(nativeAuthFile(), 'utf8')).toBe(B0);
  });

  it('login cancelado devolve a sessão anterior à vaga nativa, com permissão 0600', () => {
    saveNativeAs(A0, 'admin@volarehost.example');
    expect(prepareCodexNativeLogin()).toEqual({ ok: true });
    expect(fs.existsSync(nativeAuthFile())).toBe(false);

    expect(restoreCodexNativeLogin()).toBe(true);
    expect(fs.readFileSync(nativeAuthFile(), 'utf8')).toBe(A0);
    if (process.platform !== 'win32') {
      expect(fs.statSync(nativeAuthFile()).mode & 0o777).toBe(0o600);
    }
    // Uma devolução só: a segunda chamada não tem o que fazer.
    expect(restoreCodexNativeLogin()).toBe(false);
  });

  it('se a conta renovou no home gerenciado durante o login, volta a cópia renovada, não a consumida', () => {
    const adminId = saveNativeAs(A0, 'admin@volarehost.example');
    expect(prepareCodexNativeLogin()).toEqual({ ok: true });
    // Pane ou sonda de cota renovou a linhagem no home gerenciado.
    fs.writeFileSync(managedAuthFile(adminId), A2, { mode: 0o600 });

    expect(restoreCodexNativeLogin()).toBe(true);
    expect(refreshTokenOf(fs.readFileSync(nativeAuthFile(), 'utf8'))).toBe('rt-admin-2');
  });

  it('sessão nativa sem conta salva sai da vaga sem virar conta e volta no cancelamento', () => {
    saveNativeAs(B0, 'retornoja@example.invalid');
    writeNative(A0);

    expect(prepareCodexNativeLogin()).toEqual({ ok: true });
    expect(fs.existsSync(nativeAuthFile())).toBe(false);
    expect(listAccounts('codex').map((account) => account.email)).toEqual([
      'retornoja@example.invalid',
    ]);

    expect(restoreCodexNativeLogin()).toBe(true);
    expect(fs.readFileSync(nativeAuthFile(), 'utf8')).toBe(A0);
  });

  it('cofre ilegível falha fechado: a sessão nativa fica onde está e o login não abre', () => {
    const adminId = saveNativeAs(A0, 'admin@volarehost.example');
    writeNative(A1);
    deps.unreadable.add(CRED + adminId);

    const result = prepareCodexNativeLogin();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sessão atual do Codex/);
    expect(fs.readFileSync(nativeAuthFile(), 'utf8')).toBe(A1);
    expect(restoreCodexNativeLogin()).toBe(false);
  });

  it('auth.json que é link (dotfiles) sai como link e volta como o mesmo link', () => {
    if (process.platform === 'win32') return;
    const target = path.join(home, 'dotfiles', 'codex-auth.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, A0, { mode: 0o600 });
    fs.mkdirSync(path.dirname(nativeAuthFile()), { recursive: true });
    fs.symlinkSync(target, nativeAuthFile());

    expect(prepareCodexNativeLogin()).toEqual({ ok: true });
    expect(fs.lstatSync(nativeAuthFile(), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(target, 'utf8')).toBe(A0);

    expect(restoreCodexNativeLogin()).toBe(true);
    expect(fs.lstatSync(nativeAuthFile()).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(nativeAuthFile())).toBe(target);
  });

  it('sem login nativo não há o que preparar nem devolver', () => {
    expect(prepareCodexNativeLogin()).toEqual({ ok: true });
    expect(restoreCodexNativeLogin()).toBe(false);
    expect(fs.existsSync(nativeAuthFile())).toBe(false);
  });
});

describe('duas pessoas do mesmo workspace Codex (Team/Business)', () => {
  it('entrar na segunda pessoa cria a conta dela e não sobrescreve a primeira', () => {
    // O account_id é o workspace: as duas pessoas o compartilham.
    const admin = codexAuth('admin@volarehost.example', 'ws-team', 'rt-admin', T0);
    const colleague = codexAuth('retornoja@example.invalid', 'ws-team', 'rt-colleague', T0 + 60_000);
    const adminId = saveNativeAs(admin, 'admin@volarehost.example');

    expect(prepareCodexNativeLogin()).toEqual({ ok: true });
    codexLogin(colleague, []);
    const colleagueId = addActiveSessionAccount('codex', 'retornoja@example.invalid')!.id;

    expect(colleagueId).not.toBe(adminId);
    expect(listAccounts('codex').map((account) => account.email).sort()).toEqual([
      'admin@volarehost.example',
      'retornoja@example.invalid',
    ]);
    expect(refreshTokenOf(deps.secrets.get(CRED + adminId)!)).toBe('rt-admin');
    expect(refreshTokenOf(fs.readFileSync(managedAuthFile(adminId), 'utf8'))).toBe('rt-admin');
    expect(refreshTokenOf(deps.secrets.get(CRED + colleagueId)!)).toBe('rt-colleague');
  });
});
