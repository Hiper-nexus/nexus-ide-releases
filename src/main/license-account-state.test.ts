import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindLicenseAccount, persistLicenseSeal, readLicenseAccountState, invalidateLicenseAccountBinding } from './license-account-state';
import { bindAuthenticatedAccount, getAuthenticatedAccountId, restoreAuthenticatedAccount } from './auth-client';
const now = Date.parse('2026-09-30T12:00:00.000Z');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());
function store() {
  const values = new Map([['auth:session', 'session-a']]);
  return { values, hasSecret: (key: string) => values.has(key), hasCachedSecret: (key: string) => values.has(key), getSecret: (key: string) => values.get(key) ?? null,
    setInternalSecret: vi.fn((key: string, value: string) => { values.set(key, value); return { ok: true }; }) };
}
it.each(['removed-floor', 'invalid-floor', 'removed-record', 'legacy'])('H1: %s cannot retain authenticated offline access', async kind => {
  const vault = store(); bindLicenseAccount('account-a', 'session-a', vault);
  persistLicenseSeal(vault, { clockFloor: now, latestIat: now / 1000, revokedAt: null, needsOnlineValidation: false });
  const raw = JSON.parse(vault.getSecret('auth:account')!);
  if (kind === 'removed-floor') delete raw.state.accounts['account-a'].clockFloor;
  if (kind === 'invalid-floor') raw.state.accounts['account-a'].clockFloor = 'invalid';
  vault.values.set('auth:account', kind === 'legacy' ? JSON.stringify({ id: 'account-a', sessionHash: raw.state.binding.sessionHash }) : JSON.stringify(raw));
  if (kind === 'removed-record') vault.values.delete('auth:account');
  expect(getAuthenticatedAccountId(vault)).toBeNull();
  const api = vi.fn().mockResolvedValue({ status: 0, json: null });
  await restoreAuthenticatedAccount({ store: vault, api });
  expect(api).toHaveBeenCalledWith('/v1/me');
  expect(getAuthenticatedAccountId(vault)).toBeNull();
});
it('H1/H2: changing a syntactically valid floor or emission invalidates the binding MAC', () => {
  const vault = store(); bindLicenseAccount('account-a', 'session-a', vault);
  persistLicenseSeal(vault, { clockFloor: now, latestIat: now / 1000, revokedAt: now / 1000, needsOnlineValidation: false });
  const raw = JSON.parse(vault.getSecret('auth:account')!);
  raw.state.accounts['account-a'] = { clockFloor: now - 1000, latestIat: 0, revokedAt: null, needsOnlineValidation: false };
  vault.values.set('auth:account', JSON.stringify(raw));
  expect(readLicenseAccountState(vault)).toBeNull();
});
it('refresh rebinds the MAC to the rotated session without losing the clock or revocation fence', () => {
  const vault = store(); bindLicenseAccount('account-a', 'session-a', vault);
  const seal = { clockFloor: now, latestIat: now / 1000, revokedAt: now / 1000, needsOnlineValidation: false };
  persistLicenseSeal(vault, seal);
  vault.values.set('auth:session', 'session-b');
  expect(bindAuthenticatedAccount('account-a', 'session-b', vault, 'session-a').ok).toBe(true);
  expect(readLicenseAccountState(vault)?.seal).toEqual({ ...seal, needsOnlineValidation: true });
  expect(readLicenseAccountState(vault, 'session-a')).toBeNull();
});
it('a refused vault write never fabricates a sealed account', () => {
  const vault = store(); vault.setInternalSecret.mockReturnValue({ ok: false });
  expect(bindLicenseAccount('account-a', 'session-a', vault).ok).toBe(false);
  expect(readLicenseAccountState(vault)).toBeNull();
});

it('F-228: seal key on disk but decrypt-denied fails closed — never regenerates', () => {
  const disk = new Map([['auth:session', 'session-a'], ['auth:license-seal-key', 'a'.repeat(64)]]);
  const cache = new Map([['auth:session', 'session-a']]);
  const vault = {
    hasSecret: (key: string) => disk.has(key),
    hasCachedSecret: (key: string) => cache.has(key),
    getSecret: (key: string) => cache.get(key) ?? null,
    setInternalSecret: vi.fn((key: string, value: string) => { cache.set(key, value); disk.set(key, value); return { ok: true }; }),
  };
  expect(bindLicenseAccount('account-a', 'session-a', vault)).toEqual({ ok: false, error: 'seal-key-unavailable' });
  expect(vault.setInternalSecret).not.toHaveBeenCalledWith('auth:license-seal-key', expect.anything());
  expect(disk.get('auth:license-seal-key')).toBe('a'.repeat(64));
});
it('F-228: missing seal key is still created on first bind', () => {
  const vault = store();
  expect(bindLicenseAccount('account-a', 'session-a', vault).ok).toBe(true);
  expect(vault.setInternalSecret).toHaveBeenCalledWith('auth:license-seal-key', expect.stringMatching(/^[a-f0-9]{64}$/));
});
it('H2: switching accounts preserves each account emission and revocation history', () => {
  const vault = store(); bindLicenseAccount('account-a', 'session-a', vault);
  persistLicenseSeal(vault, { clockFloor: now, latestIat: now / 1000, revokedAt: now / 1000, needsOnlineValidation: false });
  vault.values.set('auth:session', 'session-b');
  bindAuthenticatedAccount('account-b', 'session-b', vault, 'session-a');
  vault.values.set('auth:session', 'session-c');
  bindAuthenticatedAccount('account-a', 'session-c', vault, 'session-b');
  expect(readLicenseAccountState(vault)?.seal.latestIat).toBe(now / 1000);
  expect(readLicenseAccountState(vault)?.seal.revokedAt).toBe(now / 1000);
});


it('H2: logout keeps revocation history while removing authenticated access', () => {
  const vault = store(); bindLicenseAccount('account-a', 'session-a', vault);
  persistLicenseSeal(vault, { clockFloor: now, latestIat: now / 1000, revokedAt: now / 1000, needsOnlineValidation: false });
  expect(invalidateLicenseAccountBinding(vault).ok).toBe(true);
  expect(getAuthenticatedAccountId(vault)).toBeNull();
  vault.values.set('auth:session', 'new-session');
  bindAuthenticatedAccount('account-a', 'new-session', vault);
  expect(readLicenseAccountState(vault)?.seal).toMatchObject({ latestIat: now / 1000, revokedAt: now / 1000, needsOnlineValidation: true });
});
