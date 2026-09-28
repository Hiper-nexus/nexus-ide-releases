/**
 * Background process MCP tools — grok-build background-tasks pattern,
 * built on the existing sandboxed terminal runner.
 */
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
} from './mcp-protocol';
import { requireStr, str } from './tool-util';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveCwdForScope } from './workspace-path';
import { executionScopeFor } from './gate';
import {
  buildScopedShellPlan,
  createScopedSandboxHome,
  type SandboxProfile,
} from '../runtime/process-sandbox';
import { assertGovernedWorkspaceControlBoundary } from './governed-workspace-control-boundary';
import { emitBgTaskEvent } from './bg-task-events';
import { sameProjectScope } from './project-scoped-broadcast';
import type { ProjectExecutionScope } from '../../shared/types';
import { removeTreeSync } from '../util/remove-tree';

interface BgTask {
  id: string;
  command: string;
  proc: ChildProcess;
  scope: Readonly<ProjectExecutionScope>;
  ownerToken: string;
  ownerSessionId: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  state: 'running' | 'terminating' | 'exited';
  authorityRevoked: boolean;
  terminationRequested: boolean;
  finalized: boolean;
  startedAt: number;
  endedAt: number | null;
  killTree: (signal: NodeJS.Signals) => void;
  forceKillTimer: NodeJS.Timeout | null;
  detachOutputListeners: () => void;
  detachAbortListener: () => void;
  physicalExit: Promise<void>;
  resolvePhysicalExit: () => void;
}

const bgTasks = new Map<string, BgTask>();
let bgCounter = 0;
const OUTPUT_CAP = 512 * 1024;
/** Soft cap so exited tasks cannot grow unbounded in a long-lived main process. */
const BG_TASK_MAP_MAX = 64;
const BG_TASK_RETAIN_MS = 10 * 60_000;

function pruneBgTasks(now = Date.now()): void {
  for (const [id, task] of bgTasks) {
    if (task.state !== 'exited') continue;
    const ended = task.endedAt ?? task.startedAt;
    if (now - ended > BG_TASK_RETAIN_MS) bgTasks.delete(id);
  }
  if (bgTasks.size <= BG_TASK_MAP_MAX) return;
  const exited = [...bgTasks.entries()]
    .filter(([, t]) => t.state === 'exited')
    .sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0));
  while (bgTasks.size > BG_TASK_MAP_MAX && exited.length > 0) {
    const [id] = exited.shift()!;
    bgTasks.delete(id);
  }
}

function signalTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  try {
    if (process.platform === 'win32') proc.kill(signal);
    else process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // already gone
    }
  }
}

function appendCap(prev: string, chunk: Buffer | string): string {
  const next = prev + (Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
  if (next.length <= OUTPUT_CAP) return next;
  return `${next.slice(0, OUTPUT_CAP)}\n...[TRUNCATED]`;
}

function isSameTaskOwner(
  task: BgTask,
  ctx: { token: string; sessionId?: string },
): boolean {
  return (
    task.ownerToken === ctx.token &&
    task.ownerSessionId === (ctx.sessionId ?? null)
  );
}

function isSameTaskScope(
  task: BgTask,
  ctx: {
    scope: ProjectExecutionScope;
    executionScope?: ProjectExecutionScope;
  },
): boolean {
  return sameProjectScope(task.scope, executionScopeFor(ctx));
}

function requestTaskTermination(task: BgTask, revoked: boolean): void {
  if (task.state === 'exited') return;
  task.authorityRevoked ||= revoked;
  task.state = 'terminating';
  if (revoked) task.detachOutputListeners();
  if (task.terminationRequested) return;
  task.terminationRequested = true;
  task.killTree('SIGTERM');
  task.forceKillTimer = setTimeout(() => {
    if (task.state !== 'exited') task.killTree('SIGKILL');
  }, 3_000);
  task.forceKillTimer.unref?.();
}

async function waitForTaskTeardown(task: BgTask): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      task.physicalExit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'session_authority_revoked; physical process exit not proven',
              ),
            ),
          5_000,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const bgRun: McpToolDef = {
  name: 'nexus_bg_run',
  description:
    'Start a shell command in the background (dev servers, long tests, builds). ' +
    'Returns taskId immediately. Poll with nexus_bg_wait / kill with nexus_bg_kill. ' +
    'Sandboxed to the workspace like nexus_terminal_run.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      sandboxProfile: {
        type: 'string',
        enum: ['workspace-only', 'workspace-net', 'yolo'],
      },
    },
    required: ['command'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    assertGovernedWorkspaceControlBoundary(ctx, bgRun.name);
    const executionScope = executionScopeFor(ctx);
    const command = requireStr(args, 'command');
    const cwd = resolveCwdForScope(executionScope, str(args, 'cwd'));
    const rawProfile = str(args, 'sandboxProfile');
    const sandboxProfile: SandboxProfile | undefined =
      rawProfile === 'workspace-only' ||
      rawProfile === 'workspace-net' ||
      rawProfile === 'yolo'
        ? rawProfile
        : 'workspace-net'; // bg often runs dev servers / installs
    const sandbox = createScopedSandboxHome(executionScope);
    let plan;
    try {
      plan = buildScopedShellPlan({
        platform: process.platform,
        command,
        cwd,
        rootRealPath: executionScope.rootRealPath,
        sandboxDir: sandbox.dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          USER: process.env.USER,
          SHELL: process.env.SHELL,
        },
        sandboxProfile,
      });
    } catch (error) {
      removeTreeSync(sandbox.dir, { recursive: true, force: true });
      throw error;
    }
    let proc: ChildProcess;
    try {
      // Linearization point after all path/sandbox preparation.
      assertMcpInvocationCurrent(invocation);
      proc = spawn(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        detached: plan.detached,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      removeTreeSync(sandbox.dir, { recursive: true, force: true });
      throw error;
    }
    const id = `bg-${++bgCounter}`;
    let resolvePhysicalExit!: () => void;
    const physicalExit = new Promise<void>((resolve) => {
      resolvePhysicalExit = resolve;
    });
    const task: BgTask = {
      id,
      command,
      proc,
      scope: Object.freeze({ ...executionScope }),
      ownerToken: ctx.token,
      ownerSessionId: ctx.sessionId ?? null,
      stdout: '',
      stderr: '',
      exitCode: null,
      state: 'running',
      authorityRevoked: false,
      terminationRequested: false,
      finalized: false,
      startedAt: Date.now(),
      endedAt: null,
      killTree: (signal) => signalTree(proc, signal),
      forceKillTimer: null,
      detachOutputListeners: () => {},
      detachAbortListener: () => {},
      physicalExit,
      resolvePhysicalExit,
    };
    const onStdout = (chunk: Buffer | string) => {
      if (!task.authorityRevoked) {
        task.stdout = appendCap(task.stdout, chunk);
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      if (!task.authorityRevoked) {
        task.stderr = appendCap(task.stderr, chunk);
      }
    };
    task.detachOutputListeners = () => {
      proc.stdout?.removeListener('data', onStdout);
      proc.stderr?.removeListener('data', onStderr);
    };
    const onAuthorityRevoked = () => {
      requestTaskTermination(task, true);
    };
    task.detachAbortListener = () => {
      invocation?.signal?.removeEventListener(
        'abort',
        onAuthorityRevoked,
      );
    };
    const finalize = (code: number | null, error = false) => {
      if (task.finalized) return;
      task.finalized = true;
      // A shell may close after daemonizing a child. Keep the detached group
      // under Nexus ownership until every descendant receives termination.
      task.killTree(task.terminationRequested ? 'SIGKILL' : 'SIGTERM');
      task.state = 'exited';
      task.exitCode = error ? -1 : code;
      task.endedAt = Date.now();
      if (task.forceKillTimer) clearTimeout(task.forceKillTimer);
      task.detachAbortListener();
      task.detachOutputListeners();
      task.resolvePhysicalExit();
      emitBgTaskEvent({
        taskId: id,
        command,
        status: 'exited',
        exitCode: task.exitCode,
        projectId: task.scope.projectId,
        checkoutId: task.scope.checkoutId,
        scope: task.scope,
        at: task.endedAt,
      });
      pruneBgTasks();
      try {
        removeTreeSync(sandbox.dir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('[bg-task] sandbox cleanup failed:', cleanupError);
      }
    };

    pruneBgTasks();
    bgTasks.set(id, task);
    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.once('close', (code) => finalize(code));
    proc.once('error', () => finalize(null, true));
    invocation?.signal?.addEventListener(
      'abort',
      onAuthorityRevoked,
      { once: true },
    );
    if (invocation?.signal?.aborted) onAuthorityRevoked();

    // Yield one microtask so a revocation racing the spawn cannot receive an
    // operational task id. The task stays internally owned until close/error.
    await Promise.resolve();
    try {
      assertMcpInvocationCurrent(invocation);
    } catch {
      onAuthorityRevoked();
      await waitForTaskTeardown(task);
      throw new Error('session_authority_revoked');
    }
    if (task.authorityRevoked) {
      await waitForTaskTeardown(task);
      throw new Error('session_authority_revoked');
    }
    if (task.state === 'exited') {
      throw new Error('background process exited before start confirmation');
    }

    emitBgTaskEvent({
      taskId: id,
      command,
      status: 'started',
      exitCode: null,
      projectId: task.scope.projectId,
      checkoutId: task.scope.checkoutId,
      scope: task.scope,
      at: task.startedAt,
    });
    return {
      taskId: id,
      command,
      status: 'running',
      message: 'Background task started. Use nexus_bg_wait to poll.',
    };
  },
};

const bgWait: McpToolDef = {
  name: 'nexus_bg_wait',
  description:
    'Get status/output of a background task from nexus_bg_run. ' +
    'Optional timeoutMs waits for exit (default 0 = poll only).',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      timeoutMs: { type: 'number' },
    },
    required: ['taskId'],
  },
  handler: async (args, ctx) => {
    const taskId = requireStr(args, 'taskId');
    const task = bgTasks.get(taskId);
    if (!task) {
      return { ok: false, error: `unknown taskId ${taskId}` };
    }
    if (!isSameTaskScope(task, ctx)) {
      return { ok: false, error: 'task belongs to another project scope' };
    }
    if (!isSameTaskOwner(task, ctx)) {
      return {
        ok: false,
        error: 'task belongs to another MCP session authority',
      };
    }
    if (task.authorityRevoked) {
      return { ok: false, error: 'session_authority_revoked' };
    }
    const timeoutMs =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.min(Math.max(0, Math.floor(args.timeoutMs)), 120_000)
        : 0;
    if (timeoutMs > 0 && task.state !== 'exited') {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          task.proc.removeListener('close', finish);
          task.proc.removeListener('error', finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        task.proc.once('close', finish);
        task.proc.once('error', finish);
        if (task.state === 'exited') finish();
      });
    }
    if (task.authorityRevoked) {
      return { ok: false, error: 'session_authority_revoked' };
    }
    return {
      ok: true,
      taskId: task.id,
      command: task.command,
      status: task.state === 'exited' ? 'exited' : 'running',
      exitCode: task.exitCode,
      stdout: task.stdout,
      stderr: task.stderr,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
    };
  },
};

const bgKill: McpToolDef = {
  name: 'nexus_bg_kill',
  description: 'Terminate a background task started with nexus_bg_run.',
  inputSchema: {
    type: 'object',
    properties: { taskId: { type: 'string' } },
    required: ['taskId'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const taskId = requireStr(args, 'taskId');
    const task = bgTasks.get(taskId);
    if (!task) return { killed: false, reason: 'not found' };
    if (!isSameTaskScope(task, ctx)) {
      return { killed: false, reason: 'wrong scope' };
    }
    if (!isSameTaskOwner(task, ctx)) {
      return { killed: false, reason: 'another MCP session authority owns task' };
    }
    if (task.authorityRevoked) {
      return { killed: false, reason: 'session_authority_revoked' };
    }
    if (task.state === 'exited') {
      return { killed: false, reason: 'task already exited' };
    }
    assertMcpInvocationCurrent(invocation);
    requestTaskTermination(task, false);
    emitBgTaskEvent({
      taskId,
      command: task.command,
      status: 'killed',
      exitCode: task.exitCode,
      projectId: task.scope.projectId,
      checkoutId: task.scope.checkoutId,
      scope: task.scope,
      at: Date.now(),
    });
    return { killed: true, taskId };
  },
};

const bgList: McpToolDef = {
  name: 'nexus_bg_list',
  description: 'List background tasks for this project checkout.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const tasks = [...bgTasks.values()]
      .filter(
        (t) =>
          isSameTaskScope(t, ctx) &&
          isSameTaskOwner(t, ctx) &&
          !t.authorityRevoked,
      )
      .map((t) => ({
        taskId: t.id,
        command: t.command.slice(0, 200),
        status: t.state === 'exited' ? 'exited' : 'running',
        exitCode: t.exitCode,
        startedAt: t.startedAt,
      }));
    return { tasks };
  },
};

export function buildBgTools(): McpToolDef[] {
  return [bgRun, bgWait, bgKill, bgList];
}
