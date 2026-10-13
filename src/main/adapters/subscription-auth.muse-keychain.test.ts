import { describe, expect, it, vi } from 'vitest';
import {
  MUSE_KEYCHAIN_SERVICE,
  museAuthBlobIsUsable,
  museKeychainDelegatedProviders,
  museKeychainItemExists,
  museKeychainSessionExists,
  resetMuseKeychainCache,
} from './subscription-auth';

/**
 * Regressão de campo (21/09): Muse Spark logado e operacional, exibido como
 * «não verificado».
 *
 * O `auth.json` do Muse guarda só a IDENTIDADE quando
 * `credential_backend: keychain`; o segredo vai para o item
 * `ai.meta.dev.credentials`, cuja CONTA é o nome do provider. O detector
 * exigia um token dentro do arquivo, não achava, e parava em «unknown».
 *
 * Formato exatamente como o da máquina de campo.
 */
const KEYCHAIN_BACKED = JSON.stringify({
  schema_version: 2,
  providers: {
    meta: {
      mechanism: 'oauth',
      obtained_via: 'device_code',
      api_base_url: 'https://api.meta.ai/v1',
      user_full_name: 'Cleofas Rocha',
      user_email: 'user@example.com',
      storage: 'keychain',
    },
  },
});

const FILE_BACKED = JSON.stringify({
  schema_version: 2,
  providers: { meta: { mechanism: 'api_key', api_key: 'sk-live', storage: 'file' } },
});

const LOGGED_OUT = JSON.stringify({ schema_version: 2, providers: {} });

describe('Muse keychain-delegated session', () => {
  it('names the providers whose secret lives in the Keychain', () => {
    expect(museKeychainDelegatedProviders(KEYCHAIN_BACKED)).toEqual(['meta']);
    // Token no arquivo não é delegação.
    expect(museKeychainDelegatedProviders(FILE_BACKED)).toEqual([]);
    expect(museKeychainDelegatedProviders(LOGGED_OUT)).toEqual([]);
    for (const junk of ['', 'not json', '{}', '[]', 'null']) {
      expect(museKeychainDelegatedProviders(junk)).toEqual([]);
    }
  });

  it('proves the session when the item exists for that provider account', () => {
    const asked: Array<string> = [];
    const exists = museKeychainSessionExists(KEYCHAIN_BACKED, {
      museKeychainProbe: (account) => {
        asked.push(account);
        return true;
      },
    });
    expect(exists).toBe(true);
    // A conta do item é o NOME DO PROVIDER, não o e-mail nem um literal.
    expect(asked).toEqual(['meta']);
  });

  it('stays honest when the item is absent (really logged out)', () => {
    expect(
      museKeychainSessionExists(KEYCHAIN_BACKED, { museKeychainProbe: () => false }),
    ).toBe(false);
  });

  it('never touches the Keychain when the caller opts out', () => {
    expect(
      museKeychainSessionExists(KEYCHAIN_BACKED, {
        probeMuseKeychain: false,
        museKeychainProbe: () => {
          throw new Error('must not probe');
        },
      }),
    ).toBe(false);
  });

  it('does not probe at all when nothing is delegated', () => {
    const probe = () => {
      throw new Error('must not probe');
    };
    expect(museKeychainSessionExists(FILE_BACKED, { museKeychainProbe: probe })).toBe(false);
    expect(museKeychainSessionExists(LOGGED_OUT, { museKeychainProbe: probe })).toBe(false);
  });

  it('keeps the file-token path independent of the Keychain', () => {
    expect(museAuthBlobIsUsable(FILE_BACKED)).toBe(true);
    expect(museAuthBlobIsUsable(KEYCHAIN_BACKED)).toBe(false);
    expect(museAuthBlobIsUsable(LOGGED_OUT)).toBe(false);
  });

  it('pins the service name the Muse binary uses', () => {
    expect(MUSE_KEYCHAIN_SERVICE).toBe('ai.meta.dev.credentials');
  });
});

describe.skipIf(process.platform !== 'darwin')('Muse keychain item probe throttle', () => {
  function execFailing(status: number) {
    return vi.fn(() => {
      throw Object.assign(new Error('security failed'), { status });
    }) as unknown as typeof import('node:child_process').execFileSync;
  }

  it('does not re-run `security` after an ACL denial (dialog shown once, then backoff)', () => {
    resetMuseKeychainCache();
    const execImpl = execFailing(51);
    let clock = 10_000;
    expect(museKeychainItemExists('meta', execImpl, () => clock)).toBe(false);
    clock += 60_000;
    expect(museKeychainItemExists('meta', execImpl, () => clock)).toBe(false);
    expect(execImpl).toHaveBeenCalledTimes(1);
  });

  it('re-probes when the item is simply absent (44: no dialog; a fresh login must appear)', () => {
    resetMuseKeychainCache();
    const execImpl = vi.fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('not found'), { status: 44 });
      })
      .mockImplementationOnce(() => Buffer.from('')) as unknown as typeof import('node:child_process').execFileSync;
    const clock = 20_000;
    expect(museKeychainItemExists('meta', execImpl, () => clock)).toBe(false);
    expect(museKeychainItemExists('meta', execImpl, () => clock)).toBe(true);
    expect(execImpl).toHaveBeenCalledTimes(2);
  });

  it('serves a confirmed item from the memo instead of re-running `security`', () => {
    resetMuseKeychainCache();
    const execImpl = vi.fn(() => Buffer.from('')) as unknown as typeof import('node:child_process').execFileSync;
    let clock = 30_000;
    expect(museKeychainItemExists('meta', execImpl, () => clock)).toBe(true);
    clock += 30_000;
    expect(museKeychainItemExists('meta', execImpl, () => clock)).toBe(true);
    expect(execImpl).toHaveBeenCalledTimes(1);
  });
});
