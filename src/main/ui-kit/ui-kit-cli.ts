import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../util/remove-tree';

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
/** How often the captured output's size is checked against the cap. */
const UI_KIT_OUTPUT_WATCH_MS = 250;
export const UI_KIT_TERMINATION_GRACE_MS = 2_000;
export const UI_KIT_MAX_ARGS = 64;
export const UI_KIT_MAX_ARG_CHARS = 512;
export const UI_KIT_MAX_ENV_NAME_CHARS = 64;
export const UI_KIT_MAX_ENV_VALUE_CHARS = 4_096;

/**
 * The registry the child resolves the kit package from, pinned in the ENV.
 *
 * This is the one place a writing run in the project's own directory differs
 * from the design runners, which always work in a throwaway temp dir. npm
 * reads a `.npmrc` from its cwd, so a repository could set
 * `registry=https://evil.test` and decide WHICH `shadcn` package we download
 * and execute. npm's precedence is cmdline > env > project `.npmrc` > user >
 * global, so setting it here overrides the project's.
 *
 * An operator who legitimately uses their own mirror keeps it: their
 * `npm_config_registry` is forwarded by the allowlist and is not overwritten.
 * A project that REQUIRES its private mirror for its own dependencies will see
 * an install failure instead — a visible failure, which is the better half of
 * the trade against the repository choosing the code we run.
 */
export const UI_KIT_DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

/**
 * npm keys a project's `.npmrc` could use to redirect resolution even with the
 * registry pinned: route the request through a host of its choice, or make a
 * forged certificate acceptable. An env value beats a project `.npmrc`, and an
 * EMPTY value is how npm is told "no proxy", so these are pinned empty.
 *
 * The operator's own proxy/CA live in their user `.npmrc`, which is still read
 * — pinning `userconfig` would have discarded their auth tokens with it.
 */
const NPM_REDIRECT_KEYS_PINNED_EMPTY = [
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_ca',
  'npm_config_cafile',
] as const;

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
  // Where BoardUI resolves its config on Linux (and anywhere it is exported):
  // the licence file must be written where the child READS it, and a terminal
  // the user runs `boardui` in resolves the same root.
  'XDG_CONFIG_HOME',
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
  /**
   * The caller already holds this project's write slot and releases it once
   * this run settles. Set by a caller that edits project config BEFORE the
   * run (shadcn's components.json), so a refused retry cannot touch it while
   * another install is still going.
   */
  readonly projectWriteClaimed?: boolean;
  /**
   * Where the PACKAGE is resolved from.
   *
   * `isolated` spawns in a throwaway Nexus-owned directory, which is the only
   * way to keep the project out of the decision: npm reads a `.npmrc` from its
   * cwd, and `npx` prefers a binary from the cwd's `node_modules/.bin` — so a
   * repository with a committed `node_modules/.bin/shadcn`, or an `.npmrc`
   * naming its own registry, would otherwise choose the code that runs.
   * Measured: with the project as cwd, `npx` went to the registry the
   * repository named.
   *
   * It requires a CLI that can be pointed back at the project (`cwdFlag`).
   */
  readonly resolveIn?: 'project' | 'isolated';
  /** Append `--cwd <project>` so an isolated run still acts on the project. */
  readonly cwdFlag?: boolean;
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
  // Only when the operator has not chosen one: theirs wins, the project's
  // never does.
  if (!env.npm_config_registry) {
    env.npm_config_registry = UI_KIT_DEFAULT_NPM_REGISTRY;
  }
  for (const key of NPM_REDIRECT_KEYS_PINNED_EMPTY) {
    if (!env[key]) env[key] = '';
  }
  // A project cannot turn certificate checking off for our download.
  if (!env.npm_config_strict_ssl) env.npm_config_strict_ssl = 'true';
  // The vendors' own analytics stay home. BoardUI ships a PostHog client that
  // reports every command — licence actions included — from every machine;
  // its dist honours both of these (read 22/10/2026). Set last, so nothing
  // above can switch it back on.
  env.DO_NOT_TRACK = '1';
  env.BOARDUI_TELEMETRY_DISABLED = '1';
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
    // On Linux and Windows every Nexus writer worktree is born with this link
    // (F-1535, no clonefile there), so the refusal has to say what to do in
    // THAT case, not only in a hand-made one: the kit's npm install would
    // write into the coordination checkout's tree that the link points at.
    throw new UiKitCliError(
      'SHARED_NODE_MODULES',
      `refusing to install into ${cwd}: node_modules is a symlink`,
      'This checkout shares one install with others (a Nexus worktree on ' +
        'Linux/Windows links it to the main checkout), and a package-manager ' +
        'write would corrupt the shared tree. Give this checkout its own ' +
        'install first — remove the node_modules link (the link only, never ' +
        'its target) and run the project install (npm ci / pnpm install) — ' +
        'or install the kit item in the main checkout.',
    );
  }
  return cwd;
}

/**
 * NOT unref'd, unlike the timeout timer: the caller's rejection is sequenced
 * BEHIND this grace period, so an unref'd timer here lets a quiet event loop
 * exit with the promise still pending — the await never settles. (Electron's
 * main loop never empties, so this only ever bit a plain-node harness, which
 * is exactly where it was found.)
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

/** Windows batch launchers cannot be spawned with shell:false (EINVAL).
 * Run npm's fixed JS entrypoint with a real Node executable instead. Never
 * interpolate project paths or kit arguments into cmd.exe source.
 */
export function resolveUiKitNpxLaunch(
  options: ResolveNpxCommandOptions = {},
): { command: string; argsPrefix: string[] } {
  const command = resolveNpxCommand(options);
  if ((options.platform ?? process.platform) !== 'win32' || /\.exe$/iu.test(command)) {
    return { command, argsPrefix: [] };
  }
  const exists = options.exists ?? ((file: string) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  // Both npm's global prefix and a local node_modules/.bin installation.
  const dir = path.win32.dirname(command);
  const entry = [
    path.win32.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.win32.resolve(dir, '..', 'npm', 'bin', 'npx-cli.js'),
  ].find(exists);
  const node = [dir, ...(options.pathString ?? process.env.PATH ?? '').split(';')]
    .filter(candidate => path.win32.isAbsolute(candidate))
    .map(candidate => path.win32.join(candidate, 'node.exe')).find(exists);
  if (!path.win32.isAbsolute(command) || !entry || !node) {
    throw new UiKitCliError('SPAWN_FAILED',
      'UI-kit needs node.exe and npm/bin/npx-cli.js on the Windows Node installation.',
      'Install Node with npm and expose its directory on PATH.');
  }
  return { command: node, argsPrefix: [entry] };
}

/**
 * Projects with a WRITING kit run in flight, by real path.
 *
 * An MCP client cuts a tool call long before an install finishes (Codex: 120 s
 * against our 300 s), the install keeps running, and the agent's retry started
 * a SECOND `shadcn add` / `npm install` in the same tree — two writers on one
 * lockfile. One writer per project; the second is refused at once with what
 * to do, instead of queueing behind a run nobody is watching.
 */
const writingProjects = new Map<string, number>();

function projectWriteKey(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function claimUiKitProjectWrite(cwd: string, now: number = Date.now()): () => void {
  const key = projectWriteKey(cwd);
  const since = writingProjects.get(key);
  if (since !== undefined) {
    throw new UiKitCliError(
      'PROJECT_BUSY',
      `another UI-kit install is still running in this project ` +
        `(started ${Math.max(0, Math.round((now - since) / 1000))} s ago)`,
      'Wait for it to finish, check which files it wrote, then retry only what is missing.',
    );
  }
  writingProjects.set(key, now);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (writingProjects.get(key) === now) writingProjects.delete(key);
  };
}

export function resetUiKitProjectWritesForTests(): void {
  writingProjects.clear();
}
/**
 * ESRCH means the group is already gone, which is the outcome teardown wanted.
 * Warning about it turned a clean exit into a scary log line.
 */
export function isAlreadyGoneKillError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ESRCH'
  );
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
    if (!isAlreadyGoneKillError(error)) {
      console.warn(`[ui-kit] failed to kill process group ${pid}:`, error);
    }
  }
}

export const runUiKitCli: UiKitCliRunner = (request) =>
  new Promise<UiKitCliRunResult>((resolve, reject) => {
    const writes = request.writes === true;
    let cwd: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    try {
      cwd = assertSafeUiKitCwd(request.cwd, { writes });
      args = [...assertSafeUiKitArgs(request.args)];
      env = buildUiKitChildEnv(process.env, request.extraEnv ?? {});
    } catch (error) {
      reject(error);
      return;
    }
    if (request.signal?.aborted) {
      reject(new UiKitCliError('ABORTED', 'UI-kit run aborted'));
      return;
    }

    // The project is still the authorized target and still gets the
    // node_modules guard above; only the RESOLUTION moves out of it.
    const isolated = request.resolveIn === 'isolated';
    let spawnCwd = cwd;
    let scratchDir: string | null = null;
    if (isolated) {
      try {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-run-'));
        spawnCwd = scratchDir;
      } catch (error) {
        reject(
          new UiKitCliError(
            'NO_SCRATCH_DIR',
            'could not create an isolated directory to resolve the kit from: ' +
              (error instanceof Error ? error.message : String(error)),
          ),
        );
        return;
      }
      if (request.cwdFlag) args = [...args, '--cwd', cwd];
    }

    const timeoutMs =
      request.timeoutMs ??
      (writes ? UI_KIT_WRITE_TIMEOUT_MS : UI_KIT_READ_TIMEOUT_MS);
    const maxBytes = writes
      ? UI_KIT_WRITE_MAX_OUTPUT_BYTES
      : UI_KIT_READ_MAX_OUTPUT_BYTES;
    // stdout goes to a private FILE, not a pipe. Both CLIs print their JSON
    // with console.log and then call process.exit(): on a pipe Node writes
    // asynchronously and exit drops whatever has not drained, so everything
    // past 64 KiB was cut — `view dashboard-01` (77 KB) and a 200-item
    // @shadcnuikit search came back as broken JSON, and the cache kept them
    // (measured 22/10/2026). A write to a file is synchronous: the child
    // cannot exit before it lands.
    let capture: { dir: string; file: string; fd: number | null } | null = null;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-out-'));
      const file = path.join(dir, 'stdout');
      capture = { dir, file, fd: fs.openSync(file, 'wx', 0o600) };
    } catch (error) {
      if (scratchDir) {
        try {
          removeTreeSync(scratchDir);
        } catch {
          // Noise, not a failure.
        }
      }
      reject(
        new UiKitCliError(
          'NO_SCRATCH_DIR',
          'could not create a private file for the kit output: ' +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
      return;
    }

    const isWindows = process.platform === 'win32';
    const options: SpawnOptions = {
      cwd: spawnCwd,
      env,
      stdio: ['ignore', capture.fd ?? 'pipe', 'pipe'],
      detached: !isWindows,
      shell: false,
      windowsHide: isWindows,
    };

    function closeCaptureFd(): void {
      if (capture?.fd === null || capture?.fd === undefined) return;
      try {
        fs.closeSync(capture.fd);
      } catch {
        // Already closed.
      }
      capture.fd = null;
    }
    function captureSize(): number {
      if (!capture) return 0;
      try {
        return fs.statSync(capture.file).size;
      } catch {
        return 0;
      }
    }
    function readCapture(): string {
      if (!capture) return '';
      try {
        const size = Math.min(captureSize(), maxBytes);
        const buffer = Buffer.alloc(size);
        const fd = fs.openSync(capture.file, 'r');
        try {
          fs.readSync(fd, buffer, 0, size, 0);
        } finally {
          fs.closeSync(fd);
        }
        return buffer.toString('utf8');
      } catch {
        return '';
      }
    }
    function dropCapture(): void {
      closeCaptureFd();
      if (!capture) return;
      const target = capture.dir;
      capture = null;
      try {
        removeTreeSync(target);
      } catch {
        // A leftover temp dir is noise, never a reason to fail the run.
      }
    }

    function dropScratch(): void {
      if (!scratchDir) return;
      const target = scratchDir;
      scratchDir = null;
      try {
        removeTreeSync(target);
      } catch {
        // A leftover temp dir is noise, never a reason to fail the run.
      }
    }

    // Released when the child is really gone, never on a timeout alone: the
    // process group is still writing until it exits.
    let releaseWrite: () => void = () => {};
    if (writes && request.projectWriteClaimed !== true) {
      try {
        releaseWrite = claimUiKitProjectWrite(cwd);
      } catch (error) {
        dropScratch();
        dropCapture();
        reject(error);
        return;
      }
    }

    let child: ReturnType<typeof spawn>;
    try {
      const launch = resolveUiKitNpxLaunch();
      child = spawn(
        launch.command,
        [...launch.argsPrefix, '-y', UI_KIT_PACKAGES[request.kit], ...args],
        options,
      );
    } catch (error) {
      releaseWrite();
      dropScratch();
      dropCapture();
      reject(
        error instanceof UiKitCliError
          ? error
          : new UiKitCliError(
              'SPAWN_FAILED',
              `failed to spawn ${request.kit}: ` +
                (error instanceof Error ? error.message : String(error)),
            ),
      );
      return;
    }

    // The child holds its own descriptor now; ours would keep the file open.
    closeCaptureFd();

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
    // The output cap still holds with a file: a runaway child is stopped by
    // size, just not byte by byte.
    const sizeWatch = setInterval(() => {
      if (captureSize() + bytes > maxBytes) {
        fail(
          new UiKitCliError(
            'OUTPUT_TOO_LARGE',
            `${request.kit} output exceeded ${maxBytes} bytes`,
          ),
        );
      }
    }, UI_KIT_OUTPUT_WATCH_MS);
    sizeWatch.unref?.();

    function cleanup(): void {
      clearTimeout(timer);
      clearInterval(sizeWatch);
      request.signal?.removeEventListener('abort', onAbort);
      dropScratch();
      dropCapture();
    }
    function fail(error: UiKitCliError): void {
      if (settled) return;
      settled = true;
      cleanup();
      // `.catch` BEFORE `.finally`, so an EPERM from the SIGKILL cannot carry
      // its own rejection out of the derivative with no handler.
      void terminateTree(child.pid)
        .catch(() => {})
        .finally(() => {
          releaseWrite();
          reject(error);
        });
    }
    function onAbort(): void {
      fail(new UiKitCliError('ABORTED', 'UI-kit run aborted'));
    }
    function accumulate(chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes + captureSize() > maxBytes) {
        fail(
          new UiKitCliError(
            'OUTPUT_TOO_LARGE',
            `${request.kit} output exceeded ${maxBytes} bytes`,
          ),
        );
        return;
      }
      stderr += chunk.toString('utf8');
    }

    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => accumulate(chunk));
    child.once('error', (error: Error) => {
      releaseWrite();
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
      releaseWrite();
      if (settled) return;
      settled = true;
      // Read BEFORE cleanup removes the file.
      const stdout = readCapture();
      cleanup();
      resolve({ stdout, stderr, code });
    });
  });

/**
 * Containment check for a path the CALLER chose.
 *
 * Three ways past a string-only check, all found by review on this code:
 *
 * - On Windows `C:foo` is DRIVE-RELATIVE: it resolves against the current
 *   directory of drive C, not this project, and has no slash after the colon.
 * - A symlink needs no `..`. An untrusted repository that ships
 *   `components -> /etc` turns `components/ui` into a write outside, and the
 *   string looks perfectly ordinary.
 * - A DANGLING symlink is worse, not better: `existsSync` follows links, so a
 *   link to a missing target reads as "nothing here" and the walk goes past
 *   it — and then `mkdir -p` through that link CREATES the target outside.
 *
 * So this walks component by component from the project root with `lstat`
 * (which sees a link whether or not its target exists) and requires every
 * link it meets to resolve back inside. The caller must pass the exact string
 * that will reach argv: a value normalised differently here than by the
 * builder checks one path and runs another.
 */
export const UI_KIT_MAX_LINK_HOPS = 8;

export interface PathContainmentFs {
  readonly realpathSync?: (target: string) => string;
  readonly lstatSync?: (target: string) => { isSymbolicLink(): boolean };
  readonly readlinkSync?: (target: string) => string;
}

export function assertPathStaysInProject(
  projectCwd: string,
  argvPath: string,
  options: PathContainmentFs = {},
): string {
  const realpathSync = options.realpathSync ?? fs.realpathSync;
  const lstatSync =
    options.lstatSync ?? ((target: string) => fs.lstatSync(target));
  const readlinkSync = options.readlinkSync ?? fs.readlinkSync;

  if (argvPath !== argvPath.trim()) {
    // The differential itself: a builder that trims would run a different
    // path than the one checked here.
    throw new UiKitCliError(
      'PATH_NOT_NORMALIZED',
      'a target path may not have leading or trailing whitespace',
    );
  }

  let projectReal: string;
  try {
    projectReal = realpathSync(projectCwd);
  } catch {
    throw new UiKitCliError(
      'CWD_NOT_FOUND',
      `UI-kit project directory does not resolve: ${projectCwd}`,
    );
  }

  const escapes = (candidate: string): boolean => {
    const rel = path.relative(projectReal, candidate);
    return rel === '' || rel.startsWith('..') || path.isAbsolute(rel);
  };

  const target = path.resolve(projectReal, argvPath);
  if (escapes(target)) {
    throw new UiKitCliError(
      'PATH_ESCAPES_PROJECT',
      `target path resolves outside the project: ${argvPath.slice(0, 96)}`,
    );
  }

  // Walk the components. On a link, the target's OWN path is re-walked from
  // the project root rather than trusted after one string check — that was a
  // real bypass: with `a -> b/c` and `b -> /etc`, `b/c` relative-checks clean
  // while `b` is the link that leaves. Only walking `b` finds it.
  let pending = path.relative(projectReal, target).split(path.sep).filter(Boolean);
  let hops = 0;
  for (let restart = 0; restart <= UI_KIT_MAX_LINK_HOPS; restart += 1) {
    let current = projectReal;
    let hopped = false;
    for (let index = 0; index < pending.length; index += 1) {
      const segment = pending[index];
      if (segment === undefined) continue;
      current = path.join(current, segment);
      if (escapes(current)) {
        throw new UiKitCliError(
          'PATH_ESCAPES_PROJECT',
          `target path resolves outside the project: ${argvPath.slice(0, 96)}`,
        );
      }
      let stats: { isSymbolicLink(): boolean };
      try {
        stats = lstatSync(current);
      } catch {
        // Nothing from here down exists, and every component above was proven
        // inside. There is no link left to hide behind.
        return argvPath;
      }
      if (!stats.isSymbolicLink()) continue;

      hops += 1;
      if (hops > UI_KIT_MAX_LINK_HOPS) {
        throw new UiKitCliError(
          'PATH_LINK_LOOP',
          `target path goes through too many links: ${argvPath.slice(0, 96)}`,
        );
      }
      let destination: string;
      try {
        destination = readlinkSync(current);
      } catch {
        throw new UiKitCliError(
          'PATH_ESCAPES_PROJECT',
          `target path goes through an unreadable link: ${argvPath.slice(0, 96)}`,
        );
      }
      // `path.resolve` collapses `..` physically, so a link target that climbs
      // out is caught by the same containment test.
      const resolved = path.resolve(path.dirname(current), destination);
      if (escapes(resolved)) {
        throw new UiKitCliError(
          'PATH_ESCAPES_PROJECT',
          `target path leaves the project through a link: ${argvPath.slice(0, 96)}`,
        );
      }
      pending = [
        ...path.relative(projectReal, resolved).split(path.sep).filter(Boolean),
        ...pending.slice(index + 1),
      ];
      hopped = true;
      break;
    }
    if (!hopped) return argvPath;
  }
  throw new UiKitCliError(
    'PATH_LINK_LOOP',
    `target path goes through too many links: ${argvPath.slice(0, 96)}`,
  );
}
