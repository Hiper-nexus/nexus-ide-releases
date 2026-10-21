import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One sandboxed runner for every UI-kit CLI (`shadcn`, `boardui`).
 *
 * Same threat model as the design-contract runners
 * (src/main/design/getdesign-cli-source.ts): an untrusted npm package, a fixed
 * argv, `shell: false`, an env allowlist, a wall-clock timeout, an output byte
 * cap and process-group teardown.
 *
 * It differs from those in ONE way that drives most of the rules below: a
 * design contract is markdown we read out of a temp directory, but a UI kit
 * WRITES COMPONENTS INTO THE USER'S PROJECT and runs a package-manager install
 * to do it. So a writing command has to run with the project as cwd, and that
 * cwd is the dangerous part:
 *
 * - `npx`/`npm` rewrite `node_modules`. When `<cwd>/node_modules` is a symlink
 *   — which is how Nexus checkouts share one install — that write lands in the
 *   SHARED tree and corrupts every other worktree pointing at it. A writing run
 *   is refused there instead of discovering it afterwards.
 * - Registry tokens travel as env vars (`${REGISTRY_TOKEN}` in
 *   `components.json`), so this runner needs a hole in the "no secret
 *   passthrough" rule. It is exactly one hole: `extraEnv`, name-validated, and
 *   the values are never logged, never echoed into an error and never put in
 *   argv (argv is world-readable in `ps`).
 */

export const UI_KIT_IDS = ['shadcn', 'boardui'] as const;
export type UiKitId = (typeof UI_KIT_IDS)[number];

/**
 * `@latest` on purpose, like the vendors' own docs and the getdesign source: a
 * component kit pinned to an old tag ships stale components and stale a11y
 * fixes into client projects. Both packages are invoked through `npx -y`.
 */
export const UI_KIT_PACKAGES: Record<UiKitId, string> = {
  shadcn: 'shadcn@latest',
  boardui: 'boardui@latest',
};

/** Read-only queries: no install, so the short budget is enough. */
export const UI_KIT_READ_TIMEOUT_MS = 120_000;
/** Writing commands shell out to a package-manager install. */
export const UI_KIT_WRITE_TIMEOUT_MS = 300_000;
export const UI_KIT_READ_MAX_OUTPUT_BYTES = 4_000_000;
/** Install logs are chatty; capping them too low turns success into TIMEOUT. */
export const UI_KIT_WRITE_MAX_OUTPUT_BYTES = 12_000_000;
export const UI_KIT_TERMINATION_GRACE_MS = 2_000;
export const UI_KIT_MAX_ARGS = 64;
export const UI_KIT_MAX_ARG_CHARS = 512;
export const UI_KIT_MAX_ENV_NAME_CHARS = 64;
export const UI_KIT_MAX_ENV_VALUE_CHARS = 4_096;

/** Env var names a registry may be authenticated with. Uppercase only. */
export const UI_KIT_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Env keys forwarded to the child; everything else is dropped. Mirrors the
 * design runners' list — no provider key, no Nexus secret ever reaches a CLI.
 */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NODE_OPTIONS',
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_registry',
  'npm_config_user_agent',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
] as const;

/**
 * `extraEnv` is an allowlist BY SHAPE, not a denylist of bad names.
 *
 * A denylist was the first cut and it was wrong: npm reads EVERY
 * `npm_config_*` variable as configuration, and the loader reads `LD_PRELOAD`
 * / `DYLD_INSERT_LIBRARIES`, so a caller could have injected code into the npx
 * child or repointed the registry through a name nobody thought to list.
 *
 * The only legitimate use of this channel is a registry credential that
 * `components.json` references as `${VAR}`. So a name has to LOOK like one —
 * it must carry one of the credential words below — and the dangerous
 * families are refused on top of that. `LD_PRELOAD` and `NODE_EXTRA_CA_CERTS`
 * fail the first test before the second one is reached.
 */
const ENV_CREDENTIAL_WORDS = [
  'TOKEN',
  'KEY',
  'SECRET',
  'AUTH',
  'PASS',
  'LICENSE',
  'LICENCE',
  'CREDENTIAL',
] as const;

/** Families that must never arrive through this channel, whatever their name. */
const ENV_FORBIDDEN_PREFIXES = [
  'NPM_CONFIG',
  'NODE_',
  'LD_',
  'DYLD_',
  'ELECTRON_',
  'NEXUS_',
  'PYTHON',
  'PERL5',
  'BASH',
  'GIT_',
  'SSL_',
  'OPENSSL_',
] as const;

const PROTECTED_ENV_NAMES = new Set<string>([
  ...CHILD_ENV_ALLOWLIST,
  'npm_config_yes',
  'ENV',
  'IFS',
  'SHELL',
  'SHELLOPTS',
  'BASH_ENV',
]);

export function envNameLooksLikeCredential(name: string): boolean {
  return ENV_CREDENTIAL_WORDS.some((word) => name.includes(word));
}

export class UiKitCliError extends Error {
  readonly code: string;
  /** Operator-facing remediation, when there is one worth printing. */
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'UiKitCliError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export interface UiKitCliRunRequest {
  readonly kit: UiKitId;
  /** Argv AFTER `npx -y <package>`. Built by the kit modules, never by a model. */
  readonly args: readonly string[];
  /** Absolute directory. The project root for a writing run. */
  readonly cwd: string;
  /** True when the command writes files / installs dependencies. */
  readonly writes?: boolean;
  /** Registry auth only. Values are secret: never logged, never in argv. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface UiKitCliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export type UiKitCliRunner = (
  request: UiKitCliRunRequest,
) => Promise<UiKitCliRunResult>;

export function buildUiKitChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  extraEnv: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { npm_config_yes: 'true' };
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }
  for (const [name, value] of Object.entries(extraEnv)) {
    env[assertSafeEnvName(name)] = assertSafeEnvValue(name, value);
  }
  return env;
}

export function assertSafeEnvName(name: string): string {
  if (
    name.length === 0 ||
    name.length > UI_KIT_MAX_ENV_NAME_CHARS ||
    !UI_KIT_ENV_NAME_PATTERN.test(name)
  ) {
    throw new UiKitCliError(
      'INVALID_ENV_NAME',
      `registry env var name must match ${String(UI_KIT_ENV_NAME_PATTERN)} ` +
        `and stay under ${UI_KIT_MAX_ENV_NAME_CHARS} characters`,
    );
  }
  if (PROTECTED_ENV_NAMES.has(name)) {
    // Letting a caller set PATH or npm_config_yes would move the whole run to
    // a binary / configuration of its choosing.
    throw new UiKitCliError(
      'PROTECTED_ENV_NAME',
      `${name} cannot be overridden for a UI-kit run`,
    );
  }
  const upper = name.toUpperCase();
  for (const prefix of ENV_FORBIDDEN_PREFIXES) {
    if (upper.startsWith(prefix)) {
      throw new UiKitCliError(
        'PROTECTED_ENV_NAME',
        `${name} belongs to the ${prefix}* family, which can redirect the ` +
          'package manager or inject code into the child',
      );
    }
  }
  if (!envNameLooksLikeCredential(upper)) {
    throw new UiKitCliError(
      'NOT_A_CREDENTIAL_ENV_NAME',
      `${name} does not look like a registry credential (expected one of ` +
        `${ENV_CREDENTIAL_WORDS.join(', ')} in the name)`,
    );
  }
  return name;
}

function assertSafeEnvValue(name: string, value: string): string {
  // The value is a secret, so it never appears in the message — only its name.
  if (typeof value !== 'string' || value.length === 0) {
    throw new UiKitCliError('INVALID_ENV_VALUE', `${name} has an empty value`);
  }
  if (value.length > UI_KIT_MAX_ENV_VALUE_CHARS) {
    throw new UiKitCliError(
      'INVALID_ENV_VALUE',
      `${name} exceeds ${UI_KIT_MAX_ENV_VALUE_CHARS} characters`,
    );
  }
  if (/[\0\r\n]/.test(value)) {
    throw new UiKitCliError(
      'INVALID_ENV_VALUE',
      `${name} contains a NUL or newline`,
    );
  }
  return value;
}

export function assertSafeUiKitArgs(args: readonly string[]): readonly string[] {
  if (args.length > UI_KIT_MAX_ARGS) {
    throw new UiKitCliError(
      'TOO_MANY_ARGS',
      `a UI-kit run takes at most ${UI_KIT_MAX_ARGS} arguments`,
    );
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0) {
      throw new UiKitCliError('INVALID_ARG', 'empty UI-kit argument');
    }
    if (arg.length > UI_KIT_MAX_ARG_CHARS) {
      throw new UiKitCliError(
        'INVALID_ARG',
        `UI-kit argument exceeds ${UI_KIT_MAX_ARG_CHARS} characters`,
      );
    }
    if (/[\0\r\n]/.test(arg)) {
      throw new UiKitCliError(
        'INVALID_ARG',
        'UI-kit argument contains a NUL or newline',
      );
    }
  }
  return args;
}

export interface AssertSafeCwdOptions {
  readonly writes?: boolean;
  readonly statSync?: (target: string) => fs.Stats;
  readonly lstatSync?: (target: string) => fs.Stats;
}

/**
 * The guard that matters. A writing run inside a checkout whose `node_modules`
 * is a symlink would have the package-manager install write THROUGH the link
 * into the shared tree every other worktree depends on.
 */
export function assertSafeUiKitCwd(
  cwd: string,
  options: AssertSafeCwdOptions = {},
): string {
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new UiKitCliError(
      'CWD_NOT_ABSOLUTE',
      'a UI-kit run needs an absolute project directory',
    );
  }
  const statSync = options.statSync ?? fs.statSync;
  let stats: fs.Stats;
  try {
    stats = statSync(cwd);
  } catch {
    throw new UiKitCliError(
      'CWD_NOT_FOUND',
      `UI-kit project directory does not exist: ${cwd}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new UiKitCliError(
      'CWD_NOT_DIRECTORY',
      `UI-kit project path is not a directory: ${cwd}`,
    );
  }
  if (!options.writes) return cwd;

  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const modules = path.join(cwd, 'node_modules');
  let linkStats: fs.Stats | null = null;
  try {
    linkStats = lstatSync(modules);
  } catch {
    // No node_modules yet: the install will create a real one. Fine.
    return cwd;
  }
  if (linkStats.isSymbolicLink()) {
    throw new UiKitCliError(
      'SHARED_NODE_MODULES',
      `refusing to install into ${cwd}: node_modules is a symlink`,
      'This checkout shares one install with others, and a package-manager ' +
        'write would corrupt the shared tree. Run the UI kit in the project ' +
        'you are building, or give this checkout its own node_modules.',
    );
  }
  return cwd;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

export const UI_KIT_WINDOWS_NPX_CANDIDATES = ['npx.cmd', 'npx.exe'] as const;

export interface ResolveNpxCommandOptions {
  readonly platform?: NodeJS.Platform;
  readonly pathString?: string;
  readonly exists?: (candidate: string) => boolean;
}

/**
 * A bare `npx` with `shell: false` is ENOENT on Windows, where npm ships
 * `npx.cmd` / `npx.exe` (the lesson already paid for in the getdesign source).
 */
export function resolveNpxCommand(
  options: ResolveNpxCommandOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'npx';
  const pathString = options.pathString ?? process.env.PATH ?? '';
  const exists =
    options.exists ??
    ((candidate: string) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  for (const dir of pathString.split(';')) {
    if (!dir) continue;
    for (const candidate of UI_KIT_WINDOWS_NPX_CANDIDATES) {
      const full = path.win32.join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  return UI_KIT_WINDOWS_NPX_CANDIDATES[0];
}

/** Kill the group: the package manager's node child holds the download open. */
async function terminateTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const taskkill = path.win32.join(
      process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
      'System32',
      'taskkill.exe',
    );
    await new Promise<void>((resolve) => {
      const killer = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }
  try {
    signalGroup(pid, 'SIGTERM');
  } catch {
    // The SIGKILL escalation below is the authoritative stop.
  }
  await delay(UI_KIT_TERMINATION_GRACE_MS);
  try {
    signalGroup(pid, 'SIGKILL');
  } catch (error) {
    console.warn(`[ui-kit] failed to kill process group ${pid}:`, error);
  }
}

export const runUiKitCli: UiKitCliRunner = (request) =>
  new Promise<UiKitCliRunResult>((resolve, reject) => {
    const writes = request.writes === true;
    let cwd: string;
    let args: readonly string[];
    let env: NodeJS.ProcessEnv;
    try {
      cwd = assertSafeUiKitCwd(request.cwd, { writes });
      args = assertSafeUiKitArgs(request.args);
      env = buildUiKitChildEnv(process.env, request.extraEnv ?? {});
    } catch (error) {
      reject(error);
      return;
    }
    if (request.signal?.aborted) {
      reject(new UiKitCliError('ABORTED', 'UI-kit run aborted'));
      return;
    }

    const timeoutMs =
      request.timeoutMs ??
      (writes ? UI_KIT_WRITE_TIMEOUT_MS : UI_KIT_READ_TIMEOUT_MS);
    const maxBytes = writes
      ? UI_KIT_WRITE_MAX_OUTPUT_BYTES
      : UI_KIT_READ_MAX_OUTPUT_BYTES;
    const isWindows = process.platform === 'win32';
    const options: SpawnOptions = {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
      shell: false,
      windowsHide: isWindows,
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        resolveNpxCommand(),
        ['-y', UI_KIT_PACKAGES[request.kit], ...args],
        options,
      );
    } catch (error) {
      reject(
        new UiKitCliError(
          'SPAWN_FAILED',
          `failed to spawn ${request.kit}: ` +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      fail(
        new UiKitCliError(
          'TIMEOUT',
          `${request.kit} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    function cleanup(): void {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
    function fail(error: UiKitCliError): void {
      if (settled) return;
      settled = true;
      cleanup();
      // `.catch` BEFORE `.finally`, so an EPERM from the SIGKILL cannot carry
      // its own rejection out of the derivative with no handler.
      void terminateTree(child.pid)
        .catch(() => {})
        .finally(() => reject(error));
    }
    function onAbort(): void {
      fail(new UiKitCliError('ABORTED', 'UI-kit run aborted'));
    }
    function accumulate(chunk: Buffer, isStdout: boolean): void {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(
          new UiKitCliError(
            'OUTPUT_TOO_LARGE',
            `${request.kit} output exceeded ${maxBytes} bytes`,
          ),
        );
        return;
      }
      if (isStdout) stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    }

    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => accumulate(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => accumulate(chunk, false));
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new UiKitCliError(
          'SPAWN_FAILED',
          `failed to run ${request.kit}: ${error.message}`,
          'Ensure Node and npx are available on PATH.',
        ),
      );
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code });
    });
  });
