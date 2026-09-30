/**
 * Sole Main access authority. Integration API for pane/PTY/mission/sync owners:
 * getAccessState(): LicenseState; requireAccess('use' | 'cloudSync'): AccessDecision;
 * maxAgents(): number | null (0 when blocked, null means unlimited);
 * applyLicenseToken(token: string): { ok: boolean; error?: string };
 * clearAccess(): void; onAccessChanged(listener: (state: LicenseState) => void): () => void.
 * Check at the mutation boundary, including after awaits. Renderer state is informational.
 * Logout must call clearAccess() before deleting session secrets (it also resets pending login).
 * Billing/auth/renewal stay available while blocked. No enforcement at spawn/sync sites here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_LICENSE, type AccessBlockedReason, type LicenseState } from '../shared/billing-types';
import { verifyLicenseToken } from './persistence/billing-license';
import { resolveBackendUrl } from './backend-url';

export type AccessDecision = { ok: true } | { ok: false; reason: AccessBlockedReason | 'cloud-sync-disabled' };
export interface LicenseAccessDeps {
  licensePath: string;
  publicKeyPem: () => string | null;
  issuer: () => string;
  accountId: () => string | null;
  now: () => number;
  monotonicNow: () => number;
  readClock: () => number;
  writeClock: (epochMs: number) => void;
}

export function createLicenseAccess(deps: LicenseAccessDeps) {
  let highWater = 0, lastMono = deps.monotonicNow(), persistedClock = 0;
  let sealedBoundary: string | undefined;
  let cleared = false;
  let revocationToken: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = JSON.stringify(DEFAULT_LICENSE);
  const listeners = new Set<(state: LicenseState) => void>();
  function now(): number {
    const mono = deps.monotonicNow();
    highWater = Math.max(deps.now(), deps.readClock(), highWater + Math.max(0, mono - lastMono));
    lastMono = mono;
    return highWater;
  }
  function sealClock(time: number, boundary?: string): void {
    // ponytail: seal at most once/minute, plus once per observed deadline.
    // A restart has only this sealed floor; no offline trusted clock exists.
    if (time - persistedClock < 60000 && (!boundary || boundary === sealedBoundary)) return;
    deps.writeClock(time);
    persistedClock = time;
    if (boundary) sealedBoundary = boundary;
  }
  function blocked(reason: AccessBlockedReason): LicenseState {
    return { ...DEFAULT_LICENSE, limits: { ...DEFAULT_LICENSE.limits }, blockedReason: reason };
  }
  function evaluate(): LicenseState {
    const account = deps.accountId();
    if (cleared || !account) return blocked('login-required');
    let raw: { token?: unknown };
    try {
      // Bound file size before parsing an operator-writable file.
      if (revocationToken) raw = { token: revocationToken };
      else {
        if (fs.statSync(deps.licensePath).size > 32768) return blocked('invalid-license');
        raw = JSON.parse(fs.readFileSync(deps.licensePath, 'utf8'));
      }
    } catch (error) {
      return blocked((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'login-required' : 'invalid-license');
    }
    const time = now();
    const result = verifyLicenseToken(raw?.token, { publicKeyPem: deps.publicKeyPem(), issuer: deps.issuer(), now: () => time });
    sealClock(time, !result.ok && result.reason === 'license-expired' ? `expired:${raw.token}` : undefined);
    if (!result.ok) return blocked(result.reason);
    const c = result.claims;
    if (c.sub !== account) return blocked('account-mismatch');
    const reason: AccessBlockedReason | null = c.access === 'suspended' || c.access === 'inactive' ? c.access :
      c.access === 'trial' && time >= Date.parse(c.trialEndsAt!) ? 'trial-ended' : null;
    if (reason === 'trial-ended') sealClock(time, `trial:${raw.token}`);
    return { plan: c.plan, email: c.email, status: c.status, renewsAt: c.renewsAt,
      verified: true, access: c.access, trialEndsAt: c.trialEndsAt, limits: { ...c.limits },
      expiresAt: new Date(c.exp * 1000).toISOString(), canUseApp: reason === null, blockedReason: reason };
  }
  function getAccessState(): LicenseState {
    const state = evaluate();
    const serialized = JSON.stringify(state);
    const changed = serialized !== previous;
    if (changed || (!timer && state.canUseApp)) {
      previous = serialized;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (state.canUseApp && state.expiresAt) {
        const deadline = Math.min(Date.parse(state.expiresAt), state.access === 'trial' ? Date.parse(state.trialEndsAt!) : Infinity);
        timer = setTimeout(() => { timer = undefined; getAccessState(); }, Math.max(1, deadline - now()));
        timer.unref?.();
      }
      if (changed) for (const listener of listeners) {
        try { listener(structuredClone(state)); }
        catch { /* An observer cannot change the access decision or starve other subscribers. */ }
      }
    }
    return state;
  }
  function applyLicenseToken(token: string): { ok: boolean; error?: string } {
    const account = deps.accountId();
    if (!account) return { ok: false, error: 'login-required' };
    const result = verifyLicenseToken(token, { publicKeyPem: deps.publicKeyPem(), issuer: deps.issuer(), now });
    if (!result.ok) return { ok: false, error: result.reason };
    if (result.claims.sub !== account) return { ok: false, error: 'account-mismatch' };
    const revoked = result.claims.access === 'suspended' || result.claims.access === 'inactive';
    // A full disk must never defer a verified revocation until the next restart.
    if (revoked) { revocationToken = token; cleared = false; }
    try {
      fs.mkdirSync(path.dirname(deps.licensePath), { recursive: true });
      const tmp = `${deps.licensePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, token }), { mode: 0o600 });
      fs.renameSync(tmp, deps.licensePath);
      revocationToken = revoked ? token : null;
      cleared = false;
      getAccessState();
      return { ok: true };
    } catch {
      getAccessState();
      return { ok: false, error: 'license-persistence-failed' };
    }
  }
  function clearAccess(): void {
    cleared = true;
    try { fs.unlinkSync(deps.licensePath); } catch { /* in-memory revocation wins even on disk failure */ }
    getAccessState();
  }
  return {
    getAccessState, applyLicenseToken, clearAccess,
    requireAccess(capability: 'use' | 'cloudSync'): AccessDecision {
      const state = getAccessState();
      if (!state.canUseApp) return { ok: false, reason: state.blockedReason! };
      if (capability === 'cloudSync' && !state.limits.cloudSync) return { ok: false, reason: 'cloud-sync-disabled' };
      return { ok: true };
    },
    maxAgents(): number | null { const state = getAccessState(); return state.canUseApp ? state.limits.maxAgents : 0; },
    onAccessChanged(listener: (state: LicenseState) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function secrets() { return require('./persistence/secrets-store') as typeof import('./persistence/secrets-store'); }
const authority = createLicenseAccess({
  licensePath: path.join(os.homedir(), '.nexus', 'license.json'),
  publicKeyPem: () => process.env.NEXUS_LICENSE_PUBKEY?.trim() || null,
  issuer: () => new URL(resolveBackendUrl()).origin,
  accountId: () => (require('./auth-client') as typeof import('./auth-client')).getAuthenticatedAccountId(),
  now: Date.now, monotonicNow: () => performance.now(),
  readClock: () => secrets().hasCachedSecret('license:clock') ? Number(secrets().getSecret('license:clock')) || 0 : 0,
  writeClock: (time) => { secrets().setSecret('license:clock', String(time)); },
});
export const { getAccessState, requireAccess, maxAgents, applyLicenseToken, onAccessChanged } = authority;
export function clearAccess(): void {
  (require('./auth-client') as typeof import('./auth-client')).resetPendingLogin();
  secrets().deleteSecret('auth:account');
  authority.clearAccess();
}
