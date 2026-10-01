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
    api.changed(); await flush();
    expect(useAccessStore.getState()).toMatchObject({ canUseApp: false, blockedReason: reason });
    api.get.mockResolvedValue(active); api.changed(); await flush();
    expect(useAccessStore.getState().canUseApp).toBe(true);
  });
  it('keeps the granted snapshot on screen while a renewal read is in flight (F-228)', async () => {
    let resolve!: (state: LicenseState) => void;
    const api = setup(); await flush();
    expect(useAccessStore.getState().canUseApp).toBe(true);
    api.get.mockImplementationOnce(() => new Promise<LicenseState>(r => { resolve = r; }));
    api.changed();
    // Em voo: nada de flicker — canUseApp do último snapshot permanece.
    expect(useAccessStore.getState()).toMatchObject({ loading: true, canUseApp: true });
    resolve({ ...active, limits: { maxAgents: 4, cloudSync: true } });
    await flush();
    expect(useAccessStore.getState()).toMatchObject({ loading: false, canUseApp: true, maxAgents: 4, cloudSync: true });
  });
  it('first read stays canUseApp:false until the Main snapshot resolves', async () => {
    const get = vi.fn().mockImplementation(() => new Promise<LicenseState>(() => {}));
    setup(get);
    expect(useAccessStore.getState()).toMatchObject({ loading: true, canUseApp: false });
  });
  it('re-read resolving canUseApp:false blocks the app', async () => {
    const api = setup(); await flush();
    api.get.mockResolvedValue({ ...DEFAULT_LICENSE, blockedReason: 'trial-ended' });
    api.changed();
    // Em voo ainda vale o snapshot anterior.
    expect(useAccessStore.getState().canUseApp).toBe(true);
    await flush();
    expect(useAccessStore.getState()).toMatchObject({ canUseApp: false, blockedReason: 'trial-ended' });
  });
  it('IPC failure after a granted snapshot keeps canUseApp with failed:true (Main stays the authority)', async () => {
    const api = setup(); await flush();
    api.get.mockRejectedValue(new Error('private diagnostic')); api.changed(); await flush();
    expect(useAccessStore.getState()).toMatchObject({ canUseApp: true, failed: true });
  });
  it('IPC failure without any snapshot fails closed with verification-unavailable', async () => {
    setup(vi.fn(async () => { throw new Error('ipc down'); }));
    await flush();
    expect(useAccessStore.getState()).toMatchObject({ canUseApp: false, failed: true, blockedReason: 'verification-unavailable', cloudSync: false, maxAgents: 0 });
  });
});
