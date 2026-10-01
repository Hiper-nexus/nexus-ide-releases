/**
 * Sole Main access authority. Integration API for pane/PTY/mission/sync owners:
 * getAccessState(): LicenseState; requireAccess('use' | 'cloudSync'): AccessDecision;
 * maxAgents(): number | null (0 when blocked, null means unlimited);
 * applyLicenseToken(token: string): { ok: boolean; error?: string };
 * clearAccess(): void; onAccessChanged(listener: (state: LicenseState) => void): () => void.
 * Check at the mutation boundary, including after awaits. Renderer state is informational.
 * Logout must call clearAccess() before deleting session secrets (it also resets pending login).
 * Billing/auth/renewal stay available while blocked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_LICENSE, type AccessBlockedReason, type LicenseState } from '../shared/billing-types';
import { verifyLicenseToken } from './persistence/billing-license';
import { hasSecret } from './persistence/secrets-store';
import { isLicenseBootSyncSettled } from './license-sync';
import { resolveBackendUrl } from './backend-url';
import { isCurrentProcessSmokeTest } from './smoke-core';
import { isLicenseSeal, persistLicenseSeal, readLicenseAccountState, invalidateLicenseAccountBinding, type LicenseSeal } from './license-account-state';
import type { DesktopLicenseClaims } from '../../shared/contract';

export type AccessDecision = { ok: true } | { ok: false; reason: AccessBlockedReason | 'cloud-sync-disabled' };
export interface LicenseAccessDeps {
  licensePath: string;
  publicKeyPem: () => string | null;
  issuer: () => string;
  accountId: () => string | null;
  now: () => number;
  monotonicNow: () => number;
  readSeal: () => LicenseSeal | null;
  writeSeal: (seal: LicenseSeal) => { ok: boolean };
}

// F-250: o smoke empacotado (--smoke-test) nunca vira produto utilizável —
// roda os probes e encerra — então o gate cede, como vault/updater/mic já
// cedem (smoke-core). Sem isto o probe mission-prepare morre em
// login-required e o release gate falha num falso negativo.
const SMOKE_LICENSE: LicenseState = Object.freeze({
  plan: 'pro', email: null, status: 'active', renewsAt: null,
  verified: true, access: 'pro', trialEndsAt: null,
  limits: Object.freeze({ maxAgents: null, cloudSync: true }), expiresAt: null,
  canUseApp: true, blockedReason: null,
});

/** On-disk session existence (no decrypt — the keychain cache is cold at boot). */
function hasPersistedAuthSession(): boolean {
  return hasSecret('auth:session') && hasSecret('auth:account') &&
    hasSecret('auth:refresh');
}

export function createLicenseAccess(deps: LicenseAccessDeps) {
  let highWater = 0, lastMono = deps.monotonicNow(), persistedClock = 0;
  let sealedBoundary: string | undefined;
  let persistenceFailed = false;
  const accepted = new Map<string, LicenseSeal>();
  let cleared = false;
  let revocationToken: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = JSON.stringify(DEFAULT_LICENSE);
  const listeners = new Set<(state: LicenseState) => void>();
  function currentSeal(): LicenseSeal | null {
    const stored = deps.readSeal();
    if (!isLicenseSeal(stored)) return null;
    const known = accepted.get(deps.accountId() ?? '');
    if (!known) return stored;
    return { ...stored, clockFloor: Math.max(stored.clockFloor, known.clockFloor),
      latestIat: stored.latestIat === null ? known.latestIat : Math.max(stored.latestIat, known.latestIat ?? 0),
      revokedAt: stored.revokedAt === null ? known.revokedAt : Math.max(stored.revokedAt, known.revokedAt ?? 0) };
  }
  function now(): number {
    const mono = deps.monotonicNow();
    highWater = Math.max(deps.now(), currentSeal()?.clockFloor ?? NaN, highWater + Math.max(0, mono - lastMono));
    lastMono = mono;
    return highWater;
  }
  function persist(seal: LicenseSeal): boolean {
    try {
      if (deps.writeSeal(seal).ok) { persistedClock = seal.clockFloor; persistenceFailed = false; return true; }
    } catch { /* The vault's failure is not permission to use an unsealed clock. */ }
    persistenceFailed = true;
    return false;
  }
  function sealClock(time: number, boundary?: string): boolean {
    const seal = currentSeal();
    if (!seal) return false;
    if (time - persistedClock < 60000 && (!boundary || boundary === sealedBoundary)) return true;
    if (!persist({ ...seal, clockFloor: time })) return false;
    if (boundary) sealedBoundary = boundary;
    return true;
  }
  function isReplay(c: DesktopLicenseClaims, seal: LicenseSeal): boolean {
    return (seal.latestIat !== null && c.iat < seal.latestIat) ||
      ((c.access === 'pro' || c.access === 'trial') && seal.revokedAt !== null && c.iat <= seal.revokedAt);
  }
  function accept(c: DesktopLicenseClaims, seal: LicenseSeal, time: number): boolean {
    // F-228: o iat assinado é piso de tempo real — com o leeway, um iat futuro
    // não pode gerar selo que isLicenseSeal rejeite (clockFloor < latestIat*1000).
    const next = { clockFloor: Math.max(time, c.iat * 1000), needsOnlineValidation: false, latestIat: Math.max(seal.latestIat ?? 0, c.iat),
      revokedAt: c.access === 'suspended' || c.access === 'inactive' ? Math.max(seal.revokedAt ?? 0, c.iat) : seal.revokedAt };
    accepted.set(c.sub, next); // Never forget a revocation even when the vault refuses the write.
    return persist(next);
  }
  function blocked(reason: AccessBlockedReason): LicenseState {
    return { ...DEFAULT_LICENSE, limits: { ...DEFAULT_LICENSE.limits }, blockedReason: reason };
  }
  function evaluate(): LicenseState {
    if (isCurrentProcessSmokeTest()) return SMOKE_LICENSE;
    const account = deps.accountId();
    // F-228: cold boot — sessão persistida no disco com o boot sync ainda em
    // voo não é "sem login". `hasSecret` não exige decrypt (cache ainda frio).
    if (!account && !cleared && hasPersistedAuthSession() &&
      !isLicenseBootSyncSettled()) {
      return blocked('startup-pending');
    }
    if (cleared || !account) return blocked('login-required');
    const seal = currentSeal();
    if (!seal || seal.latestIat === null || seal.needsOnlineValidation) return blocked('login-required');
    if (persistenceFailed && !persist({ ...seal, clockFloor: now() })) return blocked('verification-unavailable');
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
    if (!sealClock(time, !result.ok && result.reason === 'license-expired' ? `expired:${raw.token}` : undefined)) return blocked('verification-unavailable');
    if (!result.ok) return blocked(result.reason);
    const c = result.claims;
    if (c.sub !== account) return blocked('account-mismatch');
    if (isReplay(c, seal)) return blocked('invalid-license');
    if ((c.iat > seal.latestIat || ((c.access === 'suspended' || c.access === 'inactive') && c.iat !== seal.revokedAt)) && !accept(c, seal, time)) return blocked('verification-unavailable');
    const reason: AccessBlockedReason | null = c.access === 'suspended' || c.access === 'inactive' ? c.access :
      c.access === 'trial' && time >= Date.parse(c.trialEndsAt!) ? 'trial-ended' : null;
    if (reason === 'trial-ended' && !sealClock(time, `trial:${raw.token}`)) return blocked('verification-unavailable');
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
  function apply(token: string, online: boolean): { ok: boolean; error?: string } {
    const account = deps.accountId();
    const seal = currentSeal();
    if (!account || !seal || (!online && (seal.latestIat === null || seal.needsOnlineValidation))) return { ok: false, error: 'login-required' };
    if (persistenceFailed && !online) return { ok: false, error: 'verification-unavailable' };
    const result = verifyLicenseToken(token, { publicKeyPem: deps.publicKeyPem(), issuer: deps.issuer(), now });
    if (!result.ok) return { ok: false, error: result.reason };
    if (result.claims.sub !== account) return { ok: false, error: 'account-mismatch' };
    if (isReplay(result.claims, seal)) return { ok: false, error: 'invalid-license' };
    const revoked = result.claims.access === 'suspended' || result.claims.access === 'inactive';
    // A full disk must never defer a verified revocation until the next restart.
    if (revoked) { revocationToken = token; cleared = false; }
    // F-228: grava o arquivo ANTES de avançar a cerca de replay. Na ordem
    // inversa uma falha de escrita deixava o token ANTIGO no disco abaixo do
    // latestIat novo → replay → lockout. Se o selo falhar depois da gravação,
    // a próxima evaluate() vê iat > latestIat e sela ali.
    try {
      fs.mkdirSync(path.dirname(deps.licensePath), { recursive: true });
      const tmp = `${deps.licensePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, token }), { mode: 0o600 });
      fs.renameSync(tmp, deps.licensePath);
    } catch {
      getAccessState();
      return { ok: false, error: 'license-persistence-failed' };
    }
    if (!accept(result.claims, seal, now())) {
      getAccessState();
      return { ok: false, error: 'verification-unavailable' };
    }
    persistenceFailed = false;
    revocationToken = revoked ? token : null;
    cleared = false;
    getAccessState();
    return { ok: true };
  }
  function clearAccess(): void {
    cleared = true;
    try { fs.unlinkSync(deps.licensePath); } catch { /* in-memory revocation wins even on disk failure */ }
    getAccessState();
  }
  return {
    getAccessState, clearAccess,
    applyLicenseToken: (token: string) => apply(token, false),
    // Only authenticated HTTP responses may initialize/recover a missing license fence.
    applyOnlineLicenseToken: (token: string) => apply(token, true),
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
  readSeal: () => readLicenseAccountState(secrets())?.seal ?? null,
  writeSeal: (seal) => persistLicenseSeal(secrets(), seal),
});
export const { getAccessState, requireAccess, maxAgents, applyLicenseToken, applyOnlineLicenseToken, onAccessChanged } = authority;
export function clearAccess(): void {
  (require('./auth-client') as typeof import('./auth-client')).resetPendingLogin();
  invalidateLicenseAccountBinding(secrets());
  authority.clearAccess();
}
