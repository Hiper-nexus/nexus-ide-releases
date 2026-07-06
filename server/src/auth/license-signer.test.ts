import { describe, expect, it } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import {
  freeLicenseInput,
  signLicense,
  verifyLicense,
} from './license-signer';

async function keypair() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  return {
    priv: await exportPKCS8(privateKey),
    pub: await exportSPKI(publicKey),
  };
}

describe('license-signer', () => {
  it('assina e verifica; Free por padrão; exp ~30d', async () => {
    const { priv, pub } = await keypair();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const now = () => nowSeconds;
    const jwt = await signLicense(freeLicenseInput('a@b.com'), priv, now);
    const payload = await verifyLicense(jwt, pub);
    expect(payload?.plan).toBe('free');
    expect(payload?.email).toBe('a@b.com');
    expect(payload?.exp).toBe(nowSeconds + 30 * 24 * 3600);
    expect(payload?.graceUntil).toBeNull();
  });

  it('assinatura de outra chave é rejeitada (null)', async () => {
    const a = await keypair();
    const b = await keypair();
    const jwt = await signLicense(freeLicenseInput('x@y.com'), a.priv);
    expect(await verifyLicense(jwt, b.pub)).toBeNull();
  });

  it('token expirado verifica como null', async () => {
    const { priv, pub } = await keypair();
    const past = () => 1_000;
    const jwt = await signLicense(freeLicenseInput('z@z.com'), priv, past);
    expect(await verifyLicense(jwt, pub)).toBeNull();
  });
});
