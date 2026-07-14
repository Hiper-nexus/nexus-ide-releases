import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { resolvePlaceholders } from '../../shared/adapter-types';
import { getAdapter } from '../adapters/adapter-registry';
import { MAX_BENCHMARK_TEXT_CHARS, type BenchmarkCompetitorExecutor } from './benchmark-runner';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_OUTPUT_CHARS = MAX_BENCHMARK_TEXT_CHARS;
const BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TERM',
] as const;

export interface CliBenchmarkExecutorOptions {
  resolveAdapter: (adapterId: string) => CliPtyAdapter | null;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Explicit opt-in: provider CLIs may consume money or mutate the workspace. */
  allowExternalExecution?: boolean;
  /** Testable/process boundary environment; only allowlisted keys are copied. */
  baseEnv?: NodeJS.ProcessEnv;
}

interface Invocation {
  file: string;
  args: string[];
  cwd: string;
  promptViaStdin: boolean;
  prompt: string;
  trailingNewline: boolean;
  env: Record<string, string>;
}

function safeEnv(adapter: CliPtyAdapter, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of adapter.env.passthrough) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(adapter.env.static)) env[key] = value;
  return env;
}

function buildInvocation(
  adapter: CliPtyAdapter,
  modelId: string,
  prompt: string,
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
): Invocation {
  if (adapter.spawn.headless.length === 0) throw new Error(`adapter ${adapter.id} has no headless command`);
  const hasPromptPlaceholder = adapter.spawn.headless.some((arg) => arg.includes('{{PROMPT}}'));
  const hasModelPlaceholder = adapter.spawn.headless.some((arg) => arg.includes('{{MODEL}}'));
  const vars = { MODEL: modelId, CWD: cwd, PROMPT: prompt, SESSION_ID: '' };
  const resolved = resolvePlaceholders(adapter.spawn.headless, vars).filter((arg) => arg.length > 0);
  const file = resolved[0];
  if (!file || file.includes('\0')) throw new Error(`adapter ${adapter.id} has an invalid headless executable`);
  let args = resolved.slice(1);
  if (!hasPromptPlaceholder) {
    if (adapter.promptInjection.method === 'flag' && adapter.promptInjection.flag) {
      args = [...args, adapter.promptInjection.flag, prompt];
    } else if (adapter.promptInjection.method !== 'stdin') {
      throw new Error(`adapter ${adapter.id} does not declare a usable prompt injection`);
    }
  }
  if (modelId && !hasModelPlaceholder && adapter.models.flag) {
    args = [...args, adapter.models.flag, modelId];
  }
  args = [...args, ...adapter.spawn.extraArgs];
  return {
    file,
    args,
    cwd,
    promptViaStdin: !hasPromptPlaceholder && adapter.promptInjection.method === 'stdin',
    prompt,
    trailingNewline: adapter.promptInjection.trailingNewline,
    env: safeEnv(adapter, baseEnv),
  };
}

function terminate(child: ChildProcess): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fall through to the direct child handle.
    }
  }
  child.kill('SIGTERM');
}

function runInvocation(invocation: Invocation, timeoutMs: number, maxOutputChars: number): Promise<{
  answer: string;
  durationMs: number;
}> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(invocation.file, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
    };
    child.once('error', (error) => finish(new Error('benchmark provider process failed', { cause: error })));
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > maxOutputChars) {
        terminate(child);
        finish(new Error('benchmark provider output exceeded the configured limit'));
      }
    });
    child.stderr?.resume();
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`benchmark provider exited unsuccessfully (${code ?? signal ?? 'unknown'})`));
        return;
      }
      const answer = stdout.trim();
      if (!answer) {
        finish(new Error('benchmark provider returned an empty answer'));
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ answer, durationMs: Math.max(0, Date.now() - startedAt) });
    });
    timer = setTimeout(() => {
      terminate(child);
      finish(new Error('benchmark provider timed out'));
    }, timeoutMs);
    if (invocation.promptViaStdin) {
      child.stdin?.end(invocation.prompt + (invocation.trailingNewline ? '\n' : ''));
    } else {
      child.stdin?.end();
    }
  });
}

export function createCliBenchmarkExecutor(
  options: CliBenchmarkExecutorOptions,
): BenchmarkCompetitorExecutor {
  if (!path.isAbsolute(options.cwd)) throw new Error('benchmark executor cwd must be absolute');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_OUTPUT_CHARS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('benchmark timeoutMs must be positive');
  if (!Number.isInteger(maxOutputChars) || maxOutputChars <= 0 || maxOutputChars > MAX_BENCHMARK_TEXT_CHARS) {
    throw new Error('benchmark maxOutputChars is outside the safe limit');
  }
  const baseEnv = options.baseEnv ?? process.env;

  return async ({ prompt, subject }) => {
    if (options.allowExternalExecution !== true) {
      throw new Error('benchmark provider execution requires allowExternalExecution=true');
    }
    const adapter = options.resolveAdapter(subject.adapterId);
    if (!adapter) throw new Error(`benchmark adapter not found: ${subject.adapterId}`);
    const invocation = buildInvocation(adapter, subject.modelId, prompt, options.cwd, baseEnv);
    return runInvocation(invocation, timeoutMs, maxOutputChars);
  };
}

/** Main-process convenience boundary using the already-initialized adapter registry. */
export function createRegisteredCliBenchmarkExecutor(
  options: Omit<CliBenchmarkExecutorOptions, 'resolveAdapter'>,
): BenchmarkCompetitorExecutor {
  return createCliBenchmarkExecutor({
    ...options,
    resolveAdapter: (adapterId) => {
      const adapter = getAdapter(adapterId);
      return adapter?.kind === 'cli-pty' ? adapter : null;
    },
  });
}
