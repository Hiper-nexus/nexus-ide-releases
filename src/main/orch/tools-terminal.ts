import type { McpToolDef } from './mcp-protocol';
import { requireStr, str } from './tool-util';
import { exec, type ChildProcess } from 'node:child_process';
import { resolveWorkspaceCwd } from './workspace-path';

/**
 * Terminal execution MCP tools for Jarvis agent.
 * Runs shell commands in the workspace directory with output streaming.
 */

const activeProcesses = new Map<string, ChildProcess>();
let processCounter = 0;

const terminalRun: McpToolDef = {
  name: 'nexus_terminal_run',
  description:
    'Run a shell command in the workspace directory. Returns stdout and stderr. ' +
    'The command runs to completion or until the timeout (default 30s). ' +
    'Use this for build commands, tests, linting, and other CLI tools. ' +
    'DESTRUCTIVE commands (rm -rf, git push --force, etc.) are BLOCKED by guardrails.',
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
        description: 'Timeout in milliseconds (default: 30000, max: 300000)',
      },
      env: {
        type: 'object',
        description: 'Extra environment variables',
      },
    },
    required: ['command'],
  },
  handler: async (args) => {
    const command = requireStr(args, 'command');
    const cwd = resolveWorkspaceCwd(str(args, 'cwd'));
    const timeoutMs = Math.min(
      typeof args.timeoutMs === 'number' ? args.timeoutMs : 30000,
      300_000,
    );
    const extraEnv = (args.env as Record<string, string> | undefined) ?? {};

    return new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      killed: boolean;
    }>((resolve, reject) => {
      const proc = exec(command, {
        cwd,
        timeout: timeoutMs,
        env: { ...process.env, ...extraEnv },
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });

      const id = String(++processCounter);
      activeProcesses.set(id, proc);

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        // Force kill after 3s if still alive
        setTimeout(() => {
          if (proc.exitCode === null) {
            proc.kill('SIGKILL');
          }
        }, 3000);
      }, timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        activeProcesses.delete(id);
        resolve({
          exitCode: code,
          stdout: stdout.slice(-100_000), // Truncate to 100KB
          stderr: stderr.slice(-100_000),
          killed,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        activeProcesses.delete(id);
        reject(err);
      });
    });
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
  handler: async (args) => {
    const pid = str(args, 'processId');
    if (pid) {
      const proc = activeProcesses.get(pid);
      if (!proc) {
        return { killed: false, reason: `process ${pid} not found or already exited` };
      }
      proc.kill('SIGTERM');
      activeProcesses.delete(pid);
      return { killed: true, processId: pid };
    }
    // Kill the most recent
    if (activeProcesses.size === 0) {
      return { killed: false, reason: 'no running processes' };
    }
    const lastId = String(processCounter);
    const proc = activeProcesses.get(lastId);
    if (proc) {
      proc.kill('SIGTERM');
      activeProcesses.delete(lastId);
      return { killed: true, processId: lastId };
    }
    return { killed: false, reason: 'no running processes' };
  },
};

export function buildTerminalTools(): McpToolDef[] {
  return [terminalRun, terminalKill];
}
