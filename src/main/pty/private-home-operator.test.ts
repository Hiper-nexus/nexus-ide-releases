import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensurePrivateHomeKeychains,
  ensurePrivateHomeOperatorAccess,
  linkDarwinUserKeychains,
} from './private-home-operator';

let root: string;
let realHome: string;
let userData: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kc-')));
  realHome = path.join(root, 'home');
  userData = path.join(root, 'userData');
  fs.mkdirSync(path.join(realHome, 'Library', 'Keychains'), { recursive: true });
  fs.writeFileSync(path.join(realHome, 'Library', 'Keychains', 'login.keychain-db'), 'db');
  fs.writeFileSync(path.join(realHome, 'Library', 'Keychains', 'notes.txt'), 'x');
  fs.mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function privateHome(...parts: string[]): string {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ensurePrivateHomeKeychains (F-629)', () => {
  it('links only *.keychain-db into a Nexus ephemeral HOME', () => {
    const home = privateHome(realHome, '.nexus', 'ephemeral', 'abc123');
    const linked = ensurePrivateHomeKeychains(home, { realHome, userDataDir: userData, platform: 'darwin' });
    expect(linked).toBe(true);
    const target = path.join(home, 'Library', 'Keychains', 'login.keychain-db');
    const source = path.join(realHome, 'Library', 'Keychains', 'login.keychain-db');
    if (process.platform === 'win32') {
      expect(fs.readFileSync(target, 'utf8')).toBe('db');
    } else {
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(target)).toBe(fs.realpathSync(source));
    }
    expect(fs.existsSync(path.join(home, 'Library', 'Keychains', 'notes.txt'))).toBe(false);
  });

  it('covers provider-state private HOMEs under userData (cursor, droid, MiMo, Codex shell-home)', () => {
    const home = privateHome(userData, 'provider-state', 'droid', 'ck1', 'home');
    expect(ensurePrivateHomeKeychains(home, { realHome, userDataDir: userData, platform: 'darwin' })).toBe(true);
    expect(fs.existsSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'))).toBe(true);
  });

  it('never touches the real HOME nor a HOME outside Nexus-owned roots', () => {
    expect(ensurePrivateHomeKeychains(realHome, { realHome, userDataDir: userData, platform: 'darwin' })).toBe(false);
    const foreign = privateHome(root, 'someone-else-home');
    expect(ensurePrivateHomeKeychains(foreign, { realHome, userDataDir: userData, platform: 'darwin' })).toBe(false);
    expect(fs.existsSync(path.join(foreign, 'Library'))).toBe(false);
  });

  it('is a no-op off macOS and when HOME is missing', () => {
    const home = privateHome(realHome, '.nexus', 'ephemeral', 'linux');
    expect(ensurePrivateHomeKeychains(home, { realHome, userDataDir: userData, platform: 'linux' })).toBe(false);
    expect(ensurePrivateHomeKeychains(undefined, { realHome, userDataDir: userData, platform: 'darwin' })).toBe(false);
    expect(fs.existsSync(path.join(home, 'Library'))).toBe(false);
  });

  it('keeps an existing overlay keychain untouched (idempotent)', () => {
    const home = privateHome(realHome, '.nexus', 'ephemeral', 'again');
    linkDarwinUserKeychains(realHome, home);
    expect(ensurePrivateHomeKeychains(home, { realHome, userDataDir: userData, platform: 'darwin' })).toBe(true);
    expect(fs.readdirSync(path.join(home, 'Library', 'Keychains'))).toEqual(['login.keychain-db']);
  });

  it('does not follow a symlinked HOME escaping the Nexus roots', () => {
    const outside = privateHome(root, 'outside');
    const link = path.join(realHome, '.nexus', 'ephemeral', 'sneaky');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);
    expect(ensurePrivateHomeKeychains(link, { realHome, userDataDir: userData, platform: 'darwin' })).toBe(false);
    expect(fs.existsSync(path.join(outside, 'Library'))).toBe(false);
  });

  it('writable lane gets the operator gh/git identity — no more "gh auth login" in Grok/MiMo/cursor panes', () => {
    fs.mkdirSync(path.join(realHome, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(realHome, '.config', 'gh', 'hosts.yml'), 'github.com: {}');
    fs.writeFileSync(path.join(realHome, '.gitconfig'), '[user]');
    const home = privateHome(userData, 'mcp-clients', 'grok', 'x', '.nexus-home');
    ensurePrivateHomeOperatorAccess(home, { realHome, userDataDir: userData, platform: 'darwin', writable: true });
    const sameFile = (linked: string, source: string) => {
      const a = fs.statSync(linked);
      const b = fs.statSync(source);
      return a.dev === b.dev && a.ino === b.ino;
    };
    expect(sameFile(path.join(home, '.config', 'gh'), path.join(realHome, '.config', 'gh'))).toBe(true);
    expect(sameFile(path.join(home, '.gitconfig'), path.join(realHome, '.gitconfig'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'))).toBe(true);
  });

  it('read-only lane gets the keychain but never the developer identity', () => {
    fs.mkdirSync(path.join(realHome, '.config', 'gh'), { recursive: true });
    const home = privateHome(realHome, '.nexus', 'ephemeral', 'ro');
    ensurePrivateHomeOperatorAccess(home, { realHome, userDataDir: userData, platform: 'darwin', writable: false });
    expect(fs.existsSync(path.join(home, '.config'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'))).toBe(true);
  });

  it('never replaces an entry the adapter already staged', () => {
    fs.writeFileSync(path.join(realHome, '.gitconfig'), 'real');
    const home = privateHome(realHome, '.nexus', 'ephemeral', 'staged');
    fs.writeFileSync(path.join(home, '.gitconfig'), 'staged');
    ensurePrivateHomeOperatorAccess(home, { realHome, userDataDir: userData, platform: 'darwin', writable: true });
    expect(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8')).toBe('staged');
  });
});
