import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from './mcp-protocol';
import { requireStr, str } from './tool-util';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { isIsolatedWriterContext, parseIsolatedWriterGitCommand } from './isolated-writer-policy';
import { buildGitTools } from './tools-git';
import { resolveCwdForScope } from './workspace-path';
import type { ProjectExecutionScope } from '../../shared/types';
import { executionScopeFor } from './gate';
import {
  buildScopedShellPlan,
  createScopedSandboxHome,
  type SandboxProfile,
} from '../runtime/process-sandbox';
import { assertGovernedWorkspaceControlBoundary } from './governed-workspace-control-boundary';
import { getOrchSettings } from '../persistence/settings-store';
import {
  isOperatorChoicePolicy,
  type SquadCliPolicyMode,
} from '../../shared/squad-cli-policy';
import { triageCommandFailure } from '../jev/jev-terminal-triage';
import { removeTree } from '../util/remove-tree';
import { acquireHeavyCommandPermit, type HeavyCommandPermit } from './heavy-command-permit';
import { classifyHeavyCommand } from './heavy-command-classifier';
import { retainHeavyCommandPermitForProcess } from './heavy-command-process';
import { prepareOwnedCommandLaunch, type OwnedCommandLaunch } from './owned-command-launch';

/**
 * Terminal execution MCP tools for Jarvis agent.
 * Runs shell commands in the workspace directory with output streaming.
 */

interface ActiveProcess {
  proc: ChildProcess;
  installationId: string;
  projectId: string;
  checkoutId: string;
  rootRealPath: string;
  ownerToken: string;
  ownerSessionId: string | null;
  killTree: (signal: NodeJS.Signals) => void;
  killRequested: boolean;
}

const activeProcesses = new Map<string, ActiveProcess>();
let processCounter = 0;

const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'LANG', 'USER', 'SHELL']);
/**
 * O que o chamador da ferramenta pode sobrescrever. O PATH fica de fora: o
 * sandbox LIBERA A LEITURA dos diretórios do PATH (regras de toolchain no
 * Seatbelt, mounts no Bubblewrap). Com o PATH nas mãos de quem chama, um
 * agente pedia `env: { PATH: '~/.ssh' }` e o perfil abria o diretório que o
 * sandbox existe para esconder (F-733). O PATH é sempre o do operador; quem
 * precisa de outro dentro do comando usa `PATH=… comando` na própria linha,
 * que não muda o que o sandbox deixa ler.
 */
const CALLER_ENV_KEYS = new Set(['HOME', 'LANG', 'USER', 'SHELL']);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const OUTPUT_TRUNCATED_MARKER = '\n...[TRUNCATED: output exceeded 1048576 bytes]';

interface OutputBuffer {
  value: string;
  bytes: number;
  truncated: boolean;
}

export function sanitizeEnv(extraEnv: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
    for (const [key, value] of Object.entries(extraEnv as Record<string, unknown>)) {
      if (CALLER_ENV_KEYS.has(key) && typeof value === 'string') {
        env[key] = value;
      }
    }
  }
  return env;
}

function appendOutput(buffer: OutputBuffer, chunk: Buffer | string): void {
  if (buffer.truncated) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = OUTPUT_CAP_BYTES - buffer.bytes;
  if (bytes.length <= remaining) {
    buffer.value += bytes.toString();
    buffer.bytes += bytes.length;
    return;
  }
  if (remaining > 0) {
    buffer.value += bytes.subarray(0, remaining).toString();
    buffer.bytes = OUTPUT_CAP_BYTES;
  }
  buffer.value += OUTPUT_TRUNCATED_MARKER;
  buffer.truncated = true;
}

function boundedTimeout(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.floor(raw)), MAX_TIMEOUT_MS);
}

export function resolveTerminalSandboxProfile(
  rawProfile: string | undefined,
  squadCliPolicy: SquadCliPolicyMode,
): SandboxProfile | undefined {
  if (
    rawProfile === 'workspace-only' ||
    rawProfile === 'workspace-net' ||
    rawProfile === 'yolo'
  ) {
    return rawProfile;
  }
  return isOperatorChoicePolicy(squadCliPolicy)
    ? 'workspace-net'
    : undefined;
}

function isSameCheckout(
  entry: ActiveProcess,
  scope: ProjectExecutionScope,
): boolean {
  return (
    entry.installationId === scope.installationId &&
    entry.projectId === scope.projectId &&
    entry.checkoutId === scope.checkoutId &&
    entry.rootRealPath === scope.rootRealPath
  );
}

function isSameOwner(entry: ActiveProcess, ctx: {
  token: string;
  sessionId?: string;
}): boolean {
  return (
    entry.ownerToken === ctx.token &&
    entry.ownerSessionId === (ctx.sessionId ?? null)
  );
}

function revokedError(): Error {
  return new Error('session_authority_revoked');
}

function removeInvocationAbortListener(
  invocation: McpToolInvocation | undefined,
  listener: () => void,
): void {
  invocation?.signal?.removeEventListener('abort', listener);
}

const terminalRun: McpToolDef = {
  name: 'nexus_terminal_run',
  description:
    'Run a shell command in the workspace directory. Returns stdout and stderr. ' +
    'The command runs to completion or until the timeout (default 30s). ' +
    'Use this for build commands, tests, linting, and other CLI tools. ' +
    'Heavy commands from mission agents wait for the project slot and available memory. ' +
    'DESTRUCTIVE commands (rm -rf, git push --force, etc.) are BLOCKED by guardrails. ' +
    'On non-zero exit, `triage` may be attached: {kind: flaky|environment|config|regression|usage, confidence, retryHelps} — use it to decide between rerun, fix environment, or fix code.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 60000, max: 300000)',
      },
      env: {
        type: 'object',
        description:
          'Extra environment variables. Only HOME, LANG, USER and SHELL are ' +
          'honored; PATH is always the operator PATH (prefix the command ' +
          'with PATH=… to change lookup inside it).',
      },
      sandboxProfile: {
        type: 'string',
        enum: ['workspace-only', 'workspace-net', 'yolo'],
        description:
          'Sandbox profile: workspace-net is the Autopilot default; ' +
          'Hardened defaults to workspace-only on macOS/Windows. Explicit ' +
          'workspace-only denies network; yolo still remains checkout-confined.',
      },
    },
    required: ['command'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    assertGovernedWorkspaceControlBoundary(ctx, terminalRun.name);
    if (isIsolatedWriterContext(ctx)) {
      const cwd = path.resolve(executionScopeFor(ctx).rootRealPath, str(args, 'cwd') ?? '.');
      const request = parseIsolatedWriterGitCommand(requireStr(args, 'command'), cwd);
      const tool = buildGitTools().find((candidate) => candidate.name === request.tool)!;
      // Never spawn a shell, including for -C, command chains and sh -c.
      // The Git handler validates actual cwd, allocation, HEAD and pathspecs.
      const result = await tool.handler(request.args, ctx, invocation) as Record<string, unknown>;
      const stdout = result.output ?? result.diff ?? (Array.isArray(result.commits) ? result.commits.join('\n') : JSON.stringify(result));
      return { exitCode: 0, stdout: String(stdout), stderr: '', killed: false };
    }
    const executionScope = executionScopeFor(ctx);
    const command = requireStr(args, 'command');
    const cwd = resolveCwdForScope(executionScope, str(args, 'cwd'));
    const timeoutMs = boundedTimeout(args.timeoutMs);
    const env = sanitizeEnv(args.env);
    const rawProfile = str(args, 'sandboxProfile');
    const sandboxProfile = resolveTerminalSandboxProfile(
      rawProfile,
      getOrchSettings().squadCliPolicy,
    );
    const sandbox = createScopedSandboxHome(executionScope);
    let plan;
    try {
      plan = buildScopedShellPlan({
        platform: process.platform,
        command,
        cwd,
        rootRealPath: executionScope.rootRealPath,
        sandboxDir: sandbox.dir,
        env,
        sandboxProfile,
      });
    } catch (error) {
      await removeTree(sandbox.dir, { recursive: true, force: true });
      throw error;
    }

    let proc: ChildProcess;
    let heavyPermit: HeavyCommandPermit | undefined;
    let ownedCommand: OwnedCommandLaunch | undefined;
    try {
      const kind = classifyHeavyCommand(command);
      if (kind) heavyPermit = await acquireHeavyCommandPermit({ scope: executionScopeFor(ctx), missionId: ctx.missionId,
        sessionId: ctx.sessionId, kind, signal: invocation?.signal,
        isCurrent: () => { assertMcpInvocationCurrent(invocation); return true; } });
      // Linearization point: no process may exist unless the exact MCP
      // session/intent is still current after all preparation.
      assertMcpInvocationCurrent(invocation);
      ownedCommand = await prepareOwnedCommandLaunch(plan);
      assertMcpInvocationCurrent(invocation);
      plan = ownedCommand.plan;
      proc = spawn(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        detached: plan.detached,
        stdio: ownedCommand.stdio ?? ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      await ownedCommand?.dispose();
      heavyPermit?.release(); // No physical process was spawned.
      await removeTree(sandbox.dir, { recursive: true, force: true });
      throw error;
    }
    const physicalExit = ownedCommand!.waitForExit(proc);
    void physicalExit.catch(() => {});
    if (heavyPermit) retainHeavyCommandPermitForProcess(heavyPermit, proc, { detached: plan.detached, physicalExit });

    const result = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      killed: boolean;
    }>((resolve, reject) => {
      const killTree = (signal: NodeJS.Signals) =>
        ownedCommand!.stop(proc, signal);

      const id = String(++processCounter);
      activeProcesses.set(id, {
        proc,
        installationId: executionScope.installationId,
        projectId: executionScope.projectId,
        checkoutId: executionScope.checkoutId,
        rootRealPath: executionScope.rootRealPath,
        ownerToken: ctx.token,
        ownerSessionId: ctx.sessionId ?? null,
        killTree,
        killRequested: false,
      });

      const stdout: OutputBuffer = { value: '', bytes: 0, truncated: false };
      const stderr: OutputBuffer = { value: '', bytes: 0, truncated: false };
      let killed = false;
      let authorityRevoked = false;
      let settled = false;
      let finalized = false;
      let forceKillTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let teardownProofTimer: NodeJS.Timeout | null = null;

      const onStdout = (chunk: Buffer) => {
        if (!authorityRevoked) appendOutput(stdout, chunk);
      };
      const onStderr = (chunk: Buffer) => {
        if (!authorityRevoked) appendOutput(stderr, chunk);
      };
      const removeOutputListeners = () => {
        proc.stdout?.removeListener('data', onStdout);
        proc.stderr?.removeListener('data', onStderr);
      };
      const requestTermination = (revoked: boolean) => {
        killed = true;
        authorityRevoked ||= revoked;
        const entry = activeProcesses.get(id);
        if (entry) entry.killRequested = true;
        if (revoked) removeOutputListeners();
        killTree('SIGTERM');
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            if (proc.exitCode === null) {
              killTree('SIGKILL');
            }
          }, 3000);
          forceKillTimer.unref?.();
        }
        if (!teardownProofTimer) {
          teardownProofTimer = setTimeout(() => {
            if (finalized || settled) return;
            settled = true;
            reject(
              new Error(
                authorityRevoked
                  ? 'session_authority_revoked; physical process exit not proven'
                  : 'terminal_timeout; physical process exit not proven',
              ),
            );
          }, 5_000);
          teardownProofTimer.unref?.();
        }
      };
      const onAuthorityRevoked = () => {
        if (authorityRevoked) return;
        requestTermination(true);
      };
      let finalizing = false;
      const finalize = async (code: number | null, error?: Error) => {
        if (finalizing) return;
        if (finalized) return;
        finalizing = true;
        try { await physicalExit; await ownedCommand!.dispose(); }
        catch {
          requestTermination(false);
          if (!settled) { settled = true; reject(new Error('command_descendant_exit_unproven')); }
          finalizing = false; return;
        }
        finalized = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (teardownProofTimer) clearTimeout(teardownProofTimer);
        removeInvocationAbortListener(invocation, onAuthorityRevoked);
        removeOutputListeners();
        // The platform's complete lifetime proof has already settled.
        activeProcesses.delete(id);
        let cleanupError: Error | undefined;
        try {
          await removeTree(sandbox.dir, { recursive: true, force: true });
        } catch (cause) {
          cleanupError =
            cause instanceof Error ? cause : new Error(String(cause));
        }
        if (settled) return;
        settled = true;
        if (authorityRevoked) {
          reject(revokedError());
        } else if (error) {
          reject(error);
        } else if (cleanupError) {
          reject(cleanupError);
        } else {
          resolve({
            exitCode: code,
            stdout: stdout.value,
            stderr: stderr.value,
            killed,
          });
        }
      };

      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.once('close', (code) => finalize(code));
      proc.once('error', (error) => finalize(null, error));

      timeoutTimer = setTimeout(() => requestTermination(false), timeoutMs);
      timeoutTimer.unref?.();
      invocation?.signal?.addEventListener(
        'abort',
        onAuthorityRevoked,
        { once: true },
      );
      if (invocation?.signal?.aborted) {
        onAuthorityRevoked();
      } else {
        try {
          assertMcpInvocationCurrent(invocation);
        } catch {
          onAuthorityRevoked();
        }
      }
    });

    // Triagem Jev da falha (piloto automático): campo aditivo; qualquer erro
    // ou serviço fora devolve o resultado exatamente como antes.
    if (
      typeof result.exitCode === 'number' &&
      result.exitCode !== 0 &&
      !result.killed
    ) {
      try {
        // A triagem é egresso externo: revalida a autoridade ANTES de sair
        // da máquina. Autoridade revogada devolve o resultado original.
        assertMcpInvocationCurrent(invocation);
        const triage = await triageCommandFailure(
          {
            command,
            exitCode: result.exitCode,
            output: `${result.stdout}\n${result.stderr}`,
          },
          { signal: invocation?.signal },
        );
        if (triage) return { ...result, triage };
      } catch (error) {
        console.warn('[terminal] triagem Jev falhou (ignorada):', error);
      }
    }
    return result;
  },
};

const terminalKill: McpToolDef = {
  name: 'nexus_terminal_kill',
  description:
    'Kill a running terminal command by its process id. ' +
    'The process id is returned by nexus_terminal_run (future streaming ' +
    'version). Currently kills the most recent command.',
  inputSchema: {
    type: 'object',
    properties: {
      processId: {
        type: 'string',
        description: 'Process id from nexus_terminal_run (optional; kills latest if omitted)',
      },
    },
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const pid = str(args, 'processId');
    if (pid) {
      const entry = activeProcesses.get(pid);
      if (!entry) {
        return { killed: false, reason: `process ${pid} not found or already exited` };
      }
      if (!isSameCheckout(entry, executionScopeFor(ctx))) {
        throw new Error('not authorized: process belongs to another project checkout');
      }
      if (!isSameOwner(entry, ctx)) {
        throw new Error('not authorized: process belongs to another MCP session');
      }
      assertMcpInvocationCurrent(invocation);
      entry.killRequested = true;
      entry.killTree('SIGTERM');
      return { killed: true, processId: pid };
    }
    // Kill the most recent
    if (activeProcesses.size === 0) {
      return { killed: false, reason: 'no running processes' };
    }
    const latest = [...activeProcesses.entries()]
      .reverse()
      .find(
        ([, entry]) =>
          isSameCheckout(entry, executionScopeFor(ctx)) &&
          isSameOwner(entry, ctx),
      );
    if (latest) {
      const [lastId, entry] = latest;
      assertMcpInvocationCurrent(invocation);
      entry.killRequested = true;
      entry.killTree('SIGTERM');
      return { killed: true, processId: lastId };
    }
    return { killed: false, reason: 'no running processes' };
  },
};

export function buildTerminalTools(): McpToolDef[] {
  return [terminalRun, terminalKill];
}
