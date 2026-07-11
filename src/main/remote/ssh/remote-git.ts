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
  write(command: string): Promise<string>;
};

function shellQuoteSingle(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
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
  const git = async (args: string): Promise<string> => {
    const cmd = `git -C ${shellQuoteSingle(root)} ${args}`;
    const result = await session.transport.exec(cmd);
    if (result.code !== 0) {
      throw new Error(`remote-git failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };

  return {
    async status() {
      return git('status --porcelain=v1 --branch');
    },
    async diff() {
      return git('diff --no-color');
    },
    async fetch() {
      if (!policy.allowFetch) throw new RemoteGitDeniedError('fetch denied by policy');
      return git('fetch --all --prune');
    },
    async write(command) {
      if (!policy.allowWrite) throw new RemoteGitDeniedError('write denied by policy');
      // Reject force-like agent-accessible operations (including lease/with-lease).
      if (
        /(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:\s|$)/.test(command) ||
        /reset\s+--hard/.test(command) ||
        /clean\s+-f/.test(command)
      ) {
        throw new RemoteGitDeniedError('force/hard operations denied');
      }
      return git(command);
    },
  };
}
