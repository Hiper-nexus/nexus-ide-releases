import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  owners: [] as Array<{ account_id: string | null }>,
  deletes: [] as unknown[][],
  deleteChanges: 1,
  /** F-1473: SQLite real em memória para o religamento de conta. */
  real: null as Database.Database | null,
}));
vi.mock('./db', () => ({
  getDb: () => db.real ?? ({
    prepare: (sql: string) => ({
      all: () => db.owners,
      run: (...args: unknown[]) => {
        if (/^\s*DELETE FROM provider_pane_sessions/.test(sql)) db.deletes.push([sql, ...args]);
        return { changes: db.deleteChanges };
      },
    }),
  }),
}));
import {
  forgetProviderSessionById,
  getProviderPaneSession,
  providerSessionAccountIsCompatible,
  rebindProviderPaneSessionAccount,
  saveProviderPaneSession,
  sessionBelongsToAccount,
} from './provider-session-store';

describe('forgetProviderSessionById (F-721)', () => {
  const scope = { installationId: 'i', projectId: 'p', checkoutId: 'c' };

  it('apaga toda linha do projeto que aponta para o id que falhou (cada Retomar copia a linha), e só esse id', () => {
    db.deletes.length = 0;
    db.deleteChanges = 3;
    expect(forgetProviderSessionById(scope, 'claude', 'old-id')).toBe(3);
    const [sql, ...args] = db.deletes[0]!;
    expect(sql).toMatch(/AND adapter_id = \? AND session_id = \?/);
    expect(sql).not.toMatch(/pane_id/);
    expect(args).toEqual(['i', 'p', 'c', 'claude', 'old-id']);
  });

  it('devolve 0 quando não havia linha com esse id', () => {
    db.deleteChanges = 0;
    expect(forgetProviderSessionById(scope, 'claude', 'other')).toBe(0);
    db.deleteChanges = 1;
  });
});

describe('sessionBelongsToAccount', () => {
  it('refuses to rebind a persisted conversation to a different or unpinned account', () => {
    const scope = { installationId: 'i', projectId: 'p', checkoutId: 'c' } as Parameters<typeof providerSessionAccountIsCompatible>[0];
    db.owners = [];
    expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'ses', 'acct-a')).toBe(true);
    db.owners = [{ account_id: 'acct-a' }];
    expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'ses', 'acct-a')).toBe(true);
    expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'ses', 'acct-b')).toBe(false);
    expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'ses')).toBe(false);
    db.owners = [{ account_id: null }];
    expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'ses', 'acct-a')).toBe(false);
  });
  it('fail-closed: owned row without pin is denied', () => {
    expect(sessionBelongsToAccount('acc-a', undefined)).toBe(false);
    expect(sessionBelongsToAccount('acc-a', null)).toBe(false);
    expect(sessionBelongsToAccount('acc-a', '')).toBe(false);
  });

  it('fail-closed: pin without stored owner is denied', () => {
    expect(sessionBelongsToAccount(null, 'acc-b')).toBe(false);
    expect(sessionBelongsToAccount(undefined, 'acc-b')).toBe(false);
  });

  it('allows exact resume only when owners match', () => {
    expect(sessionBelongsToAccount('acc-b', 'acc-b')).toBe(true);
    expect(sessionBelongsToAccount('acc-a', 'acc-b')).toBe(false);
  });

  it('allows legacy unowned rows only when caller also has no pin', () => {
    expect(sessionBelongsToAccount(null, undefined)).toBe(true);
    expect(sessionBelongsToAccount(undefined, null)).toBe(true);
  });
});

describe('rebindProviderPaneSessionAccount (F-1473)', () => {
  const scope = { version: 1 as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/project', identitySource: 'manifest' as const };
  const worktree = { ...scope, checkoutId: 'c-worktree', rootRealPath: '/project-wt' };
  function realDb(): void {
    db.real = new Database(':memory:');
    db.real.exec(`CREATE TABLE provider_pane_sessions (
      installation_id TEXT, project_id TEXT, checkout_id TEXT, pane_id TEXT, adapter_id TEXT,
      session_key TEXT, session_id TEXT, transcript_path TEXT, updated_at INTEGER, account_id TEXT,
      PRIMARY KEY (installation_id, project_id, checkout_id, pane_id, adapter_id));`);
  }
  afterEach(() => { db.real?.close(); db.real = null; });

  it('Claude A → B: a conversa do pane passa a ser da conta B (todas as linhas do pane) e deixa de ser da A', () => {
    realDb();
    saveProviderPaneSession(scope, 'pane-1', 'claude', { key: 'session_id', id: 'ses-claude' }, 'acct-a');
    saveProviderPaneSession(worktree, 'pane-1', 'claude', { key: 'session_id', id: 'ses-claude' }, 'acct-a');
    expect(getProviderPaneSession(scope, 'pane-1', 'claude', 'acct-b')).toBeNull();
    expect(rebindProviderPaneSessionAccount(scope, 'pane-1', 'claude', 'acct-a', 'acct-b')).toBe(true);
    expect(getProviderPaneSession(scope, 'pane-1', 'claude', 'acct-b')?.id).toBe('ses-claude');
    expect(getProviderPaneSession(worktree, 'pane-1', 'claude', 'acct-b')?.id).toBe('ses-claude');
    expect(getProviderPaneSession(scope, 'pane-1', 'claude', 'acct-a')).toBeNull();
    // Repetir (rajada coalescida) é idempotente.
    expect(rebindProviderPaneSessionAccount(scope, 'pane-1', 'claude', 'acct-a', 'acct-b')).toBe(true);
  });

  it('login nativo (sem conta) → conta B também leva a conversa', () => {
    realDb();
    saveProviderPaneSession(scope, 'pane-native', 'claude', { key: 'session_id', id: 'ses-native' });
    expect(rebindProviderPaneSessionAccount(scope, 'pane-native', 'claude', undefined, 'acct-b')).toBe(true);
    expect(getProviderPaneSession(scope, 'pane-native', 'claude', 'acct-b')?.id).toBe('ses-native');
  });

  it('adapter sem histórico compartilhado (agy, codex) e adapter diferente nunca herdam a conversa', () => {
    realDb();
    saveProviderPaneSession(scope, 'pane-2', 'agy', { key: 'session_id', id: 'ses-agy' }, 'acct-a');
    saveProviderPaneSession(scope, 'pane-2', 'codex', { key: 'session_id', id: 'ses-codex' }, 'acct-a');
    saveProviderPaneSession(scope, 'pane-2', 'claude', { key: 'session_id', id: 'ses-claude' }, 'acct-a');
    expect(rebindProviderPaneSessionAccount(scope, 'pane-2', 'agy', 'acct-a', 'acct-b')).toBe(false);
    expect(rebindProviderPaneSessionAccount(scope, 'pane-2', 'codex', 'acct-a', 'acct-b')).toBe(false);
    expect(getProviderPaneSession(scope, 'pane-2', 'agy', 'acct-a')?.id).toBe('ses-agy');
    expect(getProviderPaneSession(scope, 'pane-2', 'codex', 'acct-a')?.id).toBe('ses-codex');
    // Religar o Claude não toca a linha de outro adapter do mesmo pane.
    expect(rebindProviderPaneSessionAccount(scope, 'pane-2', 'claude', 'acct-a', 'acct-b')).toBe(true);
    expect(getProviderPaneSession(scope, 'pane-2', 'codex', 'acct-b')).toBeNull();
    expect(getProviderPaneSession(scope, 'pane-2', 'codex', 'acct-a')?.id).toBe('ses-codex');
  });

  it('CAS: conversa de uma terceira conta não é tomada', () => {
    realDb();
    saveProviderPaneSession(scope, 'pane-3', 'claude', { key: 'session_id', id: 'ses-c' }, 'acct-c');
    expect(rebindProviderPaneSessionAccount(scope, 'pane-3', 'claude', 'acct-a', 'acct-b')).toBe(false);
    expect(getProviderPaneSession(scope, 'pane-3', 'claude', 'acct-c')?.id).toBe('ses-c');
  });
});
