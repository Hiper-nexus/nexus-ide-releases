// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: SafariCookies.test.ts sem Effect — mesmas fixtures binárias montadas byte a byte; asserts sobre {ok, reason} e StoredCookie; EPERM do TCC simulado por spy de fs (nunca o jar real do Safari).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBinaryCookies, readSafariJar } from './safari-cookies';

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-safari-test-')); roots.push(dir); return dir; };

interface FixtureCookie { domain: string; name: string; path: string; value: string; flags: number; expiry: number }

/** Encodes one cookie exactly as Safari lays it out. */
function encodeCookie(cookie: FixtureCookie): Buffer {
  const strings = [cookie.domain, cookie.name, cookie.path, cookie.value];
  const offsets: number[] = [];
  let cursor = 56;
  for (const value of strings) { offsets.push(cursor); cursor += Buffer.byteLength(value) + 1; }
  const buffer = Buffer.alloc(cursor);
  buffer.writeUInt32LE(cursor, 0);
  buffer.writeUInt32LE(cookie.flags, 8);
  offsets.forEach((offset, index) => buffer.writeUInt32LE(offset, 16 + index * 4));
  buffer.writeDoubleLE(cookie.expiry, 40);
  strings.forEach((value, index) => buffer.write(value, offsets[index]!, 'utf8'));
  return buffer;
}

/** Builds a single-page `Cookies.binarycookies` file. */
function encodeBinaryCookies(cookies: FixtureCookie[]): Buffer {
  const encoded = cookies.map(encodeCookie);
  const offsets: number[] = [];
  let cursor = 12 + encoded.length * 4;
  for (const cookie of encoded) { offsets.push(cursor); cursor += cookie.length; }
  const page = Buffer.alloc(cursor);
  page.writeUInt32BE(0x0000_0100, 0);
  page.writeUInt32LE(encoded.length, 4);
  offsets.forEach((offset, index) => page.writeUInt32LE(offset, 8 + index * 4));
  encoded.forEach((cookie, index) => cookie.copy(page, offsets[index]!));
  const header = Buffer.alloc(12);
  header.write('cook', 0, 'latin1');
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(page.length, 8);
  return Buffer.concat([header, page]);
}

const cookiesOf = (file: Buffer) => {
  const parsed = parseBinaryCookies(file);
  if (!parsed.ok) throw new Error(`expected a parsed jar, got ${parsed.reason}`);
  return parsed.cookies;
};
const refused = (file: Buffer) => expect(parseBinaryCookies(file)).toEqual({ ok: false, reason: 'readFailed' });

describe('parseBinaryCookies', () => {
  it("reads Safari's format and rebases its 2001 epoch", () => {
    const file = encodeBinaryCookies([
      { domain: '.apple.com', name: 'session', path: '/', value: 'abc', flags: 0x1 | 0x4, expiry: 800_000_000 },
      { domain: 'example.test', name: 'plain', path: '/app', value: 'v', flags: 0, expiry: 0 },
    ]);
    expect(cookiesOf(file)).toEqual([
      // Safari counts from 2001-01-01; the profile from 1970. The format
      // predates SameSite, and Lax is the safe modern default.
      { host: '.apple.com', name: 'session', value: 'abc', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 800_000_000 + APPLE_EPOCH_OFFSET_SECONDS },
      // Host-only stays without the leading dot, so it is never widened to subdomains.
      { host: 'example.test', name: 'plain', value: 'v', path: '/app', secure: false, httpOnly: false, sameSite: 'Lax' },
    ]);
  });

  it('reads cookies spread across multiple pages', () => {
    const firstPage = encodeBinaryCookies([{ domain: 'a.test', name: 'one', path: '/', value: '1', flags: 0, expiry: 1 }]).subarray(12);
    const secondPage = encodeBinaryCookies([{ domain: 'b.test', name: 'two', path: '/', value: '2', flags: 0, expiry: 1 }]).subarray(12);
    const header = Buffer.alloc(16);
    header.write('cook', 0, 'latin1');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(firstPage.length, 8);
    header.writeUInt32BE(secondPage.length, 12);
    expect(cookiesOf(Buffer.concat([header, firstPage, secondPage])).map((cookie) => cookie.name)).toEqual(['one', 'two']);
  });

  it('rejects a page that runs past the end of the file', () => {
    const firstPage = encodeBinaryCookies([{ domain: 'a.test', name: 'one', path: '/', value: '1', flags: 0, expiry: 1 }]).subarray(12);
    const secondPage = encodeBinaryCookies([{ domain: 'b.test', name: 'two', path: '/', value: '2', flags: 0, expiry: 1 }]).subarray(12);
    const header = Buffer.alloc(16);
    header.write('cook', 0, 'latin1');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(firstPage.length + secondPage.length + 32, 8);
    header.writeUInt32BE(secondPage.length, 12);
    refused(Buffer.concat([header, firstPage, secondPage]));
  });

  it("rejects a record whose declared size runs past its page", () => {
    const valid = encodeBinaryCookies([{ domain: 'a.test', name: 'n', path: '/', value: 'v', expiry: 1_000, flags: 0 }]);
    const recordStart = 12 + valid.readUInt32LE(12 + 8);
    const corrupt = Buffer.from(valid);
    corrupt.writeUInt32LE(0xffff, recordStart);
    refused(corrupt);
  });

  it('rejects records truncated inside the 56-byte header', () => {
    const valid = encodeBinaryCookies([{ domain: 'a.test', name: 'n', path: '/', value: 'v', expiry: 1_000, flags: 0 }]);
    const recordStart = 12 + valid.readUInt32LE(12 + 8);
    for (let size = 48; size < 56; size += 1) {
      const corrupt = Buffer.from(valid);
      corrupt.writeUInt32LE(size, recordStart);
      refused(corrupt);
    }
  });

  it('rejects record offsets that point into the page header or an earlier record', () => {
    const valid = encodeBinaryCookies([
      { domain: 'a.test', name: 'n', path: '/', value: 'v', expiry: 1_000, flags: 0 },
      { domain: 'b.test', name: 'm', path: '/', value: 'w', expiry: 1_000, flags: 0 },
    ]);
    const intoTable = Buffer.from(valid);
    intoTable.writeUInt32LE(4, 12 + 12);
    refused(intoTable);
    const overlapping = Buffer.from(valid);
    overlapping.writeUInt32LE(valid.readUInt32LE(12 + 8), 12 + 12);
    refused(overlapping);
    expect(cookiesOf(valid)).toHaveLength(2);
  });

  it('rejects string offsets that point into the record header', () => {
    const valid = encodeBinaryCookies([{ domain: 'a.test', name: 'n', path: '/', value: 'v', expiry: 1_000, flags: 0 }]);
    const recordStart = 12 + valid.readUInt32LE(12 + 8);
    for (const offsetField of [16, 20, 24, 28]) {
      const corrupt = Buffer.from(valid);
      corrupt.writeUInt32LE(55, recordStart + offsetField);
      refused(corrupt);
    }
  });

  it('accepts the checksum and property-list trailer Safari writes', () => {
    const file = encodeBinaryCookies([{ domain: 'a.test', name: 'c', path: '/', value: 'v', flags: 0, expiry: 0 }]);
    const plist = Buffer.from('bplist00 stub');
    const plistLength = Buffer.alloc(4);
    plistLength.writeUInt32BE(plist.length, 0);
    expect(cookiesOf(Buffer.concat([file, Buffer.alloc(8)]))).toHaveLength(1);
    expect(cookiesOf(Buffer.concat([file, Buffer.alloc(8), plistLength, plist]))).toHaveLength(1);
  });

  it('rejects a jar whose page table stops short of its contents', () => {
    const first = encodeBinaryCookies([{ domain: 'a.test', name: 'c', path: '/', value: 'v', flags: 0, expiry: 0 }]);
    const extraPage = encodeBinaryCookies([{ domain: 'b.test', name: 'd', path: '/', value: 'w', flags: 0, expiry: 0 }]).subarray(12);
    refused(Buffer.concat([first, extraPage]));
    const badLength = Buffer.alloc(4);
    badLength.writeUInt32BE(99, 0);
    refused(Buffer.concat([first, Buffer.alloc(8), badLength, Buffer.from('x')]));
  });

  it('rejects a file that is not binarycookies, and a header that ends mid-table', () => {
    refused(Buffer.from('not a cookie jar'));
    const truncated = Buffer.alloc(10);
    truncated.write('cook', 0, 'latin1');
    truncated.writeUInt32BE(1, 4);
    refused(truncated);
  });
});

describe('readSafariJar', () => {
  it('reports a malformed jar as a read failure', () => {
    const jar = path.join(tempDir(), 'Cookies.binarycookies');
    fs.writeFileSync(jar, 'not a cookie jar');
    expect(readSafariJar(jar)).toEqual({ ok: false, reason: 'readFailed' });
  });

  it('reports the TCC denial (EPERM) as the Full Disk Access grant', () => {
    const jar = path.join(tempDir(), 'Cookies.binarycookies');
    fs.writeFileSync(jar, encodeBinaryCookies([]));
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    expect(readSafariJar(jar)).toEqual({ ok: false, reason: 'needsFullDiskAccess' });
  });

  it('keeps an ordinary EACCES and a missing jar as plain read failures', () => {
    const directory = tempDir();
    const jar = path.join(directory, 'Cookies.binarycookies');
    fs.writeFileSync(jar, encodeBinaryCookies([]));
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
    expect(readSafariJar(jar)).toEqual({ ok: false, reason: 'readFailed' });
    vi.restoreAllMocks();
    expect(readSafariJar(path.join(directory, 'absent.binarycookies'))).toEqual({ ok: false, reason: 'readFailed' });
  });
});
