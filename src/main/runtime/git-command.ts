import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  /** Nexus-owned temporary index; never points at a workspace/user index. */
  readonly privateIndexFile?: string;
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

export interface PrivateGitIndex {
  readonly path: string;
  dispose(): void;
}

export function createPrivateGitIndex(): PrivateGitIndex {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-git-index-'),
  );
  const directoryRealPath = fs.realpathSync(directory);
  const indexPath = path.join(directoryRealPath, 'index');
  return Object.freeze({
    path: indexPath,
    dispose: () => {
      fs.rmSync(directoryRealPath, { recursive: true, force: true });
    },
  });
}

function assertPrivateIndexPath(indexFile: string): string {
  const resolved = path.resolve(indexFile);
  const parent = path.dirname(resolved);
  const tempRoot = fs.realpathSync(os.tmpdir());
  const parentReal = fs.realpathSync(parent);
  const parentStat = fs.lstatSync(parent);
  if (
    path.basename(resolved) !== 'index' ||
    !path.basename(parent).startsWith('nexus-git-index-') ||
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentReal !== parent ||
    (parentReal !== tempRoot &&
      !parentReal.startsWith(`${tempRoot}${path.sep}`))
  ) {
    throw new Error('unsafe private Git index path');
  }
  return resolved;
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
    if (options.privateIndexFile) {
      env.GIT_INDEX_FILE = assertPrivateIndexPath(options.privateIndexFile);
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

/**
 * Decides whether a matched config entry can actually run a command.
 *
 * The regexp above selects candidate *keys*; refusing on the key alone was
 * value-blind and produced false positives that blocked the whole repository.
 * `core.fsmonitor=true` is the most common one: the boolean form selects Git's
 * built-in fsmonitor daemon and executes nothing, while only a path/command
 * value spawns a process. A repository was refused over a pure performance
 * setting, and every worker in it was blocked.
 */
export function isExecutableGitConfigEntry(
  key: string,
  value: string,
): boolean {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedValue = value.trim();
  // An empty value disables the setting; nothing can be spawned from it.
  if (!normalizedValue) return false;
  if (normalizedKey === 'core.fsmonitor') {
    // Boolean = built-in daemon. Anything else is a hook path/command.
    return !/^(true|false)$/i.test(normalizedValue);
  }
  if (
    normalizedKey.startsWith('submodule.') &&
    normalizedKey.endsWith('.update')
  ) {
    // Only the `!command` form executes; checkout/rebase/merge/none do not.
    return normalizedValue.startsWith('!');
  }
  return true;
}

function executableGitConfigEntries(stdout: string): string[] {
  const offenders: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(' ');
    const key = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const value = separator === -1 ? '' : trimmed.slice(separator + 1);
    if (isExecutableGitConfigEntry(key, value)) offenders.push(key);
  }
  return offenders;
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
    const offenders = executableGitConfigEntries(config.stdout);
    if (offenders.length > 0) {
      // Name the keys: "executable Git config" alone gave the operator nothing
      // to inspect or unset in their own repository.
      throw new Error(
        'repository contains executable Git config (hooks, filters, diff, ' +
          `merge, or fsmonitor): ${[...new Set(offenders)].sort().join(', ')}`,
      );
    }
  }
  if (config.status !== 0 && config.status !== 1) {
    // `git config --local` fora de um repo sai 128 — reportar isso como
    // "inspection failed" mandava o agente caçar um bug inexistente quando o
    // cwd (ex.: raiz de workspace multi-projeto) simplesmente não é um repo.
    if (/not a git repository|--local can only be used inside/i.test(config.stderr)) {
      throw new Error(`not a git repository: ${cwd}`);
    }
    throw new GitCommandError(
      'Git executable-config inspection failed',
      args,
      config,
    );
  }
}
