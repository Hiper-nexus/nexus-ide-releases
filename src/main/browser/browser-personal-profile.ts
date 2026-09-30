import { app } from 'electron';
import type { WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BrowserProfileChange, BrowserProfileMode } from '../../shared/browser-profile';
import { getSecret, hasSecret, setInternalSecret } from '../persistence/secrets-store';
import { writeJsonAtomic } from '../util/atomic-write';
import { BrowserCookieProfile, profileCookieSchema, profileCookiesSchema, type ProfileCookie, type ProfileCookiePeer } from './browser-profile-cookies';

const VAULT_KEY = 'browser:personal-profile-cookies';
const SYNC_DELAY_MS = 100;
const preferencesSchema = z.object({
  enabled: z.boolean().default(false),
  shareWithAgents: z.boolean().default(false),
  modes: z.record(z.string(), z.enum(['personal', 'isolated'])).default({}),
  agentPanes: z.array(z.string()).max(2000).default([]),
});
type ProfilePreferences = z.infer<typeof preferencesSchema>;
let preferences: ProfilePreferences | undefined;
let profile: BrowserCookieProfile | undefined;
const preferencesFile = () => path.join(app.getPath('userData'), 'browser-profile.json');

export function getBrowserProfilePreferences(): ProfilePreferences {
  if (!preferences) {
    try {
      const file = preferencesFile();
      if (fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid profile preferences');
      preferences = preferencesSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { preferences = preferencesSchema.parse({}); }
  }
  return preferences;
}

export function browserProfileMode(key: string, agentOwned: boolean): BrowserProfileMode {
  const settings = getBrowserProfilePreferences();
  if (settings.modes[key]) return settings.modes[key];
  const mode: BrowserProfileMode = settings.enabled && (!(agentOwned || settings.agentPanes.includes(key)) || settings.shareWithAgents) ? 'personal' : 'isolated';
  const next = { ...settings, modes: { ...settings.modes, [key]: mode } };
  writeJsonAtomic(preferencesFile(), next);
  preferences = next;
  return mode;
}

export function rememberAgentBrowser(key: string): void {
  const current = getBrowserProfilePreferences();
  if (current.agentPanes.includes(key)) return;
  const next = { ...current, agentPanes: [...current.agentPanes.slice(-1999), key] };
  writeJsonAtomic(preferencesFile(), next);
  preferences = next;
}

export function changeBrowserProfile(key: string, change: BrowserProfileChange): void {
  const current = getBrowserProfilePreferences();
  const modes = { ...current.modes, ...(change.mode ? { [key]: change.mode } : {}) };
  const next = preferencesSchema.parse({ ...current, modes,
    enabled: current.enabled || change.mode === 'personal',
    shareWithAgents: change.shareWithAgents ?? current.shareWithAgents,
  });
  writeJsonAtomic(preferencesFile(), next);
  preferences = next;
}

export function personalCookieProfile(): BrowserCookieProfile {
  if (!profile) {
    const stored = getSecret(VAULT_KEY);
    if (stored === null && hasSecret(VAULT_KEY)) throw new Error('O cofre do perfil está bloqueado. Desbloqueie o cofre antes de usar seus logins.');
    let cookies: ProfileCookie[];
    try { cookies = stored ? profileCookiesSchema.parse(JSON.parse(stored)) : []; }
    catch { throw new Error('Não foi possível abrir os dados do perfil Nexus.'); }
    profile = new BrowserCookieProfile(cookies, (next) => {
      const result = setInternalSecret(VAULT_KEY, JSON.stringify(next));
      if (!result.ok) throw new Error('Não foi possível guardar os logins no cofre do Nexus.');
    });
  }
  return profile;
}

export function cookieProtocolParams(cookie: ProfileCookie): Record<string, unknown> {
  // Omitting domain is necessary to preserve host-only / __Host- cookies.
  return {
    name: cookie.name, value: cookie.value,
    url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
    ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}),
    path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.expires !== undefined && cookie.expires > 0 ? { expires: cookie.expires } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/** Bind cookies only. Network sessions/proxies remain private to each pane. */
export async function connectPersonalProfile(
  contents: WebContents,
  assertCurrent: () => void,
  onError: (message: string) => void,
  ledger = personalCookieProfile(),
): Promise<() => Promise<void>> {
  const debug = contents.debugger;
  if (debug.isAttached()) throw new Error('Feche as ferramentas de desenvolvedor desta aba para conectar o perfil.');
  assertCurrent();
  debug.attach('1.3');
  let disposed = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const command = async (method: string, args?: Record<string, unknown>): Promise<any> => {
    assertCurrent();
    if (disposed || contents.isDestroyed() || !debug.isAttached()) throw new Error('Profile connection closed');
    const result = await debug.sendCommand(method, args);
    assertCurrent();
    return result;
  };
  const peer: ProfileCookiePeer = {
    revision: () => revision,
    read: async () => {
      // Network is target/session-scoped in Electron. Storage without a
      // browserContextId addresses the default context, not this partition.
      const response = await command('Network.getAllCookies');
      if (!Array.isArray(response?.cookies) || response.cookies.length > 10_000) throw new Error('Invalid cookie snapshot');
      const cookies: ProfileCookie[] = [];
      for (const raw of response.cookies) {
        // Nonce/opaque partitions cannot be replayed in another context.
        if (raw?.partitionKeyOpaque === true) continue;
        const parsed = profileCookieSchema.safeParse(raw);
        if (!parsed.success) throw new Error('Unsupported cookie snapshot');
        const cookie = parsed.data;
        if (cookie.expires !== undefined && cookie.expires <= 0) delete cookie.expires;
        cookies.push(cookie);
      }
      return cookies;
    },
    clear: async () => { await command('Network.clearBrowserCookies'); },
    apply: async (changed, removed) => {
      const cookies = [
        ...removed.map((cookie) => cookieProtocolParams({ ...cookie, value: '', expires: 1 })),
        ...changed.map(cookieProtocolParams),
      ];
      if (cookies.length) await command('Network.setCookies', { cookies });
    },
    failed: () => onError('Esta aba perdeu a sincronização dos logins. Reconecte o Perfil Nexus.'),
  };
  const onChanged = () => {
    revision += 1;
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void ledger.refresh(peer).catch(() => peer.failed());
    }, SYNC_DELAY_MS);
  };
  const onDetached = () => {
    if (!disposed) {
      ledger.disconnect(peer);
      peer.failed();
    }
  };
  try {
    await ledger.connect(peer);
    contents.session.cookies.on('changed', onChanged);
    debug.on('detach', onDetached);
  } catch {
    ledger.disconnect(peer);
    if (debug.isAttached()) debug.detach();
    throw new Error('Não foi possível conectar os logins desta aba ao Perfil Nexus.');
  }
  return async () => {
    if (disposed) return;
    clearTimeout(timer);
    contents.session.cookies.removeListener('changed', onChanged);
    debug.removeListener('detach', onDetached);
    try { await ledger.refresh(peer); } catch { /* A destroyed page cannot supply another snapshot. */ }
    ledger.disconnect(peer);
    disposed = true;
    if (!contents.isDestroyed() && debug.isAttached()) debug.detach();
  };
}
