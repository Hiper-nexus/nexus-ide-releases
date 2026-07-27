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

/**
 * Sandbox profiles (grok-build tool-sandbox idea):
 * - workspace-only: path confined, network denied (macOS Seatbelt default)
 * - workspace-net: path confined, network allowed (npm, curl to APIs)
 * - yolo: same confinement as workspace-net (never escapes checkout); name
 *   matches operator "full tool" mode, not host-wide root access.
 */
export type SandboxProfile = 'workspace-only' | 'workspace-net' | 'yolo';

/**
 * Explicit profile wins. When omitted:
 * - macOS / Windows → workspace-only (deny network)
 * - Linux → workspace-net (bwrap needs host net on many CI runners)
 */
export function resolveSandboxProfile(
  profile: SandboxProfile | undefined,
  platform: NodeJS.Platform = process.platform,
): SandboxProfile {
  if (
    profile === 'workspace-net' ||
    profile === 'yolo' ||
    profile === 'workspace-only'
  ) {
    return profile;
  }
  return platform === 'linux' ? 'workspace-net' : 'workspace-only';
}

export function sandboxAllowsNetwork(profile: SandboxProfile): boolean {
  return profile === 'workspace-net' || profile === 'yolo';
}

export interface ScopedShellPlanInput {
  platform: NodeJS.Platform;
  command: string;
  cwd: string;
  rootRealPath: string;
  sandboxDir: string;
  env: NodeJS.ProcessEnv;
  /** Default workspace-only (deny net on macOS). */
  sandboxProfile?: SandboxProfile;
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
  /** Optional pre-created private HOME within sandboxDir. */
  privateHome?: string;
  /** Optional pre-created private temp directory within sandboxDir. */
  privateTmp?: string;
  /** Sensors/review commands set this so validation can never mutate code. */
  readOnlyRoot?: boolean;
  sandboxProfile?: SandboxProfile;
  /**
   * Existing provider-state paths required by the sandboxed parent process.
   * These are canonicalized before entering the profile; child sandboxes still
   * intersect this outer authority with their own narrower policy.
   */
  extraReadPaths?: readonly string[];
  /** Existing provider-state paths the parent process must persist. */
  extraWritePaths?: readonly string[];
  /**
   * Exact trusted executables that may use the network while the inherited
   * sandbox keeps every other descendant offline. macOS only.
   */
  networkAllowedProcessPaths?: readonly string[];
  /**
   * Lexical and canonical control roots that remain non-writable even under a
   * writable checkout. Paths may be absent when the profile is compiled.
   */
  protectedWritePaths?: readonly string[];
}

interface NormalizedExecPlanInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly rootRealPath: string;
  readonly sandboxDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readOnlyRoot: boolean;
  readonly sandboxProfile: SandboxProfile;
  readonly extraReadPaths: readonly string[];
  readonly extraWritePaths: readonly string[];
  readonly networkAllowedProcessPaths: readonly string[];
  readonly protectedWritePaths: readonly string[];
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
export const MACOS_SEATBELT_EXECUTABLE = '/usr/bin/sandbox-exec';

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

function canonicalPotentialPath(candidate: string): string {
  const suffix: string[] = [];
  let ancestor = candidate;
  for (;;) {
    try {
      return path.join(
        fs.realpathSync.native(ancestor),
        ...suffix.reverse(),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error('sandbox path has no resolvable filesystem ancestor');
    }
    suffix.push(path.basename(ancestor));
    ancestor = parent;
  }
}

function canonicalExistingPaths(
  values: readonly string[] | undefined,
  label: string,
): string[] {
  const canonical = new Set<string>();
  for (const raw of values ?? []) {
    if (!path.isAbsolute(raw) || raw.includes('\0')) {
      throw new Error(`${label} must contain absolute NUL-free paths`);
    }
    let real: string;
    try {
      real = fs.realpathSync.native(raw);
    } catch {
      throw new Error(`${label} path must already exist`);
    }
    canonical.add(real);
  }
  return [...canonical].sort();
}

function normalizedProtectedWritePaths(
  values: readonly string[] | undefined,
): string[] {
  const normalized = new Set<string>();
  for (const raw of values ?? []) {
    if (!path.isAbsolute(raw) || raw.includes('\0')) {
      throw new Error(
        'protected write roots must contain absolute NUL-free paths',
      );
    }
    const resolved = path.resolve(raw);
    if (path.dirname(resolved) === resolved) {
      throw new Error('refusing to protect a filesystem root as a subpath');
    }
    // Preserve the lexical entry as well as its physical target. If the
    // protected root is itself a symlink, protecting only realpath(raw) would
    // still permit unlinking/replacing that directory entry inside an
    // otherwise writable checkout.
    normalized.add(resolved);
    // The protected leaf may not exist yet (that is the TOCTOU case). Resolve
    // the nearest existing ancestor so aliases such as /var -> /private/var
    // cannot make an absent control directory miss its Seatbelt rule.
    const suffix: string[] = [];
    let ancestor = resolved;
    for (;;) {
      try {
        const canonicalAncestor = fs.realpathSync.native(ancestor);
        const canonical = path.join(
          canonicalAncestor,
          ...suffix.reverse(),
        );
        if (path.dirname(canonical) === canonical) {
          throw new Error(
            'refusing to protect a filesystem root as a subpath',
          );
        }
        normalized.add(canonical);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw new Error(
          'protected write root has no resolvable filesystem ancestor',
        );
      }
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return [...normalized].sort();
}

function pathAccessRule(candidate: string): string {
  let directory = false;
  try {
    directory = fs.statSync(candidate).isDirectory();
  } catch {
    // Supplemental read/write paths are canonicalized existing paths. Keep a
    // literal fallback so an identity race never widens the grant.
  }
  return `(${directory ? 'subpath' : 'literal'} ${sbplString(candidate)})`;
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
  allowNetwork = false,
  extraReadPaths: readonly string[] = [],
  extraWritePaths: readonly string[] = [],
  networkAllowedProcessPaths: readonly string[] = [],
  protectedWritePaths: readonly string[] = [],
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
    ...extraReadPaths.flatMap((candidate) => [
      ...ancestorMetadataReadRules(candidate),
      pathAccessRule(candidate),
    ]),
    ...collectToolchainReadRules(envPath),
  ].join(' ');
  const allowedWrites = [
    ...(readOnlyRoot ? [] : [`(subpath ${sbplString(rootRealPath)})`]),
    `(subpath ${sbplString(sandboxDir)})`,
    ...extraWritePaths.map(pathAccessRule),
    '(literal "/dev/null")',
    '(literal "/dev/tty")',
  ].join(' ');
  const deniedControlWrites = protectedWritePaths
    .flatMap((candidate) => [
      `(literal ${sbplString(candidate)})`,
      `(subpath ${sbplString(candidate)})`,
    ])
    .join(' ');
  const processScopedNetworkRules = networkAllowedProcessPaths.map(
    (candidate) =>
      `(with-filter (process-path ${sbplString(candidate)}) ` +
      '(allow network*))',
  );

  return [
    '(version 1)',
    '(allow default)',
    // workspace-only denies network; workspace-net / yolo allow it.
    allowNetwork ? '(allow network*)' : '(deny network*)',
    ...processScopedNetworkRules,
    '(deny file-write*)',
    `(allow file-write* ${allowedWrites})`,
    ...(deniedControlWrites
      ? [`(deny file-write* ${deniedControlWrites})`]
      : []),
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
    sandboxProfile: input.sandboxProfile,
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

  const lexicalSandboxDir = path.resolve(input.sandboxDir);
  const requestedHome = path.resolve(
    input.privateHome ?? path.join(lexicalSandboxDir, 'home'),
  );
  const requestedTmp = path.resolve(
    input.privateTmp ?? path.join(lexicalSandboxDir, 'tmp'),
  );
  if (
    !isWithin(lexicalSandboxDir, requestedHome) ||
    !isWithin(lexicalSandboxDir, requestedTmp)
  ) {
    throw new Error(
      'sandbox private HOME and temp must remain inside its runtime directory',
    );
  }
  if (
    !isWithin(sandboxDir, canonicalPotentialPath(requestedHome)) ||
    !isWithin(sandboxDir, canonicalPotentialPath(requestedTmp))
  ) {
    throw new Error(
      'sandbox private HOME or temp resolves outside its runtime directory',
    );
  }
  ensurePrivateDir(requestedHome);
  ensurePrivateDir(requestedTmp);
  const home = fs.realpathSync.native(requestedHome);
  const tmp = fs.realpathSync.native(requestedTmp);
  if (!isWithin(sandboxDir, home) || !isWithin(sandboxDir, tmp)) {
    throw new Error(
      'sandbox private HOME or temp resolves outside its runtime directory',
    );
  }
  const sandboxProfile = resolveSandboxProfile(
    input.sandboxProfile,
    input.platform,
  );
  const networkAllowedProcessPaths = canonicalExistingPaths(
    input.networkAllowedProcessPaths,
    'network-allowed process paths',
  );
  if (
    sandboxAllowsNetwork(sandboxProfile) &&
    networkAllowedProcessPaths.length > 0
  ) {
    throw new Error(
      'process-scoped network authority cannot be combined with broad network access',
    );
  }
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
    sandboxProfile,
    extraReadPaths: Object.freeze(
      canonicalExistingPaths(input.extraReadPaths, 'extra read roots'),
    ),
    extraWritePaths: Object.freeze(
      canonicalExistingPaths(input.extraWritePaths, 'extra write roots'),
    ),
    networkAllowedProcessPaths: Object.freeze(
      networkAllowedProcessPaths,
    ),
    protectedWritePaths: Object.freeze(
      normalizedProtectedWritePaths(input.protectedWritePaths),
    ),
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
  if (
    input.extraReadPaths.length > 0 ||
    input.extraWritePaths.length > 0 ||
    input.networkAllowedProcessPaths.length > 0 ||
    input.protectedWritePaths.length > 0
  ) {
    throw new Error(
      'supplemental process sandbox roots are unavailable on linux',
    );
  }
  const maskedRoots = LINUX_MASKED_ROOTS.filter((candidate) =>
    candidate === '/home' || candidate === '/tmp' || fs.existsSync(candidate),
  );
  // `--unshare-all` then optional `--share-net`. Nested user namespaces on
  // GitHub-hosted runners cannot create loopback without share-net, so the
  // default for workspace-net/yolo (and Linux CI) keeps host net. workspace-only
  // omits --share-net for stricter isolation when the profile requests it.
  const allowNet = sandboxAllowsNetwork(input.sandboxProfile);
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    ...(allowNet ? ['--share-net'] : []),
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
        sandboxAllowsNetwork(input.sandboxProfile),
        input.extraReadPaths,
        input.extraWritePaths,
        input.networkAllowedProcessPaths,
        input.protectedWritePaths,
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
  if (
    input.extraReadPaths.length > 0 ||
    input.extraWritePaths.length > 0 ||
    input.networkAllowedProcessPaths.length > 0 ||
    input.protectedWritePaths.length > 0
  ) {
    throw new Error(
      'supplemental process sandbox roots are unavailable on win32',
    );
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
      'run', '--rm',
      '--network', sandboxAllowsNetwork(input.sandboxProfile) ? 'bridge' : 'none',
      '--read-only',
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

function installedMacosSeatbelt(): string {
  let real: string;
  try {
    real = fs.realpathSync.native(MACOS_SEATBELT_EXECUTABLE);
  } catch {
    throw new Error(
      'secure process sandbox provider is unavailable on darwin',
    );
  }
  const stat = fs.statSync(real);
  if (
    real !== MACOS_SEATBELT_EXECUTABLE ||
    !stat.isFile() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(
      'macOS sandbox provider must be the canonical root-owned system binary',
    );
  }
  fs.accessSync(real, fs.constants.X_OK);
  return real;
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
  return macosPlan(normalized, installedMacosSeatbelt());
}
