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

const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'LANG', 'USER', 'SHELL']);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const OUTPUT_TRUNCATED_MARKER = '\n...[TRUNCATED: output exceeded 1048576 bytes]';

interface OutputBuffer {
  value: string;
  bytes: number;
  truncated: boolean;
}

function sanitizeEnv(extraEnv: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
    for (const [key, value] of Object.entries(extraEnv as Record<string, unknown>)) {
      if (SAFE_ENV_KEYS.has(key) && typeof value === 'string') {
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
        description: 'Timeout in milliseconds (default: 60000, max: 300000)',
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
    const timeoutMs = boundedTimeout(args.timeoutMs);
    const env = sanitizeEnv(args.env);

    return new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      killed: boolean;
    }>((resolve, reject) => {
      const proc = exec(command, {
        cwd,
        timeout: timeoutMs,
        env,
        maxBuffer: OUTPUT_CAP_BYTES,
      });

      const id = String(++processCounter);
      activeProcesses.set(id, proc);

      const stdout: OutputBuffer = { value: '', bytes: 0, truncated: false };
      const stderr: OutputBuffer = { value: '', bytes: 0, truncated: false };
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
        appendOutput(stdout, chunk);
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        appendOutput(stderr, chunk);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        activeProcesses.delete(id);
        resolve({
          exitCode: code,
          stdout: stdout.value,
          stderr: stderr.value,
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
