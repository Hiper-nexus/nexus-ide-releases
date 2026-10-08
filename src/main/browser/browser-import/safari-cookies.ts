// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: SafariCookies.ts sem Effect — parseBinaryCookies com os mesmos limites, devolvendo {ok:false, reason} (inclusive RangeError de leitura fora do buffer); leitura do jar com teto de tamanho; EPERM do TCC vira `needsFullDiskAccess`; saída como StoredCookie do Perfil Nexus.
import fs from 'node:fs';
import type { StoredCookie } from './cookie-snapshot';

/*
 * Safari stores cookies unencrypted in `Cookies.binarycookies`; the protection
 * is TCC (Full Disk Access), not cryptography. Big-endian header, then pages:
 *   magic "cook", u32 pageCount, u32 pageSize[pageCount], then each page:
 *     u32 0x00000100, u32le cookieCount, u32le cookieOffset[cookieCount],
 *     then each cookie: u32le size, u32le unknown, u32le flags, u32le unknown,
 *       u32le urlOffset, nameOffset, pathOffset, valueOffset, u64 end-of-header,
 *       f64 expiry, f64 creation, then NUL-terminated strings at the offsets.
 */

/** Safari's timestamps count seconds from 2001-01-01, not the UNIX epoch. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;
const COOKIE_PAGE_HEADER_SIZE = 12;
/** Through the `f64 creation` field; string bytes follow. */
const COOKIE_RECORD_HEADER_SIZE = 56;
const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;
const MAX_JAR_BYTES = 64 * 1024 * 1024;

export type SafariCookieReadFailure = 'needsFullDiskAccess' | 'readFailed';
export type SafariCookieRead = { ok: true; cookies: StoredCookie[] } | { ok: false; reason: SafariCookieReadFailure };

class MalformedJar extends Error {}

function readCString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString('utf8', start, end === -1 ? buffer.length : end);
}

function parseOrThrow(buffer: Buffer): StoredCookie[] {
  if (buffer.length < 8 || buffer.toString('latin1', 0, 4) !== 'cook') throw new MalformedJar();
  const pageCount = buffer.readUInt32BE(4);
  // Every declared structure is bounds-checked against the file: Buffer.subarray
  // clamps silently, so a short page or an overlong record would otherwise
  // yield a cookie set quietly missing entries or reading the next record.
  if (8 + pageCount * 4 > buffer.length) throw new MalformedJar();
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) pageSizes.push(buffer.readUInt32BE(8 + index * 4));

  const cookies: StoredCookie[] = [];
  let pageStart = 8 + pageCount * 4;
  for (const pageSize of pageSizes) {
    if (pageSize < COOKIE_PAGE_HEADER_SIZE || pageStart + pageSize > buffer.length) throw new MalformedJar();
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;
    // Page bodies switch to little-endian after the big-endian header.
    const cookieCount = page.readUInt32LE(4);
    const offsetTableEnd = COOKIE_PAGE_HEADER_SIZE + cookieCount * 4;
    if (offsetTableEnd > page.length) throw new MalformedJar();
    // Records accepted so far: a later offset may not point back into them,
    // into the page header or into the offset table.
    const accepted: Array<readonly [start: number, end: number]> = [];
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = page.readUInt32LE(8 + index * 4);
      if (cookieStart < offsetTableEnd || cookieStart + COOKIE_RECORD_HEADER_SIZE > page.length) throw new MalformedJar();
      // Bounded by the record's own length so a string cannot run into the next record.
      const recordSize = page.readUInt32LE(cookieStart);
      const cookieEnd = cookieStart + recordSize;
      if (recordSize < COOKIE_RECORD_HEADER_SIZE || cookieEnd > page.length
        || accepted.some(([start, end]) => cookieStart < end && cookieEnd > start)) throw new MalformedJar();
      accepted.push([cookieStart, cookieEnd]);
      const cookie = page.subarray(cookieStart, cookieEnd);
      const flags = cookie.readUInt32LE(8);
      const offsets = [16, 20, 24, 28].map((field) => cookie.readUInt32LE(field));
      if (offsets.some((offset) => offset < COOKIE_RECORD_HEADER_SIZE || offset >= cookie.length)) throw new MalformedJar();
      const [host, name, path, value] = offsets.map((offset) => readCString(cookie, offset));
      const expiry = cookie.readDoubleLE(40);
      if (host === '' || name === '') continue;
      cookies.push({
        host, name, value, path: path || '/',
        secure: (flags & FLAG_SECURE) !== 0, httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        // The flags' SameSite-shaped bits match no public description; Lax is
        // the modern default, and claiming None would widen every cookie.
        sameSite: 'Lax',
        ...(expiry > 0 ? { expires: Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS } : {}),
      });
    }
  }
  // Legal trailers: nothing, the 8-byte checksum, or checksum + u32 length +
  // exactly that many property-list bytes. Anything else means the page table
  // does not describe the file, and the jar is refused rather than half-read.
  const trailer = buffer.length - pageStart;
  if (!(trailer === 0 || trailer === 8 || (trailer >= 12 && trailer === 12 + buffer.readUInt32BE(pageStart + 8)))) throw new MalformedJar();
  return cookies;
}

export function parseBinaryCookies(buffer: Buffer): SafariCookieRead {
  // RangeError from an out-of-bounds read is a malformed jar too.
  try { return { ok: true, cookies: parseOrThrow(buffer) }; } catch { return { ok: false, reason: 'readFailed' }; }
}

/**
 * TCC permits `stat` on the jar inside Safari's container but refuses the
 * read with EPERM until the app has Full Disk Access; macOS never prompts for
 * it. EACCES is an ordinary permission failure the grant cannot fix.
 */
export function readSafariJar(file: string): SafariCookieRead {
  let buffer: Buffer;
  try {
    if (fs.statSync(file).size > MAX_JAR_BYTES) return { ok: false, reason: 'readFailed' };
    buffer = fs.readFileSync(file);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'EPERM' ? 'needsFullDiskAccess' : 'readFailed' };
  }
  return parseBinaryCookies(buffer);
}
