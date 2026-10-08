// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: FirefoxCookies.ts sem Effect — leitura síncrona por better-sqlite3 do snapshot, só dos sites escolhidos e com teto de linhas; contagem por site para a seleção; saída no formato ProfileCookie (SameSite "unspecified" vira atributo ausente).
import type Database from 'better-sqlite3';
import type { BrowserImportSite } from '../../../shared/browser-profile';
import { MAX_COOKIE_ROWS } from './chromium-cookies';
import { toProfileCookie, type CookieDecode, type StoredCookie } from './cookie-snapshot';

/**
 * `moz_cookies.sameSite` holds nsICookie's constants: 0 = None, 1 = Lax,
 * 2 = Strict, 256 = Unset. Unset is not None (an explicit cross-site opt-in),
 * so it and anything unknown stay unset: guessing None would widen the cookie.
 */
const SAMESITE_NONE = 0;
const SAMESITE_LAX = 1;
const SAMESITE_STRICT = 2;
/**
 * Schemas 10–14 kept the declared value in `rawSameSite` beside a `sameSite`
 * already defaulted to Lax; Firefox's migration to 15 turns "Lax by default,
 * None declared" into Unset, and an unmigrated database is read the same way.
 */
const FIREFOX_RAW_SAMESITE_FIRST_SCHEMA = 10;
const FIREFOX_RAW_SAMESITE_LAST_SCHEMA = 14;
/** Firefox 129 (schema 16) moved `expiry` from seconds to milliseconds. */
const FIREFOX_EXPIRY_MILLISECONDS_SCHEMA = 16;

function sameSiteFromColumn(value: number | null, rawValue: number | null): StoredCookie['sameSite'] {
  // Schema 9 added the column with no default, so older rows carry NULL.
  if (value === null) return undefined;
  if (value === SAMESITE_LAX && rawValue === SAMESITE_NONE) return undefined;
  if (value === SAMESITE_NONE) return 'None';
  if (value === SAMESITE_LAX) return 'Lax';
  if (value === SAMESITE_STRICT) return 'Strict';
  return undefined;
}

interface FirefoxCookieRow {
  host: string; name: string; value: string; path: string; expiry: number;
  isSecure: number; isHttpOnly: number; sameSite: number | null; rawSameSite: number | null;
}

// Only the default container. Firefox isolates cookies per container and per
// private window through `originAttributes`; the profile has no equivalent, so
// importing them all would hand a site an arbitrary container's session.
export function listFirefoxSites(db: Database.Database): BrowserImportSite[] {
  return db.prepare("SELECT ltrim(host, '.') AS domain, count(*) AS cookies FROM moz_cookies WHERE originAttributes = '' GROUP BY ltrim(host, '.') ORDER BY domain LIMIT 2000").all() as BrowserImportSite[];
}

export function readFirefoxCookies(db: Database.Database, domains: string[], now: number): CookieDecode[] {
  const schemaVersion = Number(db.pragma('user_version', { simple: true })) || 0;
  const rawSameSite = schemaVersion >= FIREFOX_RAW_SAMESITE_FIRST_SCHEMA && schemaVersion <= FIREFOX_RAW_SAMESITE_LAST_SCHEMA
    ? 'rawSameSite' : 'NULL AS rawSameSite';
  const rows = db.prepare(`SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, ${rawSameSite} FROM moz_cookies WHERE originAttributes = '' AND ltrim(host, '.') IN (${domains.map(() => '?').join(',')}) LIMIT ?`)
    .all(...domains, MAX_COOKIE_ROWS + 1) as FirefoxCookieRow[];
  if (rows.length > MAX_COOKIE_ROWS) throw new RangeError('Too many cookies');
  return rows.map((row) => {
    const sameSite = sameSiteFromColumn(row.sameSite, row.rawSameSite);
    const expires = row.expiry <= 0 ? undefined
      : schemaVersion >= FIREFOX_EXPIRY_MILLISECONDS_SCHEMA ? Math.floor(row.expiry / 1000) : row.expiry;
    return toProfileCookie({
      host: row.host, name: row.name, value: row.value, path: row.path,
      secure: row.isSecure === 1, httpOnly: row.isHttpOnly === 1,
      ...(sameSite ? { sameSite } : {}), ...(expires !== undefined ? { expires } : {}),
    }, now);
  });
}
