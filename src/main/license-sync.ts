import type { apiFetch } from './api-client';

export interface LicenseSyncDeps {
  api: typeof apiFetch;
  applyLicense: (jwt: string) => { ok: boolean; error?: string };
  readAccess: () => string | null;
  /** Account + login/logout generation, unchanged by a refresh of the same session. */
  sessionKey: () => string | null;
  notify: () => void;
  setIntervalFn: (fn: () => Promise<void>, ms: number) => unknown;
  clearIntervalFn: (id: unknown) => void;
}
export interface LicenseBootSyncDeps {
  hasCachedAuthSession: () => boolean;
  sync: () => Promise<boolean>;
  afterFirstPaint: (callback: () => void) => void;
  startPeriodic: () => void;
}
const POLL_MS = 5_000;
const POLL_MAX = 24;
let defaults: LicenseSyncDeps | undefined;
function defaultDeps(): LicenseSyncDeps {
  if (defaults) return defaults;
  const { apiFetch: api } = require('./api-client') as typeof import('./api-client');
  const access = require('./license-access') as typeof import('./license-access');
  const auth = require('./auth-client') as typeof import('./auth-client');
  defaults = {
    api, applyLicense: access.applyLicenseToken,
    readAccess: () => access.getAccessState().access,
    sessionKey: () => { const id = auth.getAuthenticatedAccountId(); return id ? `${auth.getAuthGeneration()}:${id}` : null; },
    // The authority broadcasts changes, including expiry without any network activity.
    notify: () => {},
    setIntervalFn: (fn, ms) => { const timer = setInterval(() => void fn(), ms); timer.unref(); return timer; },
    clearIntervalFn: id => clearInterval(id as NodeJS.Timeout),
  };
  return defaults;
}
const flights = new WeakMap<LicenseSyncDeps, Promise<boolean>>();
export function syncLicenseOnce(deps: LicenseSyncDeps = defaultDeps()): Promise<boolean> {
  const active = flights.get(deps);
  if (active) return active;
  const session = deps.sessionKey();
  if (!session) return Promise.resolve(false);
  const flight = (async () => {
    try {
      const result = await deps.api('/v1/license');
      if (deps.sessionKey() !== session || result.status !== 200) return false;
      const body = result.json as { ok?: boolean; data?: { licenca?: unknown } } | null;
      const jwt = body?.ok ? body.data?.licenca : undefined;
      if (typeof jwt !== 'string' || !deps.applyLicense(jwt).ok) return false;
      deps.notify();
      return true;
    } catch { return false; }
  })().finally(() => { flights.delete(deps); });
  flights.set(deps, flight);
  return flight;
}
const checkoutTimers = new WeakMap<LicenseSyncDeps, unknown>();
export function startCheckoutPolling(deps: LicenseSyncDeps = defaultDeps()): void {
  if (checkoutTimers.has(deps)) deps.clearIntervalFn(checkoutTimers.get(deps));
  let runs = 0;
  const session = deps.sessionKey();
  const id = deps.setIntervalFn(async () => {
    runs += 1;
    if (deps.sessionKey() === session) await syncLicenseOnce(deps);
    if (deps.sessionKey() !== session || deps.readAccess() === 'pro' || runs >= POLL_MAX) {
      deps.clearIntervalFn(id);
      checkoutTimers.delete(deps);
    }
  }, POLL_MS);
  checkoutTimers.set(deps, id);
}

export interface PeriodicLicenseSyncDeps {
  sync: () => Promise<boolean>;
  expiresAt: () => string | null;
  onChanged: (listener: () => void) => () => void;
  now: () => number;
}
/** Renew at least every 5 min, or one minute before exp; failures retry after 30s. */
export function startPeriodicLicenseSync(deps: PeriodicLicenseSyncDeps): () => void {
  let stopped = false, running = false, scheduling = false;
  let timer: ReturnType<typeof setTimeout>;
  function schedule(retry = false): void {
    clearTimeout(timer);
    if (stopped || running || scheduling) return;
    scheduling = true;
    const expiry = deps.expiresAt();
    const delay = retry ? 30_000 : Math.max(30_000, Math.min(300_000, expiry ? Date.parse(expiry) - deps.now() - 60_000 : 300_000));
    timer = setTimeout(async () => {
      running = true;
      let success = false;
      try { success = await deps.sync(); } catch { /* offline keeps the unexpired token */ }
      finally { running = false; schedule(!success); }
    }, delay);
    timer.unref?.();
    scheduling = false;
  }
  const unsubscribe = deps.onChanged(() => schedule());
  schedule();
  return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
}
let stopPeriodic: (() => void) | undefined;
function defaultBootSyncDeps(): LicenseBootSyncDeps {
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  const auth = require('./auth-client') as typeof import('./auth-client');
  const access = require('./license-access') as typeof import('./license-access');
  const sync = async (): Promise<boolean> => {
    await auth.restoreAuthenticatedAccount();
    access.getAccessState();
    return syncLicenseOnce();
  };
  return {
    hasCachedAuthSession: () => secrets.hasCachedSecret('auth:session') && secrets.hasCachedSecret('auth:account') && secrets.hasCachedSecret('license:clock'),
    sync,
    afterFirstPaint: callback => {
      // Keychain may synchronously block in SecItemCopyMatching. Wait for the
      // renderer's existing ready signal, then yield before any cold decryption.
      const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron');
      const { WINDOW_CHANNELS } = require('../shared/channels') as typeof import('../shared/channels');
      const ready = (): void => { const timer = setTimeout(callback, 1000); timer.unref(); };
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.webContents.isLoadingMainFrame() && win.isVisible()) ready();
      else {
        const mounted = (event: import('electron').IpcMainEvent): void => {
          if (win && event.sender !== win.webContents) return;
          ipcMain.removeListener(WINDOW_CHANNELS.mounted, mounted);
          ready();
        };
        ipcMain.on(WINDOW_CHANNELS.mounted, mounted);
      }
    },
    startPeriodic: () => {
      stopPeriodic?.();
      stopPeriodic = startPeriodicLicenseSync({ sync, expiresAt: () => access.getAccessState().expiresAt,
        onChanged: listener => access.onAccessChanged(listener), now: Date.now });
    },
  };
}
export function syncLicenseOnBoot(deps: LicenseBootSyncDeps = defaultBootSyncDeps()): void {
  if (deps.hasCachedAuthSession()) void deps.sync().catch(() => undefined);
  deps.afterFirstPaint(() => {
    deps.startPeriodic();
    void deps.sync().catch(() => undefined);
  });
}
