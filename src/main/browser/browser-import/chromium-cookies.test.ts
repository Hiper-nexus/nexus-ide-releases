// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: ChromiumCookies.test.ts sem Effect — bancos sintéticos com better-sqlite3 lidos pelo snapshot; asserts no ProfileCookie e nos motivos de descarte; inclui os casos do antigo chrome-cookie-import.test.ts (digest de domínio, particionado, sessão sem validade, expirado).
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeChromiumCookie, decryptChromiumValue, readChromiumRows, type ChromiumCookieRow } from './chromium-cookies';
import type { ChromiumKeyMaterial } from './chromium-keys';
import { withCookieSnapshot } from './cookie-snapshot';

const now = 1_800_000_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const encryptChromium = (prefix: 'v10' | 'v11', value: string | Buffer, key: Buffer): Buffer => {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix), cipher.update(value), cipher.final()]);
};
const encryptWindowsV10 = (value: string | Buffer, key: Buffer): Buffer => {
  const nonce = Buffer.from('0123456789ab');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, encrypted, cipher.getAuthTag()]);
};
const boundValue = (host: string, value: string) => Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)]);

interface FixtureRow { host: string; name: string; value?: string; encrypted?: Buffer; secure?: number; samesite?: number; partition?: string; expiresUtc?: number }
/** A Chromium-shaped `Cookies` database; `partitionColumn: false` is a pre-CHIPS schema. */
function cookieDatabase(version: number | string, rows: FixtureRow[], partitionColumn = true): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-chromium-test-')); roots.push(directory);
  const file = path.join(directory, 'Cookies');
  const db = new Database(file);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL,
      path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
      samesite INTEGER NOT NULL${partitionColumn ? ", top_frame_site_key TEXT NOT NULL DEFAULT ''" : ''})`);
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  const insert = db.prepare(`INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite${partitionColumn ? ', top_frame_site_key' : ''})
    VALUES (?, ?, ?, ?, '/', ?, ?, 0, ?${partitionColumn ? ', ?' : ''})`);
  for (const row of rows) {
    insert.run(row.host, row.name, row.value ?? '', row.encrypted ?? Buffer.alloc(0), row.expiresUtc ?? 0, row.secure ?? 1, row.samesite ?? 0,
      ...(partitionColumn ? [row.partition ?? ''] : []));
  }
  db.close();
  return file;
}

function read(file: string, keys: ChromiumKeyMaterial, platform: NodeJS.Platform, domains?: string[]) {
  const snapshot = withCookieSnapshot(file, (db) => {
    const selected = domains ?? (db.prepare("SELECT DISTINCT ltrim(host_key, '.') AS d FROM cookies").all() as Array<{ d: string }>).map((row) => row.d);
    return readChromiumRows(db, selected);
  });
  if (!snapshot.ok) throw new Error(snapshot.reason);
  const decoded = snapshot.value.rows.map((row) => ({ host: row.host_key, decoded: decodeChromiumCookie(row, snapshot.value.schemaVersion, keys, platform, now) }));
  return {
    values: decoded.flatMap(({ decoded: entry }) => (entry.ok ? [{ name: entry.cookie.name, value: entry.cookie.value }] : [])),
    skippedHosts: decoded.filter(({ decoded: entry }) => !entry.ok).map(({ host }) => host),
  };
}

describe('decryptChromiumValue', () => {
  it('decrypts Windows v10 AES-GCM records and rejects App-Bound v20 records', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef');
    const host = '.example.test';
    expect(decryptChromiumValue(encryptWindowsV10(boundValue(host, 'windows value'), key), { gcmV10: key }, host, 24, 'win32')).toBe('windows value');
    expect(decryptChromiumValue(Buffer.from('v20app-bound'), { gcmV10: key }, host, 24, 'win32')).toBeNull();
    expect(decryptChromiumValue(encryptWindowsV10(boundValue(host, 'windows value'), Buffer.alloc(32, 1)), { gcmV10: key }, host, 24, 'win32')).toBeNull();
  });
});

describe('Chromium cookie database', () => {
  const key = Buffer.from('0123456789abcdef');

  it('reads plaintext, encrypted, and genuinely empty cookie values', () => {
    const file = cookieDatabase(23, [
      { host: 'plain.example', name: 'plain', value: 'stored plaintext', secure: 0 },
      { host: 'secure.example', name: 'encrypted', encrypted: encryptChromium('v10', 'stored encrypted', key) },
      { host: 'empty.example', name: 'empty', secure: 0 },
    ]);
    expect(read(file, { cbcV10: key }, 'darwin')).toEqual({
      values: [{ name: 'plain', value: 'stored plaintext' }, { name: 'encrypted', value: 'stored encrypted' }, { name: 'empty', value: '' }],
      skippedHosts: [],
    });
  });

  it('enforces the domain binding only for schema 24 and newer', () => {
    const records = [
      { host: 'bound.example', name: 'valid', encrypted: encryptChromium('v10', boundValue('bound.example', 'kept'), key) },
      // Moved between hosts: the digest no longer matches its own host_key.
      { host: 'wrong.example', name: 'mismatch', encrypted: encryptChromium('v10', boundValue('another.example', 'drop'), key) },
      { host: 'short.example', name: 'short', encrypted: encryptChromium('v10', 'short value', key) },
    ];
    expect(read(cookieDatabase(24, records), { cbcV10: key }, 'darwin')).toEqual({
      values: [{ name: 'valid', value: 'kept' }], skippedHosts: ['wrong.example', 'short.example'],
    });
    // Pre-24 values are arbitrary bytes, including 32+ byte ones.
    const legacy = 'x'.repeat(32) + ' legacy value';
    expect(read(cookieDatabase(23, [{ host: 'legacy.example', name: 'legacy', encrypted: encryptChromium('v10', legacy, key) }]), { cbcV10: key }, 'darwin').values)
      .toEqual([{ name: 'legacy', value: legacy }]);
  });

  it('decrypts mixed v10 and v11 cookies with their respective keys', () => {
    const cbcV11 = Buffer.from('fedcba9876543210');
    const file = cookieDatabase('24', [
      { host: 'v10.example', name: 'v10-cookie', encrypted: encryptChromium('v10', boundValue('v10.example', 'v10 value'), key) },
      { host: 'v11.example', name: 'v11-cookie', encrypted: encryptChromium('v11', boundValue('v11.example', 'v11 value'), cbcV11) },
    ]);
    expect(read(file, { cbcV10: key, cbcV11 }, 'linux')).toEqual({
      values: [{ name: 'v10-cookie', value: 'v10 value' }, { name: 'v11-cookie', value: 'v11 value' }], skippedHosts: [],
    });
    expect(read(file, { cbcV10: key }, 'linux')).toEqual({ values: [{ name: 'v10-cookie', value: 'v10 value' }], skippedHosts: ['v11.example'] });
  });

  it('recovers records written with the empty-passphrase key, but not records with no key at all', () => {
    const cbcV11 = Buffer.from('fedcba9876543210');
    const cbcEmpty = pbkdf2Sync('', 'saltysalt', 1, 16, 'sha1');
    const file = cookieDatabase('23', [
      { host: 'ev10.example', name: 'empty-v10', encrypted: encryptChromium('v10', 'empty v10 value', cbcEmpty) },
      { host: 'ev11.example', name: 'empty-v11', encrypted: encryptChromium('v11', 'empty v11 value', cbcEmpty) },
    ]);
    expect(read(file, { cbcV10: key, cbcV11, cbcEmpty }, 'linux').values)
      .toEqual([{ name: 'empty-v10', value: 'empty v10 value' }, { name: 'empty-v11', value: 'empty v11 value' }]);
    expect(read(file, { cbcV10: key, cbcEmpty }, 'linux')).toEqual({ values: [{ name: 'empty-v10', value: 'empty v10 value' }], skippedHosts: ['ev11.example'] });
  });

  it("decrypts Linux v10 records with Chromium's keyring-free 'peanuts' key", () => {
    const peanuts = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
    const file = cookieDatabase(24, [{ host: 'linux.example', name: 'peanuts', encrypted: encryptChromium('v10', boundValue('linux.example', 'fallback value'), peanuts) }]);
    expect(read(file, { cbcV10: peanuts }, 'linux').values).toEqual([{ name: 'peanuts', value: 'fallback value' }]);
  });

  it('treats unversioned values as legacy clear text on macOS and Linux', () => {
    const file = cookieDatabase(23, [{ host: 'legacy.example', name: 'legacy', encrypted: Buffer.from('legacy cleartext') }]);
    expect(read(file, { cbcV10: key }, 'darwin').values).toEqual([{ name: 'legacy', value: 'legacy cleartext' }]);
    expect(read(file, { cbcV10: key }, 'linux').values).toEqual([{ name: 'legacy', value: 'legacy cleartext' }]);
  });

  it('skips partitioned cookies without breaking pre-CHIPS schemas', () => {
    expect(read(cookieDatabase(14, [{ host: 'legacy.example', name: 'legacy', value: 'kept', secure: 0 }], false), {}, 'darwin').values)
      .toEqual([{ name: 'legacy', value: 'kept' }]);
    const chips = cookieDatabase(23, [
      { host: 'plain.example', name: 'plain', value: 'kept', secure: 0 },
      { host: 'partitioned.example', name: 'partitioned', value: 'must skip', partition: 'https://top.example' },
    ]);
    expect(read(chips, {}, 'darwin')).toEqual({ values: [{ name: 'plain', value: 'kept' }], skippedHosts: ['partitioned.example'] });
  });

  it('rejects a malformed schema version', () => {
    const file = cookieDatabase('not-a-version', []);
    expect(() => withCookieSnapshot(file, (db) => readChromiumRows(db, ['example.com']))).toThrow('Unknown cookie schema');
  });

  it('reads only the selected sites', () => {
    const file = cookieDatabase(23, [
      { host: '.selected.example', name: 'a', value: 'kept', secure: 0 },
      { host: 'other.example', name: 'b', value: 'do-not-import', secure: 0 },
    ]);
    expect(read(file, {}, 'darwin', ['selected.example']).values).toEqual([{ name: 'a', value: 'kept' }]);
  });
});

describe('decodeChromiumCookie', () => {
  const key = Buffer.alloc(16, 7);
  const row = (overrides: Partial<ChromiumCookieRow> = {}): ChromiumCookieRow => ({
    host_key: '.example.com', name: 'login', value: '', encrypted_value: Buffer.alloc(0), path: '/',
    expires_seconds: now + 3600 + 11_644_473_600, is_secure: 1, is_httponly: 1, samesite: 1, top_frame_site_key: '', ...overrides,
  });

  it('maps a decrypted row onto the profile cookie, keeping a host-only or domain scope as stored', () => {
    expect(decodeChromiumCookie(row({ encrypted_value: encryptChromium('v10', boundValue('.example.com', 'synthetic-login'), key) }), 24, { cbcV10: key }, 'darwin', now)).toEqual({
      ok: true,
      cookie: { domain: '.example.com', name: 'login', value: 'synthetic-login', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: now + 3600 },
    });
  });

  it('keeps session cookies without inventing an expiry, and drops expired rows', () => {
    const session = decodeChromiumCookie(row({ value: 'session-value', expires_seconds: 0 }), 24, {}, 'darwin', now);
    expect(session).toMatchObject({ ok: true, cookie: { value: 'session-value' } });
    if (session.ok) expect(session.cookie).not.toHaveProperty('expires');
    expect(decodeChromiumCookie(row({ value: 'expired', expires_seconds: now - 1 + 11_644_473_600 }), 24, {}, 'darwin', now)).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports partitioned and undecryptable rows, and never widens SameSite', () => {
    expect(decodeChromiumCookie(row({ value: 'x', top_frame_site_key: 'https://top.example' }), 24, { cbcV10: key }, 'darwin', now)).toEqual({ ok: false, reason: 'partitioned' });
    expect(decodeChromiumCookie(row({ encrypted_value: Buffer.from('v20-encrypted') }), 24, { cbcV10: key }, 'darwin', now)).toEqual({ ok: false, reason: 'encrypted' });
    expect(decodeChromiumCookie(row({ encrypted_value: encryptChromium('v10', 'x', key) }), 24, {}, 'darwin', now)).toEqual({ ok: false, reason: 'encrypted' });
    const unspecified = decodeChromiumCookie(row({ value: 'v', samesite: -1 }), 24, {}, 'darwin', now);
    if (unspecified.ok) expect(unspecified.cookie).not.toHaveProperty('sameSite');
    // SameSite=None without Secure is refused by Chromium; it is narrowed, not widened.
    const insecureNone = decodeChromiumCookie(row({ value: 'v', samesite: 0, is_secure: 0 }), 24, {}, 'darwin', now);
    expect(insecureNone.ok && insecureNone.cookie.sameSite).toBeFalsy();
  });
});
