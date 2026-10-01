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

import { getClefApiToken, hasClefCredential, resolveClefApiToken, setClefApiToken, maskedClefApiToken } from './clef-secrets';

describe('Clef credentials', () => {
  beforeEach(() => {
    vault.data.clear(); vault.read.mockClear(); delete process.env.CLOUDFLARE_API_TOKEN;
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
    process.env.CLOUDFLARE_API_TOKEN = 'env-token';
    expect(resolveClefApiToken()).toBe('env-token');
    setClefApiToken('stored-token');
    expect(resolveClefApiToken()).toBe('stored-token');
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
});
