/**
 * Background process MCP tools — grok-build background-tasks pattern,
 * built on the existing sandboxed terminal runner.
 */
import type { McpToolDef } from './mcp-protocol';
import { requireStr, str } from './tool-util';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { resolveCwdForScope } from './workspace-path';
import { executionScopeFor } from './gate';
import {
  buildScopedShellPlan,
  createScopedSandboxHome,
  type SandboxProfile,
} from '../runtime/process-sandbox';
import { emitBgTaskEvent } from './bg-task-events';

interface BgTask {
  id: string;
  command: string;
  proc: ChildProcess;
  projectId: string;
  checkoutId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  killTree: (signal: NodeJS.Signals) => void;
}

const bgTasks = new Map<string, BgTask>();
let bgCounter = 0;
const OUTPUT_CAP = 512 * 1024;
/** Soft cap so exited tasks cannot grow unbounded in a long-lived main process. */
const BG_TASK_MAP_MAX = 64;
const BG_TASK_RETAIN_MS = 10 * 60_000;

function pruneBgTasks(now = Date.now()): void {
  for (const [id, task] of bgTasks) {
    if (task.exitCode === null) continue;
    const ended = task.endedAt ?? task.startedAt;
    if (now - ended > BG_TASK_RETAIN_MS) bgTasks.delete(id);
  }
  if (bgTasks.size <= BG_TASK_MAP_MAX) return;
  const exited = [...bgTasks.entries()]
    .filter(([, t]) => t.exitCode !== null)
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
  handler: async (args, ctx) => {
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
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      throw error;
    }
    const proc = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: plan.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const id = `bg-${++bgCounter}`;
    const task: BgTask = {
      id,
      command,
      proc,
      projectId: ctx.scope.projectId,
      checkoutId: ctx.scope.checkoutId,
      stdout: '',
      stderr: '',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      killTree: (signal) => signalTree(proc, signal),
    };
    pruneBgTasks();
    bgTasks.set(id, task);
    proc.stdout?.on('data', (c) => {
      task.stdout = appendCap(task.stdout, c);
    });
    proc.stderr?.on('data', (c) => {
      task.stderr = appendCap(task.stderr, c);
    });
    emitBgTaskEvent({
      taskId: id,
      command,
      status: 'started',
      exitCode: null,
      projectId: task.projectId,
      checkoutId: task.checkoutId,
      at: task.startedAt,
    });
    proc.on('close', (code) => {
      task.exitCode = code;
      task.endedAt = Date.now();
      emitBgTaskEvent({
        taskId: id,
        command,
        status: 'exited',
        exitCode: code,
        projectId: task.projectId,
        checkoutId: task.checkoutId,
        at: task.endedAt,
      });
      pruneBgTasks();
      setTimeout(() => {
        fs.rmSync(sandbox.dir, { recursive: true, force: true });
      }, 50);
    });
    proc.on('error', () => {
      task.exitCode = -1;
      task.endedAt = Date.now();
      emitBgTaskEvent({
        taskId: id,
        command,
        status: 'exited',
        exitCode: -1,
        projectId: task.projectId,
        checkoutId: task.checkoutId,
        at: task.endedAt,
      });
      pruneBgTasks();
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
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
    if (
      task.projectId !== ctx.scope.projectId ||
      task.checkoutId !== ctx.scope.checkoutId
    ) {
      return { ok: false, error: 'task belongs to another project scope' };
    }
    const timeoutMs =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.min(Math.max(0, Math.floor(args.timeoutMs)), 120_000)
        : 0;
    if (timeoutMs > 0 && task.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const onClose = () => {
          clearTimeout(timer);
          resolve();
        };
        task.proc.once('close', onClose);
        if (task.exitCode !== null) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    return {
      ok: true,
      taskId: task.id,
      command: task.command,
      status: task.exitCode === null ? 'running' : 'exited',
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
  handler: async (args, ctx) => {
    const taskId = requireStr(args, 'taskId');
    const task = bgTasks.get(taskId);
    if (!task) return { killed: false, reason: 'not found' };
    if (
      task.projectId !== ctx.scope.projectId ||
      task.checkoutId !== ctx.scope.checkoutId
    ) {
      return { killed: false, reason: 'wrong scope' };
    }
    task.killTree('SIGTERM');
    setTimeout(() => {
      if (task.exitCode === null) task.killTree('SIGKILL');
    }, 3_000);
    emitBgTaskEvent({
      taskId,
      command: task.command,
      status: 'killed',
      exitCode: task.exitCode,
      projectId: task.projectId,
      checkoutId: task.checkoutId,
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
          t.projectId === ctx.scope.projectId &&
          t.checkoutId === ctx.scope.checkoutId,
      )
      .map((t) => ({
        taskId: t.id,
        command: t.command.slice(0, 200),
        status: t.exitCode === null ? 'running' : 'exited',
        exitCode: t.exitCode,
        startedAt: t.startedAt,
      }));
    return { tasks };
  },
};

export function buildBgTools(): McpToolDef[] {
  return [bgRun, bgWait, bgKill, bgList];
}
