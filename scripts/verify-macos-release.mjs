import { spawnSync } from "node:child_process";
import { listPackage } from "@electron/asar";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_BUNDLE_ID = "com.nexuside.app";
export const DEFAULT_SIGNING_IDENTITY =
  "Developer ID Application: Cleofas Pereira rocha";
export const RESPONSIBILITY_SUPERVISOR_NAME = "nexus-pty-supervisor";
const CS_RUNTIME_FLAG = 0x10000;
const SUPPORTED_MACHO_ARCHITECTURES = new Set(["arm64", "x86_64"]);

const REQUIRED_FUSES = [
  "RunAsNode is Disabled",
  "EnableCookieEncryption is Enabled",
  "EnableNodeOptionsEnvironmentVariable is Disabled",
  "EnableNodeCliInspectArguments is Disabled",
  "EnableEmbeddedAsarIntegrityValidation is Enabled",
  "OnlyLoadAppFromAsar is Enabled",
  "GrantFileProtocolExtraPrivileges is Disabled",
];
const RELEASE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function assertRequiredElectronFuses(output) {
  const fuses = stripVTControlCharacters(String(output));
  for (const required of REQUIRED_FUSES) {
    if (!fuses.includes(required)) {
      throw new Error(`required Electron fuse missing: ${required}`);
    }
  }
}

export function buildFusesReadInvocation(appPath, root = RELEASE_ROOT) {
  return {
    command: process.execPath,
    args: [
      path.join(
        path.resolve(root),
        "node_modules",
        "@electron",
        "fuses",
        "dist",
        "bin.js",
      ),
      "read",
      "--app",
      appPath,
    ],
  };
}

function exactlyOne(paths, extension, label) {
  const matches = paths.filter((candidate) =>
    candidate.toLowerCase().endsWith(extension),
  );
  if (matches.length !== 1) {
    throw new Error(
      `release must contain exactly one ${label}; found ${matches.length}`,
    );
  }
  return matches[0];
}

export function assertReleaseArtifacts(paths) {
  return {
    dmg: exactlyOne(paths, ".dmg", "DMG"),
    zip: exactlyOne(paths, ".zip", "ZIP (required by Squirrel.Mac updater)"),
  };
}

export function parseCodesignMetadata(output) {
  const authorities = [];
  let identifier = "";
  let teamIdentifier = "";
  let secureTimestamp = "";
  let signedTime = "";
  let codeDirectoryFlags = 0;
  let codeDirectoryFlagNames = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("Identifier=")) {
      identifier = line.slice("Identifier=".length).trim();
    }
    if (line.startsWith("Authority=")) {
      authorities.push(line.slice("Authority=".length).trim());
    }
    if (line.startsWith("TeamIdentifier=")) {
      teamIdentifier = line.slice("TeamIdentifier=".length).trim();
    }
    if (line.startsWith("Timestamp=")) {
      secureTimestamp = line.slice("Timestamp=".length).trim();
    }
    if (line.startsWith("Signed Time=")) {
      signedTime = line.slice("Signed Time=".length).trim();
    }
    // `codesign -dv --verbose=4` also emits an `Executable Segment flags=`
    // line after CodeDirectory. Only CodeDirectory carries the signature
    // flags (including CS_RUNTIME); accepting the later segment flags would
    // overwrite a valid hardened-runtime result with its execution bits.
    const flags = line.startsWith("CodeDirectory ")
      ? /\bflags=0x([0-9a-f]+)(?:\(([^)]*)\))?/iu.exec(line)
      : null;
    if (flags) {
      codeDirectoryFlags = Number.parseInt(flags[1], 16);
      codeDirectoryFlagNames = (flags[2] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    }
  }
  return {
    identifier,
    authorities,
    teamIdentifier,
    secureTimestamp,
    signedTime,
    codeDirectoryFlags,
    codeDirectoryFlagNames,
  };
}

export function assertSignatureMetadata(metadata, teamId, identityName) {
  const expectedAuthority = `${identityName} (${teamId})`;
  if (metadata.teamIdentifier !== teamId) {
    throw new Error(
      `codesign TeamIdentifier mismatch: expected ${teamId}, got ${metadata.teamIdentifier || "<missing>"}`,
    );
  }
  if (metadata.authorities[0] !== expectedAuthority) {
    throw new Error(
      `codesign Authority mismatch: expected ${expectedAuthority}, got ${metadata.authorities[0] || "<missing>"}`,
    );
  }
  if (!metadata.secureTimestamp) {
    throw new Error(
      "codesign secure Timestamp is missing" +
        (metadata.signedTime ? "; Signed Time is not a secure timestamp" : ""),
    );
  }
}

export function expectedEntitlementKeysForPath(filePath, appPath) {
  const normalized = filePath.replaceAll("\\", "/");
  const normalizedApp = appPath.replaceAll("\\", "/").replace(/\/$/u, "");

  const isBundleExecutable = (bundleName) => {
    const executableName = bundleName.slice(0, -".app".length);
    return normalized.endsWith(
      `/${bundleName}/Contents/MacOS/${executableName}`,
    );
  };

  if (isBundleExecutable("NexusIDE Helper (Plugin).app")) {
    return ["com.apple.security.cs.allow-unsigned-executable-memory"];
  }
  if (isBundleExecutable("NexusIDE Helper (Renderer).app")) {
    return [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.device.audio-input",
    ];
  }
  if (
    isBundleExecutable("NexusIDE Helper.app") ||
    isBundleExecutable("NexusIDE Helper (GPU).app")
  ) {
    return ["com.apple.security.cs.allow-jit"];
  }
  if (normalized === `${normalizedApp}/Contents/MacOS/nexus-ide`) {
    return [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.device.audio-input",
    ];
  }
  return [];
}

export function assertPackagedSmokeOutput(output, platform = process.platform) {
  const required = [
    "[smoke] renderer-mounted",
    "[smoke] functional-ready",
    "[smoke] shutdown-complete",
  ];
  if (platform === "darwin") {
    required.push("[smoke] darwin-pty-supervisor-ready");
  }
  for (const proof of required) {
    if (!output.includes(proof)) {
      throw new Error(`artifact smoke lacked ${proof} proof`);
    }
  }
}

export function parseLipoArchitectures(output) {
  const normalized = String(output).trim();
  if (!normalized) {
    throw new Error("lipo did not report any Mach-O architectures");
  }
  const architectures = normalized.split(/\s+/u);
  const unsupported = [
    ...new Set(
      architectures.filter(
        (architecture) => !SUPPORTED_MACHO_ARCHITECTURES.has(architecture),
      ),
    ),
  ].sort();
  if (unsupported.length !== 0) {
    throw new Error(
      `lipo reported unsupported Mach-O architecture(s): ` +
        unsupported.join(", "),
    );
  }
  const seen = new Set();
  const duplicates = [
    ...new Set(
      architectures.filter((architecture) => {
        if (seen.has(architecture)) return true;
        seen.add(architecture);
        return false;
      }),
    ),
  ].sort();
  if (duplicates.length !== 0) {
    throw new Error(
      `lipo reported duplicate Mach-O architecture(s): ` +
        duplicates.join(", "),
    );
  }
  return [...architectures].sort();
}

export function buildCodesignSliceInvocations(binaryPath, architectures) {
  const expectedArchitectures = parseLipoArchitectures(architectures.join(" "));
  return expectedArchitectures.map((architecture) => ({
    architecture,
    verify: {
      command: "/usr/bin/codesign",
      args: [
        "--verify",
        "--strict",
        "--verbose=2",
        "-a",
        architecture,
        binaryPath,
      ],
    },
    metadata: {
      command: "/usr/bin/codesign",
      args: ["-dv", "--verbose=4", "-a", architecture, binaryPath],
    },
    entitlements: {
      command: "/usr/bin/codesign",
      args: [
        "-d",
        "--entitlements",
        "-",
        "--xml",
        "-a",
        architecture,
        binaryPath,
      ],
    },
  }));
}

export function expectedMachOArchitecturesForPath(
  candidate,
  appPath,
  expectedArchitecture,
) {
  const responsibilitySupervisor = path.join(
    path.resolve(appPath),
    "Contents",
    "Resources",
    RESPONSIBILITY_SUPERVISOR_NAME,
  );
  if (path.resolve(candidate) === responsibilitySupervisor) {
    return ["arm64", "x86_64"];
  }
  return [expectedArchitecture];
}

export function assertSingleResponsibilitySupervisorPath(paths, appPath) {
  const expected = path.join(
    path.resolve(appPath),
    "Contents",
    "Resources",
    RESPONSIBILITY_SUPERVISOR_NAME,
  );
  const normalized = paths.map((candidate) => path.resolve(candidate));
  if (normalized.length !== 1 || normalized[0] !== expected) {
    throw new Error(
      `release must contain exactly one ${RESPONSIBILITY_SUPERVISOR_NAME} ` +
        `at ${expected}; found ${normalized.join(", ") || "<none>"}`,
    );
  }
  return expected;
}

export function assertNoBundledNodePtySpawnHelpers(paths) {
  const forbidden = paths.filter(
    (candidate) => path.basename(candidate) === "spawn-helper",
  );
  if (forbidden.length !== 0) {
    throw new Error(
      `release contains forbidden node-pty spawn-helper entries: ` +
        forbidden.join(", "),
    );
  }
}

export function assertResponsibilitySupervisorSignatureMetadata(
  metadata,
  teamId,
  identityName,
) {
  assertSignatureMetadata(metadata, teamId, identityName);
  if (metadata.identifier !== RESPONSIBILITY_SUPERVISOR_NAME) {
    throw new Error(
      `responsibility supervisor Identifier mismatch: expected ` +
        `${RESPONSIBILITY_SUPERVISOR_NAME}, got ` +
        `${metadata.identifier || "<missing>"}`,
    );
  }
  if ((metadata.codeDirectoryFlags & CS_RUNTIME_FLAG) !== CS_RUNTIME_FLAG) {
    throw new Error(
      "responsibility supervisor is missing the hardened runtime code flag",
    );
  }
}

export function assertMatchingReleaseArchitectures(
  dmgArchitectures,
  zipArchitectures,
  expectedArchitecture,
) {
  const dmg = [...dmgArchitectures].sort();
  const zip = [...zipArchitectures].sort();
  if (JSON.stringify(dmg) !== JSON.stringify(zip)) {
    throw new Error(
      `DMG and ZIP architecture mismatch: DMG=${dmg.join(",")} ZIP=${zip.join(",")}`,
    );
  }
  if (dmg.length !== 1 || dmg[0] !== expectedArchitecture) {
    throw new Error(
      `release is single-architecture for this host: expected only ` +
        `${expectedArchitecture}, got ${dmg.join(",") || "<none>"}`,
    );
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

async function collectRegularFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile()) {
        files.push(candidate);
      }
    }
  }
  await visit(root);
  return files;
}

async function collectEntriesNamed(root, name) {
  const matches = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.name === name) matches.push(candidate);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(candidate);
      }
    }
  }
  await visit(root);
  return matches;
}

async function discoverArtifacts(root) {
  const candidates = await collectRegularFiles(root);
  return assertReleaseArtifacts(candidates);
}

async function findSingleApp(root) {
  const apps = [];
  async function visit(directory, depth) {
    if (depth > 3) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.name === "NexusIDE.app") {
        apps.push(candidate);
      } else {
        await visit(candidate, depth + 1);
      }
    }
  }
  await visit(root, 0);
  if (apps.length !== 1) {
    throw new Error(
      `expected exactly one NexusIDE.app in ${root}; found ${apps.length}`,
    );
  }
  return apps[0];
}

function readPlistValue(infoPlist, key) {
  return runChecked("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlist,
  ]).stdout.trim();
}

function readEntitlements(binaryPath, invocation) {
  const command = invocation?.command ?? "/usr/bin/codesign";
  const args = invocation?.args ?? [
    "-d",
    "--entitlements",
    "-",
    "--xml",
    binaryPath,
  ];
  const xml = runChecked(command, args).stdout.trim();
  if (!xml) return {};
  const json = runChecked(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    { input: xml },
  ).stdout;
  return JSON.parse(json);
}

function assertExactEntitlements(
  binaryPath,
  appPath,
  invocation,
  architecture = "",
) {
  const actual = Object.keys(readEntitlements(binaryPath, invocation)).sort();
  const expected = expectedEntitlementKeysForPath(binaryPath, appPath).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `entitlements mismatch for ${binaryPath}` +
        `${architecture ? ` [${architecture}]` : ""}: expected ` +
        `${expected.join(", ") || "<none>"}; got ` +
        `${actual.join(", ") || "<none>"}`,
    );
  }
}

function verifyCodesignSlices(
  binaryPath,
  appPath,
  signing,
  architectures,
  assertMetadata,
) {
  for (const invocation of buildCodesignSliceInvocations(
    binaryPath,
    architectures,
  )) {
    runChecked(invocation.verify.command, invocation.verify.args);
    const metadata = parseCodesignMetadata(
      runChecked(invocation.metadata.command, invocation.metadata.args)
        .combined,
    );
    assertMetadata(metadata, signing.teamId, signing.identityName);
    assertExactEntitlements(
      binaryPath,
      appPath,
      invocation.entitlements,
      invocation.architecture,
    );
  }
}

async function verifyResponsibilitySupervisor(appPath, signing) {
  const supervisorPath = assertSingleResponsibilitySupervisorPath(
    await collectEntriesNamed(appPath, RESPONSIBILITY_SUPERVISOR_NAME),
    appPath,
  );
  const stats = await fs.lstat(supervisorPath);
  const expectedRealPath = path.join(
    await fs.realpath(appPath),
    "Contents",
    "Resources",
    RESPONSIBILITY_SUPERVISOR_NAME,
  );
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o111) === 0 ||
    (await fs.realpath(supervisorPath)) !== expectedRealPath
  ) {
    throw new Error(
      "responsibility supervisor must be one exact regular executable file",
    );
  }
  const fileType = runChecked("/usr/bin/file", ["-b", supervisorPath]).stdout;
  if (!fileType.includes("Mach-O")) {
    throw new Error("responsibility supervisor is not a Mach-O executable");
  }
  const architectures = parseLipoArchitectures(
    runChecked("/usr/bin/lipo", ["-archs", supervisorPath]).stdout,
  );
  if (JSON.stringify(architectures) !== JSON.stringify(["arm64", "x86_64"])) {
    throw new Error(
      `responsibility supervisor must be universal arm64+x86_64; got ` +
        `${architectures.join(",") || "<none>"}`,
    );
  }
  runChecked("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    supervisorPath,
  ]);
  const metadata = parseCodesignMetadata(
    runChecked("/usr/bin/codesign", ["-dv", "--verbose=4", supervisorPath])
      .combined,
  );
  assertResponsibilitySupervisorSignatureMetadata(
    metadata,
    signing.teamId,
    signing.identityName,
  );
  assertExactEntitlements(supervisorPath, appPath);
  return supervisorPath;
}

async function verifyMachOBinaries(appPath, signing, expectedArchitecture) {
  const responsibilitySupervisor = await verifyResponsibilitySupervisor(
    appPath,
    signing,
  );
  const files = await collectRegularFiles(appPath);
  let count = 0;
  let responsibilitySupervisorIdentityCount = 0;
  for (const candidate of files) {
    const fileType = runChecked("/usr/bin/file", ["-b", candidate]).stdout;
    if (!fileType.includes("Mach-O")) continue;
    const architectures = parseLipoArchitectures(
      runChecked("/usr/bin/lipo", ["-archs", candidate]).stdout,
    );
    const expectedArchitectures = expectedMachOArchitecturesForPath(
      candidate,
      appPath,
      expectedArchitecture,
    );
    if (
      JSON.stringify(architectures) !== JSON.stringify(expectedArchitectures)
    ) {
      throw new Error(
        `Mach-O architecture mismatch for ${candidate}: expected exactly ` +
          `${expectedArchitectures.join(",")}, got ` +
          `${architectures.join(",") || "<none>"}`,
      );
    }
    count += 1;
    runChecked("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      candidate,
    ]);
    const metadata = parseCodesignMetadata(
      runChecked("/usr/bin/codesign", ["-dv", "--verbose=4", candidate])
        .combined,
    );
    if (metadata.identifier === RESPONSIBILITY_SUPERVISOR_NAME) {
      responsibilitySupervisorIdentityCount += 1;
      if (path.resolve(candidate) !== responsibilitySupervisor) {
        throw new Error(
          `responsibility supervisor identity was copied outside its exact path: ${candidate}`,
        );
      }
    }
    assertSignatureMetadata(metadata, signing.teamId, signing.identityName);
    assertExactEntitlements(candidate, appPath);
    verifyCodesignSlices(
      candidate,
      appPath,
      signing,
      expectedArchitectures,
      path.resolve(candidate) === responsibilitySupervisor
        ? assertResponsibilitySupervisorSignatureMetadata
        : assertSignatureMetadata,
    );
  }
  if (count === 0) throw new Error(`no Mach-O files found in ${appPath}`);
  if (responsibilitySupervisorIdentityCount !== 1) {
    throw new Error(
      `release must contain exactly one signed responsibility supervisor; ` +
        `found ${responsibilitySupervisorIdentityCount}`,
    );
  }
}

async function verifyApp(appPath, expected, signing) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const bundleId = readPlistValue(infoPlist, "CFBundleIdentifier");
  const version = readPlistValue(infoPlist, "CFBundleShortVersionString");
  if (bundleId !== expected.bundleId) {
    throw new Error(
      `bundle ID mismatch: expected ${expected.bundleId}, got ${bundleId}`,
    );
  }
  if (version !== expected.version) {
    throw new Error(
      `bundle version mismatch: expected ${expected.version}, got ${version}`,
    );
  }
  assertNoBundledNodePtySpawnHelpers([
    ...(await collectEntriesNamed(appPath, "spawn-helper")),
    ...listPackage(path.join(appPath, "Contents", "Resources", "app.asar"))
      .filter((entry) =>
        /(?:^|\/)spawn-helper$/u.test(entry.replaceAll("\\", "/")),
      )
      .map((entry) => `app.asar:${entry}`),
  ]);

  runChecked("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  assertSignatureMetadata(
    parseCodesignMetadata(
      runChecked("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]).combined,
    ),
    signing.teamId,
    signing.identityName,
  );
  runChecked("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=2",
    appPath,
  ]);
  runChecked("/usr/bin/xcrun", ["stapler", "validate", appPath]);
  await verifyMachOBinaries(appPath, signing, expected.architecture);

  const fuseRead = buildFusesReadInvocation(appPath);
  const fuses = runChecked(fuseRead.command, fuseRead.args).combined;
  assertRequiredElectronFuses(fuses);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const smoke = runChecked(process.execPath, [
    path.join(scriptDir, "smoke-packaged-app.mjs"),
    "--app",
    appPath,
  ]).combined;
  assertPackagedSmokeOutput(smoke, "darwin");
  const mainExecutable = path.join(appPath, "Contents", "MacOS", "nexus-ide");
  return parseLipoArchitectures(
    runChecked("/usr/bin/lipo", ["-archs", mainExecutable]).stdout,
  );
}

function verifyDmgContainer(dmgPath, signing) {
  runChecked("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    dmgPath,
  ]);
  assertSignatureMetadata(
    parseCodesignMetadata(
      runChecked("/usr/bin/codesign", ["-dv", "--verbose=4", dmgPath]).combined,
    ),
    signing.teamId,
    signing.identityName,
  );
  runChecked("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=2",
    dmgPath,
  ]);
  runChecked("/usr/bin/xcrun", ["stapler", "validate", dmgPath]);
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function assertConfiguration({
  version,
  teamId,
  identityName,
  bundleId,
  architecture,
}) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`invalid release version: ${version || "<missing>"}`);
  }
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error(`invalid Apple Team ID: ${teamId || "<missing>"}`);
  }
  if (
    !identityName.startsWith("Developer ID Application: ") ||
    /[\r\n]/u.test(identityName)
  ) {
    throw new Error("invalid expected signing identity");
  }
  if (bundleId !== DEFAULT_BUNDLE_ID) {
    throw new Error(`unexpected bundle ID configuration: ${bundleId}`);
  }
  if (architecture !== "arm64" && architecture !== "x86_64") {
    throw new Error(`invalid release architecture: ${architecture}`);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS release verification must run on macOS");
  }
  const args = parseArgs(process.argv.slice(2));
  const artifactsRoot = path.resolve(args.artifacts ?? "out/make");
  const expected = {
    version: args.version ?? "",
    bundleId: args["bundle-id"] ?? DEFAULT_BUNDLE_ID,
    architecture:
      args.arch ?? (process.arch === "x64" ? "x86_64" : process.arch),
  };
  const signing = {
    teamId: args["team-id"] ?? process.env.APPLE_TEAM_ID ?? "",
    identityName: args.identity ?? DEFAULT_SIGNING_IDENTITY,
  };
  assertConfiguration({ ...expected, ...signing });

  const artifacts = await discoverArtifacts(artifactsRoot);
  verifyDmgContainer(artifacts.dmg, signing);

  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nexus-release-verify-"),
  );
  const mountPoint = path.join(temporaryRoot, "dmg");
  const zipRoot = path.join(temporaryRoot, "zip");
  let isMounted = false;
  try {
    await fs.mkdir(mountPoint);
    await fs.mkdir(zipRoot);
    runChecked("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPoint,
      artifacts.dmg,
    ]);
    isMounted = true;
    const dmgArchitectures = await verifyApp(
      await findSingleApp(mountPoint),
      expected,
      signing,
    );
    runChecked("/usr/bin/ditto", ["-x", "-k", artifacts.zip, zipRoot]);
    const zipArchitectures = await verifyApp(
      await findSingleApp(zipRoot),
      expected,
      signing,
    );
    assertMatchingReleaseArchitectures(
      dmgArchitectures,
      zipArchitectures,
      expected.architecture,
    );
  } finally {
    if (isMounted) {
      try {
        runChecked("/usr/bin/hdiutil", ["detach", "-force", mountPoint]);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }

  console.log(`verified DMG: ${artifacts.dmg}`);
  console.log(`verified updater ZIP: ${artifacts.zip}`);
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
