import crypto from 'node:crypto';
export const LICENSE_NOW = Date.parse('2026-09-30T12:00:00.000Z');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
export const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
export function licenseFixture(overrides: Record<string, unknown> = {}): string {
  const access = overrides.access ?? 'trial';
  const blocked = access === 'suspended' || access === 'inactive';
  const claims = {
    sub: 'account-a', iss: 'https://api.nexuside.app', aud: 'nexus-desktop',
    iat: LICENSE_NOW / 1000, exp: LICENSE_NOW / 1000 + (blocked ? 300 : 3600),
    plan: blocked ? 'free' : 'pro', status: blocked ? 'none' : 'active', email: 'a@example.test',
    renewsAt: null, graceUntil: null, access, trialEndsAt: '2026-10-15T12:00:00.000Z',
    limits: { maxAgents: blocked ? 0 : access === 'pro' ? null : 2, cloudSync: access === 'pro' }, ...overrides,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.${crypto.sign(null, Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
}
