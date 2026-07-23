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

  it('blocks operations on a dead transport until an explicit manual reconnect', async () => {
    const cap = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'h-reconnect',
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
    await transport.disconnect();

    await expect(session.transport.exec('echo no-auto-retry')).rejects.toMatchObject({
      code: 'not_connected',
    });
    expect(transport.history.filter((entry) => entry.startsWith('connect:'))).toHaveLength(1);

    await session.reconnect();
    await expect(session.transport.exec('echo explicit')).resolves.toMatchObject({ code: 0 });
    expect(transport.history.filter((entry) => entry.startsWith('connect:'))).toHaveLength(2);
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
