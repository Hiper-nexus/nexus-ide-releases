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
