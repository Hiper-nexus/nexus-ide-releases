import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { ChromeImportResult, ChromeProfileSummary, ChromeSiteSummary } from '../../shared/browser-profile';
import { profileCookieSchema, type ProfileCookie } from './browser-profile-cookies';

export interface ChromeCookieRow {
  host_key: string; name: string; value: string; encrypted_value: Buffer;
  path: string; expires_utc: number; is_secure: number; is_httponly: number;
  samesite: number; top_frame_site_key: string;
}
export type ChromeCookieDecode = { ok: true; cookie: ProfileCookie } | { ok: false; reason: 'partitioned' | 'encrypted' | 'expired' | 'invalid' };
export function decodeChromeCookie(row: ChromeCookieRow, version: number, key: Buffer | undefined, now: number): ChromeCookieDecode {
  if (row.top_frame_site_key) return { ok: false, reason: 'partitioned' };
  const expires = row.expires_utc > 0 ? row.expires_utc / 1e6 - 11644473600 : undefined;
  if (expires !== undefined && expires <= now) return { ok: false, reason: 'expired' };
  let value = row.value;
  if (row.encrypted_value.length) {
    if (!key || row.encrypted_value.subarray(0, 3).toString() !== 'v10') return { ok: false, reason: 'encrypted' };
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
      let plain = Buffer.concat([decipher.update(row.encrypted_value.subarray(3)), decipher.final()]);
      // Chrome schema 24+ authenticates the cookie's host inside the cipher.
      if (version >= 24) {
        const digest = createHash('sha256').update(row.host_key).digest();
        if (plain.length < 32 || !plain.subarray(0, 32).equals(digest)) return { ok: false, reason: 'invalid' };
        plain = plain.subarray(32);
      }
      value = plain.toString('utf8');
    } catch { return { ok: false, reason: 'encrypted' }; }
  }
  const sameSite = ({ 0: 'None', 1: 'Lax', 2: 'Strict' } as const)[row.samesite as 0 | 1 | 2];
  const parsed = profileCookieSchema.safeParse({
    name: row.name, value, domain: row.host_key, path: row.path,
    secure: Boolean(row.is_secure), httpOnly: Boolean(row.is_httponly),
    ...(sameSite ? { sameSite } : {}), ...(expires !== undefined ? { expires } : {}),
  });
  return parsed.success ? { ok: true, cookie: parsed.data } : { ok: false, reason: 'invalid' };
}

const MAX_COOKIE_ROWS = 20_000;
const chromeRoot = () => path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const profileId = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 24);

function profilesAt(root: string): Array<ChromeProfileSummary & { folder: string }> {
  if (!fs.existsSync(root)) return [];
  let names: Record<string, { name?: string }> = {};
  try {
    const file = path.join(root, 'Local State');
    if (fs.statSync(file).size < 4 * 1024 * 1024) names = JSON.parse(fs.readFileSync(file, 'utf8'))?.profile?.info_cache ?? {};
  } catch { /* Folder names remain usable when Local State is unavailable. */ }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name))
    .slice(0, 50)
    .map((entry) => ({
      id: profileId(entry.name), folder: entry.name,
      name: typeof names[entry.name]?.name === 'string'
        ? names[entry.name].name!.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : entry.name,
    }));
}

export function listChromeProfiles(root = chromeRoot()): ChromeProfileSummary[] {
  return profilesAt(root).map(({ id, name }) => ({ id, name }));
}

function withCookieDatabase<T>(id: string, root: string, read: (db: Database.Database) => T): T {
  const profile = profilesAt(root).find((candidate) => candidate.id === id);
  if (!profile) throw new Error('O perfil do Chrome não está mais disponível.');
  const base = fs.realpathSync(path.join(root, profile.folder));
  const candidate = [path.join(base, 'Network', 'Cookies'), path.join(base, 'Cookies')].find((file) => fs.existsSync(file));
  if (!candidate) throw new Error('Este perfil ainda não tem sessões para importar.');
  const file = fs.realpathSync(candidate);
  if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile() || fs.statSync(file).size > 128 * 1024 * 1024) {
    throw new Error('O arquivo de sessões desse perfil não pode ser importado.');
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
    return read(db);
  } catch {
    throw new Error('Não foi possível ler as sessões. Feche o Chrome e tente novamente.');
  } finally { db?.close(); }
}

export function listChromeSites(id: string, root = chromeRoot()): ChromeSiteSummary[] {
  return withCookieDatabase(id, root, (db) => {
    const rows = db.prepare("SELECT ltrim(host_key, '.') AS domain, count(*) AS cookies FROM cookies GROUP BY ltrim(host_key, '.') ORDER BY domain LIMIT 2000").all() as ChromeSiteSummary[];
    return rows.filter((row) => /^[a-z0-9.[\]:-]{1,253}$/i.test(row.domain));
  });
}

async function chromeMacKey(): Promise<Buffer | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 16_384,
    });
    const password = stdout.replace(/\r?\n$/, '');
    return password ? pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1') : undefined;
  } catch { return undefined; } // Keychain denial never exposes its output.
}

export async function readChromeImport(
  id: string, domains: string[], assertCurrent: () => void,
  options: { root?: string; readKey?: () => Promise<Buffer | undefined>; now?: number } = {},
): Promise<{ cookies: ProfileCookie[]; result: ChromeImportResult }> {
  assertCurrent();
  const root = options.root ?? chromeRoot();
  const selection = new Set(domains);
  if (!selection.size || selection.size > 200 || domains.some((domain) => !/^[a-z0-9.[\]:-]{1,253}$/i.test(domain))) {
    throw new Error('Selecione entre 1 e 200 sites.');
  }
  const { rows, version } = withCookieDatabase(id, root, (db) => {
    const columns = new Set((db.pragma('table_info(cookies)') as Array<{ name: string }>).map((column) => column.name));
    const partitionColumn = columns.has('top_frame_site_key') ? 'top_frame_site_key' : "'' AS top_frame_site_key";
    const query = db.prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, ${partitionColumn} FROM cookies WHERE ltrim(host_key, '.') IN (${[...selection].map(() => '?').join(',')}) LIMIT ?`);
    const rows = query.all(...selection, MAX_COOKIE_ROWS + 1) as ChromeCookieRow[];
    if (rows.length > MAX_COOKIE_ROWS) throw new Error('Too many cookies');
    const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined)?.value);
    if (!Number.isInteger(version) || version < 1) throw new Error('Unknown cookie schema');
    return { rows, version };
  });
  assertCurrent();
  const needsKey = rows.some((row) => row.encrypted_value.subarray(0, 3).toString() === 'v10');
  const key = needsKey ? await (options.readKey ?? chromeMacKey)() : undefined;
  const cookies: ProfileCookie[] = [];
  const result: ChromeImportResult = { importedCookies: 0, importedSites: 0, skipped: { partitioned: 0, encrypted: 0, expired: 0, invalid: 0 } };
  try {
    assertCurrent();
    for (const row of rows) {
      const decoded = decodeChromeCookie(row, version, key, options.now ?? Date.now() / 1000);
      if (decoded.ok) cookies.push(decoded.cookie);
      else result.skipped[decoded.reason] += 1;
    }
  } finally { key?.fill(0); }
  result.importedCookies = cookies.length;
  result.importedSites = new Set(cookies.map((cookie) => cookie.domain.replace(/^\./, ''))).size;
  return { cookies, result };
}
