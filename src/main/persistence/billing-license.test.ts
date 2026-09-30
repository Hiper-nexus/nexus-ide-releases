import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLicenseToken } from './billing-license';
import { licenseFixture, LICENSE_NOW, publicKeyPem } from '../../test/license-fixture';

const options = { publicKeyPem, issuer: 'https://api.nexuside.app', now: () => LICENSE_NOW };
describe('desktop license verification', () => {
  it.each(['trial', 'pro', 'suspended', 'inactive'] as const)('verifies %s claims without converting none to active', access => {
    const result = verifyLicenseToken(licenseFixture({ access }), options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.access).toBe(access);
  });
  it.each([
    { exp: undefined }, { iat: undefined }, { iat: '123' }, { exp: '123' },
    { exp: LICENSE_NOW / 1000 }, { exp: LICENSE_NOW / 1000 - 1 },
    { exp: LICENSE_NOW / 1000 + 86401 }, { iat: LICENSE_NOW / 1000 + 1 },
    { iss: 'https://attacker.test' }, { aud: 'other' }, { sub: '' },
    { nbf: LICENSE_NOW / 1000 + 1 }, { nbf: 'tomorrow' }, { access: undefined },
    { access: ['trial'] }, { plan: ['pro'] }, { status: ['active'] },
    { access: 'free' }, { limits: undefined }, { limits: { maxAgents: -1, cloudSync: true } },
    { limits: { maxAgents: 1.5, cloudSync: true } }, { limits: { maxAgents: null, cloudSync: 'true' } },
    { trialEndsAt: 'yesterday' }, { trialEndsAt: null }, { renewsAt: '2026-02-30T00:00:00.000Z' },
    { graceUntil: 123 }, { plan: 'free' }, { status: 'none' }, { email: 42 },
    { access: 'suspended', exp: LICENSE_NOW / 1000 + 301 },
  ])('rejects incomplete or invalid claims: %j', claims => {
    expect(verifyLicenseToken(licenseFixture(claims), options).ok).toBe(false);
  });
  it('rejects missing/unusable pinned key, wrong key, tampering and unsupported algorithm', () => {
    const jwt = licenseFixture();
    expect(verifyLicenseToken(jwt, { ...options, publicKeyPem: '' })).toMatchObject({ ok: false, reason: 'verification-unavailable' });
    const pair = crypto.generateKeyPairSync('ed25519');
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(verifyLicenseToken(jwt, { ...options, publicKeyPem: privatePem })).toMatchObject({ ok: false, reason: 'verification-unavailable' });
    const other = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyLicenseToken(jwt, { ...options, publicKeyPem: other }).ok).toBe(false);
    expect(verifyLicenseToken(jwt.replace(jwt.split('.')[1], Buffer.from('{"plan":"pro"}').toString('base64url')), options).ok).toBe(false);
    expect(verifyLicenseToken('eyJhbGciOiJub25lIn0.e30.eA', options).ok).toBe(false);
  });
});
