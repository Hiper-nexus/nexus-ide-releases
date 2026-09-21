import { expect, it, vi } from 'vitest';
import { resolveVerifiedNativeClaudeToken } from './claude-native-account';

const credential = JSON.stringify({ claudeAiOauth: { accessToken: 'native-access', expiresAt: 4_000_000_000_000 } });
const response = (email: string) => ({ ok: true, status: 200, json: async () => ({ account: { uuid: 'native-id', email } }), text: async () => '' });

it('recovers native quota only after the server proves the saved account email', async () => {
  const options = { readCredential: async () => credential, fetchImpl: vi.fn(async () => response('Owner@Example.test')) };
  expect(await resolveVerifiedNativeClaudeToken('owner@example.test', options)).toBe('native-access');
  expect(await resolveVerifiedNativeClaudeToken('other@example.test', options)).toBeNull();
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
