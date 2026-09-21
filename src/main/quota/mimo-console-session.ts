import { createHash } from 'node:crypto';
import { authorizeMimoPartition, hasMimoPartitionConsent } from './mimo-console-consent';
import type { BrowserWindow, Session } from 'electron';
import { captureNativeAuth } from '../adapters/managed-credentials';
import { parseMimoAuth } from '../adapters/mimo-auth';
import { getAccount } from '../persistence/account-store';
import { getSecret } from '../persistence/secrets-store';
import type { LiveProviderProbe } from './provider-live-usage';
import { isMimoTokenPlan, MIMO_CONSOLE_ORIGIN, probeMimoTokenPlan, type MimoQuotaIdentity } from './mimo-token-plan';

const LOGIN_URL = `${MIMO_CONSOLE_ORIGIN}/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fplan-manage`;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
let connectionGeneration = 0;
const connections = new Map<string, Session>();
const windows = new Map<string, BrowserWindow>();
export interface MimoQuotaConnectionResult { ok: boolean; message: string }
export function isMimoConsoleNavigation(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      // Xiaomi's public SNS flow redirects this same window to Google/Apple.
      ['platform.xiaomimimo.com', 'account.xiaomi.com', 'accounts.google.com', 'appleid.apple.com'].includes(url.hostname);
  } catch { return false; }
}
export function resolveMimoQuotaIdentity(accountId?: string): MimoQuotaIdentity | null {
  try {
    if (accountId && getAccount(accountId)?.adapterId !== 'mimo-code') return null;
    const blob = accountId ? getSecret(`acctcred:${accountId}`) : captureNativeAuth('mimo-code')?.blob;
    const auth = blob ? parseMimoAuth(blob) : null;
    // Raw API keys never reach Electron, renderer, logs, or quota requests.
    return auth ? { uid: auth.uid, baseUrl: auth.baseUrl } : null;
  } catch { return null; }
}
function connectionKey(identity: MimoQuotaIdentity, accountId?: string): string {
  // Bind consent and cookies to the exact CLI identity without persisting its UID.
  return createHash('sha256').update(JSON.stringify([accountId ?? 'native', identity.uid, identity.baseUrl])).digest('hex');
}
function prepareConsoleSession(session: Session): Session {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  return session;
}
async function authorizedSession(key: string, isCurrent: () => boolean): Promise<Session | null> {
  const active = connections.get(key);
  if (active) return active;
  const { app, session } = await import('electron');
  if (!isCurrent() || !hasMimoPartitionConsent(app.getPath('userData'), key)) return null;
  const restored = prepareConsoleSession(session.fromPartition(`persist:nexus-mimo-quota-${key}`));
  connections.set(key, restored);
  return restored;
}
export async function fetchMimoAccountUsage(accountId?: string): Promise<LiveProviderProbe> {
  const auth = resolveMimoQuotaIdentity(accountId);
  if (!auth) return { windows: null, hint: 'no-credential' };
  if (!isMimoTokenPlan(auth)) return { windows: null, hint: 'unavailable' };
  const generation = connectionGeneration;
  const key = connectionKey(auth, accountId);
  if (windows.has(key)) return { windows: null, hint: 'unavailable' };
  try {
    const activeSession = await authorizedSession(key, () => {
      const current = resolveMimoQuotaIdentity(accountId);
      return !windows.has(key) && generation === connectionGeneration && current?.uid === auth.uid && current?.baseUrl === auth.baseUrl;
    });
    const before = resolveMimoQuotaIdentity(accountId);
    if (windows.has(key) || generation !== connectionGeneration || before?.uid !== auth.uid || before?.baseUrl !== auth.baseUrl) return { windows: null, hint: 'unavailable' };
    if (!activeSession) return { windows: null, hint: 'unavailable' };
    const probe = await probeMimoTokenPlan(auth, (url, options) => {
      if (windows.has(key) || generation !== connectionGeneration) throw new Error('Quota connection unavailable');
      return activeSession.fetch(url, options);
    });
    const current = resolveMimoQuotaIdentity(accountId);
    if (windows.has(key) || generation !== connectionGeneration || current?.uid !== auth.uid || current?.baseUrl !== auth.baseUrl) return { windows: null, hint: 'unavailable' };
    return probe;
  } catch { return { windows: null, hint: 'unavailable' }; }
}
/** Only a trusted renderer click calls this. Cookies remain in this partition. */
export async function connectMimoQuota(accountId?: string): Promise<MimoQuotaConnectionResult> {
  const generation = connectionGeneration;
  const identity = resolveMimoQuotaIdentity(accountId);
  if (!identity || !isMimoTokenPlan(identity)) {
    return { ok: false, message: 'Entre na CLI MiMo com a chave do Token Plan antes de conectar a cota. A assinatura Desktop é separada.' };
  }
  const key = connectionKey(identity, accountId);
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { ok: false, message: 'Conclua o login na janela MiMo já aberta e feche a janela para verificar a cota.' };
  }
  const { app, BrowserWindow, session } = await import('electron');
  const partition = `persist:nexus-mimo-quota-${key}`;
  const consoleSession = prepareConsoleSession(session.fromPartition(partition));
  const window = new BrowserWindow({
    width: 960, height: 740, title: 'Conectar cota MiMo · entre e feche para verificar',
    autoHideMenuBar: true,
    webPreferences: { session: consoleSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  windows.set(key, window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardNavigation = (event: Electron.Event, url: string) => { if (!isMimoConsoleNavigation(url)) event.preventDefault(); };
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const closed = new Promise<void>(resolve => window.once('closed', () => { windows.delete(key); resolve(); }));
  const timer = setTimeout(() => { if (!window.isDestroyed()) window.close(); }, LOGIN_TIMEOUT_MS);
  try {
    await window.loadURL(LOGIN_URL);
    await closed;
    const current = resolveMimoQuotaIdentity(accountId);
    if (generation !== connectionGeneration || current?.uid !== identity?.uid || current?.baseUrl !== identity?.baseUrl) {
      return { ok: false, message: 'Conexão cancelada ou conta da CLI alterada. Tente novamente.' };
    }
    connections.set(key, consoleSession);
    const probe = await fetchMimoAccountUsage(accountId);
    if (!probe.windows?.length) {
      connections.delete(key);
      return { ok: false, message: 'Cota não confirmada. Entre no console com a mesma conta do Token Plan usada pela CLI e tente novamente.' };
    }
    if (generation !== connectionGeneration) return { ok: false, message: 'Conexão cancelada. Tente novamente.' };
    authorizeMimoPartition(app.getPath('userData'), key);
    return { ok: true, message: 'Cota do Token Plan conectada à conta da CLI.' };
  } catch {
    connections.delete(key);
    if (!window.isDestroyed()) window.close();
    return { ok: false, message: 'Não foi possível conectar o console MiMo. Tente novamente.' };
  } finally { clearTimeout(timer); }
}
export function closeMimoQuotaConnections(): void {
  connectionGeneration++;
  for (const window of windows.values()) if (!window.isDestroyed()) window.close();
  windows.clear();
  connections.clear();
}
