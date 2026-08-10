import { describe, expect, it, vi } from 'vitest';
import {
  createPersistentSessionBackend,
  planPersistentAgentSpawn,
  tmuxSessionName,
  type TmuxRunner,
  type TmuxRunnerSync,
} from './persistent-session';

describe('tmuxSessionName', () => {
  it('sanitizes workspace and pane into a stable nexus name', () => {
    expect(tmuxSessionName('/Users/me/App', 'pane-1')).toBe(
      'nexus-Users-me-App-pane-1',
    );
  });

  it('caps length at 80 characters', () => {
    const name = tmuxSessionName('w'.repeat(100), 'p'.repeat(100));
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.startsWith('nexus-')).toBe(true);
  });
});

describe('createPersistentSessionBackend', () => {
  it('reports unavailable on win32 without calling tmux', async () => {
    const runner = vi.fn<TmuxRunner>();
    const backend = createPersistentSessionBackend(runner, 'win32');
    await expect(backend.probeAvailable()).resolves.toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('probes tmux -V on unix', async () => {
    const runner = vi.fn<TmuxRunner>().mockResolvedValue({
      code: 0,
      stdout: 'tmux 3.4',
      stderr: '',
    });
    const backend = createPersistentSessionBackend(runner, 'darwin');
    await expect(backend.probeAvailable()).resolves.toBe(true);
    expect(runner).toHaveBeenCalledWith(['-V'], { timeoutMs: 2_000 });
  });

  it('returns exists when has-session succeeds', async () => {
    const runner = vi.fn<TmuxRunner>().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const backend = createPersistentSessionBackend(runner, 'darwin');
    await expect(
      backend.ensureSession({
        name: 'nexus-a',
        cwd: '/tmp',
        command: 'claude',
        args: [],
      }),
    ).resolves.toBe('exists');
  });

  it('creates a detached session when missing', async () => {
    const runner = vi
      .fn<TmuxRunner>()
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const backend = createPersistentSessionBackend(runner, 'darwin');
    await expect(
      backend.ensureSession({
        name: 'nexus-a',
        cwd: '/tmp/proj',
        command: 'claude',
        args: ['--foo'],
      }),
    ).resolves.toBe('created');
    expect(runner).toHaveBeenLastCalledWith(
      [
        'new-session',
        '-d',
        '-s',
        'nexus-a',
        '-c',
        '/tmp/proj',
        'claude',
        '--foo',
      ],
      { timeoutMs: 10_000 },
    );
  });

  it('builds attach args for the PTY host', () => {
    const backend = createPersistentSessionBackend(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
    }));
    expect(backend.attachArgs('nexus-a')).toEqual({
      file: 'tmux',
      args: ['attach-session', '-t', 'nexus-a'],
    });
  });

  it('kills a named session', async () => {
    const runner = vi.fn<TmuxRunner>().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const backend = createPersistentSessionBackend(runner, 'darwin');
    await backend.killSession('nexus-a');
    expect(runner).toHaveBeenCalledWith(['kill-session', '-t', 'nexus-a'], {
      timeoutMs: 5_000,
    });
  });

  it('lists only nexus- prefixed sessions', async () => {
    const runner = vi.fn<TmuxRunner>().mockResolvedValue({
      code: 0,
      stdout: 'nexus-a\nother\nnexus-b\n',
      stderr: '',
    });
    const backend = createPersistentSessionBackend(runner, 'darwin');
    await expect(backend.listNexusSessions()).resolves.toEqual([
      'nexus-a',
      'nexus-b',
    ]);
  });
});

describe('planPersistentAgentSpawn', () => {
  it('stays direct when disabled, sealed, or missing pane', () => {
    const backend = createPersistentSessionBackend(
      async () => ({ code: 0, stdout: '', stderr: '' }),
      'darwin',
      () => ({ code: 0, stdout: '', stderr: '' }),
    );
    expect(
      planPersistentAgentSpawn({
        enabled: false,
        workspaceId: '/ws',
        paneId: 'p1',
        cwd: '/ws',
        file: '/bin/claude',
        args: [],
        sealedNative: false,
        backend,
      }).mode,
    ).toBe('direct');
    expect(
      planPersistentAgentSpawn({
        enabled: true,
        workspaceId: '/ws',
        paneId: 'p1',
        cwd: '/ws',
        file: '/bin/claude',
        args: [],
        sealedNative: true,
        backend,
      }).mode,
    ).toBe('direct');
    expect(
      planPersistentAgentSpawn({
        enabled: true,
        workspaceId: '/ws',
        paneId: undefined,
        cwd: '/ws',
        file: '/bin/claude',
        args: [],
        sealedNative: false,
        backend,
      }).mode,
    ).toBe('direct');
  });

  it('creates tmux session and returns attach args', () => {
    const sync = vi
      .fn<TmuxRunnerSync>()
      .mockReturnValueOnce({ code: 0, stdout: 'tmux 3.4', stderr: '' }) // -V
      .mockReturnValueOnce({ code: 1, stdout: '', stderr: '' }) // has-session
      .mockReturnValueOnce({ code: 0, stdout: '', stderr: '' }); // new-session
    const backend = createPersistentSessionBackend(
      async () => ({ code: 0, stdout: '', stderr: '' }),
      'darwin',
      sync,
    );
    const plan = planPersistentAgentSpawn({
      enabled: true,
      workspaceId: '/ws',
      paneId: 'pane-1',
      cwd: '/ws',
      file: '/bin/claude',
      args: ['--foo'],
      sealedNative: false,
      backend,
    });
    expect(plan.mode).toBe('tmux');
    expect(plan.file).toBe('tmux');
    expect(plan.args).toEqual([
      'attach-session',
      '-t',
      expect.stringMatching(/^nexus-/),
    ]);
    expect(plan.tmuxName).toMatch(/^nexus-/);
  });
});
