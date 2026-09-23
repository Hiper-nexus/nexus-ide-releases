import { afterEach, expect, it, vi } from 'vitest';
import { probeClaudeCredentialIdentity, resolveClaudeCredentialProfile, resolveVerifiedNativeClaudeToken } from './claude-native-account';

const credential = JSON.stringify({ claudeAiOauth: { accessToken: 'native-access', expiresAt: 4_000_000_000_000 } });
const response = (email: string) => ({ ok: true, status: 200, json: async () => ({ account: { uuid: 'native-id', email } }), text: async () => '' });
afterEach(() => vi.unstubAllGlobals());

it('reuses a recent server identity proof through a transient profile 429 for the same token only', async () => {
  const verified = JSON.stringify({ claudeAiOauth: {
    accessToken: 'profile-cache-token-unique', expiresAt: 4_000_000_000_000,
  } });
  const fetchImpl = vi.fn(async () => response('owner@example.test'));
  vi.stubGlobal('fetch', fetchImpl);
  expect(await probeClaudeCredentialIdentity(verified, 'owner@example.test')).toBe('match');
  fetchImpl.mockImplementation(async () => ({ ...response('owner@example.test'), ok: false, status: 429 }));
  expect(await probeClaudeCredentialIdentity(verified, 'owner@example.test')).toBe('match');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const other = verified.replace('profile-cache-token-unique', 'different-cache-token');
  expect(await probeClaudeCredentialIdentity(other, 'owner@example.test')).toBe('unavailable');
  expect(await probeClaudeCredentialIdentity(verified.replace('4000000000000', '1'), 'owner@example.test')).toBe('auth-expired');
});

it('recovers native quota only after the server proves the saved account email', async () => {
  const options = { readCredential: async () => credential, fetchImpl: vi.fn(async () => response('Owner@Example.test')) };
  expect(await resolveVerifiedNativeClaudeToken('owner@example.test', options)).toBe('native-access');
  expect(await resolveVerifiedNativeClaudeToken('other@example.test', options)).toBeNull();
});

it('returns the provider profile identity for an explicit Claude account capture', async () => {
  expect(await resolveClaudeCredentialProfile(credential, {
    fetchImpl: async () => response('Owner@Example.test'),
  })).toEqual({ email: 'owner@example.test', accountUuid: 'native-id' });
});

it.each([401, 429, 500])('does not borrow a token when profile proof fails with %i', async (status) => {
  expect(await resolveVerifiedNativeClaudeToken('owner@example.test', {
    readCredential: async () => credential,
    fetchImpl: async () => ({ ...response('owner@example.test'), ok: false, status }),
  })).toBeNull();
});

it('rejects malformed profiles and expired native access without rotating the grant', async () => {
  const fetchImpl = vi.fn(async () => ({ ...response('owner@example.test'), json: async () => ({ account: { email: 'owner@example.test' } }) }));
  expect(await resolveVerifiedNativeClaudeToken('owner@example.test', { readCredential: async () => credential, fetchImpl })).toBeNull();
  expect(await resolveVerifiedNativeClaudeToken('owner@example.test', {
    readCredential: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'expired', expiresAt: 1 } }), fetchImpl,
  })).toBeNull();
});

it('separates a wrong-account credential from an unavailable profile service', async () => {
  expect(await probeClaudeCredentialIdentity(credential, 'owner@example.test', {
    fetchImpl: async () => response('other@example.test'),
  })).toBe('mismatch');
  expect(await probeClaudeCredentialIdentity(credential, 'owner@example.test', {
    fetchImpl: async () => ({ ...response('owner@example.test'), ok: false, status: 429 }),
  })).toBe('unavailable');
  expect(await probeClaudeCredentialIdentity(credential, 'owner@example.test', {
    fetchImpl: async () => ({ ...response('owner@example.test'), ok: false, status: 401 }),
  })).toBe('auth-expired');
});

it('requires the provider account UUID to match before trusting a CLI usage cache', async () => {
  expect(await probeClaudeCredentialIdentity(credential, 'owner@example.test', {
    expectedAccountUuid: 'another-account',
    fetchImpl: async () => response('owner@example.test'),
  })).toBe('mismatch');
});
