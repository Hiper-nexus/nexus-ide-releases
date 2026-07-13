import type { apiFetch } from './api-client';

export interface LicenseSyncDeps {
  api: typeof apiFetch;
  applyLicense: (jwt: string) => { ok: boolean; error?: string };
  readPlan: () => string;
  notify: () => void;
  setIntervalFn: (fn: () => Promise<void>, ms: number) => unknown;
  clearIntervalFn: (id: unknown) => void;
}

export interface LicenseBootSyncDeps {
  hasCachedAuthSession: () => boolean;
  sync: () => Promise<boolean>;
}

const POLL_MS = 5_000;
const POLL_MAX = 24;

function defaultDeps(): LicenseSyncDeps {
  // Lazy require: mantém o módulo testável sem carregar Electron no topo.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { apiFetch: api } = require('./api-client') as typeof import('./api-client');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const billing = require('./persistence/billing-ipc') as typeof import('./persistence/billing-ipc');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BrowserWindow } = require('electron') as typeof import('electron');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BILLING_CHANNELS } = require('../shared/billing-types') as typeof import('../shared/billing-types');
  return {
    api,
    applyLicense: (jwt) => billing.applyLicenseToken(jwt),
    readPlan: () => billing.currentPlan(),
    notify: () => BrowserWindow.getAllWindows()[0]?.webContents.send(BILLING_CHANNELS.changed),
    setIntervalFn: (fn, ms) => setInterval(() => void fn(), ms),
    clearIntervalFn: (id) => clearInterval(id as NodeJS.Timeout),
  };
}

export async function syncLicenseOnce(
  deps: LicenseSyncDeps = defaultDeps(),
): Promise<boolean> {
  const result = await deps.api('/v1/license');
  if (result.status !== 200) return false;
  const body = result.json as { ok?: boolean; data?: { licenca?: string } } | null;
  const jwt = body?.ok ? body.data?.licenca : undefined;
  if (!jwt) return false;
  if (!deps.applyLicense(jwt).ok) return false;
  deps.notify();
  return true;
}

export function startCheckoutPolling(deps: LicenseSyncDeps = defaultDeps()): void {
  let runs = 0;
  const id = deps.setIntervalFn(async () => {
    runs += 1;
    await syncLicenseOnce(deps);
    if (deps.readPlan() !== 'free' || runs >= POLL_MAX) deps.clearIntervalFn(id);
  }, POLL_MS);
}

function defaultBootSyncDeps(): LicenseBootSyncDeps {
  // Reading/decrypting the encrypted auth session here can synchronously block
  // Electron in SecItemCopyMatching before the first window paints. A session
  // already unlocked in this process is safe; a cold boot keeps the persisted
  // local license and refreshes through the explicit account/checkout flows.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  return {
    hasCachedAuthSession: () => secrets.hasCachedSecret('auth:session'),
    sync: () => syncLicenseOnce(),
  };
}

export function syncLicenseOnBoot(
  deps: LicenseBootSyncDeps = defaultBootSyncDeps(),
): void {
  if (!deps.hasCachedAuthSession()) return;
  void deps.sync().catch(() => undefined);
}
