import { describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ owners: [] as Array<{ account_id: string | null }> }));
vi.mock('./db', () => ({ getDb: () => ({ prepare: () => ({ all: () => db.owners }) }) }));
import { providerSessionAccountIsCompatible, sessionBelongsToAccount } from './provider-session-store';

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
