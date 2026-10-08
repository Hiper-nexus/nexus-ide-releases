// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: FirefoxCookies.test.ts sem Effect — `cookies.sqlite` sintético por better-sqlite3 lido pelo snapshot; asserts no ProfileCookie (SameSite ausente = unspecified). Os casos de parseFirefoxProfiles foram para sources.test.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { withCookieSnapshot } from './cookie-snapshot';
import { readFirefoxCookies } from './firefox-cookies';

const now = 1_700_000_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

interface Row { host?: string; name: string; value?: string; path?: string; expiry?: number; isSecure?: number; isHttpOnly?: number; sameSite: number | null; rawSameSite?: number; originAttributes?: string }
/** A `cookies.sqlite` with Firefox's real `moz_cookies` shape; schema 16+ stores `expiry` in ms. */
function firefoxDatabase(rows: Row[], schemaVersion = 15): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-firefox-test-')); roots.push(directory);
  const file = path.join(directory, 'cookies.sqlite');
  const db = new Database(file);
  db.pragma(`user_version = ${schemaVersion}`);
  const hasRaw = schemaVersion >= 10 && schemaVersion <= 14;
  db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER,
    isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, ${hasRaw ? 'rawSameSite INTEGER,' : ''} originAttributes TEXT NOT NULL DEFAULT '')`);
  const insert = db.prepare(`INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, ${hasRaw ? 'rawSameSite, ' : ''}originAttributes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${hasRaw ? '?, ' : ''}?)`);
  for (const row of rows) {
    insert.run(row.host ?? 'example.test', row.name, row.value ?? 'v', row.path ?? '/', row.expiry ?? 0, row.isSecure ?? 0, row.isHttpOnly ?? 0,
      row.sameSite, ...(hasRaw ? [row.rawSameSite ?? row.sameSite] : []), row.originAttributes ?? '');
  }
  db.close();
  return file;
}
function read(file: string, domains = ['example.test', 'github.com', 'mail.test']) {
  const snapshot = withCookieSnapshot(file, (db) => readFirefoxCookies(db, domains, now));
  if (!snapshot.ok) throw new Error(snapshot.reason);
  return snapshot.value.flatMap((entry) => (entry.ok ? [entry.cookie] : []));
}

describe('readFirefoxCookies', () => {
  it('converts millisecond expiries from schema 16 and newer', () => {
    expect(read(firefoxDatabase([{ name: 'c', expiry: 1_800_000_000_000, sameSite: 1 }], 16))[0]?.expires).toBe(1_800_000_000);
    expect(read(firefoxDatabase([{ name: 'c', expiry: 1_800_000_000, sameSite: 1 }], 15))[0]?.expires).toBe(1_800_000_000);
  });

  it('maps moz_cookies onto the profile cookie, keeping host-only and domain scopes', () => {
    expect(read(firefoxDatabase([
      { host: '.github.com', name: 'session', value: 'abc', expiry: 1_800_000_000, isSecure: 1, isHttpOnly: 1, sameSite: 1 },
      { host: 'example.test', name: 'plain', path: '/app', sameSite: 0, isSecure: 1 },
    ]))).toEqual([
      { domain: '.github.com', name: 'session', value: 'abc', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 1_800_000_000 },
      // Session cookies carry no expiry rather than one at the epoch.
      { domain: 'example.test', name: 'plain', value: 'v', path: '/app', secure: true, httpOnly: false, sameSite: 'None' },
    ]);
  });

  it('keeps an unset SameSite unspecified instead of widening it to None', () => {
    const cookies = read(firefoxDatabase([{ name: 'unset', sameSite: 256, isSecure: 1 }, { name: 'none', sameSite: 0, isSecure: 1 }]));
    expect(cookies.map(({ name, sameSite }) => ({ name, sameSite }))).toEqual([{ name: 'unset', sameSite: undefined }, { name: 'none', sameSite: 'None' }]);
  });

  it('imports rows whose SameSite was never written (schema 9)', () => {
    const cookies = read(firefoxDatabase([{ name: 'legacy', sameSite: null }, { name: 'strict', sameSite: 2 }], 9));
    expect(cookies.map(({ name, sameSite }) => ({ name, sameSite }))).toEqual([{ name: 'legacy', sameSite: undefined }, { name: 'strict', sameSite: 'Strict' }]);
  });

  it('applies the schema-15 rawSameSite rule to older databases', () => {
    const cookies = read(firefoxDatabase([
      { name: 'defaulted', sameSite: 1, rawSameSite: 0 },
      { name: 'declared', sameSite: 1, rawSameSite: 1 },
      { name: 'none', sameSite: 0, rawSameSite: 0, isSecure: 1 },
    ], 14));
    expect(cookies.map(({ name, sameSite }) => ({ name, sameSite }))).toEqual([
      { name: 'defaulted', sameSite: undefined }, { name: 'declared', sameSite: 'Lax' }, { name: 'none', sameSite: 'None' },
    ]);
  });

  it('imports only the default container and only the selected sites', () => {
    const file = firefoxDatabase([
      { host: 'mail.test', name: 'session', value: 'default-container', sameSite: 1 },
      { host: 'mail.test', name: 'session', value: 'work-container', sameSite: 1, originAttributes: '^userContextId=2' },
      { host: 'mail.test', name: 'private', value: 'private-window', sameSite: 1, originAttributes: '^privateBrowsingId=1' },
      { host: 'other.test', name: 'other', value: 'not-selected', sameSite: 1 },
    ]);
    expect(read(file).map((cookie) => cookie.value)).toEqual(['default-container']);
  });

  it('reads without mutating the source database', () => {
    const file = firefoxDatabase([{ name: 'n', expiry: 1_800_000_000, isSecure: 1, sameSite: 2 }]);
    const before = fs.readFileSync(file);
    read(file);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
