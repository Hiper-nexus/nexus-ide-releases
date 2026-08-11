/**
 * Pure lifecycle contracts for quit=detach vs close=kill — keeps the
 * security-sensitive fence testable without the full pty-manager graph.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPersistentSessionBackend,
  type TmuxRunnerSync,
} from './persistent-session';

function maybeKillPersistentTmux(input: {
  persistentTmuxName: string | undefined;
  killPersistentOnFinalize: boolean | undefined;
  kill: (name: string) => void;
}): boolean {
  if (
    input.persistentTmuxName &&
    input.killPersistentOnFinalize !== false
  ) {
    input.kill(input.persistentTmuxName);
    return true;
  }
  return false;
}

describe('persistent session lifecycle contract', () => {
  it('close path kills the exact tmux session', () => {
    const sync = vi.fn<TmuxRunnerSync>().mockReturnValue({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const backend = createPersistentSessionBackend(
      async () => ({ code: 0, stdout: '', stderr: '' }),
      'darwin',
      sync,
    );
    const killed = maybeKillPersistentTmux({
      persistentTmuxName: 'nexus-ws-pane-1',
      killPersistentOnFinalize: true,
      kill: (name) => backend.killSessionSync(name),
    });
    expect(killed).toBe(true);
    expect(sync).toHaveBeenCalledWith(
      ['kill-session', '-t', '=nexus-ws-pane-1'],
      { timeoutMs: 5_000 },
    );
  });

  it('quit/detach path skips kill-session', () => {
    const sync = vi.fn<TmuxRunnerSync>().mockReturnValue({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const backend = createPersistentSessionBackend(
      async () => ({ code: 0, stdout: '', stderr: '' }),
      'darwin',
      sync,
    );
    const killed = maybeKillPersistentTmux({
      persistentTmuxName: 'nexus-ws-pane-1',
      killPersistentOnFinalize: false,
      kill: (name) => backend.killSessionSync(name),
    });
    expect(killed).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });
});
