import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFile(...args),
}));

let keychain: typeof import('./native-oauth-keychain');

const BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'access-live',
    refreshToken: 'refresh-live',
  },
});

function reply(
  error: ({ code?: number } & Error) | null,
  stdout = '',
): void {
  execFile.mockImplementationOnce(
    (
      _bin: string,
      _args: string[],
      _options: object,
      callback: (error: ({ code?: number } & Error) | null, stdout: string) => void,
    ) => callback(error, stdout),
  );
}

beforeEach(async () => {
  vi.resetModules();
  execFile.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
  keychain = await import('./native-oauth-keychain');
  keychain.invalidateNativeOAuthCredentialCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('async native OAuth Keychain cache', () => {
  it('shares a pending read across callers of the same service', async () => {
    const callbacks: Array<(error: null, stdout: string) => void> = [];
    execFile.mockImplementation((_bin, _args, _options, callback) => callbacks.push(callback));
    const first = keychain.readNativeOAuthCredential('Claude Code-credentials');
    const second = keychain.readNativeOAuthCredential('Claude Code-credentials');
    expect(execFile).toHaveBeenCalledTimes(1);
    callbacks.forEach((callback) => callback(null, BLOB));
    await expect(first).resolves.toContain('access-live');
    await expect(second).resolves.toContain('access-live');
  });

  it('shares a fresh pending observation across simultaneous post-login callers', async () => {
    const callbacks: Array<(error: null, stdout: string) => void> = [];
    execFile.mockImplementation((_bin, _args, _options, callback) => callbacks.push(callback));
    const first = keychain.readNativeOAuthCredential('Claude Code-credentials', undefined, { bypassCache: true });
    const second = keychain.readNativeOAuthCredential('Claude Code-credentials', undefined, { bypassCache: true });
    callbacks[0](null, BLOB);
    await expect(first).resolves.toContain('access-live');
    expect(execFile).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toContain('access-live');
  });

  it('queues only one fresh observation for callers waiting on a pre-login read', async () => {
    const callbacks: Array<(error: null, stdout: string) => void> = [];
    execFile.mockImplementation((_bin, _args, _options, callback) => callbacks.push(callback));
    const old = keychain.readNativeOAuthCredential('Claude Code-credentials');
    const first = keychain.readNativeOAuthCredential('Claude Code-credentials', undefined, { bypassCache: true });
    const second = keychain.readNativeOAuthCredential('Claude Code-credentials', undefined, { bypassCache: true });
    callbacks[0](null, BLOB);
    await old;
    callbacks[1](null, BLOB.replace(/live/g, 'after-login'));
    await expect(first).resolves.toContain('after-login');
    expect(execFile).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toContain('after-login');
  });

  it.each([false, true])('discards a pending result after invalidation (all=%s)', async (all) => {
    const callbacks: Array<(error: null, stdout: string) => void> = [];
    execFile.mockImplementation((_bin, _args, _options, callback) => callbacks.push(callback));
    const first = keychain.readNativeOAuthCredential('Claude Code-credentials');
    keychain.invalidateNativeOAuthCredentialCache(all ? undefined : 'Claude Code-credentials');
    const second = keychain.readNativeOAuthCredential('Claude Code-credentials');
    const next = BLOB.replace(/live/g, 'after-login');
    expect(execFile).toHaveBeenCalledTimes(2);
    callbacks[1](null, next);
    await expect(second).resolves.toContain('after-login');
    callbacks[0](null, BLOB);
    await first;
    await expect(keychain.readNativeOAuthCredential('Claude Code-credentials'))
      .resolves.toContain('after-login');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('does not let an old denial overwrite a trusted post-login capture', async () => {
    let callback!: (error: Error & { code: number }, stdout: string) => void;
    execFile.mockImplementation((_bin, _args, _options, cb) => { callback = cb; });
    const first = keychain.readNativeOAuthCredential('Claude Code-credentials');
    const rejected = expect(first).rejects.toThrow('Keychain unavailable');
    keychain.rememberNativeOAuthCredential('Claude Code-credentials', BLOB);
    callback(Object.assign(new Error('denied'), { code: 51 }), '');
    await rejected;
    await expect(keychain.readNativeOAuthCredential('Claude Code-credentials'))
      .resolves.toContain('access-live');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('fresh post-login reads do not join a pre-login flight', async () => {
    const callbacks: Array<(error: null, stdout: string) => void> = [];
    execFile.mockImplementation((_bin, _args, _options, callback) => callbacks.push(callback));
    const first = keychain.readNativeOAuthCredential('Claude Code-credentials');
    const fresh = keychain.readNativeOAuthCredential('Claude Code-credentials', undefined, { bypassCache: true });
    callbacks[0](null, BLOB);
    await first;
    const follower = keychain.readNativeOAuthCredential('Claude Code-credentials');
    expect(execFile).toHaveBeenCalledTimes(2);
    callbacks[1](null, BLOB.replace(/live/g, 'after-login'));
    await expect(fresh).resolves.toContain('after-login');
    await expect(follower).resolves.toContain('after-login');
  });

  it('coalesces hot status polls instead of reading the secret every 2s', async () => {
    reply(null, BLOB);
    await expect(
      keychain.readNativeOAuthCredential('Claude Code-credentials'),
    ).resolves.toContain('access-live');
    await expect(
      keychain.readNativeOAuthCredential('Claude Code-credentials'),
    ).resolves.toContain('access-live');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('fresh post-login read bypasses an old successful credential', async () => {
    reply(null, BLOB);
    await keychain.readNativeOAuthCredential('Claude Code-credentials');

    const next = BLOB.replace(/live/g, 'after-login');
    reply(null, next);
    await expect(
      keychain.readNativeOAuthCredential(
        'Claude Code-credentials',
        undefined,
        { bypassCache: true },
      ),
    ).resolves.toContain('after-login');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('never bypasses denial backoff and reopen the macOS dialog', async () => {
    reply(Object.assign(new Error('interaction not allowed'), { code: 51 }));
    await expect(
      keychain.readNativeOAuthCredential('Claude Code-credentials'),
    ).rejects.toThrow('Keychain unavailable');
    await expect(
      keychain.readNativeOAuthCredential(
        'Claude Code-credentials',
        undefined,
        { bypassCache: true },
      ),
    ).rejects.toThrow('Keychain unavailable');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('short-caches item-not-found so a new login appears quickly', async () => {
    reply(Object.assign(new Error('not found'), { code: 44 }));
    await expect(
      keychain.readNativeOAuthCredential('Claude Code-credentials'),
    ).resolves.toBeNull();

    vi.advanceTimersByTime(15_001);
    reply(null, BLOB);
    await expect(
      keychain.readNativeOAuthCredential('Claude Code-credentials'),
    ).resolves.toContain('access-live');
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});
