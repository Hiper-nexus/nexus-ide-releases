import { describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  owners: [] as Array<{ account_id: string | null }>,
  deletes: [] as unknown[][],
  deleteChanges: 1,
}));
vi.mock('./db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => db.owners,
      run: (...args: unknown[]) => {
        if (/^\s*DELETE FROM provider_pane_sessions/.test(sql)) db.deletes.push([sql, ...args]);
        return { changes: db.deleteChanges };
      },
    }),
  }),
}));
import { forgetProviderSessionById, providerSessionAccountIsCompatible, sessionBelongsToAccount } from './provider-session-store';

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
