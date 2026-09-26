import { createCipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeChromeCookie, listChromeProfiles, listChromeSites, readChromeImport, type ChromeCookieRow } from './chrome-cookie-import';

const key = Buffer.alloc(16, 7);
const now = 1_800_000_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const row = (overrides: Partial<ChromeCookieRow> = {}): ChromeCookieRow => ({
  host_key: '.example.com', name: 'login', value: '', encrypted_value: Buffer.alloc(0),
  path: '/', expires_utc: (now + 3600 + 11644473600) * 1e6,
  is_secure: 1, is_httponly: 1, samesite: 1, top_frame_site_key: '', ...overrides,
});
function encrypted(domain: string, value: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.concat([createHash('sha256').update(domain).digest(), Buffer.from(value)])), cipher.final()]);
}

describe('compatible Chrome cookie import', () => {
  it('verifies the schema-24 domain digest before importing an encrypted cookie', () => {
    const valid = row({ encrypted_value: encrypted('.example.com', 'synthetic-login') });
    expect(decodeChromeCookie(valid, 24, key, now)).toEqual({
      ok: true,
      cookie: { domain: '.example.com', name: 'login', value: 'synthetic-login', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: now + 3600 },
    });
    expect(decodeChromeCookie({ ...valid, host_key: '.other.example' }, 24, key, now)).toMatchObject({ ok: false });
  });
  it('reports partitioned and unsupported encryption without widening cookie scope', () => {
    expect(decodeChromeCookie(row({ value: 'x', top_frame_site_key: 'https://top.example' }), 24, key, now))
      .toEqual({ ok: false, reason: 'partitioned' });
    expect(decodeChromeCookie(row({ encrypted_value: Buffer.from('v20-encrypted') }), 24, key, now))
      .toEqual({ ok: false, reason: 'encrypted' });
  });
  it('keeps session cookies without inventing an expiry, and drops expired rows', () => {
    expect(decodeChromeCookie(row({ value: 'session-value', expires_utc: 0 }), 24, undefined, now))
      .toMatchObject({ ok: true, cookie: { value: 'session-value' } });
    const session = decodeChromeCookie(row({ value: 'session-value', expires_utc: 0 }), 24, undefined, now);
    if (session.ok) expect(session.cookie).not.toHaveProperty('expires');
    expect(decodeChromeCookie(row({ value: 'expired', expires_utc: (now - 1 + 11644473600) * 1e6 }), 24, undefined, now))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('reads only selected sites from a real readonly database and rechecks authority after Keychain', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-chrome-fixture-')); roots.push(root);
    fs.mkdirSync(path.join(root, 'Default'));
    const file = path.join(root, 'Default', 'Cookies');
    const db = new Database(file);
    db.exec("CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc REAL, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT)");
    const selectedRow = row({ encrypted_value: encrypted('.example.com', 'selected-login') });
    const otherRow = row({ host_key: 'other.example', value: 'do-not-import' });
    const insert = db.prepare('INSERT INTO cookies VALUES (@host_key,@name,@value,@encrypted_value,@path,@expires_utc,@is_secure,@is_httponly,@samesite,@top_frame_site_key)');
    insert.run(selectedRow); insert.run(otherRow); db.close();
    const original = fs.readFileSync(file);
    const [profile] = listChromeProfiles(root);
    expect(listChromeSites(profile.id, root)).toEqual([{ domain: 'example.com', cookies: 1 }, { domain: 'other.example', cookies: 1 }]);
    const imported = await readChromeImport(profile.id, ['example.com'], () => {}, { root, readKey: async () => Buffer.from(key), now });
    expect(imported.cookies.map((cookie) => cookie.value)).toEqual(['selected-login']);
    expect(imported.result.importedSites).toBe(1);
    expect(fs.readFileSync(file)).toEqual(original);
    let revoked = false;
    await expect(readChromeImport(profile.id, ['example.com'], () => { if (revoked) throw new Error('scope changed'); }, {
      root, now, readKey: async () => { revoked = true; return Buffer.from(key); },
    })).rejects.toThrow('scope changed');
  });
});
