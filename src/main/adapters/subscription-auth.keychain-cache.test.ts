import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFile(...args),
  execFileSync: vi.fn(() => { throw new Error('Unexpected synchronous process'); }),
  spawnSync: vi.fn(() => { throw new Error('Unexpected process'); }),
}));
vi.mock('../path-resolver', () => ({
  realUserHome: () => '/unused-test-home',
  resolveCliBinary: () => ({ binPath: '/test/claude', effectivePath: '/test', source: 'absolute' }),
}));

let home: string;
let auth: typeof import('./subscription-auth');
beforeEach(async () => {
  vi.resetModules();
  execFile.mockReset();
  vi.useFakeTimers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-keychain-backoff-'));
  auth = await import('./subscription-auth');
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('Claude native Keychain denial', () => {
  it('keeps auth unknown and never runs CLI attestation during denial backoff', async () => {
    execFile.mockImplementation((bin, _args, _options, callback) => {
      if (bin === 'security') callback(Object.assign(new Error('denied'), { code: 51 }), '');
      else callback(null, '{"loggedIn":false}');
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(auth.refreshClaudeSubscriptionAuthCache(home, undefined, { authoritative: true }))
        .rejects.toThrow('Keychain unavailable');
      expect(auth.subscriptionAuthStatusIsUnknown('claude', home)).toBe(true);
    }
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][0]).toBe('security');
  });

  it('still accepts CLI attestation when the Keychain item is absent', async () => {
    execFile.mockImplementation((bin, _args, _options, callback) => {
      if (bin === 'security') callback(Object.assign(new Error('absent'), { code: 44 }), '');
      else callback(null, '{"loggedIn":true}');
    });
    await expect(auth.refreshClaudeSubscriptionAuthCache(home))
      .resolves.toMatchObject({ value: true });
    expect(execFile.mock.calls.map(([bin]) => bin)).toEqual(['security', '/test/claude']);
  });
});
