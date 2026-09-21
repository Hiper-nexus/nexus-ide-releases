import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const browser = vi.hoisted(() => ({ userData: '', options: null as any, window: null as any, load: vi.fn(async () => undefined), fetch: vi.fn(), partition: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    destroyed = false;
    constructor(options: unknown) { super(); browser.options = options; browser.window = this; }
    loadURL = browser.load;
    isDestroyed() { return this.destroyed; }
    focus() {}
    close() { this.destroyed = true; this.emit('closed'); }
  }
  return { app: { getPath: () => browser.userData }, BrowserWindow: Window, session: { fromPartition: browser.partition.mockImplementation(() => ({ fetch: browser.fetch, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() })) } };
});
vi.mock('../adapters/managed-credentials', () => ({ captureNativeAuth: vi.fn() }));
vi.mock('../persistence/account-store', () => ({ getAccount: vi.fn() }));
vi.mock('../persistence/secrets-store', () => ({ getSecret: vi.fn() }));
import { isMimoConsoleNavigation, resolveMimoQuotaIdentity, fetchMimoAccountUsage, connectMimoQuota, closeMimoQuotaConnections } from './mimo-console-session';
import { captureNativeAuth } from '../adapters/managed-credentials';
import { getAccount } from '../persistence/account-store';
import { getSecret } from '../persistence/secrets-store';
const blob = JSON.stringify({ xiaomi: { type: 'api', key: 'tp-test', metadata: { uid: '123', base_url: 'https://token-plan-sgp.xiaomimimo.com/v1' } } });
describe('MiMo explicit console connection', () => {
  beforeEach(() => { browser.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-session-')); });
  afterEach(() => { closeMimoQuotaConnections(); fs.rmSync(browser.userData, { recursive: true, force: true }); vi.clearAllMocks(); });
  it('opens a sandboxed partition only after the click and confirms on close', async () => {
    vi.mocked(captureNativeAuth).mockReturnValue({ blob, authRelativePath: 'data/auth.json' });
    const payloads = [{ code: 0, data: { userId: '123' } }, { code: 0, data: { usage: { items: [{ name: 'total_token', used: 20, limit: 100, percent: 0.2 }] } } }, { code: 0, data: { userId: '123' } }];
    browser.fetch.mockImplementation(async () => new Response(JSON.stringify(payloads.shift()), { headers: { 'content-type': 'application/json' } }));
    const pending = connectMimoQuota();
    await vi.waitFor(() => expect(browser.load).toHaveBeenCalled());
    expect(browser.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true });
    expect(browser.options.webPreferences.preload).toBeUndefined();
    expect(browser.partition).toHaveBeenCalledWith(expect.stringMatching(/^persist:nexus-mimo-quota-[a-f0-9]{64}$/));
    expect(browser.fetch).not.toHaveBeenCalled();
    const event = { preventDefault: vi.fn() };
    browser.window.webContents.emit('will-redirect', event, 'http://127.0.0.1');
    expect(event.preventDefault).toHaveBeenCalled();
    browser.window.close();
    expect(await pending).toEqual({ ok: true, message: 'Cota do Token Plan conectada à conta da CLI.' });
    expect(browser.fetch).toHaveBeenCalledTimes(3);
    vi.clearAllMocks();
    const reconnect = connectMimoQuota();
    await vi.waitFor(() => expect(browser.load).toHaveBeenCalled());
    expect(await fetchMimoAccountUsage()).toEqual({ windows: null, hint: 'unavailable' });
    expect(browser.fetch).not.toHaveBeenCalled();
    payloads.push({ code: 0, data: { userId: '123' } }, { code: 0, data: { usage: { items: [{ name: 'total_token', used: 20, limit: 100, percent: 0.2 }] } } }, { code: 0, data: { userId: '123' } });
    browser.window.close();
    expect((await reconnect).ok).toBe(true);
    closeMimoQuotaConnections();
    vi.clearAllMocks();
    payloads.push({ code: 0, data: { userId: '123' } }, { code: 0, data: { usage: { items: [{ name: 'total_token', used: 20, limit: 100, percent: 0.2 }] } } }, { code: 0, data: { userId: '123' } });
    expect((await fetchMimoAccountUsage()).windows?.[0].usedRatio).toBe(0.2);
    expect(browser.partition).toHaveBeenCalledTimes(1);
    expect(browser.load).not.toHaveBeenCalled();
    const consentFile = path.join(browser.userData, 'quota', 'mimo-console-consent.json');
    const consent = fs.readFileSync(consentFile, 'utf8');
    closeMimoQuotaConnections();
    vi.clearAllMocks();
    browser.fetch.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: { userId: 'other-console' } }), { headers: { 'content-type': 'application/json' } }));
    expect((await fetchMimoAccountUsage()).windows).toBeNull();
    expect(browser.fetch).toHaveBeenCalledTimes(1);
    expect(browser.load).not.toHaveBeenCalled();
    expect(fs.readFileSync(consentFile, 'utf8')).toBe(consent);
    closeMimoQuotaConnections();
    vi.clearAllMocks();
    vi.mocked(captureNativeAuth).mockReturnValue({ blob: blob.replace('123', '456'), authRelativePath: 'data/auth.json' });
    expect((await fetchMimoAccountUsage()).windows).toBeNull();
    expect(browser.partition).not.toHaveBeenCalled();
    expect(browser.fetch).not.toHaveBeenCalled();
  });
  it('does not reconnect when shutdown closes a pending login', async () => {
    vi.mocked(captureNativeAuth).mockReturnValue({ blob, authRelativePath: 'data/auth.json' });
    const pending = connectMimoQuota();
    await vi.waitFor(() => expect(browser.load).toHaveBeenCalled());
    closeMimoQuotaConnections();
    expect((await pending).ok).toBe(false);
    expect(browser.fetch).not.toHaveBeenCalled();
  });
  it.each(['mismatch', 'network'])('never persists authorization after %s failure', async (failure) => {
    vi.mocked(captureNativeAuth).mockReturnValue({ blob, authRelativePath: 'data/auth.json' });
    browser.fetch.mockImplementation(async () => {
      if (failure === 'network') throw new Error('network unavailable');
      return new Response(JSON.stringify({ code: 0, data: { userId: 'other-console' } }), { headers: { 'content-type': 'application/json' } });
    });
    const pending = connectMimoQuota();
    await vi.waitFor(() => expect(browser.load).toHaveBeenCalled());
    browser.window.close();
    expect((await pending).ok).toBe(false);
    expect(fs.existsSync(path.join(browser.userData, 'quota', 'mimo-console-consent.json'))).toBe(false);
    closeMimoQuotaConnections();
    vi.clearAllMocks();
    expect((await fetchMimoAccountUsage()).windows).toBeNull();
    expect(browser.partition).not.toHaveBeenCalled();
    expect(browser.fetch).not.toHaveBeenCalled();
  });
  it('does not restore a session after the CLI credential is removed', async () => {
    vi.mocked(captureNativeAuth).mockReturnValue(null);
    expect(await fetchMimoAccountUsage()).toEqual({ windows: null, hint: 'no-credential' });
    expect(browser.partition).not.toHaveBeenCalled();
    expect(browser.fetch).not.toHaveBeenCalled();
  });
  it('pins navigation to official HTTPS account/console origins', () => {
    expect(isMimoConsoleNavigation('https://platform.xiaomimimo.com/console/plan-manage')).toBe(true);
    expect(isMimoConsoleNavigation('https://account.xiaomi.com/pass/serviceLogin')).toBe(true);
    expect(isMimoConsoleNavigation('https://accounts.google.com/o/oauth2/auth')).toBe(true);
    expect(isMimoConsoleNavigation('https://appleid.apple.com/auth/authorize')).toBe(true);
    expect(isMimoConsoleNavigation('https://accounts.google.com.attacker.test')).toBe(false);
    expect(isMimoConsoleNavigation('http://appleid.apple.com/auth/authorize')).toBe(false);
    for (const url of ['http://platform.xiaomimimo.com', 'https://platform.xiaomimimo.com.attacker.test', 'https://user@platform.xiaomimimo.com', 'https://platform.xiaomimimo.com:444', 'file:///etc/passwd', 'https://127.0.0.1']) expect(isMimoConsoleNavigation(url)).toBe(false);
  });
  it('reads the pinned credential only after verifying its adapter', () => {
    vi.mocked(getAccount).mockReturnValue({ adapterId: 'codex' } as never);
    vi.mocked(getSecret).mockClear();
    expect(resolveMimoQuotaIdentity('wrong')).toBeNull();
    expect(getSecret).not.toHaveBeenCalled();
    vi.mocked(getAccount).mockReturnValue({ adapterId: 'mimo-code' } as never);
    vi.mocked(getSecret).mockReturnValue(blob);
    expect(resolveMimoQuotaIdentity('mine')).toEqual({ uid: '123', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' });
    expect(getSecret).toHaveBeenCalledWith('acctcred:mine');
  });
  it('keeps valid paygo CLI auth separate from absent Token Plan quota', async () => {
    vi.mocked(captureNativeAuth).mockReturnValue({ blob: blob.replace('https://token-plan-sgp.xiaomimimo.com/v1', 'https://api.xiaomimimo.com/v1'), authRelativePath: 'data/auth.json' });
    expect(await fetchMimoAccountUsage()).toEqual({ windows: null, hint: 'unavailable' });
    expect(browser.partition).not.toHaveBeenCalled();
    expect(browser.fetch).not.toHaveBeenCalled();
  });
  it('does not create a browser/session or call the network before explicit connection', async () => {
    vi.mocked(captureNativeAuth).mockReturnValue({ blob, authRelativePath: 'data/auth.json' });
    expect(await fetchMimoAccountUsage()).toEqual({ windows: null, hint: 'unavailable' });
    expect(browser.partition).not.toHaveBeenCalled();
    expect(browser.fetch).not.toHaveBeenCalled();
  });
});
