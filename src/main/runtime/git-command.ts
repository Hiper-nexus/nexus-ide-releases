import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../util/remove-tree';

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

export interface AsyncGitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<GitResult>;
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
      removeTreeSync(directoryRealPath, { recursive: true, force: true });
    },
  });
}

/**
 * F-1442: comparison form of a path. Windows spells one directory several
 * legitimate ways — 8.3 short name (`ADMINI~1`), case, `/` vs `\`, and the
 * `\\?\` prefix `realpath.native` returns — and the JS `realpath` expands none
 * of them, so comparing spellings refused the real private temp index on every
 * handoff. Only the canonical form is compared; the caller keeps its own path.
 */
function canonicalPathForComparison(value: string): string {
  // `native` resolves reparse points AND expands 8.3 short names; the JS
  // realpath leaves `C:\Users\ADMINI~1\…` untouched, which is what made the
  // two sides of the containment check disagree.
  const real = fs.realpathSync.native(value);
  return normalizePathForComparison(real);
}

function normalizePathForComparison(value: string): string {
  if (process.platform !== 'win32') return value;
  let out = value.replaceAll('/', '\\');
  if (out.startsWith('\\\\?\\UNC\\')) out = `\\\\${out.slice('\\\\?\\UNC\\'.length)}`;
  else if (out.startsWith('\\\\?\\')) out = out.slice('\\\\?\\'.length);
  // The NTFS namespace is case-insensitive: two spellings are one directory.
  return out.toLowerCase();
}

function isUncPath(canonical: string): boolean {
  return process.platform === 'win32' && canonical.startsWith('\\\\');
}

export function assertPrivateIndexPath(indexFile: string): string {
  const resolved = path.resolve(indexFile);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  const parentCanonical = canonicalPathForComparison(parent);
  const tempCanonical = canonicalPathForComparison(os.tmpdir());
  if (
    path.basename(resolved).toLowerCase() !== 'index' ||
    !path.basename(parent).startsWith('nexus-git-index-') ||
    // lstat reports a Windows junction as a symlink: the index must sit in a
    // directory Nexus created, never behind a link somebody else planted.
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    isUncPath(parentCanonical) ||
    (parentCanonical !== tempCanonical &&
      !parentCanonical.startsWith(`${tempCanonical}${path.sep}`))
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

/** Secrets never leave in an error: credentials in a remote URL are masked. */
function stderrTail(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return line.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 200);
}

/**
 * "Git process could not complete" alone hid the cause (F-spawn 18/10: three
 * isolatedWriter spawns under a heavy build). Name the subcommand, the reason
 * (deadline, errno, signal) and the last stderr line.
 */
function incompleteGitMessage(
  args: readonly string[],
  error: unknown,
  timeoutMs: number,
  stderr: string,
): string {
  const failure = error as
    | (Error & { code?: unknown; killed?: boolean; signal?: unknown })
    | undefined;
  const reason =
    failure?.code === 'ETIMEDOUT' || failure?.killed
      ? `timeout de ${Math.round(timeoutMs / 1000)}s`
      : typeof failure?.code === 'string'
        ? failure.code
        : typeof failure?.signal === 'string'
          ? failure.signal
          : 'sinal ou saída sem status';
  const tail = stderrTail(stderr);
  return (
    `Git process could not complete: git ${args.filter((arg) => !arg.startsWith('-')).slice(0, 2).join(' ')} (${reason})` +
    (tail ? `; stderr: ${tail}` : '')
  );
}

const TRANSIENT_GIT_STDERR =
  /index\.lock|\.lock': File exists|could not lock|cannot lock ref|unable to create .*\.lock/i;

/** Deadline, spawn pressure (EAGAIN) or a lock held by a concurrent Git. */
export function isTransientGitFailure(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    (error.message.startsWith('Git process could not complete') ||
      TRANSIENT_GIT_STDERR.test(error.stderr))
  );
}

/** Retries `operation` on transient Git failures with backoff (1 s, 3 s). */
export async function retryTransientGit<T>(
  operation: () => Promise<T>,
  options: {
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onRetry?: (error: unknown, attempt: number) => void;
  } = {},
): Promise<T> {
  const delays = options.delaysMs ?? [1_000, 3_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delays.length || !isTransientGitFailure(error)) throw error;
      options.onRetry?.(error, attempt + 1);
      await sleep(delays[attempt]!);
    }
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

    const env = safeGitEnvironment(args, options);
    const result = spawnSync(
      'git',
      [
        '-C',
        cwd,
        ...safeGitArgv(args),
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
        incompleteGitMessage(args, result.error ?? { signal: result.signal }, options.timeoutMs ?? 30_000, stderr),
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

function safeGitEnvironment(
  args: readonly string[],
  options: GitRunOptions,
): NodeJS.ProcessEnv {
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
  // F-580: the user's global and system git config is trusted — it is not
  // repository content — and it is what carries credential helpers
  // (`gh auth git-credential`, osxkeychain, GCM), `user.name`/`user.email`,
  // `url.insteadOf` and proxy settings. Stripping it via
  // GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL killed every HTTPS push/pull from
  // Main with "could not read Username". Repo-LOCAL executable config is
  // still refused by assertSafeLocalGitConfig, and hooks/fsmonitor/gpg/
  // protocols stay pinned by the `-c` overrides in safeGitArgv.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.GIT_EDITOR = 'true';
  env.GIT_MERGE_AUTOEDIT = 'no';
  env.GIT_ALLOW_PROTOCOL = 'https:ssh:git:http';
  env.LC_ALL = 'C';
  // F-1384: leitura (status, diff) não regrava o index da worktree. Sem isto
  // o `git status` pega o index.lock para gravar o refresh, e um kill nessa
  // janela deixa o lock de 0 byte que derruba `git add` do writer. Locks
  // obrigatórios (add, commit, checkout) não são afetados.
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function safeGitArgv(args: readonly string[]): string[] {
  const disabledHooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return [
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
  ];
}

/**
 * Main-process Git runner for IPC/diagnostic paths. It preserves the exact
 * security envelope of ProcessGitRunner while allowing Electron to continue
 * servicing renderer and PTY events during slow repository probes.
 */
export class AsyncProcessGitRunner implements AsyncGitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitResult> {
    if (cwd.includes('\0') || args.some((arg) => arg.includes('\0'))) {
      return Promise.reject(
        new GitCommandError('Git argv contains a NUL byte', args),
      );
    }
    let env: NodeJS.ProcessEnv;
    try {
      env = safeGitEnvironment(args, options);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', cwd, ...safeGitArgv(args)],
        {
          encoding: 'utf8',
          env,
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          timeout: options.timeoutMs ?? 30_000,
          // F-1384: SIGTERM, não SIGKILL — o Git trata o sinal e apaga os
          // próprios lockfiles; SIGKILL no meio deixava `index.lock` órfão.
          killSignal: 'SIGTERM',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const errorCode = (
            error as (Error & { readonly code?: string | number }) | null
          )?.code;
          const status =
            typeof errorCode === 'number'
              ? errorCode
              : error
                ? null
                : 0;
          const result = {
            status: status ?? 1,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
          };
          if (status === null) {
            reject(
              new GitCommandError(
                incompleteGitMessage(args, error, options.timeoutMs ?? 30_000, result.stderr),
                args,
                result,
                error,
              ),
            );
            return;
          }
          if (status !== 0 && !options.allowFailure) {
            reject(
              new GitCommandError(
                `Git command failed with exit ${status}`,
                args,
                result,
                error,
              ),
            );
            return;
          }
          resolve(result);
        },
      );
    });
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

export async function assertSafeLocalGitConfigAsync(
  runner: AsyncGitRunner,
  cwd: string,
): Promise<void> {
  const args = [
    'config',
    '--local',
    '--get-regexp',
    EXECUTABLE_GIT_CONFIG_PATTERN,
  ] as const;
  const config = await runner.run(cwd, args, { allowFailure: true });
  if (config.status === 0 && config.stdout.trim().length > 0) {
    const offenders = executableGitConfigEntries(config.stdout);
    if (offenders.length > 0) {
      throw new Error(
        'repository contains executable Git config (hooks, filters, diff, ' +
          `merge, or fsmonitor): ${[...new Set(offenders)].sort().join(', ')}`,
      );
    }
  }
  if (config.status !== 0 && config.status !== 1) {
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
