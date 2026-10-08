// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: ChromiumKeys.test.ts sem Effect — AsyncEntry falso injetado (nunca o Keychain real), secret-tool e PowerShell por executores falsos que capturam argv/stdin; o módulo real do @napi-rs/keyring só é carregado, nunca consultado.
import { pbkdf2Sync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeWindowsWrappedKey, loadKeyring, readKeychainSecret, readLinuxSecret, resolveChromiumKeys, unwrapWindowsDpapiKey,
} from './chromium-keys';

const keyringWith = (getPassword: () => Promise<string | null | undefined>) => {
  const created: Array<[string, string]> = [];
  return {
    created,
    load: () => ({ AsyncEntry: class { constructor(service: string, account: string) { created.push([service, account]); } getPassword = getPassword } }),
  };
};
const darwinRequest = { platform: 'darwin' as const, keychainService: 'Chrome Safe Storage', keychainAccount: 'Chrome' };

describe('macOS Chromium secrets (in-process Keychain)', () => {
  it('derives the cookie key from the keychain secret read by AsyncEntry for the browser item', async () => {
    const keyring = keyringWith(async () => 'macos-secret');
    const keys = await resolveChromiumKeys(darwinRequest, { keychain: (service, account) => readKeychainSecret(service, account, keyring.load) });
    expect(keys.ok && keys.value.cbcV10?.toString('hex')).toBe('3df7306fb1eac353289565a2f6b64f74');
    expect(keyring.created).toEqual([['Chrome Safe Storage', 'Chrome']]);
  });

  it('reports a missing keychain item whether the binding resolves empty or rejects with NoEntry', async () => {
    expect(await readKeychainSecret('s', 'a', keyringWith(async () => null).load)).toEqual({ ok: false, reason: 'keychainItemMissing' });
    expect(await readKeychainSecret('s', 'a', keyringWith(async () => undefined).load)).toEqual({ ok: false, reason: 'keychainItemMissing' });
    expect(await readKeychainSecret('s', 'a', keyringWith(async () => { throw new Error('No matching entry found in secure storage'); }).load))
      .toEqual({ ok: false, reason: 'keychainItemMissing' });
  });

  it('reports a denied approval, and an unloadable binding, without exposing the cause', async () => {
    expect(await readKeychainSecret('s', 'a', keyringWith(async () => { throw new Error('User canceled the operation.'); }).load))
      .toEqual({ ok: false, reason: 'needsKeychainApproval' });
    expect(await readKeychainSecret('s', 'a', () => { throw new Error('Cannot find module'); })).toEqual({ ok: false, reason: 'keychainUnavailable' });
  });

  it('never times out on the Keychain modal', async () => {
    vi.useFakeTimers();
    try {
      let answer: (value: string) => void = () => {};
      const pending = readKeychainSecret('s', 'a', keyringWith(() => new Promise((resolve) => { answer = resolve; })).load);
      // The user takes as long as they like; nothing races the prompt.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      answer('approved-late');
      expect(await pending).toEqual({ ok: true, value: 'approved-late' });
    } finally { vi.useRealTimers(); }
  });

  it('loads the real N-API binding in this runtime without touching the Keychain', () => {
    // Only the class is inspected: no entry is created, so nothing is read.
    expect(typeof loadKeyring().AsyncEntry).toBe('function');
  });
});

describe('Linux Chromium secrets', () => {
  it('looks up the libsecret application attribute through /usr/bin/secret-tool, preserving the exact secret', async () => {
    const run = vi.fn(async () => ({ stdout: 'linux-secret \t\n' }));
    expect(await readLinuxSecret('msedge', run)).toEqual({ ok: true, value: 'linux-secret \t\n' });
    expect(run).toHaveBeenCalledWith('/usr/bin/secret-tool', ['lookup', 'application', 'msedge'], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('keeps the v10 fallback and the empty-passphrase key when the keyring is unavailable', async () => {
    const keys = await resolveChromiumKeys(
      { platform: 'linux', linuxSecretApplication: 'chrome' },
      { linux: (application) => readLinuxSecret(application, async () => { throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); }) },
    );
    expect(keys.ok).toBe(true);
    if (!keys.ok) return;
    expect(keys.value.cbcV10?.toString('hex')).toBe(pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1').toString('hex'));
    expect(keys.value.cbcEmpty).toHaveLength(16);
    expect(keys.value.cbcV11).toBeUndefined();
    expect(keys.value.cbcV11Error).toBe('keychainUnavailable');
  });

  it('derives the v11 key from the keyring secret and reports an empty answer as a missing item', async () => {
    const keys = await resolveChromiumKeys({ platform: 'linux', linuxSecretApplication: 'brave' }, { linux: async () => ({ ok: true, value: 'linux-secret' }) });
    expect(keys.ok && keys.value.cbcV11).toHaveLength(16);
    expect(await readLinuxSecret('vivaldi', async () => ({ stdout: '' }))).toEqual({ ok: false, reason: 'keychainItemMissing' });
  });
});

describe('Windows Chromium secrets', () => {
  it('accepts only DPAPI-wrapped keys and refuses App-Bound ones', () => {
    const wrapped = Buffer.from('wrapped-key');
    const encoded = Buffer.concat([Buffer.from('DPAPI'), wrapped]).toString('base64');
    expect(decodeWindowsWrappedKey(`{"os_crypt":{"encrypted_key":"${encoded}"}}`)).toEqual({ ok: true, value: wrapped });
    expect(decodeWindowsWrappedKey(`{"os_crypt":{"encrypted_key":"${encoded}","app_bound_encrypted_key":"present"}}`)).toEqual({ ok: false, reason: 'appBound' });
    expect(decodeWindowsWrappedKey(`{"os_crypt":{"encrypted_key":"${wrapped.toString('base64')}"}}`)).toEqual({ ok: false, reason: 'readFailed' });
    expect(decodeWindowsWrappedKey('not json')).toEqual({ ok: false, reason: 'readFailed' });
  });

  it('unwraps the key through PowerShell on stdin, never in argv', async () => {
    const wrapped = Buffer.from('wrapped-key');
    const key = Buffer.from('0123456789abcdef0123456789abcdef');
    let captured: { command: string; args: string[]; stdin: string } | undefined;
    const fakeSpawn = ((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
      let stdin = '';
      child.stdin.on('data', (chunk) => { stdin += chunk; });
      child.stdin.on('end', () => {
        captured = { command, args, stdin };
        child.stdout.end(key.toString('base64'));
        child.stdout.on('end', () => child.emit('close', 0));
        child.stdout.resume();
      });
      return child;
    }) as unknown as typeof spawn;
    expect(await unwrapWindowsDpapiKey(wrapped, { SystemRoot: 'C:\\Windows' }, fakeSpawn)).toEqual({ ok: true, value: key });
    expect(captured?.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(captured?.args).toContain('-NonInteractive');
    expect(captured?.args.join(' ')).not.toContain(wrapped.toString('base64'));
    expect(captured?.stdin).toBe(wrapped.toString('base64'));
  });
});
