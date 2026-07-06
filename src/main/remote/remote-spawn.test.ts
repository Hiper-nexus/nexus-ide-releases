import { describe, expect, it } from 'vitest';
import {
  createRemoteTmuxSession,
  detectRemoteClis,
  listRemoteTmuxSessions,
} from './remote-spawn';

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
});
