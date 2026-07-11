// Remote FS over SSH transport with ssh-path containment (Gap D3).
// Patterns inspired by stablyai/orca SFTP helpers @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus-authored.
// See third_party/licenses/orca-MIT.txt.

import { resolveSshPathInsideRoot } from '../ssh-path';
import type { SshSession } from './ssh-session-manager';

export type RemoteFsAuthz = {
  readonly canRead: boolean;
  readonly canWrite: boolean;
};

export class RemoteFsDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteFsDeniedError';
  }
}

export type RemoteFs = {
  list(relative: string): Promise<readonly string[]>;
  read(relative: string): Promise<string>;
  write(relative: string, content: string): Promise<void>;
};

/**
 * Remote filesystem scoped to a project root on the remote host.
 * Paths that escape root fail closed.
 */
export function createRemoteFs(
  session: SshSession,
  remoteRoot: string,
  authz: RemoteFsAuthz,
): RemoteFs {
  const resolve = (relative: string): string => {
    const path = resolveSshPathInsideRoot(remoteRoot, relative);
    if (!path) {
      throw new RemoteFsDeniedError(`path escapes remote root: ${relative}`);
    }
    return path;
  };

  return {
    async list(relative) {
      if (!authz.canRead) throw new RemoteFsDeniedError('read denied');
      return session.transport.listDir(resolve(relative));
    },
    async read(relative) {
      if (!authz.canRead) throw new RemoteFsDeniedError('read denied');
      return session.transport.readFile(resolve(relative));
    },
    async write(relative, content) {
      if (!authz.canWrite) throw new RemoteFsDeniedError('write denied');
      await session.transport.writeFile(resolve(relative), content);
    },
  };
}
