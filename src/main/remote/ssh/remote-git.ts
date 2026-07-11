// Remote Git over SSH transport — read-mostly (Gap D4).
// Patterns inspired by stablyai/orca remote git helpers @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus-authored.
// See third_party/licenses/orca-MIT.txt.

import type { SshSession } from './ssh-session-manager';
import { resolveSshPathInsideRoot } from '../ssh-path';

export type RemoteGitPolicy = {
  readonly allowFetch: boolean;
  readonly allowWrite: boolean;
};

export class RemoteGitDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteGitDeniedError';
  }
}

export type RemoteGit = {
  status(): Promise<string>;
  diff(): Promise<string>;
  fetch(): Promise<string>;
  /** Destructive / mutating git — requires allowWrite. */
  write(args: readonly string[]): Promise<string>;
};

const ALLOWED_WRITE_SUBCOMMANDS = new Set([
  'add',
  'branch',
  'checkout',
  'cherry-pick',
  'commit',
  'merge',
  'pull',
  'push',
  'rebase',
  'restore',
  'revert',
  'stash',
  'switch',
  'tag',
]);

function shellQuoteSingle(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createRemoteGit(
  session: SshSession,
  remoteRepoRoot: string,
  policy: RemoteGitPolicy,
): RemoteGit {
  const root = resolveSshPathInsideRoot(remoteRepoRoot, '.');
  if (!root) {
    throw new RemoteGitDeniedError('invalid remote repo root');
  }
  const git = async (args: readonly string[]): Promise<string> => {
    if (
      args.length === 0 ||
      args.length > 128 ||
      args.some((arg) => !arg || arg.length > 8_192 || arg.includes('\0'))
    ) {
      throw new RemoteGitDeniedError('invalid git arguments');
    }
    const cmd = `git -C ${shellQuoteSingle(root)} ${args.map(shellQuoteSingle).join(' ')}`;
    const result = await session.transport.exec(cmd);
    if (result.code !== 0) {
      throw new Error(`remote-git failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };

  return {
    async status() {
      return git(['status', '--porcelain=v1', '--branch']);
    },
    async diff() {
      return git(['diff', '--no-color']);
    },
    async fetch() {
      if (!policy.allowFetch) throw new RemoteGitDeniedError('fetch denied by policy');
      return git(['fetch', '--all', '--prune']);
    },
    async write(args) {
      if (!policy.allowWrite) throw new RemoteGitDeniedError('write denied by policy');
      if (!ALLOWED_WRITE_SUBCOMMANDS.has(args[0] ?? '')) {
        throw new RemoteGitDeniedError('git subcommand denied by policy');
      }
      // Reject force-like agent-accessible operations (including lease/with-lease).
      if (
        args.some((arg) => arg === '-f' || arg.startsWith('--force')) ||
        (args[0] === 'reset' && args.includes('--hard')) ||
        (args[0] === 'clean' && args.some((arg) => arg.startsWith('-') && arg.includes('f')))
      ) {
        throw new RemoteGitDeniedError('force/hard operations denied');
      }
      return git(args);
    },
  };
}
