import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';

const harness = vi.hoisted(() => {
  let nextProcess: unknown;
  let onBuildPlan: (() => void) | undefined;
  let onSpawn: (() => void) | undefined;
  return {
    spawn: vi.fn(() => {
      if (!nextProcess) throw new Error('missing fake child process');
      const process = nextProcess;
      nextProcess = undefined;
      onSpawn?.();
      return process;
    }),
    buildScopedShellPlan: vi.fn(() => {
      onBuildPlan?.();
      return {
        file: '/bin/sh',
        args: ['-lc', 'test command'],
        cwd: '/workspace/effects',
        env: {},
        detached: true,
      };
    }),
    createScopedSandboxHome: vi.fn(() => ({
      dir: '/tmp/nexus-effect-authority-nonexistent',
      home: '/tmp/nexus-effect-authority-nonexistent/home',
      tmp: '/tmp/nexus-effect-authority-nonexistent/tmp',
    })),
    resolveCwdForScope: vi.fn(() => '/workspace/effects'),
    setProcess(process: unknown) {
      nextProcess = process;
    },
    setBuildHook(hook: (() => void) | undefined) {
      onBuildPlan = hook;
    },
    setSpawnHook(hook: (() => void) | undefined) { onSpawn = hook; },
    stopOwned: vi.fn((child: { kill(signal: NodeJS.Signals): void }, signal: NodeJS.Signals) => child.kill(signal)),
  };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: harness.spawn,
}));

vi.mock('../runtime/process-sandbox', () => ({
  buildScopedShellPlan: harness.buildScopedShellPlan,
  createScopedSandboxHome: harness.createScopedSandboxHome,
}));

vi.mock('./workspace-path', () => ({
  resolveCwdForScope: harness.resolveCwdForScope,
}));
vi.mock('./owned-command-launch', async () => ({ prepareOwnedCommandLaunch: async (plan: import('../runtime/process-sandbox').ScopedShellPlan) => ({
  ...await (await import('./__tests__/owned-command-fixture')).groupFixtureLaunch(plan), stop: harness.stopOwned,
}) }));

import { buildTerminalTools } from './tools-terminal';
import { buildBgTools } from './tools-bg';

class FakeReadable extends EventEmitter {}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly pid: number;
  exitCode: number | null = null;
  readonly kill = vi.fn();

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  close(code: number | null): void {
    this.exitCode = code;
    this.emit('close', code);
  }
}

class CountingAbortSignal {
  aborted = false;
  reason: unknown;
  addCount = 0;
  removeCount = 0;
  readonly #listeners = new Set<() => void>();

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type !== 'abort') return;
    this.addCount += 1;
    const callback =
      typeof listener === 'function'
        ? () => listener(new Event('abort'))
        : () => listener.handleEvent(new Event('abort'));
    this.#listeners.add(callback);
  }

  removeEventListener(type: string): void {
    if (type !== 'abort') return;
    this.removeCount += 1;
    this.#listeners.clear();
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = new Error('session_authority_revoked');
    for (const listener of [...this.#listeners]) listener();
  }
}

function ctx(
  token = 'token-owner',
  sessionId = 'session-owner',
): AgentGateContext {
  return {
    token,
    label: token,
    role: 'user',
    sessionId,
    scope: {
      version: 1,
      installationId: 'installation-effects',
      projectId: 'project-effects',
      checkoutId: 'checkout-effects',
      rootRealPath: '/workspace/effects',
      identitySource: 'manifest',
    },
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(
  tools: ReturnType<typeof buildTerminalTools> | ReturnType<typeof buildBgTools>,
  name: string,
) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function expectTreeSignal(
  _processKill: unknown,
  child: FakeChildProcess,
  signal: NodeJS.Signals,
): void {
  expect(harness.stopOwned).toHaveBeenCalledWith(child, signal);
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.setBuildHook(undefined);
  harness.setSpawnHook(undefined);
});

describe('effectful process invocation authority', () => {
  it('terminal revalidates immediately before spawn and creates no process after revocation', async () => {
    const controller = new AbortController();
    harness.setBuildHook(() => controller.abort());
    const run = tool(buildTerminalTools(), 'nexus_terminal_run');

    await expect(
      run.handler(
        { command: 'late write' },
        ctx(),
        { signal: controller.signal, assertCurrentAuthority: vi.fn() },
      ),
    ).rejects.toThrow(/session_authority_revoked/i);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it('terminal abort rejects, removes output listeners and TERM→KILLs the process group', async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = new FakeChildProcess(41001);
      harness.setProcess(child);
      const controller = new AbortController();
      harness.setSpawnHook(() => controller.abort());
      const run = tool(buildTerminalTools(), 'nexus_terminal_run');
      const flight = run.handler(
        { command: 'write-after-revoke', timeoutMs: 60_000 },
        ctx(),
        { signal: controller.signal, assertCurrentAuthority: vi.fn() },
      );

      await vi.waitFor(() => expect(harness.stopOwned).toHaveBeenCalled());
      expectTreeSignal(processKill, child, 'SIGTERM');
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.stderr.listenerCount('data')).toBe(0);

      child.stdout.emit('data', Buffer.from('must not be retained'));
      await vi.advanceTimersByTimeAsync(3_000);
      expectTreeSignal(processKill, child, 'SIGKILL');
      child.close(null);
      await expect(flight).rejects.toThrow(/session_authority_revoked/i);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('terminal fails explicitly when physical exit proof never arrives', async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = new FakeChildProcess(41004);
      harness.setProcess(child);
      const controller = new AbortController();
      harness.setSpawnHook(() => controller.abort());
      const flight = tool(
        buildTerminalTools(),
        'nexus_terminal_run',
      ).handler(
        { command: 'stubborn process', timeoutMs: 60_000 },
        ctx('token-stubborn', 'session-stubborn'),
        { signal: controller.signal, assertCurrentAuthority: vi.fn() },
      );

      const rejected = expect(flight).rejects.toThrow(
        /session_authority_revoked.*physical process exit not proven/i,
      );
      await vi.waitFor(() => expect(harness.stopOwned).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expectTreeSignal(processKill, child, 'SIGTERM');
      expectTreeSignal(processKill, child, 'SIGKILL');
      child.close(null);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('terminal timeout fails explicitly when physical exit proof never arrives', async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = new FakeChildProcess(41007);
      harness.setProcess(child);
      const flight = tool(buildTerminalTools(), 'nexus_terminal_run').handler(
        { command: 'stubborn timeout process', timeoutMs: 1 },
        ctx('token-timeout', 'session-timeout'),
        { assertCurrentAuthority: vi.fn() },
      );

      const rejected = expect(flight).rejects.toThrow(
        /terminal_timeout.*physical process exit not proven/i,
      );
      await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(5_001);
      await rejected;
      expectTreeSignal(processKill, child, 'SIGTERM');
      expectTreeSignal(processKill, child, 'SIGKILL');
      child.close(null);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('terminal kill cannot cross an exact-scope root collision', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = new FakeChildProcess(41008);
      harness.setProcess(child);
      const owner = ctx('token-terminal-scope', 'session-terminal-scope');
      const tools = buildTerminalTools();
      const flight = tool(tools, 'nexus_terminal_run').handler(
        { command: 'scope-bound process' },
        owner,
        { assertCurrentAuthority: vi.fn() },
      );
      await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce());
      const foreign = {
        ...owner,
        scope: {
          ...owner.scope,
          installationId: 'installation-foreign',
          rootRealPath: '/workspace/foreign',
        },
      };

      await expect(
        tool(tools, 'nexus_terminal_kill').handler({}, foreign, {
          assertCurrentAuthority: vi.fn(),
        }),
      ).resolves.toMatchObject({ killed: false });
      expect(child.exitCode).toBeNull();
      child.close(0);
      await expect(flight).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      processKill.mockRestore();
    }
  });

  it('bg run revoked during preparation creates no process or visible task', async () => {
    const controller = new AbortController();
    harness.setBuildHook(() => controller.abort());
    const tools = buildBgTools();

    await expect(
      tool(tools, 'nexus_bg_run').handler(
        { command: 'late background write' },
        ctx(),
        { signal: controller.signal, assertCurrentAuthority: vi.fn() },
      ),
    ).rejects.toThrow(/session_authority_revoked/i);
    expect(harness.spawn).not.toHaveBeenCalled();
    await expect(tool(tools, 'nexus_bg_list').handler({}, ctx())).resolves.toEqual({
      tasks: [],
    });
  });

  it('bg abort before return exposes no operational task and TERM→KILLs its tree', async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = new FakeChildProcess(41002);
      harness.setProcess(child);
      const controller = new AbortController();
      harness.setSpawnHook(() => controller.abort());
      const tools = buildBgTools();
      const flight = tool(tools, 'nexus_bg_run').handler(
        { command: 'deferred background write' },
        ctx('token-bg-abort', 'session-bg-abort'),
        { signal: controller.signal, assertCurrentAuthority: vi.fn() },
      );

      await vi.waitFor(() => expect(harness.stopOwned).toHaveBeenCalled());
      expectTreeSignal(processKill, child, 'SIGTERM');
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.stderr.listenerCount('data')).toBe(0);
      await expect(
        tool(tools, 'nexus_bg_list').handler(
          {},
          ctx('token-bg-abort', 'session-bg-abort'),
        ),
      ).resolves.toEqual({ tasks: [] });

      await vi.advanceTimersByTimeAsync(3_000);
      expectTreeSignal(processKill, child, 'SIGKILL');
      child.close(null);
      await expect(flight).rejects.toThrow(/session_authority_revoked/i);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps background task operations bound to the exact token and session', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = new FakeChildProcess(41003);
      harness.setProcess(child);
      const tools = buildBgTools();
      const owner = ctx('token-bound', 'session-bound');
      const created = (await tool(tools, 'nexus_bg_run').handler(
        { command: 'owned server' },
        owner,
      )) as { taskId: string };
      const other = ctx('token-other', 'session-other');

      await expect(
        tool(tools, 'nexus_bg_wait').handler(
          { taskId: created.taskId },
          other,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/another session|authority/i),
      });
      await expect(
        tool(tools, 'nexus_bg_kill').handler(
          { taskId: created.taskId },
          other,
        ),
      ).resolves.toMatchObject({ killed: false });
      await expect(
        tool(tools, 'nexus_bg_list').handler({}, other),
      ).resolves.toEqual({ tasks: [] });

      await expect(
        tool(tools, 'nexus_bg_wait').handler(
          { taskId: created.taskId },
          owner,
        ),
      ).resolves.toMatchObject({ ok: true, status: 'running' });
      child.close(0);
    } finally {
      processKill.mockRestore();
    }
  });

  it('keeps background tasks bound to installation and canonical root', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = new FakeChildProcess(41009);
      harness.setProcess(child);
      const tools = buildBgTools();
      const owner = ctx('token-bg-scope', 'session-bg-scope');
      const created = (await tool(tools, 'nexus_bg_run').handler(
        { command: 'scope-bound background' },
        owner,
        { assertCurrentAuthority: vi.fn() },
      )) as { taskId: string };
      const foreign = {
        ...owner,
        scope: {
          ...owner.scope,
          installationId: 'installation-foreign',
          rootRealPath: '/workspace/foreign',
        },
      };

      await expect(
        tool(tools, 'nexus_bg_wait').handler(
          { taskId: created.taskId },
          foreign,
        ),
      ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/scope/i) });
      await expect(tool(tools, 'nexus_bg_list').handler({}, foreign)).resolves.toEqual({
        tasks: [],
      });
      await expect(
        tool(tools, 'nexus_bg_kill').handler(
          { taskId: created.taskId },
          foreign,
          { assertCurrentAuthority: vi.fn() },
        ),
      ).resolves.toMatchObject({ killed: false, reason: 'wrong scope' });
      child.close(0);
    } finally {
      processKill.mockRestore();
    }
  });

  it('removes invocation and output listeners only after close proof', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const terminalChild = new FakeChildProcess(41005);
      harness.setProcess(terminalChild);
      const terminalSignal = new CountingAbortSignal();
      const terminalFlight = tool(
        buildTerminalTools(),
        'nexus_terminal_run',
      ).handler(
        { command: 'short terminal' },
        ctx('token-listener-terminal', 'session-listener-terminal'),
        {
          signal: terminalSignal as unknown as AbortSignal,
          assertCurrentAuthority: vi.fn(),
        },
      );
      await vi.waitFor(() => expect(terminalSignal.addCount).toBe(1));
      terminalChild.close(0);
      await expect(terminalFlight).resolves.toMatchObject({ exitCode: 0 });
      expect(terminalSignal.removeCount).toBe(1);
      expect(terminalChild.stdout.listenerCount('data')).toBe(0);

      const bgChild = new FakeChildProcess(41006);
      harness.setProcess(bgChild);
      const bgSignal = new CountingAbortSignal();
      await tool(buildBgTools(), 'nexus_bg_run').handler(
        { command: 'short background' },
        ctx('token-listener-bg', 'session-listener-bg'),
        {
          signal: bgSignal as unknown as AbortSignal,
          assertCurrentAuthority: vi.fn(),
        },
      );
      expect(bgSignal.addCount).toBe(1);
      bgChild.close(0);
      await vi.waitFor(() => expect(bgSignal.removeCount).toBe(1));
      expect(bgChild.stdout.listenerCount('data')).toBe(0);
    } finally {
      processKill.mockRestore();
    }
  });
});
