// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: Sources.ts sem Effect — mesmas definições de navegador (mais os caminhos do Windows para Chrome/Edge/Brave/Vivaldi, que só servem para responder "App-Bound" de forma legível), descoberta de perfis síncrona com fs/better-sqlite3, só perfis com banco de cookies, sem contagem de cookies nem detecção de navegador aberto (o snapshot dispensa fechar o navegador) e EPERM/EACCES na pasta do navegador devolvido como {ok:false, reason:'permissionDenied'}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export type BrowserImportEngine = 'chromium' | 'firefox' | 'safari';

/** Directory roots a definition builds its paths from; injectable so tests never touch the real home. */
export interface BrowserImportPathContext {
  path: typeof path;
  platform: NodeJS.Platform;
  home: string;
  /** `%APPDATA%` on Windows; unused elsewhere. */
  appData?: string;
  /** `%LOCALAPPDATA%` on Windows; unused elsewhere. */
  localAppData?: string;
}

export interface BrowserImportSourceDefinition {
  id: string;
  name: string;
  engine: BrowserImportEngine;
  userDataDirectory(context: BrowserImportPathContext): string | undefined;
  /** Chromium on macOS: where the OSCrypt key lives in the keychain. */
  keychainService?: string;
  keychainAccount?: string;
  /** Chromium's `application` attribute in the Linux libsecret schema. */
  linuxSecretApplication?: string;
}

export interface SourceProfile { directory: string; name: string }
export type SourceProfiles = { ok: true; profiles: SourceProfile[] } | { ok: false; reason: 'permissionDenied' };

export function hostPathContext(): BrowserImportPathContext {
  return { path, platform: process.platform, home: os.homedir(), appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA };
}

const macApplicationSupport = (context: BrowserImportPathContext, ...segments: string[]) =>
  context.path.join(context.home, 'Library', 'Application Support', ...segments);

/** One Chromium fork; omitting a platform's segments marks it unavailable there. */
const chromiumSource = (input: {
  id: string; name: string; keychainService: string; keychainAccount: string;
  macSegments: string[]; linuxSegments?: string[]; linuxSecretApplication?: string; windowsSegments?: string[];
}): BrowserImportSourceDefinition => ({
  id: input.id, name: input.name, engine: 'chromium',
  keychainService: input.keychainService, keychainAccount: input.keychainAccount,
  ...(input.linuxSecretApplication ? { linuxSecretApplication: input.linuxSecretApplication } : {}),
  userDataDirectory: (context) => {
    if (context.platform === 'darwin') return macApplicationSupport(context, ...input.macSegments);
    if (context.platform === 'win32') {
      return input.windowsSegments && context.localAppData ? context.path.join(context.localAppData, ...input.windowsSegments) : undefined;
    }
    if (context.platform === 'linux') return input.linuxSegments ? context.path.join(context.home, '.config', ...input.linuxSegments) : undefined;
    return undefined;
  },
});

export const BROWSER_IMPORT_SOURCES: BrowserImportSourceDefinition[] = [
  // Chrome, Edge and Brave on Windows use App-Bound Encryption since Chrome
  // 127: listed so the user learns why instead of the browser being missing.
  chromiumSource({ id: 'chrome', name: 'Chrome', keychainService: 'Chrome Safe Storage', keychainAccount: 'Chrome',
    macSegments: ['Google', 'Chrome'], linuxSegments: ['google-chrome'], linuxSecretApplication: 'chrome',
    windowsSegments: ['Google', 'Chrome', 'User Data'] }),
  chromiumSource({ id: 'edge', name: 'Microsoft Edge', keychainService: 'Microsoft Edge Safe Storage', keychainAccount: 'Microsoft Edge',
    macSegments: ['Microsoft Edge'], linuxSegments: ['microsoft-edge'], linuxSecretApplication: 'msedge',
    windowsSegments: ['Microsoft', 'Edge', 'User Data'] }),
  chromiumSource({ id: 'brave', name: 'Brave', keychainService: 'Brave Safe Storage', keychainAccount: 'Brave',
    macSegments: ['BraveSoftware', 'Brave-Browser'], linuxSegments: ['BraveSoftware', 'Brave-Browser'], linuxSecretApplication: 'brave',
    windowsSegments: ['BraveSoftware', 'Brave-Browser', 'User Data'] }),
  chromiumSource({ id: 'vivaldi', name: 'Vivaldi', keychainService: 'Vivaldi Safe Storage', keychainAccount: 'Vivaldi',
    macSegments: ['Vivaldi'], linuxSegments: ['vivaldi'], linuxSecretApplication: 'vivaldi',
    windowsSegments: ['Vivaldi', 'User Data'] }),
  chromiumSource({ id: 'opera', name: 'Opera', keychainService: 'Opera Safe Storage', keychainAccount: 'Opera',
    macSegments: ['com.operasoftware.Opera'], linuxSegments: ['opera'], linuxSecretApplication: 'opera' }),
  // Arc has no Linux build.
  chromiumSource({ id: 'arc', name: 'Arc', keychainService: 'Arc Safe Storage', keychainAccount: 'Arc',
    macSegments: ['Arc', 'User Data'] }),
  // Helium retains Chromium's libsecret application name on Linux.
  chromiumSource({ id: 'helium', name: 'Helium', keychainService: 'Helium Storage Key', keychainAccount: 'Helium',
    macSegments: ['net.imput.helium'], linuxSegments: ['net.imput.helium'], linuxSecretApplication: 'chromium',
    windowsSegments: ['imput', 'Helium', 'User Data'] }),
  {
    // The default jar lives here; named profiles use WebKit data stores in the same container.
    id: 'safari', name: 'Safari', engine: 'safari',
    userDataDirectory: (context) => context.platform === 'darwin'
      ? context.path.join(context.home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies') : undefined,
  },
  {
    id: 'firefox', name: 'Firefox', engine: 'firefox',
    userDataDirectory: (context) => {
      if (context.platform === 'darwin') return macApplicationSupport(context, 'Firefox');
      if (context.platform === 'win32') return context.appData ? context.path.join(context.appData, 'Mozilla', 'Firefox') : undefined;
      return context.path.join(context.home, '.mozilla', 'firefox');
    },
  },
];

/**
 * Where a profile's cookie database may live, most current first. Chromium 96
 * moved the live jar to `Network/Cookies`; a root-level `Cookies` is a pre-96
 * install or a leftover, so it only counts when the current one is absent.
 */
export function cookieDatabaseCandidatePaths(
  definition: BrowserImportSourceDefinition, context: BrowserImportPathContext, profileDirectory: string,
): string[] {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const profilePath = context.path.isAbsolute(profileDirectory) ? profileDirectory : context.path.join(root, profileDirectory);
  if (definition.engine === 'firefox') return [context.path.join(profilePath, 'cookies.sqlite')];
  if (definition.engine === 'safari') return [context.path.join(profilePath, 'Cookies.binarycookies')];
  return [context.path.join(profilePath, 'Network', 'Cookies'), context.path.join(profilePath, 'Cookies')];
}

/** A directory at the path would list as a profile and then fail to open; only regular files count. */
const isFile = (file: string): boolean => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
};

export function resolveCookieDatabase(
  definition: BrowserImportSourceDefinition, context: BrowserImportPathContext, profileDirectory: string,
): string | undefined {
  return cookieDatabaseCandidatePaths(definition, context, profileDirectory).find(isFile);
}

/**
 * Firefox records its profiles in `profiles.ini`. `Install*` sections point at
 * a default profile but do not describe one, so only `[ProfileN]` blocks count.
 */
export function parseFirefoxProfiles(ini: string, pathApi: typeof path, root: string): SourceProfile[] {
  const profiles: SourceProfile[] = [];
  let current: { name?: string; path?: string; isRelative?: string } | null = null;
  const flush = () => {
    if (current?.path) {
      const candidate = current.path;
      const isRelative = current.isRelative === undefined || current.isRelative === '1';
      const validIsRelative = current.isRelative === undefined || /^[01]$/.test(current.isRelative);
      let directory: string | undefined;
      if (validIsRelative && !candidate.includes('\u0000')) {
        if (isRelative) {
          if (!pathApi.isAbsolute(candidate)) {
            const relative = pathApi.relative(root, pathApi.resolve(root, candidate));
            const escapesRoot = relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative);
            if (!escapesRoot) directory = pathApi.normalize(candidate);
          }
        } else if (pathApi.isAbsolute(candidate)) {
          // IsRelative=0 profiles may live on any custom root.
          directory = pathApi.normalize(candidate);
        }
      }
      if (directory !== undefined) profiles.push({ directory, name: current.name?.trim() || directory });
    }
    current = null;
  };
  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      flush();
      current = /^\[Profile\d+\]$/i.test(line) ? {} : null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'name') current.name = value;
    if (key === 'path') current.path = value;
    if (key === 'isrelative') current.isRelative = value;
  }
  flush();
  return profiles;
}

/** A single plain path segment: no separators, no `.`/`..`, not empty. */
const isSafeProfileDirectory = (directory: string): boolean =>
  directory.length > 0 && directory !== '.' && directory !== '..' && !/[\\/]/.test(directory) && !directory.includes('\u0000');
const isSafariProfileUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isDenied = (error: unknown) => ['EPERM', 'EACCES'].includes(String((error as { code?: unknown } | undefined)?.code));
/** Profile names come from files any process of the user can write. */
const displayName = (name: string) => name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100);

function readSmallFile(file: string): string | undefined {
  try { return fs.statSync(file).size < 4 * 1024 * 1024 ? fs.readFileSync(file, 'utf8') : undefined; }
  catch (error) { if (isDenied(error)) throw error; return undefined; }
}
function readDirectory(directory: string): string[] {
  try { return fs.readdirSync(directory); }
  catch (error) { if (isDenied(error)) throw error; return []; }
}

function listSafariProfiles(context: BrowserImportPathContext, root: string): SourceProfile[] {
  const library = context.path.dirname(root);
  let declared: Array<{ title: string | null; external_uuid: string }> = [];
  let db: Database.Database | undefined;
  try {
    db = new Database(context.path.join(library, 'Safari', 'SafariTabs.db'), { readonly: true, fileMustExist: true, timeout: 1000 });
    declared = db.prepare('SELECT title, external_uuid FROM bookmarks WHERE parent = 0 AND type = 1 AND subtype = 2 AND deleted = 0 ORDER BY order_index').all() as typeof declared;
  } catch { /* Without Full Disk Access the metadata is unreadable; the default jar still lists. */ }
  finally { db?.close(); }
  const defaultProfile = declared.find((profile) => profile.external_uuid === 'DefaultProfile');
  const profiles: SourceProfile[] = [{ directory: '.', name: defaultProfile ? defaultProfile.title?.trim() || 'Personal' : 'Safari' }];
  const stores = context.path.join(library, 'WebKit', 'WebsiteDataStore');
  for (const profile of declared) {
    if (!isSafariProfileUuid(profile.external_uuid)) continue;
    profiles.push({ directory: context.path.join(stores, profile.external_uuid.toLowerCase(), 'Cookies'), name: profile.title?.trim() || profile.external_uuid });
  }
  // With readable metadata, deleted profiles left on disk are not resurrected.
  if (declared.length === 0) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(stores); } catch { /* Unreadable without Full Disk Access. */ }
    for (const entry of entries.filter(isSafariProfileUuid).sort()) profiles.push({ directory: context.path.join(stores, entry, 'Cookies'), name: entry });
  }
  return profiles;
}

function listProfilesInDirectory(definition: BrowserImportSourceDefinition, context: BrowserImportPathContext, root: string): SourceProfile[] {
  if (definition.engine === 'safari') return listSafariProfiles(context, root);
  if (definition.engine === 'firefox') {
    const ini = readSmallFile(context.path.join(root, 'profiles.ini'));
    const declared = ini === undefined ? [] : parseFirefoxProfiles(ini, context.path, root);
    // profiles.ini also lists never-launched profiles; a cookie database proves
    // one was used. With none of them proven, scan for the real ones.
    const used = declared.filter((profile) => resolveCookieDatabase(definition, context, profile.directory) !== undefined);
    if (used.length > 0) return used;
    const linux = context.platform === 'linux';
    return readDirectory(linux ? root : context.path.join(root, 'Profiles'))
      .map((entry) => ({ directory: linux ? entry : context.path.join('Profiles', entry), name: entry }))
      .filter((profile) => isSafeProfileDirectory(profile.name));
  }
  // A Chromium that ever ran wrote `Local State`. Installers of native
  // messaging hosts leave empty user-data folders for forks never used; those
  // are not browsers to list, nor permission problems to report.
  const localState = readSmallFile(context.path.join(root, 'Local State'));
  if (localState === undefined) return [];
  let declared: SourceProfile[] = [];
  try {
    const infoCache = JSON.parse(localState)?.profile?.info_cache;
    if (infoCache && typeof infoCache === 'object') {
      // Keys are directory names from a file the user's processes can write:
      // anything but a single plain segment could read outside the user data.
      declared = Object.entries(infoCache as Record<string, { name?: unknown }>)
        .filter(([directory]) => isSafeProfileDirectory(directory))
        .map(([directory, info]) => ({ directory, name: typeof info?.name === 'string' && info.name.trim() ? info.name : directory }));
    }
  } catch { /* Malformed Local State: fall back to the directory scan. */ }
  if (declared.length > 0) return declared;
  return readDirectory(root).filter(isSafeProfileDirectory).map((directory) => ({ directory, name: directory }));
}

/**
 * Profiles the source browser knows about that hold a cookie database.
 * Linux Firefox also has a Snap home; its profiles keep absolute directories
 * so reads stay pointed at the installation they came from.
 */
export function listSourceProfiles(definition: BrowserImportSourceDefinition, context: BrowserImportPathContext): SourceProfiles {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return { ok: true, profiles: [] };
  const roots = definition.engine === 'firefox' && context.platform === 'linux'
    ? [root, context.path.join(context.home, 'snap', 'firefox', 'common', '.mozilla', 'firefox')] : [root];
  const profiles = new Map<string, SourceProfile>();
  try {
    for (const directory of roots) {
      const scoped = { ...definition, userDataDirectory: () => directory };
      for (const profile of listProfilesInDirectory(scoped, context, directory)) {
        if (resolveCookieDatabase(scoped, context, profile.directory) === undefined) continue;
        const absolute = context.path.resolve(directory, profile.directory);
        if (!profiles.has(absolute)) {
          profiles.set(absolute, { directory: directory === root ? profile.directory : absolute, name: displayName(profile.name) || 'Perfil' });
        }
      }
    }
  } catch (error) {
    if (isDenied(error)) return { ok: false, reason: 'permissionDenied' };
    throw error;
  }
  return { ok: true, profiles: [...profiles.values()].slice(0, 50) };
}
