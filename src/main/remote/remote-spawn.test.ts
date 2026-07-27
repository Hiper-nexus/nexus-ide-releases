import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => callback(null, { stdout: '', stderr: '' }),
  ),
}));

vi.mock('node:child_process', () => ({ execFile: harness.execFile }));
import {
  createRemoteTmuxSession,
  detectRemoteClis,
  listRemoteTmuxSessions,
} from './remote-spawn';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('remote-spawn target validation', () => {
  it('rejects a target beginning with "-" (ssh option injection)', async () => {
    // `-Jattacker.host` would otherwise be parsed by ssh as a jump proxy.
    await expect(detectRemoteClis('-Jattacker.host')).rejects.toThrow(
      'invalid ssh target',
    );
    await expect(listRemoteTmuxSessions('-oProxyCommand')).rejects.toThrow(
      'invalid ssh target',
    );
  });

  it('rejects targets with shell metacharacters', async () => {
    for (const bad of ['host; rm -rf', 'host$(id)', 'host`whoami`', 'a b', 'host|nc']) {
      await expect(detectRemoteClis(bad)).rejects.toThrow('invalid ssh target');
    }
  });

  it('rejects an invalid tmux session name before any ssh call', async () => {
    await expect(
      createRemoteTmuxSession({
        target: 'user@host',
        cli: 'claude',
        sessionName: 'bad name; rm',
      }),
    ).rejects.toThrow('invalid tmux session name');
  });

  it('rejects an unsupported cli', async () => {
    await expect(
      createRemoteTmuxSession({
        target: 'user@host',
        // @ts-expect-error deliberately invalid at the boundary
        cli: 'rm',
      }),
    ).rejects.toThrow('unsupported remote cli');
  });

  it('spawns ssh with an allowlisted environment that excludes app secrets', async () => {
    vi.stubEnv('NEXUS_REMOTE_TEST_SECRET', 'must-not-reach-ssh');

    await detectRemoteClis('dev@example.com');

    expect(harness.execFile).toHaveBeenCalledOnce();
    const options = harness.execFile.mock.calls[0]?.[2] as {
      env: NodeJS.ProcessEnv;
    };
    expect(options.env.PATH).toBeTruthy();
    expect(options.env.HOME).toBe(process.env.HOME);
    expect(options.env).not.toHaveProperty('NEXUS_REMOTE_TEST_SECRET');
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('carries cancellation into SSH and exactly cleans a session revoked after creation', async () => {
    let revoked = false;
    harness.execFile
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: Record<string, unknown>,
          callback: (
            error: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          revoked = true;
          callback(null, {
            stdout: 'NEXUS_REMOTE_TMUX_CREATED\n',
            stderr: '',
          });
        },
      )
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: Record<string, unknown>,
          callback: (
            error: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) =>
          callback(null, {
            stdout: 'NEXUS_REMOTE_TMUX_CLEANED\n',
            stderr: '',
          }),
      );
    const controller = new AbortController();

    await expect(
      createRemoteTmuxSession(
        {
          target: 'dev@example.com',
          cli: 'codex',
          sessionName: 'nexus-revoked',
        },
        {
          signal: controller.signal,
          assertCurrentAuthority: () => {
            if (revoked) throw new Error('session_authority_revoked');
          },
        },
      ),
    ).rejects.toThrow('session_authority_revoked');

    expect(harness.execFile).toHaveBeenCalledTimes(2);
    const startArgs = harness.execFile.mock.calls[0]?.[1] as string[];
    const startOptions = harness.execFile.mock.calls[0]?.[2] as {
      signal?: AbortSignal;
    };
    const cleanupArgs = harness.execFile.mock.calls[1]?.[1] as string[];
    const startScript = startArgs.at(-1) ?? '';
    const cleanupScript = cleanupArgs.at(-1) ?? '';
    const token = startScript.match(
      /@nexus_spawn_token '([0-9a-f]{48})'/,
    )?.[1];

    expect(startOptions.signal).toBe(controller.signal);
    expect(token).toBeTruthy();
    expect(cleanupScript).toContain(token);
    expect(cleanupScript).toContain('tmux kill-session');
  });

  it('fails explicitly when revocation cleanup cannot prove the exact remote exit', async () => {
    let revoked = false;
    harness.execFile
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: Record<string, unknown>,
          callback: (
            error: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          revoked = true;
          callback(null, {
            stdout: 'NEXUS_REMOTE_TMUX_CREATED\n',
            stderr: '',
          });
        },
      )
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: Record<string, unknown>,
          callback: (
            error: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) =>
          callback(new Error('ssh cleanup unavailable'), {
            stdout: '',
            stderr: '',
          }),
      );

    await expect(
      createRemoteTmuxSession(
        {
          target: 'dev@example.com',
          cli: 'codex',
          sessionName: 'nexus-cleanup-unknown',
        },
        {
          assertCurrentAuthority: () => {
            if (revoked) throw new Error('session_authority_revoked');
          },
        },
      ),
    ).rejects.toThrow(
      /effectMayHaveCommitted: remote tmux creation outcome or exact cleanup was not proven/,
    );
  });

  it('attempts token-scoped cleanup when the start acknowledgement is lost', async () => {
    harness.execFile
      .mockImplementationOnce(
        (_file, _args, _options, callback) =>
          callback(null, { stdout: 'unexpected output\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_file, _args, _options, callback) =>
          callback(null, {
            stdout: 'NEXUS_REMOTE_TMUX_CLEANED\n',
            stderr: '',
          }),
      );

    await expect(createRemoteTmuxSession({
      target: 'dev@example.com',
      cli: 'codex',
      sessionName: 'nexus-ack-lost',
    })).resolves.toMatchObject({
      ok: false,
      error: 'remote tmux creation acknowledgement is invalid',
    });
    expect(harness.execFile).toHaveBeenCalledTimes(2);
    expect((harness.execFile.mock.calls[1]?.[1] as string[]).at(-1)).toContain(
      'tmux kill-session',
    );
  });

  it('marks prompt delivery to an adopted session as possibly committed', async () => {
    harness.execFile
      .mockImplementationOnce(
        (_file, _args, _options, callback) =>
          callback(null, {
            stdout: 'NEXUS_REMOTE_TMUX_ADOPTED\n',
            stderr: '',
          }),
      )
      .mockImplementationOnce(
        (_file, _args, _options, callback) =>
          callback(new Error('ssh dropped after send-keys'), {
            stdout: '',
            stderr: '',
          }),
      );

    await expect(createRemoteTmuxSession({
      target: 'dev@example.com',
      cli: 'codex',
      sessionName: 'nexus-adopted',
      prompt: 'deploy now',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(
        'effectMayHaveCommitted: prompt delivery outcome was not proven',
      ),
    });
    expect(harness.execFile).toHaveBeenCalledTimes(2);
  });
});
