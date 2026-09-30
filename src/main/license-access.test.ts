import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLicenseAccess } from './license-access';
import { licenseFixture, LICENSE_NOW, publicKeyPem } from '../test/license-fixture';

let dir: string;
beforeEach(() => { vi.useFakeTimers(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-access-')); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  let now = LICENSE_NOW, monotonic = 0, account: string | null = 'account-a', floor = 0;
  const file = path.join(dir, 'license.json');
  const deps = { licensePath: file, publicKeyPem: () => publicKeyPem, issuer: () => 'https://api.nexuside.app',
    accountId: () => account, now: () => now, monotonicNow: () => monotonic,
    readClock: () => floor, writeClock: vi.fn((value: number) => { floor = value; }) };
  const access = createLicenseAccess(deps);
  return { access, deps, file, setNow: (v: number) => { now = v; }, advance: (v: number) => { monotonic += v; }, setAccount: (v: string | null) => { account = v; } };
}
describe('main access authority', () => {
  it.each(['trial', 'pro', 'suspended', 'inactive'] as const)('derives %s solely from the verified token', kind => {
    const { access } = setup();
    expect(access.applyLicenseToken(licenseFixture({ access: kind })).ok).toBe(true);
    expect(access.getAccessState()).toMatchObject({ access: kind, canUseApp: kind === 'trial' || kind === 'pro', blockedReason: kind === 'trial' || kind === 'pro' ? null : kind });
  });
  it('ignores forged JSON fields and only persists version and token', () => {
    const { access, file } = setup();
    const token = licenseFixture({ access: 'inactive' });
    access.applyLicenseToken(token);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 2, token });
    fs.writeFileSync(file, JSON.stringify({ token, plan: 'pro', status: 'active', access: 'pro', limits: { maxAgents: null, cloudSync: true } }));
    expect(access.getAccessState()).toMatchObject({ plan: 'free', status: 'none', canUseApp: false });
    expect(access.maxAgents()).toBe(0);
  });
  it('missing/corrupt/deleted files never grant access', () => {
    const { access, file } = setup();
    expect(access.getAccessState().canUseApp).toBe(false);
    access.applyLicenseToken(licenseFixture());
    fs.unlinkSync(file);
    expect(access.getAccessState().canUseApp).toBe(false);
    fs.writeFileSync(file, '{');
    expect(access.getAccessState().blockedReason).toBe('invalid-license');
  });
  it('rejects another account deep link without replacing the current license', () => {
    const { access, file, setAccount } = setup();
    access.applyLicenseToken(licenseFixture());
    const before = fs.readFileSync(file, 'utf8');
    expect(access.applyLicenseToken(licenseFixture({ sub: 'account-b' }))).toMatchObject({ ok: false, error: 'account-mismatch' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    setAccount('account-b');
    expect(access.getAccessState().blockedReason).toBe('account-mismatch');
    setAccount(null);
    expect(access.getAccessState().blockedReason).toBe('login-required');
  });
  it('enforces signed limits, expiry equality and trial deadline on every query, without a timer', () => {
    const { access, setNow } = setup();
    access.applyLicenseToken(licenseFixture({ trialEndsAt: '2026-09-30T12:00:10.000Z' }));
    expect(access.requireAccess('use').ok).toBe(true);
    expect(access.requireAccess('cloudSync').ok).toBe(false);
    expect(access.maxAgents()).toBe(3);
    setNow(LICENSE_NOW + 10000);
    expect(access.getAccessState().blockedReason).toBe('trial-ended');
    expect(access.requireAccess('use').ok).toBe(false);
  });
  it('never resurrects expired tokens when wall time moves backwards, including a recreated authority', () => {
    const { access, deps, setNow, advance } = setup();
    access.applyLicenseToken(licenseFixture({ access: 'pro' }));
    advance(3600000);
    setNow(LICENSE_NOW - 3600000);
    expect(access.getAccessState().blockedReason).toBe('license-expired');
    expect(createLicenseAccess(deps).getAccessState().blockedReason).toBe('license-expired');
  });
  it('notifies at deadline, accepts immediate suspension and clearAccess prevents replay from disk', async () => {
    const { access, advance } = setup();
    const events: boolean[] = [];
    access.onAccessChanged(state => events.push(state.canUseApp));
    access.applyLicenseToken(licenseFixture({ exp: LICENSE_NOW / 1000 + 1 }));
    advance(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([true, false]);
    access.applyLicenseToken(licenseFixture({ access: 'suspended' }));
    expect(access.getAccessState().blockedReason).toBe('suspended');
    access.clearAccess();
    expect(access.getAccessState().blockedReason).toBe('login-required');
  });
});


it('keeps a valid license usable offline and blocks as soon as renewal brings suspension', async () => {
  const { syncLicenseOnce } = await import('./license-sync');
  const { access } = setup();
  access.applyLicenseToken(licenseFixture({ access: 'pro', limits: { maxAgents: null, cloudSync: true } }));
  const syncDeps = { api: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 200, json: { ok: true, data: { licenca: licenseFixture({ access: 'suspended' }) } } }),
    applyLicense: access.applyLicenseToken, readAccess: () => access.getAccessState().access,
    sessionKey: () => 'account-a:1', notify: () => {}, setIntervalFn: vi.fn(), clearIntervalFn: vi.fn() };
  expect(await syncLicenseOnce(syncDeps)).toBe(false);
  expect(access.requireAccess('cloudSync').ok).toBe(true);
  expect(access.maxAgents()).toBeNull();
  expect(await syncLicenseOnce(syncDeps)).toBe(true);
  expect(access.requireAccess('use')).toEqual({ ok: false, reason: 'suspended' });
});

it('a signed suspension revokes access even if saving the file fails', () => {
  const { access, file } = setup();
  access.applyLicenseToken(licenseFixture({ access: 'pro' }));
  // Atomic write fails: a directory already occupies the temporary filename.
  fs.mkdirSync(`${file}.tmp`);
  expect(access.applyLicenseToken(licenseFixture({ access: 'suspended' })).ok).toBe(false);
  expect(access.getAccessState().blockedReason).toBe('suspended');
});


it.each(['trial', 'pro'])('does not rewrite the vault on every repeated %s expiry check', kind => {
  const { access, deps, setNow } = setup();
  access.applyLicenseToken(licenseFixture({ access: kind, trialEndsAt: '2026-09-30T12:00:10.000Z' }));
  setNow(LICENSE_NOW + (kind === 'trial' ? 10000 : 3600000));
  expect(access.getAccessState().canUseApp).toBe(false);
  const sealed = deps.writeClock.mock.calls.length;
  for (let i = 0; i < 10; i++) access.getAccessState();
  expect(deps.writeClock).toHaveBeenCalledTimes(sealed);
});

it('a failing observer cannot reject an accepted token or starve other observers', () => {
  const { access } = setup();
  const changed = vi.fn();
  access.onAccessChanged(() => { throw new Error('observer failure'); });
  access.onAccessChanged(changed);
  expect(access.applyLicenseToken(licenseFixture())).toEqual({ ok: true });
  expect(changed).toHaveBeenCalledOnce();
});

it('reschedules notification if a timer fires just before the effective clock reaches expiry', async () => {
  const { access, advance } = setup();
  const events: boolean[] = [];
  access.onAccessChanged(state => events.push(state.canUseApp));
  access.applyLicenseToken(licenseFixture({ exp: LICENSE_NOW / 1000 + 1 }));
  advance(999);
  await vi.advanceTimersByTimeAsync(1000);
  expect(events).toEqual([true]);
  advance(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(events).toEqual([true, false]);
});
