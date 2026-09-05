import path from 'node:path';
import { createHash } from 'node:crypto';
import type { execFile } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { openClaudeKeychainService, readNativeOAuthKeychain, readNativeOAuthCredential } from './native-oauth-keychain';

describe('native OAuth keychain', () => {
  it('returns only the OAuth credential slice for main-process quota requests', async () => {
    const exec = vi.fn((_bin, _args, _options, cb) => cb(null, JSON.stringify({
      claudeAiOauth: { accessToken: 'test-access' }, mcpOAuth: { unrelated: 'private-plugin-token' },
    })));
    const result = await readNativeOAuthCredential('Claude Code-credentials', exec as unknown as typeof execFile);
    expect(JSON.parse(result!)).toEqual({ claudeAiOauth: { accessToken: 'test-access' } });
  });
  it('addresses the OpenClaude store independently from Claude and scopes custom config homes', () => {
    expect(openClaudeKeychainService('/operator')).toBe('OpenClaude-credentials');
    const custom = path.resolve('/custom-openclaude').normalize('NFC');
    const hash = createHash('sha256').update(custom).digest('hex').slice(0, 8);
    expect(openClaudeKeychainService('/operator', custom)).toBe(`OpenClaude-credentials-${hash}`);
    expect(openClaudeKeychainService('/operator', '/operator/.openclaude')).toBe('OpenClaude-credentials');
  });

  it('accepts a usable OAuth payload through a bounded asynchronous process', async () => {
    const exec = vi.fn((_bin, _args, _options, cb) => cb(null, JSON.stringify({
      claudeAiOauth: { accessToken: 'test-access' },
    })));
    await expect(readNativeOAuthKeychain('OpenClaude-credentials', exec as unknown as typeof execFile))
      .resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('security',
      ['find-generic-password', '-s', 'OpenClaude-credentials', '-w'],
      expect.objectContaining({ timeout: 5_000, killSignal: 'SIGKILL' }), expect.any(Function));
  });

  it('rejects a tokenless item and distinguishes missing from unavailable Keychain', async () => {
    const run = (error: unknown, stdout = '{}') =>
      ((_bin: unknown, _args: unknown, _options: unknown, cb: (e: unknown, s: string) => void) => cb(error, stdout)) as typeof execFile;
    await expect(readNativeOAuthKeychain('Claude Code-credentials', run(null))).resolves.toBe(false);
    await expect(readNativeOAuthKeychain('Claude Code-credentials', run({ code: 44 }))).resolves.toBe(false);
    await expect(readNativeOAuthKeychain('Claude Code-credentials', run({ code: 36 }))).rejects.toThrow('Keychain unavailable');
  });
});
