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
  delete process.env.NEXUS_REMOTE_TEST_SECRET;
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
    process.env.NEXUS_REMOTE_TEST_SECRET = 'must-not-reach-ssh';

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
});
