import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.hoisted(() => ({ entries: new Map<string, string>(), writable: true, reads: 0 }));
vi.mock('./claude-credential', async (original) => ({
  ...await original<typeof import('./claude-credential')>(),
  readManagedClaudeCredential: (dir: string) => { keychain.reads++; return keychain.entries.get(dir) ?? null; },
  writeManagedClaudeCredential: (dir: string, blob: string) => {
    if (!keychain.writable) return false;
    keychain.entries.set(dir, blob);
    return true;
  },
  deleteManagedClaudeCredential: (dir: string) => { keychain.entries.delete(dir); return true; },
}));

import {
  CLAUDE_MANAGED_AUTH_ENV,
  assertManagedClaudeAuthSupported,
  managedClaudeAuthDirectory,
  materializeManagedClaudeAuth,
  readManagedClaudeAuth,
  removeManagedClaudeAuth,
} from './managed-claude-auth';

let home: string;
const blob = (token: string, expiresAt: number) => JSON.stringify({
  claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}`, expiresAt, scopes: ['user:inference'] },
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-managed-claude-test-'));
  keychain.entries.clear();
  keychain.writable = true;
  keychain.reads = 0;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('renewable managed Claude profiles', () => {
  it('serves repeated quota reads without synchronous Keychain subprocesses', () => {
    materializeManagedClaudeAuth('account-a', blob('a', 100), { home });
    keychain.reads = 0;
    for (let i = 0; i < 3; i++) expect(readManagedClaudeAuth('account-a', { home })).toBe(blob('a', 100));
    expect(keychain.reads).toBe(0);
  });
  it('gives two accounts separate durable stores without static token env', () => {
    const a = materializeManagedClaudeAuth('account-a', blob('a', 100), { home });
    const b = materializeManagedClaudeAuth('account-b', blob('b', 200), { home });
    expect(a.env).toEqual({ [CLAUDE_MANAGED_AUTH_ENV]: a.directory });
    expect(a.directory).not.toBe(b.directory);
    expect(a.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(JSON.parse(fs.readFileSync(path.join(a.directory, '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('refresh-a');
    expect(fs.statSync(a.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(a.directory, '.credentials.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps a CLI-refreshed file and reads it back instead of restoring the stale vault', () => {
    const original = blob('old', 100);
    const renewed = blob('renewed', 300);
    const a = materializeManagedClaudeAuth('account-a', original, { home });
    fs.writeFileSync(path.join(a.directory, '.credentials.json'), renewed);
    const next = materializeManagedClaudeAuth('account-a', original, { home });
    expect(next.blob).toBe(renewed);
    expect(readManagedClaudeAuth('account-a', { home })).toBe(renewed);
  });

  it('recovers a newer scoped Keychain credential after Claude deleted its fallback file', () => {
    const a = materializeManagedClaudeAuth('account-a', blob('old', 100), { home });
    const renewed = blob('keychain-renewed', 400);
    keychain.entries.set(a.directory, renewed);
    fs.unlinkSync(path.join(a.directory, '.credentials.json'));
    const next = materializeManagedClaudeAuth('account-a', blob('old', 100), { home });
    expect(next.blob).toBe(renewed);
    expect(fs.readFileSync(path.join(a.directory, '.credentials.json'), 'utf8')).toBe(renewed);
  });

  it('replaces only the selected scoped store after an explicit new login', () => {
    const a = materializeManagedClaudeAuth('account-a', blob('a-old', 100), { home });
    const b = materializeManagedClaudeAuth('account-b', blob('b', 200), { home });
    keychain.entries.set(a.directory, blob('a-old', 100));
    keychain.entries.set(b.directory, blob('b', 200));
    const relogin = blob('a-relogin', 50);
    expect(materializeManagedClaudeAuth('account-a', relogin, { home, replace: true }).blob).toBe(relogin);
    expect(keychain.entries.get(a.directory)).toBe(relogin);
    expect(keychain.entries.get(b.directory)).toBe(blob('b', 200));
  });

  it('fails rather than leaving an older scoped Keychain to override a new login', () => {
    const a = materializeManagedClaudeAuth('account-a', blob('old', 100), { home });
    keychain.entries.set(a.directory, blob('old', 100));
    keychain.writable = false;
    expect(() => materializeManagedClaudeAuth('account-a', blob('new', 200), { home, replace: true })).toThrow(/Keychain/);
  });

  it('rejects traversal and linked auth files without modifying another account', () => {
    expect(() => managedClaudeAuthDirectory('../other', home)).toThrow();
    const a = materializeManagedClaudeAuth('account-a', blob('a', 100), { home });
    const b = materializeManagedClaudeAuth('account-b', blob('b', 200), { home });
    fs.unlinkSync(path.join(a.directory, '.credentials.json'));
    fs.symlinkSync(path.join(b.directory, '.credentials.json'), path.join(a.directory, '.credentials.json'));
    expect(() => materializeManagedClaudeAuth('account-a', blob('replacement', 300), { home })).toThrow(/link/);
    expect(fs.readFileSync(path.join(b.directory, '.credentials.json'), 'utf8')).toBe(blob('b', 200));
  });

  it('removes only the selected account auth directory and scoped Keychain entry', () => {
    const a = materializeManagedClaudeAuth('account-a', blob('a', 100), { home });
    const b = materializeManagedClaudeAuth('account-b', blob('b', 200), { home });
    keychain.entries.set(a.directory, blob('a', 100));
    keychain.entries.set(b.directory, blob('b', 200));
    removeManagedClaudeAuth('account-a', { home });
    expect(fs.existsSync(a.directory)).toBe(false);
    expect(keychain.entries.has(a.directory)).toBe(false);
    expect(readManagedClaudeAuth('account-b', { home })).toBe(blob('b', 200));
  });

  it('refuses a CLI without the isolated secure-storage capability', () => {
    const binary = path.join(home, 'claude');
    fs.writeFileSync(binary, 'old CLI without isolated storage');
    expect(() => assertManagedClaudeAuthSupported(binary)).toThrow(/CLAUDE_SECURESTORAGE_CONFIG_DIR/);
    fs.writeFileSync(binary, 'verified CLI capability: CLAUDE_SECURESTORAGE_CONFIG_DIR');
    expect(() => assertManagedClaudeAuthSupported(binary)).not.toThrow();
  });
});
