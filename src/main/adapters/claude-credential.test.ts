import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  execFileSync: vi.fn(() => 'credential-blob\n'),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock('node:child_process', () => childProcess);

import {
  readActiveClaudeCredential,
  writeActiveClaudeCredential,
} from './claude-credential';

describe.runIf(process.platform === 'darwin')('Claude Keychain boundaries', () => {
  beforeEach(() => {
    childProcess.execFileSync.mockClear();
    childProcess.spawnSync.mockClear();
  });

  it('bounds the Keychain read so SecurityAgent cannot freeze the main loop', () => {
    expect(readActiveClaudeCredential()).toBe('credential-blob');
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      expect.objectContaining({
        timeout: 5_000,
        killSignal: 'SIGKILL',
      }),
    );
  });

  it('bounds the Keychain write so account activation cannot freeze the main loop', () => {
    expect(writeActiveClaudeCredential('credential-blob')).toBe(true);
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'security',
      ['-i'],
      expect.objectContaining({
        timeout: 5_000,
        killSignal: 'SIGKILL',
      }),
    );
  });
});
