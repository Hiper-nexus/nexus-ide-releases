/**
 * Main-process-style integration: SSH mock + FS + Git + PTY stream (Gap D MVP e2e).
 */
import { describe, expect, it } from 'vitest';
import { createRemoteHostCapability } from '../remote-capability';
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  createMockSshTransport,
  createSshSessionManager,
} from './ssh-session-manager';
import { createRemoteFs, RemoteFsDeniedError } from './remote-fs';
import { createRemoteGit, RemoteGitDeniedError } from './remote-git';
import { openRemotePty } from './remote-pty';
import { decodeTerminalStreamFrame, TerminalStreamOpcode } from '../../../shared/terminal-stream-protocol';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'inst-1',
  projectId: 'proj-1',
  checkoutId: 'chk-1',
  rootRealPath: '/Users/test/proj',
  identitySource: 'manifest',
};

describe('remote stack mock e2e (D2–D5)', () => {
  it('connects under capability, FS containment, git policy, PTY stream frames', async () => {
    const capability = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'host-a',
      displayName: 'dev box',
      scope,
      paired: true,
    });
    const transport = createMockSshTransport({
      '/proj/README.md': '# hi',
      '/proj/src/main.ts': 'export {}',
    });
    const manager = createSshSessionManager();
    const session = await manager.connect(
      capability,
      {
        host: 'example.test',
        username: 'dev',
        auth: { kind: 'privateKey', privateKey: 'fake' },
      },
      transport,
    );

    const fs = createRemoteFs(session, '/proj', { canRead: true, canWrite: true });
    expect(await fs.read('README.md')).toBe('# hi');
    expect(await fs.list('src')).toEqual(['main.ts']);
    await expect(fs.read('../etc/passwd')).rejects.toBeInstanceOf(RemoteFsDeniedError);

    const git = createRemoteGit(session, '/proj', {
      allowFetch: true,
      allowWrite: false,
    });
    expect(await git.status()).toContain('##');
    await expect(git.write(['commit', '-m', 'x'])).rejects.toBeInstanceOf(RemoteGitDeniedError);
    await expect(git.write(['push', '--force'])).rejects.toBeInstanceOf(RemoteGitDeniedError);

    const frames: Uint8Array[] = [];
    const pty = await openRemotePty(session, { streamId: 7, cols: 80, rows: 24 });
    pty.onFrame((f) => frames.push(f));
    pty.writeInput('echo hi\n');
    expect(frames.length).toBe(1);
    const decoded = decodeTerminalStreamFrame(frames[0]!);
    expect(decoded?.opcode).toBe(TerminalStreamOpcode.Output);
    expect(decoded?.streamId).toBe(7);
    expect(decoded?.seq).toBe(1);
    expect(new TextDecoder().decode(decoded!.payload)).toBe('echo hi\n');
    expect(pty.getLastSeq()).toBe(1);

    await session.disconnect();
    expect(transport.isConnected()).toBe(false);
  });

  it('fails closed when capability not paired', async () => {
    const capability = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'host-b',
      displayName: 'x',
      scope,
      paired: false,
    });
    const manager = createSshSessionManager();
    await expect(
      manager.connect(
        capability,
        {
          host: 'h',
          username: 'u',
          auth: { kind: 'password', password: 'p' },
        },
        createMockSshTransport(),
      ),
    ).rejects.toThrow(/not paired/);
  });
});
