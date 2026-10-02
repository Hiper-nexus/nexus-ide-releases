import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const data = new Map<string, string>();
  return {
    data,
    getSecret: vi.fn((key: string) => data.get(key) ?? null),
    hasSecret: vi.fn((key: string) => data.has(key)),
    setSecret: vi.fn((key: string, value: string) => {
      if (value === '') {
        data.delete(key);
      } else {
        data.set(key, value);
      }
      return { ok: true };
    }),
    isSecureStorageAvailable: vi.fn(() => true),
  };
});

vi.mock('../persistence/secrets-store', () => ({
  getSecret: store.getSecret,
  hasSecret: store.hasSecret,
  setSecret: store.setSecret,
  isSecureStorageAvailable: store.isSecureStorageAvailable,
}));

import {
  getJevApiKey,
  hasJevCredential,
  hasStoredJevApiKey,
  isJevSecretStorageAvailable,
  jevApiKeySource,
  maskedJevApiKey,
  resolveJevApiKey,
  setJevApiKey,
} from './jev-secrets';

import { decisionCredentialRevision } from '../decision-models/decision-revision';

const ENV_VAR = 'TYPESAFE_API_KEY';

describe('jev-secrets', () => {
  beforeEach(() => {
    store.data.clear();
    vi.clearAllMocks();
    delete process.env[ENV_VAR];
  });

  it('set/get/has roundtrip via the vault prefix', () => {
    expect(hasStoredJevApiKey()).toBe(false);
    setJevApiKey('apikey_test_123456');
    expect(hasStoredJevApiKey()).toBe(true);
    expect(getJevApiKey()).toBe('apikey_test_123456');
    expect(store.data.has('jev-env:TYPESAFE_API_KEY')).toBe(true);
  });

  it('resolveJevApiKey prefere o cofre e cai para o env', () => {
    process.env[ENV_VAR] = 'env-key';
    expect(resolveJevApiKey()).toBe('env-key');
    setJevApiKey('stored-key');
    expect(resolveJevApiKey()).toBe('stored-key');
  });

  it('resolveJevApiKey retorna undefined sem credencial', () => {
    expect(resolveJevApiKey()).toBeUndefined();
    expect(hasJevCredential()).toBe(false);
  });

  it('hasJevCredential aceita env sem chave armazenada', () => {
    process.env[ENV_VAR] = 'env-key';
    expect(hasJevCredential()).toBe(true);
  });

  it('jevApiKeySource distingue stored/env/missing sem descriptografar', () => {
    expect(jevApiKeySource()).toBe('missing');
    process.env[ENV_VAR] = 'env-key';
    expect(jevApiKeySource()).toBe('env');
    store.data.set('jev-env:TYPESAFE_API_KEY', 'enc-blob');
    expect(jevApiKeySource()).toBe('stored');
    expect(store.getSecret).not.toHaveBeenCalled();
    expect(store.hasSecret).toHaveBeenCalled();
  });

  it('maskedJevApiKey mostra só bordas', () => {
    expect(maskedJevApiKey()).toBeNull();
    setJevApiKey('short');
    expect(maskedJevApiKey()).toBe('••••');
    setJevApiKey('apikey_abcdefghij');
    expect(maskedJevApiKey()).toBe('api…ghij');
  });

  it('empty string clears the stored key', () => {
    setJevApiKey('apikey_test_123456');
    setJevApiKey('');
    expect(hasStoredJevApiKey()).toBe(false);
  });

  it('isJevSecretStorageAvailable usa probe: false', () => {
    expect(isJevSecretStorageAvailable()).toBe(true);
    expect(store.isSecureStorageAvailable).toHaveBeenCalledWith({ probe: false });
  });
});

describe('Jev key changes invalidate in-flight decisions', () => {
  it('bumps the decision revision when the key is stored, rotated or removed — and only when the vault accepted it', () => {
    const before = decisionCredentialRevision();
    expect(setJevApiKey('first-key')).toEqual({ ok: true });
    expect(setJevApiKey('rotated-key')).toEqual({ ok: true });
    expect(setJevApiKey('')).toEqual({ ok: true });
    expect(decisionCredentialRevision()).toBe(before + 3);
    store.setSecret.mockReturnValueOnce({ ok: false, error: 'vault locked' } as never);
    expect(setJevApiKey('rejected').ok).toBe(false);
    expect(decisionCredentialRevision()).toBe(before + 3);
  });
});
