import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

interface SandboxScopeId {
  projectId: string;
  checkoutId: string;
}

export interface ScopedSandboxHome {
  dir: string;
  home: string;
  tmp: string;
}

export interface ScopedShellPlanInput {
  platform: NodeJS.Platform;
  command: string;
  cwd: string;
  rootRealPath: string;
  sandboxDir: string;
  env: NodeJS.ProcessEnv;
}

export interface ScopedShellPlan {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
}

export interface ScopedExecPlanInput {
  platform: NodeJS.Platform;
  executable: string;
  args: readonly string[];
  cwd: string;
  rootRealPath: string;
  sandboxDir: string;
  env: NodeJS.ProcessEnv;
  /** Sensors/review commands set this so validation can never mutate code. */
  readOnlyRoot?: boolean;
}

interface NormalizedExecPlanInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly rootRealPath: string;
  readonly sandboxDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readOnlyRoot: boolean;
}

const MACOS_DENIED_READ_ROOTS = [
  '/Users',
  '/Volumes',
  '/private/tmp',
  '/private/var/tmp',
  '/private/var/folders',
];

const NODE_TOOL_NAMES = new Set([
  'node',
  'npm',
  'npx',
  'corepack',
  'pnpm',
  'yarn',
]);

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function createScopedSandboxHome(
  scope: SandboxScopeId,
): ScopedSandboxHome {
  const prefix = `nexus-agent-${shortHash(
    `${scope.projectId}\0${scope.checkoutId}`,
  )}-`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  ensurePrivateDir(home);
  ensurePrivateDir(tmp);
  return { dir, home, tmp };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

function ancestorMetadataReadRules(target: string): string[] {
  const rules: string[] = [];
  let current = path.resolve(target);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rules.push(`(literal ${sbplString(parent)})`);
    current = parent;
  }
  return rules;
}

function existingRealPath(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function nodeRuntimeRoot(target: string): string | null {
  const nodeModulesMarker = `${path.sep}node_modules${path.sep}`;
  const nodeModulesIndex = target.lastIndexOf(nodeModulesMarker);
  if (nodeModulesIndex >= 0) {
    const packageStart = nodeModulesIndex + nodeModulesMarker.length;
    const packageEnd = target.indexOf(path.sep, packageStart);
    if (packageEnd > packageStart) return target.slice(0, packageEnd);
  }

  const binMarker = `${path.sep}bin${path.sep}`;
  const binIndex = target.lastIndexOf(binMarker);
  return binIndex > 0 ? target.slice(0, binIndex) : null;
}

/**
 * Permit only the executable lookup directories supplied to the child. When a
 * PATH entry is a symlink farm, Seatbelt evaluates the resolved target too, so
 * individual targets are included. Node package-manager runtimes need their
 * adjacent library tree; that exception is intentionally limited to known
 * Node tool names instead of exposing an entire user toolchain home.
 */
function collectToolchainReadRules(envPath: string | undefined): string[] {
  const rules = new Set<string>();
  const pathEntries = (envPath ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .slice(0, 128);

  for (const entry of pathEntries) {
    const dir = existingRealPath(entry);
    if (!dir) continue;
    rules.add(`(subpath ${sbplString(dir)})`);

    let names: string[];
    try {
      names = fs.readdirSync(dir).slice(0, 2_048);
    } catch {
      continue;
    }
    for (const name of names) {
      const target = existingRealPath(path.join(dir, name));
      if (!target) continue;
      rules.add(`(literal ${sbplString(target)})`);
      if (NODE_TOOL_NAMES.has(name)) {
        const runtimeRoot = nodeRuntimeRoot(target);
        if (runtimeRoot) rules.add(`(subpath ${sbplString(runtimeRoot)})`);
      }
    }
  }
  return [...rules];
}

function buildMacosProfile(
  rootRealPath: string,
  sandboxDir: string,
  envPath: string | undefined,
  readOnlyRoot = false,
): string {
  const deniedReads = MACOS_DENIED_READ_ROOTS.map(
    (root) => `(subpath ${sbplString(root)})`,
  ).join(' ');
  const allowedReads = [
    // Runtimes resolve an absolute cwd by lstat-ing each parent. Permit only
    // parent directory metadata, not their contents, before granting the
    // project subtree itself.
    ...ancestorMetadataReadRules(rootRealPath),
    ...ancestorMetadataReadRules(sandboxDir),
    `(subpath ${sbplString(rootRealPath)})`,
    `(subpath ${sbplString(sandboxDir)})`,
    ...collectToolchainReadRules(envPath),
  ].join(' ');
  const allowedWrites = [
    ...(readOnlyRoot ? [] : [`(subpath ${sbplString(rootRealPath)})`]),
    `(subpath ${sbplString(sandboxDir)})`,
    '(literal "/dev/null")',
    '(literal "/dev/tty")',
  ].join(' ');

  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* ${allowedWrites})`,
    `(deny file-read* ${deniedReads})`,
    `(allow file-read* ${allowedReads})`,
  ].join(' ');
}

export function buildScopedShellPlan(
  input: ScopedShellPlanInput,
): ScopedShellPlan {
  if (input.command.includes('\0')) throw new Error('sandbox command contains NUL');
  return buildScopedExecPlan({
    platform: input.platform,
    executable: '/bin/sh',
    args: ['-c', input.command],
    cwd: input.cwd,
    rootRealPath: input.rootRealPath,
    sandboxDir: input.sandboxDir,
    env: input.env,
  });
}

function normalizeExecPlan(input: ScopedExecPlanInput): NormalizedExecPlanInput {
  if (
    input.executable.length === 0 ||
    input.executable.length > 4_096 ||
    input.executable.includes('\0')
  ) {
    throw new Error('invalid sandbox executable');
  }
  if (
    input.args.length > 1_024 ||
    input.args.some((arg) => arg.length > 65_536 || arg.includes('\0'))
  ) {
    throw new Error('invalid sandbox argv');
  }
  const rootRealPath = fs.realpathSync(input.rootRealPath);
  const cwd = fs.realpathSync(input.cwd);
  const sandboxDir = fs.realpathSync(input.sandboxDir);
  if (!isWithin(rootRealPath, cwd)) {
    throw new Error('sandbox cwd escapes project checkout');
  }
  if (isWithin(rootRealPath, sandboxDir) || isWithin(sandboxDir, rootRealPath)) {
    throw new Error('sandbox private runtime must be disjoint from the project checkout');
  }

  const home = path.join(sandboxDir, 'home');
  const tmp = path.join(sandboxDir, 'tmp');
  ensurePrivateDir(home);
  ensurePrivateDir(tmp);
  return Object.freeze({
    executable: input.executable,
    args: Object.freeze([...input.args]),
    cwd,
    rootRealPath,
    sandboxDir,
    env: Object.freeze({
      ...input.env,
      HOME: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
    }),
    readOnlyRoot: input.readOnlyRoot === true,
  });
}

const LINUX_MASKED_ROOTS = [
  '/home',
  '/root',
  '/tmp',
  '/var/tmp',
  '/run/user',
  '/mnt',
  '/media',
] as const;

function linuxBindArgs(
  source: string,
  maskedRoots: readonly string[],
  createdDirectories: Set<string>,
  readOnly = false,
): string[] {
  const matchingRoot = [...maskedRoots]
    .filter((candidate) => isWithin(candidate, source))
    .sort((left, right) => right.length - left.length)[0];
  const args: string[] = [];
  if (matchingRoot && source !== matchingRoot) {
    const parents: string[] = [];
    let current = path.dirname(source);
    while (current !== matchingRoot && isWithin(matchingRoot, current)) {
      parents.push(current);
      current = path.dirname(current);
    }
    for (const directory of parents.reverse()) {
      if (createdDirectories.has(directory)) continue;
      createdDirectories.add(directory);
      args.push('--dir', directory);
    }
  }
  args.push(readOnly ? '--ro-bind' : '--bind', source, source);
  return args;
}

function linuxPlan(
  input: NormalizedExecPlanInput,
  bubblewrapExecutable: string,
): ScopedShellPlan {
  if (!path.isAbsolute(bubblewrapExecutable) || bubblewrapExecutable.includes('\0')) {
    throw new Error('invalid Bubblewrap provider path');
  }
  const maskedRoots = LINUX_MASKED_ROOTS.filter((candidate) =>
    candidate === '/home' || candidate === '/tmp' || fs.existsSync(candidate),
  );
  // `--unshare-all` then `--share-net`: full isolation except the network
  // namespace. Nested user namespaces on GitHub-hosted runners cannot create
  // the loopback interface (`RTM_NEWADDR: Operation not permitted`), which
  // made every sandboxed agent/terminal command fail in CI. Sharing the host
  // net keeps the rest of the confinement (user/pid/mount/uts/ipc/cgroup).
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--share-net',
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--dev', '/dev',
  ];
  for (const maskedRoot of maskedRoots) args.push('--tmpfs', maskedRoot);
  const createdDirectories = new Set<string>();
  args.push(...linuxBindArgs(input.rootRealPath, maskedRoots, createdDirectories, input.readOnlyRoot));
  args.push(...linuxBindArgs(input.sandboxDir, maskedRoots, createdDirectories));
  args.push(
    '--chdir', input.cwd,
    '--cap-drop', 'ALL',
    '--',
    input.executable,
    ...input.args,
  );
  return {
    file: bubblewrapExecutable,
    args,
    cwd: input.cwd,
    env: { ...input.env },
    detached: true,
  };
}

/** Pure Linux plan builder used by capability tests and distribution Doctor. */
export function buildLinuxBubblewrapPlan(
  input: ScopedExecPlanInput,
  bubblewrapExecutable: string,
): ScopedShellPlan {
  if (input.platform !== 'linux') throw new Error('Bubblewrap requires the linux platform');
  return linuxPlan(normalizeExecPlan(input), bubblewrapExecutable);
}

function macosPlan(
  input: NormalizedExecPlanInput,
  seatbeltExecutable: string,
): ScopedShellPlan {
  if (!path.isAbsolute(seatbeltExecutable) || seatbeltExecutable.includes('\0')) {
    throw new Error('invalid Seatbelt provider path');
  }
  return {
    file: seatbeltExecutable,
    args: [
      '-p',
      buildMacosProfile(
        input.rootRealPath,
        input.sandboxDir,
        input.env.PATH,
        input.readOnlyRoot,
      ),
      input.executable,
      ...input.args,
    ],
    cwd: input.cwd,
    env: { ...input.env },
    detached: true,
  };
}

const OCI_IMAGE_PATTERN = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/i;

function windowsOciPlan(
  input: NormalizedExecPlanInput,
  runtimeExecutable: string,
  image: string,
): ScopedShellPlan {
  if (!path.isAbsolute(runtimeExecutable) || runtimeExecutable.includes('\0')) {
    throw new Error('invalid Windows OCI sandbox runtime path');
  }
  if (!OCI_IMAGE_PATTERN.test(image)) {
    throw new Error('Windows sandbox image must be pinned by sha256 digest');
  }
  if ([input.rootRealPath, input.sandboxDir].some((value) => /[,\r\n\0]/.test(value))) {
    throw new Error('Windows OCI mount path contains unsupported delimiters');
  }
  const relativeCwd = path.relative(input.rootRealPath, input.cwd).replaceAll('\\', '/');
  const executableName = path.basename(input.executable).replace(/\.(?:cmd|exe)$/i, '');
  return {
    file: runtimeExecutable,
    args: [
      'run', '--rm', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '512', '--memory', '4g',
      '--mount', `type=bind,src=${input.rootRealPath},dst=/workspace${input.readOnlyRoot ? ',readonly' : ''}`,
      '--mount', `type=bind,src=${input.sandboxDir},dst=/nexus-runtime`,
      '--workdir', relativeCwd ? `/workspace/${relativeCwd}` : '/workspace',
      '--env', 'HOME=/nexus-runtime/home', '--env', 'TMPDIR=/nexus-runtime/tmp',
      '--env', 'CI=true', '--env', 'NO_COLOR=1',
      image, executableName, ...input.args,
    ],
    cwd: input.cwd,
    env: { PATH: input.env.PATH ?? '' },
    detached: true,
  };
}

/** Pure Windows OCI plan builder used by distribution and security tests. */
export function buildWindowsOciPlan(
  input: ScopedExecPlanInput,
  runtimeExecutable: string,
  image: string,
): ScopedShellPlan {
  if (input.platform !== 'win32') throw new Error('OCI Windows sandbox requires win32');
  return windowsOciPlan(normalizeExecPlan(input), runtimeExecutable, image);
}

/** Pure macOS plan builder used by cross-platform capability tests. */
export function buildMacosSeatbeltPlan(
  input: ScopedExecPlanInput,
  seatbeltExecutable: string,
): ScopedShellPlan {
  if (input.platform !== 'darwin') {
    throw new Error('Seatbelt requires the darwin platform');
  }
  return macosPlan(normalizeExecPlan(input), seatbeltExecutable);
}

function installedBubblewrap(): string | null {
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isFile()) {
        fs.accessSync(real, fs.constants.X_OK);
        return real;
      }
    } catch {
      // Try the next fixed provider path.
    }
  }
  return null;
}

/** Build a confined process plan whose argv is never interpreted by a shell. */
export function buildScopedExecPlan(
  input: ScopedExecPlanInput,
): ScopedShellPlan {
  const normalized = normalizeExecPlan(input);
  if (input.platform === 'linux') {
    const provider = installedBubblewrap();
    if (!provider) {
      throw new Error('secure process sandbox provider is unavailable on linux (install bubblewrap)');
    }
    return linuxPlan(normalized, provider);
  }
  if (input.platform === 'win32') {
    const runtime = process.env.NEXUS_SANDBOX_CONTAINER_RUNTIME?.trim();
    const image = process.env.NEXUS_SANDBOX_CONTAINER_IMAGE?.trim();
    if (!runtime || !image) {
      throw new Error('secure process sandbox provider is unavailable on win32; configure NEXUS_SANDBOX_CONTAINER_RUNTIME and a digest-pinned NEXUS_SANDBOX_CONTAINER_IMAGE');
    }
    const realRuntime = fs.realpathSync(runtime);
    fs.accessSync(realRuntime, fs.constants.X_OK);
    return windowsOciPlan(normalized, realRuntime, image);
  }
  if (input.platform !== 'darwin') {
    throw new Error(
      `secure process sandbox provider is unavailable on ${input.platform}`,
    );
  }
  if (!fs.existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('secure process sandbox provider is unavailable on darwin');
  }
  return macosPlan(normalized, '/usr/bin/sandbox-exec');
}
