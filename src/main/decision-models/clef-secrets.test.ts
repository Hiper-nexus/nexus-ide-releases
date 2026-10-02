import { beforeEach, describe, expect, it, vi } from 'vitest';

const vault = vi.hoisted(() => ({
  data: new Map<string, string>(),
  read: vi.fn(),
}));
vi.mock('../persistence/secrets-store', () => ({
  getSecret: (name: string) => { vault.read(name); return vault.data.get(name) ?? null; },
  hasSecret: (name: string) => vault.data.has(name),
  setSecret: (name: string, value: string) => {
    if (value) vault.data.set(name, value); else vault.data.delete(name);
    return { ok: true };
  },
  isSecureStorageAvailable: () => true,
}));

import { decisionCredentialRevision } from './decision-revision';
import { getClefApiToken, hasClefCredential, resolveClefApiToken, resolveCloudflareAccountId, setClefApiToken, maskedClefApiToken } from './clef-secrets';

describe('Clef credentials', () => {
  beforeEach(() => {
    vault.data.clear(); vault.read.mockClear();
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'NEXUS_CLEF_API_TOKEN', 'NEXUS_CLEF_ACCOUNT_ID']) delete process.env[name];
  });

  it('stores the Cloudflare token independently of the TypeSafe token', () => {
    vault.data.set('jev-env:TYPESAFE_API_KEY', 'existing-jev-key');
    expect(setClefApiToken('cloudflare-test-token-123456')).toEqual({ ok: true });
    expect(getClefApiToken()).toBe('cloudflare-test-token-123456');
    expect(vault.data.get('clef-env:CLOUDFLARE_API_TOKEN')).toBe('cloudflare-test-token-123456');
    setClefApiToken('');
    expect(getClefApiToken()).toBeNull();
    expect(vault.data.get('jev-env:TYPESAFE_API_KEY')).toBe('existing-jev-key');
  });

  it('resolves the encrypted vault before the inherited environment', () => {
    process.env.NEXUS_CLEF_API_TOKEN = 'env-token';
    expect(resolveClefApiToken()).toBe('env-token');
    setClefApiToken('stored-token');
    expect(resolveClefApiToken()).toBe('stored-token');
  });

  it('never adopts the ambient wrangler variables: their token has account-wide scope', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'wide-scope-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    expect(hasClefCredential()).toBe(false);
    expect(resolveClefApiToken()).toBeUndefined();
    expect(resolveCloudflareAccountId('')).toBeUndefined();
    process.env.NEXUS_CLEF_ACCOUNT_ID = 'fedcba9876543210fedcba9876543210';
    expect(resolveCloudflareAccountId('')).toBe('fedcba9876543210fedcba9876543210');
  });

  it('checks presence without decrypting tokens', () => {
    expect(hasClefCredential()).toBe(false);
    vault.data.set('clef-env:CLOUDFLARE_API_TOKEN', 'encrypted-token');
    expect(hasClefCredential()).toBe(true);
    expect(vault.read).not.toHaveBeenCalled();
  });

  it('exposes only a mask of an existing token', () => {
    setClefApiToken('cloudflare-test-token-123456');
    expect(maskedClefApiToken()).toBe('clo…3456');
    setClefApiToken('short');
    expect(maskedClefApiToken()).toBe('••••');
  });

  it('bumps the decision revision on every accepted token change', () => {
    const before = decisionCredentialRevision();
    setClefApiToken('first-token'); setClefApiToken('rotated-token'); setClefApiToken('');
    expect(decisionCredentialRevision()).toBe(before + 3);
  });
});
