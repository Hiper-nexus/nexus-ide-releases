import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listImportProfiles, listImportSites, readBrowserImport } from './browser-import';
import type { ChromiumKeyRequest } from './chromium-keys';
import type { BrowserImportPathContext } from './sources';

// Synthetic fixtures only: every path lives under a temporary fake home, and
// keys are injected. Nothing here reads the operator's browsers or Keychain.
const now = 1_800_000_000;
const SECRET_VALUE = 'synthetic-session-value-7f3a';
const key = pbkdf2Sync('synthetic-keychain-secret', 'saltysalt', 1003, 16, 'sha1');
const roots: string[] = [];
const handles: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeHome(platform: NodeJS.Platform = 'darwin'): BrowserImportPathContext {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-browser-import-home-'));
  roots.push(home);
  return { path, platform, home, localAppData: path.join(home, 'AppData', 'Local'), appData: path.join(home, 'AppData', 'Roaming') };
}
const encryptV10 = (host: string, value: string, cbcKey = key) => {
  const cipher = createCipheriv('aes-128-cbc', cbcKey, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])), cipher.final()]);
};
const encryptV11 = (host: string, value: string) => {
  const cipher = createCipheriv('aes-128-cbc', Buffer.alloc(16, 9), Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v11'), cipher.update(Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])), cipher.final()]);
};

interface ChromeRow { host: string; name: string; value?: string; encrypted?: Buffer }
/** A Chromium user-data dir with `Local State` and one profile's `Network/Cookies`. */
function chromiumProfile(userData: string, rows: ChromeRow[], options: { profile?: string; localState?: object } = {}): string {
  const profile = options.profile ?? 'Default';
  fs.mkdirSync(path.join(userData, profile, 'Network'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'Local State'), JSON.stringify(options.localState ?? { profile: { info_cache: { [profile]: { name: 'Pessoal' } } } }));
  const file = path.join(userData, profile, 'Network', 'Cookies');
  const db = new Database(file);
  db.exec(`CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
      is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT)`);
  const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, '/', ?, 1, 1, 1, '')");
  for (const row of rows) insert.run(row.host, row.name, row.value ?? '', row.encrypted ?? Buffer.alloc(0), (now + 3600 + 11_644_473_600) * 1_000_000);
  db.close();
  return file;
}
const chromeDir = (context: BrowserImportPathContext) => path.join(context.home, 'Library', 'Application Support', 'Google', 'Chrome');
const profileOf = (context: BrowserImportPathContext, browser: string) => {
  const found = listImportProfiles(context).find((profile) => profile.browser === browser);
  if (!found) throw new Error(`no ${browser} profile`);
  return found;
};

describe('browser import', () => {
  it('lists Chrome, Firefox and Safari profiles under the given home only, ignoring unsafe Local State keys', () => {
    const context = fakeHome();
    const chrome = chromeDir(context);
    chromiumProfile(chrome, [{ host: '.example.com', name: 'a', value: 'x' }], {
      localState: { profile: { info_cache: { Default: { name: 'Pessoal\u0007' }, '../escape': { name: 'Escape' }, 'Profile 9': { name: 'Sem banco' } } } },
    });
    const firefox = path.join(context.home, 'Library', 'Application Support', 'Firefox');
    fs.mkdirSync(path.join(firefox, 'Profiles', 'abc.default-release'), { recursive: true });
    fs.writeFileSync(path.join(firefox, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n[Profile1]\nName=Nunca usado\nPath=Profiles/unused\n');
    new Database(path.join(firefox, 'Profiles', 'abc.default-release', 'cookies.sqlite')).close();
    const safari = path.join(context.home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies');
    fs.mkdirSync(safari, { recursive: true });
    fs.writeFileSync(path.join(safari, 'Cookies.binarycookies'), 'cook');
    // An empty fork folder (left by native-messaging installers) is not a browser.
    fs.mkdirSync(path.join(context.home, 'Library', 'Application Support', 'Microsoft Edge'), { recursive: true });

    const profiles = listImportProfiles(context);
    expect(profiles.map(({ browser, name }) => ({ browser, name }))).toEqual([
      { browser: 'Chrome', name: 'Pessoal' },
      { browser: 'Safari', name: 'Safari' },
      { browser: 'Firefox', name: 'default-release' },
    ]);
    expect(profiles.every((profile) => /^[a-f0-9]{24}$/.test(profile.id))).toBe(true);
    expect(listImportProfiles(fakeHome())).toEqual([]);
  });

  it('imports only selected Chrome sites from a live, exclusively locked database and rechecks authority after the Keychain', async () => {
    const context = fakeHome();
    const file = chromiumProfile(chromeDir(context), [
      { host: '.example.com', name: 'login', encrypted: encryptV10('.example.com', SECRET_VALUE) },
      { host: 'other.example', name: 'other', value: 'do-not-import' },
    ]);
    // Chrome keeps its store open in exclusive locking mode while it runs.
    const browser = new Database(file);
    handles.push(browser);
    browser.pragma('locking_mode = EXCLUSIVE');
    browser.pragma('journal_mode = WAL');
    browser.prepare("UPDATE cookies SET name = 'login' WHERE name = 'login'").run();
    const original = fs.readFileSync(file);

    const profile = profileOf(context, 'Chrome');
    expect(listImportSites(profile.id, context)).toEqual([{ domain: 'example.com', cookies: 1 }, { domain: 'other.example', cookies: 1 }]);
    const requests: ChromiumKeyRequest[] = [];
    const resolveKeys = async (request: ChromiumKeyRequest) => { requests.push(request); return { ok: true as const, value: { cbcV10: Buffer.from(key) } }; };
    const imported = await readBrowserImport(profile.id, ['example.com'], () => {}, { context, now, resolveKeys });
    expect(imported.cookies).toEqual([{ domain: '.example.com', name: 'login', value: SECRET_VALUE, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: now + 3600 }]);
    expect(imported.result).toEqual({ importedCookies: 1, importedSites: 1, skipped: { partitioned: 0, encrypted: 0, expired: 0, invalid: 0 } });
    expect(requests).toEqual([{ platform: 'darwin', keychainService: 'Chrome Safe Storage', keychainAccount: 'Chrome', linuxSecretApplication: 'chrome' }]);
    expect(fs.readFileSync(file)).toEqual(original);

    let revoked = false;
    await expect(readBrowserImport(profile.id, ['example.com'], () => { if (revoked) throw new Error('scope changed'); }, {
      context, now, resolveKeys: async () => { revoked = true; return { ok: true, value: { cbcV10: Buffer.from(key) } }; },
    })).rejects.toThrow('scope changed');
  });

  it('never asks for the key when the selected cookies are not encrypted', async () => {
    const context = fakeHome();
    chromiumProfile(chromeDir(context), [{ host: 'plain.example', name: 'p', value: 'plain' }, { host: '.example.com', name: 'e', encrypted: encryptV10('.example.com', 'x') }]);
    const resolveKeys = vi.fn();
    const imported = await readBrowserImport(profileOf(context, 'Chrome').id, ['plain.example'], () => {}, { context, now, resolveKeys });
    expect(imported.cookies.map((cookie) => cookie.value)).toEqual(['plain']);
    expect(resolveKeys).not.toHaveBeenCalled();
  });

  it('turns key failures into readable messages without logging cookie values or keys', async () => {
    const context = fakeHome();
    chromiumProfile(chromeDir(context), [{ host: '.example.com', name: 'login', encrypted: encryptV10('.example.com', SECRET_VALUE) }]);
    const logged = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const id = profileOf(context, 'Chrome').id;
    listImportSites(id, context);
    const denied = readBrowserImport(id, ['example.com'], () => {}, { context, now, resolveKeys: async () => ({ ok: false, reason: 'needsKeychainApproval' }) });
    await expect(denied).rejects.toThrow('O Chaveiro não liberou a chave de cookies do Chrome. Tente novamente e escolha "Permitir" no aviso do macOS.');
    await readBrowserImport(id, ['example.com'], () => {}, { context, now, resolveKeys: async () => ({ ok: true, value: { cbcV10: Buffer.from(key) } }) });
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it('wipes the derived key after decoding', async () => {
    const context = fakeHome();
    chromiumProfile(chromeDir(context), [{ host: '.example.com', name: 'login', encrypted: encryptV10('.example.com', SECRET_VALUE) }]);
    const material = Buffer.from(key);
    await readBrowserImport(profileOf(context, 'Chrome').id, ['example.com'], () => {}, { context, now, resolveKeys: async () => ({ ok: true, value: { cbcV10: material } }) });
    expect(material.equals(Buffer.alloc(16))).toBe(true);
  });

  it('fails a Linux import that needed the missing keyring key, but keeps a partial one', async () => {
    const context = fakeHome('linux');
    const userData = path.join(context.home, '.config', 'google-chrome');
    chromiumProfile(userData, [{ host: '.v11.example', name: 'v11', encrypted: encryptV11('.v11.example', 'needs keyring') }]);
    const peanuts = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
    const keys = async () => ({ ok: true as const, value: { cbcV10: Buffer.from(peanuts), cbcV11Error: 'keychainUnavailable' as const } });
    const id = profileOf(context, 'Chrome').id;
    await expect(readBrowserImport(id, ['v11.example'], () => {}, { context, now, resolveKeys: keys }))
      .rejects.toThrow(/chaveiro do sistema \(Secret Service\)/);
    const db = new Database(path.join(userData, 'Default', 'Network', 'Cookies'));
    db.prepare("INSERT INTO cookies VALUES ('.v10.example', 'v10', '', ?, '/', 0, 1, 1, 1, '')").run(encryptV10('.v10.example', 'fallback', peanuts));
    db.close();
    const partial = await readBrowserImport(id, ['v10.example', 'v11.example'], () => {}, { context, now, resolveKeys: keys });
    expect(partial.cookies.map((cookie) => cookie.value)).toEqual(['fallback']);
    expect(partial.result.skipped.encrypted).toBe(1);
  });

  it('explains Windows App-Bound Encryption instead of failing silently', () => {
    const context = fakeHome('win32');
    const userData = path.join(context.localAppData!, 'Google', 'Chrome', 'User Data');
    chromiumProfile(userData, [{ host: '.example.com', name: 'a', encrypted: Buffer.from('v20app-bound') }], {
      localState: { profile: { info_cache: { Default: { name: 'Pessoal' } } }, os_crypt: { encrypted_key: Buffer.from('DPAPIx').toString('base64'), app_bound_encrypted_key: 'present' } },
    });
    expect(() => listImportSites(profileOf(context, 'Chrome').id, context)).toThrow(/App-Bound/);
  });

  it('keeps other browsers listed when the OS refuses one, and names the grant when it is chosen', () => {
    const context = fakeHome();
    chromiumProfile(chromeDir(context), [{ host: 'a.example', name: 'a', value: 'x' }]);
    const firefox = path.join(context.home, 'Library', 'Application Support', 'Firefox', 'Profiles', 'p.default');
    fs.mkdirSync(firefox, { recursive: true });
    new Database(path.join(firefox, 'cookies.sqlite')).close();
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).endsWith('Local State')) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return (read as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    const profiles = listImportProfiles(context);
    expect(profiles.map(({ browser, name }) => ({ browser, name }))).toEqual([{ browser: 'Chrome', name: 'Sem acesso' }, { browser: 'Firefox', name: 'p.default' }]);
    expect(() => listImportSites(profiles[0]!.id, context)).toThrow(/O macOS bloqueou o acesso aos perfis do Chrome\. Autorize o NexusIDE/);
  });

  it('asks for Full Disk Access when TCC refuses the Safari jar', () => {
    const context = fakeHome();
    const safari = path.join(context.home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies');
    fs.mkdirSync(safari, { recursive: true });
    fs.writeFileSync(path.join(safari, 'Cookies.binarycookies'), 'cook');
    const id = profileOf(context, 'Safari').id;
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    expect(() => listImportSites(id, context)).toThrow(/Safari para apps com Acesso Total ao Disco/);
  });

  it('refuses unknown ids, invalid selections and databases that resolve outside their profile', async () => {
    const context = fakeHome();
    const outside = chromiumProfile(path.join(context.home, 'elsewhere'), [{ host: 'a.example', name: 'a', value: 'x' }]);
    const chrome = chromeDir(context);
    chromiumProfile(chrome, []);
    fs.rmSync(path.join(chrome, 'Default', 'Network', 'Cookies'));
    fs.symlinkSync(outside, path.join(chrome, 'Default', 'Network', 'Cookies'));
    const id = profileOf(context, 'Chrome').id;
    expect(() => listImportSites(id, context)).toThrow('O arquivo de sessões desse perfil não pode ser importado.');
    expect(() => listImportSites('0'.repeat(24), context)).toThrow('O perfil do navegador não está mais disponível.');
    await expect(readBrowserImport(id, ['bad domain'], () => {}, { context })).rejects.toThrow('Selecione entre 1 e 200 sites.');
  });
});
