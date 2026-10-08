// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: BrowserImport.ts sem Effect e sem gravar no Electron — lista perfis com id opaco (sha-256 de navegador+pasta), aceita só perfis que a própria fonte relatou, lê os sites escolhidos do snapshot, pede a chave só quando uma linha escolhida precisa dela, reconfere a autoridade da aba depois do Keychain e devolve ProfileCookie[] ao ledger do Perfil Nexus; motivos viram mensagens em pt-BR sem nenhum valor de cookie ou chave.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { BrowserImportProfile, BrowserImportResult, BrowserImportSite } from '../../../shared/browser-profile';
import type { ProfileCookie } from '../browser-profile-cookies';
import {
  chromiumRowNeedsKey, decodeChromiumCookie, listChromiumSites, readChromiumRows,
} from './chromium-cookies';
import {
  decodeWindowsWrappedKey, resolveChromiumKeys, wipeChromiumKeys,
  type ChromiumKeyFailure, type ChromiumKeyMaterial, type ChromiumKeyRequest, type KeyResult,
} from './chromium-keys';
import { toProfileCookie, withCookieSnapshot, type CookieDecode, type SnapshotFailure, type SnapshotRead } from './cookie-snapshot';
import { listFirefoxSites, readFirefoxCookies } from './firefox-cookies';
import { readSafariJar, type SafariCookieRead } from './safari-cookies';
import {
  BROWSER_IMPORT_SOURCES, hostPathContext, listSourceProfiles, resolveCookieDatabase,
  type BrowserImportPathContext, type BrowserImportSourceDefinition,
} from './sources';

const MAX_COOKIE_DATABASE_BYTES = 128 * 1024 * 1024;
const SITE_PATTERN = /^[a-z0-9.[\]:-]{1,253}$/i;

interface DiscoveredProfile extends BrowserImportProfile {
  source: BrowserImportSourceDefinition;
  /** Undefined when the OS refused to list the browser's profiles. */
  directory?: string;
}

const profileId = (sourceId: string, directory: string) =>
  createHash('sha256').update(`${sourceId}\0${directory}`).digest('hex').slice(0, 24);

function discoverProfiles(context: BrowserImportPathContext): DiscoveredProfile[] {
  return BROWSER_IMPORT_SOURCES.flatMap((source): DiscoveredProfile[] => {
    const listed = listSourceProfiles(source, context);
    // One browser the OS refuses to read must not hide the others; it is
    // listed so choosing it explains which permission to grant.
    if (!listed.ok) return [{ id: profileId(source.id, '\0blocked'), name: 'Sem acesso', browser: source.name, source }];
    return listed.profiles.map((profile) => ({ id: profileId(source.id, profile.directory), name: profile.name, browser: source.name, source, directory: profile.directory }));
  });
}

export function listImportProfiles(context = hostPathContext()): BrowserImportProfile[] {
  return discoverProfiles(context).map(({ id, name, browser }) => ({ id, name, browser }));
}

const permissionMessage = (context: BrowserImportPathContext, browser: string) => context.platform === 'darwin'
  ? `O macOS bloqueou o acesso aos perfis do ${browser}. Autorize o NexusIDE em Ajustes do Sistema → Privacidade e Segurança → Acesso Total ao Disco e abra o Nexus de novo.`
  : `O sistema bloqueou o acesso aos perfis do ${browser}. Confira as permissões da pasta do navegador e tente novamente.`;

const appBoundMessage = (browser: string) =>
  `No Windows, o ${browser} protege os cookies com uma criptografia presa ao próprio navegador (App-Bound), que outros programas não podem ler. Entre nos sites pelo Perfil Nexus: o login fica salvo nele.`;

function snapshotMessage(reason: SnapshotFailure, context: BrowserImportPathContext, browser: string): string {
  if (reason === 'locked') return `O ${browser} está com o arquivo de sessões aberto e não deixa outros programas lerem. Feche o ${browser} e tente novamente.`;
  if (reason === 'permissionDenied') return permissionMessage(context, browser);
  return `Não foi possível ler as sessões do ${browser}. Tente novamente.`;
}

function keyMessage(reason: ChromiumKeyFailure, context: BrowserImportPathContext, browser: string): string {
  const linux = context.platform === 'linux';
  switch (reason) {
    case 'needsKeychainApproval':
      return linux
        ? `O chaveiro do sistema não liberou a chave de cookies do ${browser}. Desbloqueie o chaveiro e tente novamente.`
        : `O Chaveiro não liberou a chave de cookies do ${browser}. Tente novamente e escolha "Permitir" no aviso do macOS.`;
    case 'keychainItemMissing':
      return `A chave de cookies do ${browser} não está no ${linux ? 'chaveiro do sistema' : 'Chaveiro'}. Abra o ${browser} uma vez e tente novamente.`;
    case 'keychainUnavailable':
      return linux
        ? `Não foi possível ler a chave de cookies do ${browser} no chaveiro do sistema (Secret Service). Confira se o chaveiro está desbloqueado e se o secret-tool (libsecret) está instalado.`
        : `Não foi possível acessar o chaveiro do sistema para ler a chave de cookies do ${browser}.`;
    case 'appBound':
      return appBoundMessage(browser);
    case 'unsupportedPlatform':
      return `A importação do ${browser} não está disponível neste sistema.`;
    case 'readFailed':
      return `Não foi possível ler a chave de cookies do ${browser}.`;
  }
}

function safariMessage(read: Exclude<SafariCookieRead, { ok: true }>): string {
  return read.reason === 'needsFullDiskAccess'
    ? 'O macOS só libera os cookies do Safari para apps com Acesso Total ao Disco. Autorize o NexusIDE em Ajustes do Sistema → Privacidade e Segurança → Acesso Total ao Disco e abra o Nexus de novo.'
    : 'Não foi possível ler as sessões do Safari. Tente novamente.';
}

/** Resolves an opaque id to a database the source itself reported, inside its profile. */
function profileDatabase(id: string, context: BrowserImportPathContext): { profile: DiscoveredProfile; database: string } {
  // The id arrives over IPC: only profiles the source reports right now are
  // honoured, so `..` or a forged directory can never reach another file.
  const profile = discoverProfiles(context).find((candidate) => candidate.id === id);
  if (!profile) throw new Error('O perfil do navegador não está mais disponível.');
  if (profile.directory === undefined) throw new Error(permissionMessage(context, profile.browser));
  const candidate = resolveCookieDatabase(profile.source, context, profile.directory);
  if (!candidate) throw new Error('Este perfil ainda não tem sessões para importar.');
  const root = profile.source.userDataDirectory(context) ?? '';
  let database: string;
  try {
    const base = fs.realpathSync(context.path.isAbsolute(profile.directory) ? profile.directory : context.path.join(root, profile.directory));
    database = fs.realpathSync(candidate);
    const stat = fs.statSync(database);
    if (!database.startsWith(base + context.path.sep) || !stat.isFile() || stat.size > MAX_COOKIE_DATABASE_BYTES) throw new Error('outside');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) throw new Error(permissionMessage(context, profile.browser));
    throw new Error('O arquivo de sessões desse perfil não pode ser importado.');
  }
  return { profile, database };
}

/** Windows Chromium with App-Bound keys is refused before the user picks sites. */
function assertNotAppBound(profile: DiscoveredProfile, context: BrowserImportPathContext): void {
  const root = profile.source.userDataDirectory(context);
  if (context.platform !== 'win32' || profile.source.engine !== 'chromium' || !root) return;
  let localState: string;
  // Unreadable Local State is reported by the key read on import.
  try { localState = fs.readFileSync(context.path.join(root, 'Local State'), 'utf8'); } catch { return; }
  const decoded = decodeWindowsWrappedKey(localState);
  if (!decoded.ok && decoded.reason === 'appBound') throw new Error(appBoundMessage(profile.browser));
}

function fromSnapshot<T>(database: string, profile: DiscoveredProfile, context: BrowserImportPathContext, read: (db: Database.Database) => T): T {
  let snapshot: SnapshotRead<T>;
  try { snapshot = withCookieSnapshot(database, read); }
  catch (error) {
    if (error instanceof RangeError) throw new Error('Os sites escolhidos têm cookies demais para importar de uma vez. Selecione menos sites.');
    // Unexpected schema or SQL failure; its text may quote stored data, so it is dropped.
    throw new Error(snapshotMessage('readFailed', context, profile.browser));
  }
  if (!snapshot.ok) throw new Error(snapshotMessage(snapshot.reason, context, profile.browser));
  return snapshot.value;
}

export function listImportSites(id: string, context = hostPathContext()): BrowserImportSite[] {
  const { profile, database } = profileDatabase(id, context);
  let sites: BrowserImportSite[];
  if (profile.source.engine === 'safari') {
    const read = readSafariJar(database);
    if (!read.ok) throw new Error(safariMessage(read));
    const counts = new Map<string, number>();
    for (const cookie of read.cookies) {
      const domain = cookie.host.replace(/^\./, '');
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    sites = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 2000).map(([domain, cookies]) => ({ domain, cookies }));
  } else {
    assertNotAppBound(profile, context);
    sites = fromSnapshot(database, profile, context, profile.source.engine === 'firefox' ? listFirefoxSites : listChromiumSites);
  }
  return sites.filter((site) => SITE_PATTERN.test(site.domain));
}

export interface ReadBrowserImportOptions {
  context?: BrowserImportPathContext;
  now?: number;
  resolveKeys?: (request: ChromiumKeyRequest) => Promise<KeyResult<ChromiumKeyMaterial>>;
}

export async function readBrowserImport(
  id: string, domains: string[], assertCurrent: () => void, options: ReadBrowserImportOptions = {},
): Promise<{ cookies: ProfileCookie[]; result: BrowserImportResult }> {
  assertCurrent();
  const context = options.context ?? hostPathContext();
  const now = options.now ?? Date.now() / 1000;
  const selection = [...new Set(domains)];
  if (!selection.length || selection.length > 200 || selection.some((domain) => !SITE_PATTERN.test(domain))) {
    throw new Error('Selecione entre 1 e 200 sites.');
  }
  const { profile, database } = profileDatabase(id, context);
  const { source } = profile;
  let decoded: CookieDecode[];
  if (source.engine === 'safari') {
    const read = readSafariJar(database);
    if (!read.ok) throw new Error(safariMessage(read));
    const selected = new Set(selection);
    decoded = read.cookies.filter((cookie) => selected.has(cookie.host.replace(/^\./, ''))).map((cookie) => toProfileCookie(cookie, now));
  } else if (source.engine === 'firefox') {
    decoded = fromSnapshot(database, profile, context, (db) => readFirefoxCookies(db, selection, now));
  } else {
    const { rows, schemaVersion } = fromSnapshot(database, profile, context, (db) => readChromiumRows(db, selection));
    assertCurrent();
    let keys: ChromiumKeyMaterial = {};
    if (rows.some((row) => chromiumRowNeedsKey(row, context.platform))) {
      const root = source.userDataDirectory(context);
      const resolved = await (options.resolveKeys ?? resolveChromiumKeys)({
        platform: context.platform,
        keychainService: source.keychainService,
        keychainAccount: source.keychainAccount,
        linuxSecretApplication: source.linuxSecretApplication,
        ...(context.platform === 'win32' && root ? { windowsLocalStatePath: context.path.join(root, 'Local State') } : {}),
      });
      if (!resolved.ok) throw new Error(keyMessage(resolved.reason, context, profile.browser));
      keys = resolved.value;
    }
    try {
      // The Keychain prompt can take as long as the user wants: the tab may
      // have closed or changed scope while it was open.
      assertCurrent();
      decoded = rows.map((row) => decodeChromiumCookie(row, schemaVersion, keys, context.platform, now));
    } finally { wipeChromiumKeys(keys); }
    // A partial import is fine, but a missing keyring key that blocked every
    // otherwise importable cookie is a failure, not "0 cookies imported".
    if (keys.cbcV11Error && !decoded.some((entry) => entry.ok)
      && rows.some((row) => !row.top_frame_site_key && row.encrypted_value.subarray(0, 3).toString('latin1') === 'v11')) {
      throw new Error(keyMessage(keys.cbcV11Error, context, profile.browser));
    }
  }
  assertCurrent();
  const cookies: ProfileCookie[] = [];
  const result: BrowserImportResult = { importedCookies: 0, importedSites: 0, skipped: { partitioned: 0, encrypted: 0, expired: 0, invalid: 0 } };
  for (const entry of decoded) {
    if (entry.ok) cookies.push(entry.cookie);
    else result.skipped[entry.reason] += 1;
  }
  result.importedCookies = cookies.length;
  result.importedSites = new Set(cookies.map((cookie) => cookie.domain.replace(/^\./, ''))).size;
  return { cookies, result };
}
