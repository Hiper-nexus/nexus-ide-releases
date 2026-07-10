import { spawnSync } from 'node:child_process';

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const EXECUTABLE_GIT_CONFIG_PATTERN =
  '^(core\\.(hookspath|fsmonitor|sshcommand|askpass|editor|pager|gitproxy)|sequence\\.editor|credential(\\..*)?\\.helper|gpg(\\..*)?\\.program|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv)|merge\\..*\\.driver|remote\\..*\\.(uploadpack|receivepack)|submodule\\..*\\.update|url\\..*\\.(insteadof|pushinsteadof))$';
const ALLOWED_GIT_ENV_OVERRIDES = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

export interface GitRunOptions {
  readonly allowFailure?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): GitResult;
}

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    args: readonly string[],
    result: Partial<GitResult> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GitCommandError';
    this.args = Object.freeze([...args]);
    this.status = result.status ?? null;
    this.stdout = result.stdout ?? '';
    this.stderr = result.stderr ?? '';
  }
}

export class ProcessGitRunner implements GitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): GitResult {
    if (cwd.includes('\0') || args.some((arg) => arg.includes('\0'))) {
      throw new GitCommandError('Git argv contains a NUL byte', args);
    }

    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(?:GIT_|LD_|DYLD_)/.test(key)) continue;
      env[key] = value;
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!ALLOWED_GIT_ENV_OVERRIDES.has(key) || value === undefined) {
        throw new GitCommandError(`unsafe Git environment override: ${key}`, args);
      }
      env[key] = value;
    }
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_PAGER = 'cat';
    env.GIT_EDITOR = 'true';
    env.GIT_MERGE_AUTOEDIT = 'no';
    env.GIT_ALLOW_PROTOCOL = 'https:ssh:git:http';
    env.LC_ALL = 'C';

    const disabledHooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const result = spawnSync(
      'git',
      [
        '-C',
        cwd,
        '-c',
        `core.hooksPath=${disabledHooksPath}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'tag.gpgSign=false',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        'protocol.file.allow=never',
        ...args,
      ],
      {
        encoding: 'utf8',
        env,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs ?? 30_000,
      },
    );
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (result.error || result.status === null) {
      throw new GitCommandError(
        'Git process could not complete',
        args,
        { stdout, stderr },
        result.error,
      );
    }
    const value: GitResult = { status: result.status, stdout, stderr };
    if (result.status !== 0 && !options.allowFailure) {
      throw new GitCommandError(
        `Git command failed with exit ${result.status}`,
        args,
        value,
      );
    }
    return value;
  }
}

export function assertSafeLocalGitConfig(
  runner: GitRunner,
  cwd: string,
): void {
  const args = [
    'config',
    '--local',
    '--get-regexp',
    EXECUTABLE_GIT_CONFIG_PATTERN,
  ] as const;
  const config = runner.run(cwd, args, { allowFailure: true });
  if (config.status === 0 && config.stdout.trim().length > 0) {
    throw new Error(
      'repository contains executable Git config (hooks, filters, diff, merge, or fsmonitor)',
    );
  }
  if (config.status !== 0 && config.status !== 1) {
    throw new GitCommandError(
      'Git executable-config inspection failed',
      args,
      config,
    );
  }
}
