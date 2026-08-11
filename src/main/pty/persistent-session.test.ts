import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPersistentSessionWarningsForTests,
  createPersistentSessionBackend,
  planPersistentAgentSpawn,
  tmuxEnvArgs,
  tmuxSessionName,
  tmuxTarget,
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

describe('tmuxTarget / tmuxEnvArgs', () => {
  it('uses exact-match targets', () => {
    expect(tmuxTarget('nexus-a')).toBe('=nexus-a');
  });

  it('builds -e pairs and drops invalid keys', () => {
    expect(
      tmuxEnvArgs({
        HOME: '/tmp/home',
        'bad-key': 'x',
        PATH: '/bin',
      }),
    ).toEqual(['-e', 'HOME=/tmp/home', '-e', 'PATH=/bin']);
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
    expect(runner).toHaveBeenCalledWith(
      ['has-session', '-t', '=nexus-a'],
      { timeoutMs: 2_000 },
    );
  });

  it('creates a detached session with env when missing', async () => {
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
        env: { HOME: '/tmp/home', ANTHROPIC_API_KEY: 'secret' },
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
        '-e',
        'HOME=/tmp/home',
        '-e',
        'ANTHROPIC_API_KEY=secret',
        'claude',
        '--foo',
      ],
      { timeoutMs: 10_000 },
    );
  });

  it('builds attach args with exact target', () => {
    const backend = createPersistentSessionBackend(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
    }));
    expect(backend.attachArgs('nexus-a')).toEqual({
      file: 'tmux',
      args: ['attach-session', '-t', '=nexus-a'],
    });
  });

  it('kills a named session with exact target', async () => {
    const runner = vi.fn<TmuxRunner>().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const backend = createPersistentSessionBackend(runner, 'darwin');
    await backend.killSession('nexus-a');
    expect(runner).toHaveBeenCalledWith(
      ['kill-session', '-t', '=nexus-a'],
      { timeoutMs: 5_000 },
    );
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
  beforeEach(() => {
    __resetPersistentSessionWarningsForTests();
  });

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

  it('creates tmux session with env and returns attach args', () => {
    const sync = vi.fn<TmuxRunnerSync>((args) => {
      if (args[0] === '-V') {
        return { code: 0, stdout: 'tmux 3.4', stderr: '' };
      }
      if (args[0] === 'has-session') {
        return { code: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'new-session') {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    });
    const backend = createPersistentSessionBackend(
      async () => ({ code: 0, stdout: '', stderr: '' }),
      'darwin',
      sync,
    );
    const onMissing = vi.fn();
    const plan = planPersistentAgentSpawn({
      enabled: true,
      workspaceId: '/ws',
      paneId: 'pane-1',
      cwd: '/ws',
      file: '/bin/claude',
      args: ['--foo'],
      env: { HOME: '/tmp/h' },
      sealedNative: false,
      backend,
      onMissingSession: onMissing,
    });
    expect(plan.mode).toBe('tmux');
    expect(plan.file).toBe('tmux');
    expect(plan.args).toEqual([
      'attach-session',
      '-t',
      expect.stringMatching(/^=nexus-/),
    ]);
    expect(plan.tmuxName).toMatch(/^nexus-/);
    expect(plan.reattached).toBe(false);
    expect(onMissing).toHaveBeenCalledWith(plan.tmuxName);
    expect(sync).toHaveBeenCalledWith(
      expect.arrayContaining(['-e', 'HOME=/tmp/h', '/bin/claude', '--foo']),
      { timeoutMs: 10_000 },
    );
  });

  it('reattaches without recreating when session exists', () => {
    const sync = vi
      .fn<TmuxRunnerSync>()
      .mockReturnValueOnce({ code: 0, stdout: 'tmux 3.4', stderr: '' })
      .mockReturnValueOnce({ code: 0, stdout: '', stderr: '' }); // has-session
    const backend = createPersistentSessionBackend(
      async () => ({ code: 0, stdout: '', stderr: '' }),
      'darwin',
      sync,
    );
    const onMissing = vi.fn();
    const plan = planPersistentAgentSpawn({
      enabled: true,
      workspaceId: '/ws',
      paneId: 'pane-1',
      cwd: '/ws',
      file: '/bin/claude',
      args: [],
      sealedNative: false,
      backend,
      onMissingSession: onMissing,
    });
    expect(plan.mode).toBe('tmux');
    expect(plan.reattached).toBe(true);
    expect(onMissing).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
