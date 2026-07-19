/** D8 security negatives: scope fail-closed, no agent-force, path escape. */
import { describe, expect, it } from 'vitest';
import { createRemoteHostCapability, remoteCapabilityGrantsAgentForce } from '../remote-capability';
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  createMockSshTransport,
  createSshSessionManager,
} from './ssh-session-manager';
import { createRemoteFs, RemoteFsDeniedError } from './remote-fs';
import { createRemoteGit, RemoteGitDeniedError } from './remote-git';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'i',
  projectId: 'p',
  checkoutId: 'c',
  rootRealPath: '/r',
  identitySource: 'manifest',
};

describe('remote security negatives (D8)', () => {
  it('never grants agent force via capability', () => {
    const cap = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'h',
      displayName: 'h',
      scope,
      paired: true,
    });
    expect(remoteCapabilityGrantsAgentForce(cap)).toBe(false);
  });

  it('rejects empty agent identity allowlist', async () => {
    const cap = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'h',
      displayName: 'h',
      scope,
      paired: true,
    });
    const manager = createSshSessionManager();
    await expect(
      manager.connect(
        cap,
        {
          host: 'h',
          username: 'u',
          auth: { kind: 'agent', allowedFingerprints: [] },
        },
        createMockSshTransport(),
      ),
    ).rejects.toThrow(/empty agent identity/);
  });

  it('rejects wildcard agent identity allowlist (H3)', async () => {
    const cap = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'h',
      displayName: 'h',
      scope,
      paired: true,
    });
    const manager = createSshSessionManager();
    await expect(
      manager.connect(
        cap,
        {
          host: 'h',
          username: 'u',
          auth: { kind: 'agent', allowedFingerprints: ['*'] },
        },
        createMockSshTransport(),
      ),
    ).rejects.toThrow(/wildcard identity allowlist rejected/);
  });

  it('FS write denied without authz; traversal denied', async () => {
    const cap = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'h',
      displayName: 'h',
      scope,
      paired: true,
    });
    const transport = createMockSshTransport({ '/root/a': '1' });
    const session = await createSshSessionManager().connect(
      cap,
      { host: 'h', username: 'u', auth: { kind: 'password', password: 'x' } },
      transport,
    );
    const ro = createRemoteFs(session, '/root', { canRead: true, canWrite: false });
    await expect(ro.write('a', '2')).rejects.toBeInstanceOf(RemoteFsDeniedError);
    await expect(ro.read('../../etc/passwd')).rejects.toBeInstanceOf(RemoteFsDeniedError);

    const git = createRemoteGit(session, '/root', { allowFetch: false, allowWrite: false });
    await expect(git.fetch()).rejects.toBeInstanceOf(RemoteGitDeniedError);
  });

  it('quotes every write argument instead of interpolating a shell command', async () => {
    const cap = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'h-safe-git',
      displayName: 'h',
      scope,
      paired: true,
    });
    const transport = createMockSshTransport();
    const session = await createSshSessionManager().connect(
      cap,
      { host: 'h', username: 'u', auth: { kind: 'password', password: 'x' } },
      transport,
    );
    const git = createRemoteGit(session, '/root', { allowFetch: false, allowWrite: true });

    await git.write(['commit', '-m', 'x; touch /tmp/nexus-injected']);

    expect(transport.history.at(-1)).toBe(
      "exec:git -C '/root' 'commit' '-m' 'x; touch /tmp/nexus-injected'",
    );
  });
});
