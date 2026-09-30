/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LICENSE, type LicenseState } from '../../shared/billing-types';
import { connectAccessStore, useAccessStore } from './access-store';

const active: LicenseState = { ...DEFAULT_LICENSE, canUseApp: true, blockedReason: null, access: 'trial', limits: { maxAgents: 2, cloudSync: false } };
let disconnect: (() => void) | undefined;
afterEach(() => { disconnect?.(); disconnect = undefined; });
function setup(get = vi.fn(async () => active)) {
  let changed = () => {};
  const onChanged = vi.fn((cb: () => void) => { changed = cb; return vi.fn(); });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { billing: { get, onChanged } } });
  disconnect = connectAccessStore();
  return { get, onChanged, changed: () => changed() };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }
describe('Main-owned access snapshot', () => {
  it('starts closed and subscribes before the first read', async () => {
    expect(useAccessStore.getState().canUseApp).toBe(false);
    const { get, onChanged } = setup();
    expect(onChanged.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
    await flush();
    expect(useAccessStore.getState()).toMatchObject({ loading: false, canUseApp: true, maxAgents: 2, cloudSync: false });
  });
  it('discards the initial response if a change arrives during get', async () => {
    let resolve!: (state: LicenseState) => void;
    const get = vi.fn().mockImplementationOnce(() => new Promise<LicenseState>(r => { resolve = r; })).mockResolvedValue(DEFAULT_LICENSE);
    const api = setup(get);
    api.changed(); await flush();
    resolve(active); await flush();
    expect(useAccessStore.getState()).toMatchObject({ canUseApp: false, blockedReason: 'login-required' });
  });
  it.each(['login-required', 'license-expired', 'trial-ended', 'suspended'] as const)('blocks on %s and unlocks without restarting', async reason => {
    const api = setup(); await flush();
    api.get.mockResolvedValue({ ...DEFAULT_LICENSE, blockedReason: reason });
    api.changed();
    expect(useAccessStore.getState().canUseApp).toBe(false);
    await flush();
    expect(useAccessStore.getState().blockedReason).toBe(reason);
    api.get.mockResolvedValue(active); api.changed(); await flush();
    expect(useAccessStore.getState().canUseApp).toBe(true);
  });
  it('fails closed on an IPC failure even after a valid snapshot', async () => {
    const api = setup(); await flush();
    api.get.mockRejectedValue(new Error('private diagnostic')); api.changed(); await flush();
    expect(useAccessStore.getState()).toMatchObject({ canUseApp: false, failed: true, blockedReason: 'verification-unavailable', cloudSync: false, maxAgents: 0 });
  });
});
