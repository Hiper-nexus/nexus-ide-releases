import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from 'vite';
import mainConfig, { assertReleaseLicenseKey } from './vite.main.config';

describe('release license key gate', () => {
  it('fails release builds without a usable Ed25519 public key, but allows dev', () => {
    expect(() => assertReleaseLicenseKey('production', undefined)).toThrow(/NEXUS_LICENSE_PUBKEY/);
    expect(() => assertReleaseLicenseKey('production', 'bad pem')).toThrow(/NEXUS_LICENSE_PUBKEY/);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => assertReleaseLicenseKey('production', rsa)).toThrow(/Ed25519/);
    expect(() => assertReleaseLicenseKey('development', undefined)).not.toThrow();
    const pair = crypto.generateKeyPairSync('ed25519');
    expect(() => assertReleaseLicenseKey('production', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toThrow(/public key/);
    const key = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => assertReleaseLicenseKey('production', key)).not.toThrow();
  });
});


it('enforces the key gate through the real Vite production config, without breaking dev', async () => {
  vi.stubEnv('NEXUS_LICENSE_PUBKEY', '');
  try {
    await expect(resolveConfig({ ...mainConfig, configFile: false, mode: 'production' }, 'build')).rejects.toThrow(/NEXUS_LICENSE_PUBKEY/);
    await expect(resolveConfig({ ...mainConfig, configFile: false, mode: 'development' }, 'build')).resolves.toMatchObject({ mode: 'development' });
  } finally { vi.unstubAllEnvs(); }
});
