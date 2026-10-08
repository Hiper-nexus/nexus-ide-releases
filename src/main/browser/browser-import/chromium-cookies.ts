// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: ChromiumCookies.ts sem Effect — decryptChromiumValue igual ao upstream; leitura síncrona por better-sqlite3 do snapshot, só dos sites escolhidos e com teto de linhas; contagem por site para a seleção; a chave só é pedida se alguma linha escolhida precisar dela; cookies de saída no formato ProfileCookie do Perfil Nexus.
import { createDecipheriv, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BrowserImportSite } from '../../../shared/browser-profile';
import type { ChromiumKeyMaterial } from './chromium-keys';
import { toProfileCookie, type CookieDecode } from './cookie-snapshot';

/** OSCrypt's CBC mode uses a fixed IV of 16 spaces rather than a per-record one. */
const AES_CBC_IV = Buffer.alloc(16, 0x20);
const AES_GCM_NONCE_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;
/** Chromium counts microseconds from 1601-01-01; the SQL divides, this rebases. */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
export const MAX_COOKIE_ROWS = 20_000;

export interface ChromiumCookieRow {
  host_key: string; name: string; value: string; encrypted_value: Buffer; path: string;
  expires_seconds: number; is_secure: number; is_httponly: number; samesite: number; top_frame_site_key: string;
}

/**
 * Chromium >= 127 (schema 24) prefixes the plaintext with SHA-256 of the host
 * key, binding a cookie to its domain. A mismatch means the value was moved
 * between hosts, so the record is refused rather than imported.
 */
function stripDomainBinding(plaintext: Buffer, domain: string, schemaVersion: number): Buffer | null {
  if (schemaVersion < 24) return plaintext;
  const domainHash = createHash('sha256').update(domain).digest();
  return plaintext.length >= 32 && plaintext.subarray(0, 32).equals(domainHash) ? plaintext.subarray(32) : null;
}

function decryptCbc(payload: Buffer, key: Buffer, domain: string, schemaVersion: number): string | null {
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, AES_CBC_IV);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString('utf8') ?? null;
  } catch { return null; }
}

function decryptGcm(payload: Buffer, key: Buffer, domain: string, schemaVersion: number): string | null {
  if (payload.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, AES_GCM_NONCE_LENGTH));
    decipher.setAuthTag(payload.subarray(-AES_GCM_TAG_LENGTH));
    const plaintext = Buffer.concat([decipher.update(payload.subarray(AES_GCM_NONCE_LENGTH, -AES_GCM_TAG_LENGTH)), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString('utf8') ?? null;
  } catch { return null; }
}

/**
 * Decrypts one stored value, choosing the scheme from its prefix. Returns null
 * when no key covers that scheme, including Windows' App-Bound `v20`.
 */
export function decryptChromiumValue(
  encrypted: Uint8Array, keys: ChromiumKeyMaterial, domain: string,
  schemaVersion = 23, platform: NodeJS.Platform = 'linux',
): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return '';
  const prefix = buffer.subarray(0, 3).toString('latin1');
  const payload = buffer.subarray(3);
  // Windows' legacy v10 is AES-256-GCM; App-Bound records use v20 and have no key here.
  if (platform === 'win32') return prefix === 'v10' && keys.gcmV10 ? decryptGcm(payload, keys.gcmV10, domain, schemaVersion) : null;
  // Chromium retries a failed record with the empty-passphrase key
  // (crbug.com/1195256); a record whose own key is missing stays skipped.
  if (prefix === 'v10' || prefix === 'v11') {
    const own = prefix === 'v10' ? keys.cbcV10 : keys.cbcV11;
    if (!own) return null;
    return decryptCbc(payload, own, domain, schemaVersion)
      ?? (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null);
  }
  // No recognised prefix: OSCrypt on macOS and Linux returns it as legacy
  // clear text, so it is a readable cookie rather than an undecryptable one.
  if (platform === 'darwin' || platform === 'linux') return stripDomainBinding(buffer, domain, schemaVersion)?.toString('utf8') ?? null;
  return null;
}

/** Whether decoding this row needs a key from the OS credential store. */
export function chromiumRowNeedsKey(row: ChromiumCookieRow, platform: NodeJS.Platform): boolean {
  if (row.top_frame_site_key || row.encrypted_value.length === 0) return false;
  if (platform === 'win32') return true;
  const prefix = row.encrypted_value.subarray(0, 3).toString('latin1');
  return prefix === 'v10' || prefix === 'v11';
}

export function readChromiumSchemaVersion(db: Database.Database): number {
  const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: unknown } | undefined)?.value);
  if (!Number.isInteger(version) || version < 1) throw new Error('Unknown cookie schema');
  return version;
}

export function listChromiumSites(db: Database.Database): BrowserImportSite[] {
  return db.prepare("SELECT ltrim(host_key, '.') AS domain, count(*) AS cookies FROM cookies GROUP BY ltrim(host_key, '.') ORDER BY domain LIMIT 2000").all() as BrowserImportSite[];
}

/** Rows of the selected sites only. Throws past MAX_COOKIE_ROWS rather than truncating. */
export function readChromiumRows(db: Database.Database, domains: string[]): { rows: ChromiumCookieRow[]; schemaVersion: number } {
  const schemaVersion = readChromiumSchemaVersion(db);
  const columns = new Set((db.pragma('table_info(cookies)') as Array<{ name: string }>).map((column) => column.name));
  // Pre-CHIPS schemas have no partition column.
  const partition = columns.has('top_frame_site_key') ? 'top_frame_site_key' : "'' AS top_frame_site_key";
  // The microsecond timestamp overflows a safe integer; divide in SQL.
  const rows = db.prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000 AS expires_seconds, is_secure, is_httponly, samesite, ${partition} FROM cookies WHERE ltrim(host_key, '.') IN (${domains.map(() => '?').join(',')}) LIMIT ?`)
    .all(...domains, MAX_COOKIE_ROWS + 1) as ChromiumCookieRow[];
  if (rows.length > MAX_COOKIE_ROWS) throw new RangeError('Too many cookies');
  return { rows, schemaVersion };
}

export function decodeChromiumCookie(
  row: ChromiumCookieRow, schemaVersion: number, keys: ChromiumKeyMaterial, platform: NodeJS.Platform, now: number,
): CookieDecode {
  // A partitioned (CHIPS) cookie replayed without its partition would reach every top-level site.
  if (row.top_frame_site_key) return { ok: false, reason: 'partitioned' };
  const value = row.encrypted_value.length === 0 ? row.value
    : decryptChromiumValue(row.encrypted_value, keys, row.host_key, schemaVersion, platform);
  if (value === null) return { ok: false, reason: 'encrypted' };
  // -1 (unspecified) and anything unknown stay unset: guessing None would widen the cookie.
  const sameSite = ({ 0: 'None', 1: 'Lax', 2: 'Strict' } as const)[row.samesite as 0 | 1 | 2];
  return toProfileCookie({
    host: row.host_key, name: row.name, value, path: row.path,
    secure: row.is_secure === 1, httpOnly: row.is_httponly === 1,
    ...(sameSite ? { sameSite } : {}),
    ...(row.expires_seconds > 0 ? { expires: row.expires_seconds - WEBKIT_EPOCH_OFFSET_SECONDS } : {}),
  }, now);
}
