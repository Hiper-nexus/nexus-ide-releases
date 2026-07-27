import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  authenticatedDarwinSupervisorCommand,
  currentDarwinPtySupervisorRuntime,
} from "./darwin-pty-supervisor";

export const PINNED_CODEX_CLI_VERSION = "codex-cli 0.145.0";
export const PINNED_CLAUDE_CLI_VERSION = "2.1.220 (Claude Code)";
export const PINNED_CODEX_PACKAGE_VERSION = "0.145.0";
export const OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER = "2DC432GLL2";
export const ANTHROPIC_DEVELOPER_ID_TEAM_IDENTIFIER = "Q6L2SF6YDW";
export const PINNED_CODEX_DARWIN_ARM64_CDHASH =
  "c9da028e2080a684d2c355e6f40ffc53c21ff7ee";
export const PINNED_CLAUDE_DARWIN_ARM64_CDHASH =
  "474c5a3154406ea5ee537b0a25f24f9292b1570b";

export interface DarwinTrustedExecutableSeal {
  readonly platform: "darwin";
  /** Exact physical executable path sent to posix_spawn by the supervisor. */
  readonly executablePath: string;
  readonly identifier: string;
  readonly teamIdentifier: string;
  /** Code-directory hash read from the verified Developer ID signature. */
  readonly cdHash: string;
  /** Full-file digest retained for main-side installation revocation. */
  readonly sha256: string;
}

interface BinaryIdentity {
  readonly realPath: string;
  readonly signature: string;
  readonly sha256: string;
  readonly content?: string;
}

export interface TrustedNativeConfinementLaunch {
  readonly executablePath: string;
  readonly runtimeReadPaths: readonly string[];
  readonly providerNetworkProcessPaths: readonly string[];
  readonly darwinExecutableSeal: DarwinTrustedExecutableSeal;
}

interface TrustedNativeConfinementLaunchState {
  readonly adapterId: string;
  readonly cacheKey: string;
  readonly fingerprint: string;
  readonly identities: readonly BinaryIdentity[];
}

interface SnapshotOptions {
  readonly executable?: boolean;
  readonly contentLimit?: number;
}

interface CachedSnapshot {
  readonly signature: string;
  readonly sha256: string;
  readonly content?: string;
}

interface CodexPackageTarget {
  readonly packageName: string;
  readonly target: string;
  readonly os: string;
  readonly cpu: string;
  readonly executable: string;
  readonly packageVersion: string;
}

const versionCache = new Set<string>();
const macSignatureCache = new Map<string, DarwinTrustedExecutableSeal>();
const acceptedInstallationFingerprints = new Map<string, string>();
const fileSnapshotCache = new Map<string, CachedSnapshot>();
let sealedLaunches = new WeakMap<
  TrustedNativeConfinementLaunch,
  TrustedNativeConfinementLaunchState
>();
const CODEX_NPM_PLATFORM = {
  "darwin:arm64": {
    packageName: "@openai/codex-darwin-arm64",
    target: "aarch64-apple-darwin",
    os: "darwin",
    cpu: "arm64",
    executable: "codex",
    packageVersion: "0.145.0-darwin-arm64",
  },
  "darwin:x64": {
    packageName: "@openai/codex-darwin-x64",
    target: "x86_64-apple-darwin",
    os: "darwin",
    cpu: "x64",
    executable: "codex",
    packageVersion: "0.145.0-darwin-x64",
  },
  "linux:arm64": {
    packageName: "@openai/codex-linux-arm64",
    target: "aarch64-unknown-linux-musl",
    os: "linux",
    cpu: "arm64",
    executable: "codex",
    packageVersion: "0.145.0-linux-arm64",
  },
  "linux:x64": {
    packageName: "@openai/codex-linux-x64",
    target: "x86_64-unknown-linux-musl",
    os: "linux",
    cpu: "x64",
    executable: "codex",
    packageVersion: "0.145.0-linux-x64",
  },
  "win32:arm64": {
    packageName: "@openai/codex-win32-arm64",
    target: "aarch64-pc-windows-msvc",
    os: "win32",
    cpu: "arm64",
    executable: "codex.exe",
    packageVersion: "0.145.0-win32-arm64",
  },
  "win32:x64": {
    packageName: "@openai/codex-win32-x64",
    target: "x86_64-pc-windows-msvc",
    os: "win32",
    cpu: "x64",
    executable: "codex.exe",
    packageVersion: "0.145.0-win32-x64",
  },
} as const satisfies Record<string, CodexPackageTarget>;

interface DarwinAuthenticityRoot {
  readonly identifier: string;
  readonly teamIdentifier: string;
  readonly label: string;
}

interface DarwinReleaseImageRoot {
  readonly release: string;
  readonly cdHash: string;
}

/**
 * Release trust roots. Darwin is rooted in an exact Developer ID identity and
 * is re-checked against the provider's live, trace-stopped exec image by the
 * native supervisor.
 *
 * Non-Darwin native confinement deliberately has no accepted digest roots
 * yet. Adding one here is not sufficient by itself: that platform must also
 * gain an inode/image-bound spawn primitive before qualification may open.
 */
const DARWIN_AUTHENTICITY_ROOTS = Object.freeze({
  codex: Object.freeze({
    identifier: "codex",
    teamIdentifier: OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER,
    label: "Codex",
  }),
  claude: Object.freeze({
    identifier: "com.anthropic.claude-code",
    teamIdentifier: ANTHROPIC_DEVELOPER_ID_TEAM_IDENTIFIER,
    label: "Claude",
  }),
} satisfies Record<string, DarwinAuthenticityRoot>);

/**
 * Exact release-image roots for the shipped macOS architecture. A matching
 * Developer ID Team ID is necessary but not sufficient: another binary signed
 * by the same vendor is not authorized to inherit this release's authority.
 */
const DARWIN_RELEASE_IMAGE_ROOTS = Object.freeze({
  codex: Object.freeze({
    arm64: Object.freeze({
      release: PINNED_CODEX_CLI_VERSION,
      cdHash: PINNED_CODEX_DARWIN_ARM64_CDHASH,
    }),
  }),
  claude: Object.freeze({
    arm64: Object.freeze({
      release: PINNED_CLAUDE_CLI_VERSION,
      cdHash: PINNED_CLAUDE_DARWIN_ARM64_CDHASH,
    }),
  }),
} satisfies Record<string, Readonly<Record<string, DarwinReleaseImageRoot>>>);

/**
 * Digest roots are intentionally empty until Nexus ships an image/inode-bound
 * launcher for the respective platform. A package version string is metadata,
 * not a cryptographic root; accepting it here would reopen wrapper substitution.
 */
const PINNED_NATIVE_DIGEST_ROOTS = Object.freeze({
  linux: Object.freeze({} as Readonly<Record<string, string>>),
  win32: Object.freeze({} as Readonly<Record<string, string>>),
});

const MINIMAL_DARWIN_PROBE_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty",
  TMPDIR: "/private/tmp",
  LANG: "C",
  LC_ALL: "C",
});

function statSignature(stat: fs.BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function resolvedRegularFile(
  file: string,
  options: Pick<SnapshotOptions, "executable"> = {},
): {
  readonly realPath: string;
  readonly signature: string;
} {
  let realPath: string;
  try {
    realPath = fs.realpathSync.native(file);
  } catch {
    throw new Error("native confinement executable cannot be resolved");
  }
  const stat = fs.statSync(realPath, { bigint: true });
  if (!stat.isFile()) {
    throw new Error("native confinement executable is not a regular file");
  }
  if (options.executable) {
    try {
      fs.accessSync(realPath, fs.constants.X_OK);
    } catch {
      throw new Error("native confinement executable is not executable");
    }
  }
  return {
    realPath,
    signature: statSignature(stat),
  };
}

function snapshotFile(
  file: string,
  options: SnapshotOptions = {},
): BinaryIdentity {
  const resolved = resolvedRegularFile(file, options);
  const cached = fileSnapshotCache.get(resolved.realPath);
  if (
    cached?.signature === resolved.signature &&
    (options.contentLimit === undefined || cached.content !== undefined)
  ) {
    return {
      realPath: resolved.realPath,
      signature: resolved.signature,
      sha256: cached.sha256,
      ...(cached.content === undefined ? {} : { content: cached.content }),
    };
  }

  const flags =
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);
  const descriptor = fs.openSync(resolved.realPath, flags);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || statSignature(before) !== resolved.signature) {
      throw new Error(
        "native confinement file changed while its identity was captured",
      );
    }
    if (
      options.contentLimit !== undefined &&
      before.size > BigInt(options.contentLimit)
    ) {
      throw new Error("Codex npm package metadata is invalid");
    }

    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      const slice = buffer.subarray(0, bytes);
      hash.update(slice);
      if (options.contentLimit !== undefined) {
        total += bytes;
        if (total > options.contentLimit) {
          throw new Error("Codex npm package metadata is invalid");
        }
        chunks.push(Buffer.from(slice));
      }
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = resolvedRegularFile(resolved.realPath, options);
    if (
      statSignature(after) !== resolved.signature ||
      current.signature !== resolved.signature
    ) {
      throw new Error(
        "native confinement file changed while its identity was captured",
      );
    }
    const snapshot = {
      signature: resolved.signature,
      sha256: hash.digest("hex"),
      ...(options.contentLimit === undefined
        ? {}
        : { content: Buffer.concat(chunks).toString("utf8") }),
    };
    fileSnapshotCache.set(resolved.realPath, snapshot);
    return {
      realPath: resolved.realPath,
      ...snapshot,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function identityFingerprint(identities: readonly BinaryIdentity[]): string {
  return identities
    .map(
      (identity) =>
        `${identity.realPath}\0${identity.signature}\0${identity.sha256}`,
    )
    .join("\0");
}

function assertIdentityCurrent(identity: BinaryIdentity): void {
  const current = resolvedRegularFile(identity.realPath, {
    executable: false,
  });
  if (
    current.realPath !== identity.realPath ||
    current.signature !== identity.signature
  ) {
    throw new Error(
      "native confinement installation changed after qualification",
    );
  }
  const cached = fileSnapshotCache.get(identity.realPath);
  const sha256 =
    cached?.signature === identity.signature
      ? cached.sha256
      : snapshotFile(identity.realPath).sha256;
  if (sha256 !== identity.sha256) {
    throw new Error(
      "native confinement installation hash changed after qualification",
    );
  }
}

function assertPinnedVersion(
  identity: BinaryIdentity,
  seal: DarwinTrustedExecutableSeal,
  fingerprint: string,
  expected: string,
  label: string,
): void {
  const cacheKey = `${expected}\0${seal.cdHash}\0${fingerprint}`;
  if (versionCache.has(cacheKey)) return;
  const supervisedProbe = authenticatedDarwinSupervisorCommand(
    currentDarwinPtySupervisorRuntime(__dirname),
    seal,
    ["--version"],
    { qualificationProbe: true },
  );
  const probe = spawnSync(supervisedProbe.file, supervisedProbe.args, {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: MINIMAL_DARWIN_PROBE_ENV,
    cwd: "/var/empty",
  });
  // Codex may append sandbox WARNINGs after the version line when PATH is
  // minimal (e.g. "could not create PATH aliases: Operation not permitted").
  // Only the first non-empty stdout line is the version receipt.
  const versionLine =
    (probe.stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (
    probe.error ||
    probe.status !== 0 ||
    probe.signal ||
    versionLine !== expected
  ) {
    const observed = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
    const detail = [
      probe.error ? `error=${probe.error.message}` : null,
      probe.status !== null && probe.status !== 0
        ? `status=${probe.status}`
        : null,
      probe.signal ? `signal=${probe.signal}` : null,
      versionLine
        ? `versionLine=${JSON.stringify(versionLine.slice(0, 80))}`
        : null,
      observed ? `observed=${JSON.stringify(observed.slice(0, 160))}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    throw new Error(
      `${label} native confinement requires exactly ${expected}` +
        (detail ? ` (${detail})` : ""),
    );
  }
  assertIdentityCurrent(identity);
  versionCache.add(cacheKey);
}

function pinnedDarwinReleaseImageRoot(
  adapterId: string,
  arch: NodeJS.Architecture,
): DarwinReleaseImageRoot {
  const adapterRoots:
    Readonly<Record<string, DarwinReleaseImageRoot>> | undefined =
    DARWIN_RELEASE_IMAGE_ROOTS[
      adapterId as keyof typeof DARWIN_RELEASE_IMAGE_ROOTS
    ];
  const releaseRoot = adapterRoots?.[arch];
  if (!releaseRoot) {
    throw new Error(
      `${adapterId} native confinement has no pinned release image root for ` +
        `darwin/${arch}`,
    );
  }
  return releaseRoot;
}

function belongsTo(root: string, candidate: string): boolean {
  const relative = path.relative(
    fs.realpathSync.native(root),
    fs.realpathSync.native(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function parsePackageMetadata(
  identity: BinaryIdentity,
): Record<string, unknown> {
  try {
    return JSON.parse(identity.content ?? "") as Record<string, unknown>;
  } catch {
    throw new Error("Codex npm package metadata is invalid");
  }
}

function readPinnedCodexPackage(
  packageRoot: string,
  target: CodexPackageTarget,
): BinaryIdentity {
  const packageJson = snapshotFile(pathFor(packageRoot, "package.json"), {
    contentLimit: 256 * 1024,
  });
  const parsed = parsePackageMetadata(packageJson);
  const optionalDependencies =
    parsed.optionalDependencies &&
    typeof parsed.optionalDependencies === "object" &&
    !Array.isArray(parsed.optionalDependencies)
      ? (parsed.optionalDependencies as Record<string, unknown>)
      : {};
  if (
    parsed.name !== "@openai/codex" ||
    parsed.version !== PINNED_CODEX_PACKAGE_VERSION ||
    optionalDependencies[target.packageName] !==
      `npm:@openai/codex@${target.packageVersion}`
  ) {
    throw new Error(
      `Codex native confinement requires npm package @openai/codex@${PINNED_CODEX_PACKAGE_VERSION}`,
    );
  }
  return packageJson;
}

function readPinnedCodexPlatformPackage(
  platformPackageRoot: string,
  target: CodexPackageTarget,
): BinaryIdentity {
  const packageJson = snapshotFile(
    pathFor(platformPackageRoot, "package.json"),
    { contentLimit: 256 * 1024 },
  );
  const parsed = parsePackageMetadata(packageJson);
  if (
    parsed.name !== "@openai/codex" ||
    parsed.version !== target.packageVersion ||
    !Array.isArray(parsed.os) ||
    parsed.os.length !== 1 ||
    parsed.os[0] !== target.os ||
    !Array.isArray(parsed.cpu) ||
    parsed.cpu.length !== 1 ||
    parsed.cpu[0] !== target.cpu
  ) {
    throw new Error(
      `Codex native confinement requires platform package ${target.packageName}@${target.packageVersion}`,
    );
  }
  return packageJson;
}

function pathFor(root: string, ...segments: string[]): string {
  return path.join(root, ...segments);
}

function isCodexNpmWrapper(binary: string): boolean {
  return (
    path.basename(binary) === "codex.js" &&
    path.basename(path.dirname(binary)) === "bin"
  );
}

function authenticateNativeExecutableForImmutableLaunch(
  nativeBinary: BinaryIdentity,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  adapterId: string,
): DarwinTrustedExecutableSeal {
  if (platform !== "darwin") {
    const release =
      adapterId === "codex"
        ? PINNED_CODEX_CLI_VERSION
        : adapterId === "claude"
          ? PINNED_CLAUDE_CLI_VERSION
          : "unsupported";
    const digestKey = `${adapterId}\0${release}\0${arch}`;
    const pinnedDigest =
      platform === "linux" || platform === "win32"
        ? PINNED_NATIVE_DIGEST_ROOTS[platform][digestKey]
        : undefined;
    if (pinnedDigest && pinnedDigest !== nativeBinary.sha256) {
      throw new Error(
        `${adapterId} native confinement executable does not match its ` +
          `pinned ${platform}/${arch} sha256 root`,
      );
    }
    throw new Error(
      `${adapterId} native confinement has no pinned authenticity root and ` +
        `immutable spawn primitive for ${platform}/${arch}`,
    );
  }
  const root =
    DARWIN_AUTHENTICITY_ROOTS[
      adapterId as keyof typeof DARWIN_AUTHENTICITY_ROOTS
    ];
  if (!root) {
    throw new Error(
      `adapter ${adapterId} has no pinned native confinement authenticity root`,
    );
  }
  const releaseRoot = pinnedDarwinReleaseImageRoot(adapterId, arch);
  const cacheKey = [
    adapterId,
    root.identifier,
    root.teamIdentifier,
    releaseRoot.release,
    releaseRoot.cdHash,
    nativeBinary.signature,
    nativeBinary.sha256,
  ].join("\0");
  const cached = macSignatureCache.get(cacheKey);
  if (cached) return cached;
  const requirement =
    `=identifier "${root.identifier}" and anchor apple generic and ` +
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and " +
    `certificate leaf[subject.OU] = "${root.teamIdentifier}" and ` +
    `cdhash H"${releaseRoot.cdHash}"`;
  const verification = spawnSync(
    "/usr/bin/codesign",
    [
      "--verify",
      "--strict",
      "--verbose=2",
      "--test-requirement",
      requirement,
      nativeBinary.realPath,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: MINIMAL_DARWIN_PROBE_ENV,
      cwd: "/var/empty",
    },
  );
  const display = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", nativeBinary.realPath],
    {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: MINIMAL_DARWIN_PROBE_ENV,
      cwd: "/var/empty",
    },
  );
  const identityOutput = `${display.stdout}\n${display.stderr}`;
  const identifier = /^Identifier=(.+)$/mu.exec(identityOutput)?.[1]?.trim();
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu
    .exec(identityOutput)?.[1]
    ?.trim();
  const cdHash = /^CDHash=([a-fA-F0-9]{40})$/mu
    .exec(identityOutput)?.[1]
    ?.toLowerCase();
  if (
    verification.error ||
    verification.status !== 0 ||
    verification.signal ||
    display.error ||
    display.status !== 0 ||
    display.signal ||
    identifier !== root.identifier ||
    teamIdentifier !== root.teamIdentifier ||
    cdHash !== releaseRoot.cdHash ||
    !identityOutput.includes("Authority=Developer ID Application:")
  ) {
    throw new Error(
      `${root.label} native confinement requires the official Developer ID ` +
        `${root.identifier}/${root.teamIdentifier} and release ` +
        `${releaseRoot.release} for darwin/${arch} with CDHash ` +
        releaseRoot.cdHash,
    );
  }
  assertIdentityCurrent(nativeBinary);
  const seal = Object.freeze({
    platform: "darwin" as const,
    executablePath: nativeBinary.realPath,
    identifier: root.identifier,
    teamIdentifier: root.teamIdentifier,
    cdHash,
    sha256: nativeBinary.sha256,
  });
  macSignatureCache.set(cacheKey, seal);
  return seal;
}

function resolveCodexRuntime(input: {
  readonly binary: BinaryIdentity;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}): {
  readonly identities: readonly BinaryIdentity[];
  readonly nativeBinary: BinaryIdentity;
  readonly runtimeReadPaths: readonly string[];
} {
  if (!isCodexNpmWrapper(input.binary.realPath)) {
    return {
      identities: [input.binary],
      nativeBinary: input.binary,
      runtimeReadPaths: [input.binary.realPath],
    };
  }

  const packageRoot = fs.realpathSync.native(
    path.dirname(path.dirname(input.binary.realPath)),
  );
  if (!belongsTo(packageRoot, input.binary.realPath)) {
    throw new Error("Codex npm entry point escapes its package root");
  }
  const target =
    CODEX_NPM_PLATFORM[
      `${input.platform}:${input.arch}` as keyof typeof CODEX_NPM_PLATFORM
    ];
  if (!target) {
    throw new Error(
      `Codex npm runtime is not qualified for ${input.platform}/${input.arch}`,
    );
  }
  const packageMetadata = readPinnedCodexPackage(packageRoot, target);
  const platformPackageRoot = fs.realpathSync.native(
    pathFor(packageRoot, "node_modules", ...target.packageName.split("/")),
  );
  if (!belongsTo(packageRoot, platformPackageRoot)) {
    throw new Error("Codex platform runtime escapes its pinned npm package");
  }
  const platformMetadata = readPinnedCodexPlatformPackage(
    platformPackageRoot,
    target,
  );
  const nativeBinary = snapshotFile(
    pathFor(
      platformPackageRoot,
      "vendor",
      target.target,
      "bin",
      target.executable,
    ),
    { executable: true },
  );
  if (!belongsTo(platformPackageRoot, nativeBinary.realPath)) {
    throw new Error("Codex platform runtime escapes its pinned npm package");
  }
  return {
    identities: [input.binary, packageMetadata, platformMetadata, nativeBinary],
    nativeBinary,
    // The wrapper/package tree was used only for discovery and pinning. It is
    // never executed, so the confined process needs only the native Mach-O.
    runtimeReadPaths: [nativeBinary.realPath],
  };
}

/**
 * Resolve the minimum runtime read grant for the authenticated executable.
 * npm metadata is inspected by Nexus during qualification, but only the
 * platform vendor-native executable enters the confined process argv.
 */
export function trustedNativeConfinementRuntimeReadPaths(input: {
  readonly adapterId: string;
  readonly verifiedBinaryPath: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}): string[] {
  return [
    ...qualifyTrustedNativeConfinementLaunch({
      adapterId: input.adapterId,
      requestedBinPath: input.verifiedBinaryPath,
      canonicalBinPath: input.verifiedBinaryPath,
      platform: input.platform,
      arch: input.arch,
    }).runtimeReadPaths,
  ];
}

/**
 * A settings bin override must never substitute the executable whose native
 * sandbox was qualified. Compare resolved physical files, then return only the
 * authenticated vendor-native path (never an npm wrapper).
 */
export function assertTrustedNativeConfinementBinary(input: {
  readonly adapterId: string;
  readonly requestedBinPath: string;
  readonly canonicalBinPath: string | null;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}): string {
  return qualifyTrustedNativeConfinementLaunch(input).executablePath;
}

/**
 * Qualify and seal the complete physical launch chain. For the npm Codex
 * entrypoint this is wrapper -> root package metadata -> platform package
 * metadata -> exact vendor native executable. A process may accept one
 * fingerprint per canonical installation path; an in-place CLI update must be
 * followed by a Nexus restart/rescan instead of silently inheriting governed
 * authority.
 */
export function qualifyTrustedNativeConfinementLaunch(input: {
  readonly adapterId: string;
  readonly requestedBinPath: string;
  readonly canonicalBinPath: string | null;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}): TrustedNativeConfinementLaunch {
  if (!input.canonicalBinPath) {
    throw new Error(
      `adapter ${input.adapterId} has no freshly discovered canonical executable`,
    );
  }
  const requested = snapshotFile(input.requestedBinPath, {
    executable: true,
  });
  const canonical = snapshotFile(input.canonicalBinPath, {
    executable: true,
  });
  if (requested.realPath !== canonical.realPath) {
    throw new Error(
      `adapter ${input.adapterId} executable override diverges from canonical discovery`,
    );
  }
  if (requested.signature !== canonical.signature) {
    throw new Error(
      `adapter ${input.adapterId} executable changed during confinement verification`,
    );
  }
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const runtime =
    input.adapterId === "codex"
      ? resolveCodexRuntime({ binary: canonical, platform, arch })
      : {
          identities: [canonical],
          nativeBinary: canonical,
          runtimeReadPaths: [canonical.realPath],
        };
  const fingerprint = identityFingerprint(runtime.identities);
  const cacheKey = `${input.adapterId}\0${canonical.realPath}`;
  const accepted = acceptedInstallationFingerprints.get(cacheKey);
  if (accepted !== undefined && accepted !== fingerprint) {
    throw new Error(
      `adapter ${input.adapterId} native confinement installation changed after qualification`,
    );
  }
  const darwinExecutableSeal = authenticateNativeExecutableForImmutableLaunch(
    runtime.nativeBinary,
    platform,
    arch,
    input.adapterId,
  );
  if (input.adapterId === "codex") {
    assertPinnedVersion(
      runtime.nativeBinary,
      darwinExecutableSeal,
      fingerprint,
      PINNED_CODEX_CLI_VERSION,
      "Codex",
    );
  } else if (input.adapterId === "claude") {
    assertPinnedVersion(
      runtime.nativeBinary,
      darwinExecutableSeal,
      fingerprint,
      PINNED_CLAUDE_CLI_VERSION,
      "Claude",
    );
  } else {
    throw new Error(
      `adapter ${input.adapterId} has no pinned native confinement release`,
    );
  }
  for (const identity of runtime.identities) {
    assertIdentityCurrent(identity);
  }
  acceptedInstallationFingerprints.set(cacheKey, fingerprint);

  const launch = Object.freeze({
    executablePath: runtime.nativeBinary.realPath,
    runtimeReadPaths: Object.freeze([...runtime.runtimeReadPaths]),
    providerNetworkProcessPaths: Object.freeze(
      input.adapterId === "codex" ? [runtime.nativeBinary.realPath] : [],
    ),
    darwinExecutableSeal,
  });
  sealedLaunches.set(
    launch,
    Object.freeze({
      adapterId: input.adapterId,
      cacheKey,
      fingerprint,
      identities: Object.freeze([...runtime.identities]),
    }),
  );
  return launch;
}

/**
 * Main-side revocation check for a previously sealed launch. The unavoidable
 * IPC/path interval after this check is closed on Darwin by trace-execing the
 * real provider, validating its live SecCode at the kernel-owned exec trap,
 * and detaching only after an exact match.
 */
export function revalidateTrustedNativeConfinementLaunch(
  launch: TrustedNativeConfinementLaunch,
): void {
  const state = sealedLaunches.get(launch);
  if (!state) {
    throw new Error("native confinement launch proof is missing or forged");
  }
  for (const identity of state.identities) {
    assertIdentityCurrent(identity);
  }
  if (
    identityFingerprint(state.identities) !== state.fingerprint ||
    acceptedInstallationFingerprints.get(state.cacheKey) !== state.fingerprint
  ) {
    throw new Error(
      `adapter ${state.adapterId} native confinement launch proof was revoked`,
    );
  }
}

export function clearTrustedNativeCliBinaryCacheForTests(): void {
  versionCache.clear();
  macSignatureCache.clear();
  acceptedInstallationFingerprints.clear();
  fileSnapshotCache.clear();
  sealedLaunches = new WeakMap();
}
