import crypto from 'node:crypto';
import { LICENSE_BLOCKED_TTL_SECONDS, LICENSE_MAX_TTL_SECONDS, type DesktopLicenseClaims } from '../../../shared/contract';
import type { AccessBlockedReason } from '../../shared/billing-types';

export interface VerifyLicenseOptions {
  publicKeyPem: string | null;
  issuer: string;
  /** Epoch milliseconds. */
  now: () => number;
}
export type LicenseVerification =
  | { ok: true; claims: DesktopLicenseClaims }
  | { ok: false; reason: AccessBlockedReason };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000;
}
function date(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** Pure, Ed25519 only; no ambient key, clock, filesystem, session or network. */
export function verifyLicenseToken(token: unknown, opts: VerifyLicenseOptions): LicenseVerification {
  const invalid = { ok: false, reason: 'invalid-license' } as const;
  let key: crypto.KeyObject;
  try {
    if (!opts.publicKeyPem?.trim().startsWith('-----BEGIN PUBLIC KEY-----')) return { ok: false, reason: 'verification-unavailable' };
    key = crypto.createPublicKey(opts.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'verification-unavailable' };
  } catch { return { ok: false, reason: 'verification-unavailable' }; }
  if (typeof token !== 'string' || token.length > 16384) return invalid;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return invalid;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!record(header) || header.alg !== 'EdDSA' || header.crit !== undefined || header.b64 !== undefined) return invalid;
    if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return invalid;
    const c: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = opts.now() / 1000;
    if (!record(c) || !Number.isFinite(now) || !timestamp(c.exp) || !timestamp(c.iat) || c.iat > now || c.exp <= c.iat) return invalid;
    if (c.iss !== opts.issuer || c.aud !== 'nexus-desktop' || typeof c.sub !== 'string' || !c.sub.trim()) return invalid;
    if (c.nbf !== undefined && (!timestamp(c.nbf) || c.nbf > now || c.nbf >= c.exp)) return invalid;
    if (typeof c.access !== 'string' || !['trial', 'pro', 'suspended', 'inactive'].includes(c.access)) return invalid;
    const blocked = c.access === 'suspended' || c.access === 'inactive';
    if (c.exp - c.iat > (blocked ? LICENSE_BLOCKED_TTL_SECONDS : LICENSE_MAX_TTL_SECONDS)) return invalid;
    if (typeof c.plan !== 'string' || !['free', 'pro', 'team'].includes(c.plan) || typeof c.status !== 'string' || !['none', 'active', 'past_due'].includes(c.status)) return invalid;
    if (!blocked && (c.plan === 'free' || c.status === 'none')) return invalid;
    if (blocked && (c.plan !== 'free' || c.status !== 'none')) return invalid;
    if (c.email !== null && (typeof c.email !== 'string' || !c.email.trim())) return invalid;
    if (![c.renewsAt, c.graceUntil, c.trialEndsAt].every(date) || (c.access === 'trial' && c.trialEndsAt === null)) return invalid;
    if (!record(c.limits) || typeof c.limits.cloudSync !== 'boolean' ||
      (c.limits.maxAgents !== null && (!Number.isSafeInteger(c.limits.maxAgents) || (c.limits.maxAgents as number) < 0))) return invalid;
    if (now >= c.exp) return { ok: false, reason: 'license-expired' };
    return { ok: true, claims: c as unknown as DesktopLicenseClaims };
  } catch { return invalid; }
}
