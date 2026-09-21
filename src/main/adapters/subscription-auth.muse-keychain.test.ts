import { describe, expect, it } from 'vitest';
import {
  MUSE_KEYCHAIN_SERVICE,
  museAuthBlobIsUsable,
  museKeychainDelegatedProviders,
  museKeychainSessionExists,
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
