import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import * as nodePty from "@lydell/node-pty";
import {
  authenticatedDarwinSupervisorCommand,
  currentDarwinPtySupervisorRuntime,
  DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
  DARWIN_PTY_PROVIDER_PROBE_MODE,
  DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
  DARWIN_PTY_STAGE_ZERO_SOURCE,
  DARWIN_PTY_SUPERVISOR_NAME,
  isProvenDarwinPtySupervisorExit,
  NEXUS_UTILITY_HELPER_IDENTIFIER,
  resolveDarwinPtySupervisor,
  resolvePackagedDarwinPtySmokeProviderSeal,
  satisfiesPackagedDarwinAdHocSmokeSignaturePolicy,
  satisfiesPackagedDarwinRuntimeOwnershipPolicy,
  satisfiesPackagedDarwinSupervisorSignaturePolicy,
  supervisedPtyCommand,
} from "./darwin-pty-supervisor";
import type { DarwinAdHocSmokeExecutableSeal } from "./darwin-pty-supervisor";
import type { DarwinTrustedExecutableSeal } from "./trusted-native-cli-binary";
import { darwinNodePtyBootstrapLaunch } from "./darwin-node-pty-bootstrap";

const temporaryDirectories: string[] = [];
const activeProcessGroups = new Set<number>();
const activePtys = new Map<number, nodePty.IPty>();
const EXPECTED_DEVELOPER_IDENTITY =
  "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)";
const EXPECTED_TEAM_IDENTIFIER = "35P5XL3JN6";
const hasExpectedDeveloperIdentity =
  process.platform === "darwin" &&
  spawnSync(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8" },
  ).stdout.includes(EXPECTED_DEVELOPER_IDENTITY);
const sealedCodex: DarwinTrustedExecutableSeal = Object.freeze({
  platform: "darwin",
  executablePath: "/opt/vendor/codex",
  identifier: "codex",
  teamIdentifier: "2DC432GLL2",
  cdHash: "c9da028e2080a684d2c355e6f40ffc53c21ff7ee",
  sha256: "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
});
const sealedAdHocSmokeProvider: DarwinAdHocSmokeExecutableSeal = Object.freeze({
  platform: "darwin",
  executablePath:
    "/Applications/NexusIDE.app/Contents/Resources/nexus-pty-supervisor",
  identifier: "nexus-pty-supervisor",
  teamIdentifier: null,
  cdHash: "1111111111111111111111111111111111111111",
  sha256: "2".repeat(64),
  trustProfile: DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
});

function temporaryRuntime() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-darwin-supervisor-unit-"),
  );
  temporaryDirectories.push(root);
  const resourcesPath = path.join(root, "Resources");
  fs.mkdirSync(resourcesPath, { recursive: true });
  const cwd = path.join(root, "cwd");
  const helper = path.join(
    cwd,
    "resources",
    "native",
    "darwin",
    DARWIN_PTY_SUPERVISOR_NAME,
  );
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  return {
    root,
    resourcesPath,
    helper,
    runtime: {
      platform: "darwin" as const,
      packaged: false,
      resourcesPath,
      cwd,
      moduleDir: path.join(root, "module"),
    },
  };
}

function installSignedDevelopmentHelper(helper: string): {
  readonly realPath: string;
  readonly cdHash: string;
} {
  fs.copyFileSync("/usr/bin/true", helper);
  fs.chmodSync(helper, 0o755);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "nexus-pty-supervisor",
    helper,
  ]);
  const metadata = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", helper],
    { encoding: "utf8" },
  );
  const output = `${metadata.stdout}\n${metadata.stderr}`;
  const cdHash = /^CDHash=([a-f0-9]{40})$/imu.exec(output)?.[1];
  if (!cdHash) throw new Error("signed helper fixture has no CDHash");
  return { realPath: fs.realpathSync(helper), cdHash };
}

function stageZeroArgs(
  helper: { readonly realPath: string; readonly cdHash: string },
  helperArgs: readonly string[],
  timeoutSeconds = 0,
  teamIdentifier = "-",
): string[] {
  return [
    "-T",
    "-e",
    DARWIN_PTY_STAGE_ZERO_SOURCE,
    "--",
    "--helper",
    helper.realPath,
    "--identifier",
    "nexus-pty-supervisor",
    "--team-id",
    teamIdentifier,
    "--cdhash",
    helper.cdHash,
    "--timeout-seconds",
    String(timeoutSeconds),
    "--",
    ...helperArgs,
  ];
}

function readDarwinCdHash(executable: string): string {
  const metadata = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", executable],
    { encoding: "utf8" },
  );
  const output = `${metadata.stdout}\n${metadata.stderr}`;
  const cdHash = /^CDHash=([a-f0-9]{40})$/imu.exec(output)?.[1];
  if (!cdHash) throw new Error(`signed fixture has no CDHash: ${executable}`);
  return cdHash;
}

function createPackagedNativeSmokeHelper(
  defines: readonly string[] = [],
): {
  readonly root: string;
  readonly realPath: string;
  readonly cdHash: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-darwin-local-smoke-"),
  );
  temporaryDirectories.push(root);
  const helper = path.join(
    root,
    "NexusIDE.app",
    "Contents",
    "Resources",
    DARWIN_PTY_SUPERVISOR_NAME,
  );
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  buildNativeDevelopmentHelper(helper, defines);
  return {
    root,
    realPath: fs.realpathSync(helper),
    cdHash: readDarwinCdHash(helper),
  };
}

function buildNativeDevelopmentHelper(
  helper: string,
  defines: readonly string[] = [],
): void {
  execFileSync("xcrun", [
    "--sdk",
    "macosx",
    "clang",
    "-arch",
    process.arch === "x64" ? "x86_64" : "arm64",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wpedantic",
    "-mmacosx-version-min=11.0",
    ...defines.map((define) => `-D${define}`),
    path.join(process.cwd(), "native", "darwin-pty-supervisor", "main.c"),
    "-lproc",
    "-framework",
    "CoreFoundation",
    "-framework",
    "Security",
    "-o",
    helper,
  ]);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "nexus-pty-supervisor",
    "--timestamp=none",
    helper,
  ]);
}

function buildAdHocMarkerExecutable(source: string, output: string): void {
  fs.writeFileSync(
    source,
    [
      "#include <fcntl.h>",
      "#include <stdlib.h>",
      "#include <unistd.h>",
      "__attribute__((constructor)) static void mark(void) {",
      '  const char *path = getenv("NEXUS_STAGE0_SWAP_MARKER");',
      "  if (path == 0) return;",
      "  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);",
      '  if (fd >= 0) { (void)write(fd, "executed", 8); close(fd); }',
      "}",
      "int main(void) { return 0; }",
    ].join("\n"),
  );
  execFileSync("xcrun", [
    "--sdk",
    "macosx",
    "clang",
    "-arch",
    process.arch === "x64" ? "x86_64" : "arm64",
    source,
    "-o",
    output,
  ]);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "nexus-pty-supervisor",
    output,
  ]);
}

function waitForValue<T>(read: () => T | false, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = read();
        if (value !== false) {
          resolve(value);
          return;
        }
      } catch {
        // Process/file state can be between atomic transitions.
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for stage-zero fixture"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupAbsence(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processGroupExists(processGroupId);
}

async function cleanupProcessGroup(processGroupId: number): Promise<void> {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) return;
  try {
    if (!processGroupExists(processGroupId)) return;
    signalProcessGroup(processGroupId, "SIGTERM");
    if (await waitForProcessGroupAbsence(processGroupId, 3_500)) return;
    signalProcessGroup(processGroupId, "SIGKILL");
    signalProcessGroup(processGroupId, "SIGCONT");
    await waitForProcessGroupAbsence(processGroupId, 2_000);
  } finally {
    activeProcessGroups.delete(processGroupId);
  }
}

async function cleanupPty(terminal: nodePty.IPty | undefined): Promise<void> {
  if (!terminal) return;
  const pid = terminal.pid;
  try {
    if (processGroupExists(pid)) {
      try {
        if (processExists(pid)) {
          terminal.kill("SIGTERM");
        } else {
          signalProcessGroup(pid, "SIGTERM");
        }
      } catch {
        // It may have exited between the liveness check and the signal.
      }
      if (!(await waitForProcessGroupAbsence(pid, 3_500))) {
        signalProcessGroup(pid, "SIGKILL");
        signalProcessGroup(pid, "SIGCONT");
        await waitForProcessGroupAbsence(pid, 2_000);
      }
    }
  } finally {
    activePtys.delete(pid);
  }
}

function collectSpawn(
  file: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completion: Promise<{
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly pid: number;
  }>;
} {
  const child = spawn(file, [...args], {
    ...options,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid) activeProcessGroups.add(child.pid);
  const completion = new Promise<{
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly pid: number;
  }>((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.once("error", reject);
    child.once("exit", (status, signal) =>
      resolve({
        status,
        signal,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        pid: child.pid ?? 0,
      }),
    );
  });
  return { child, completion };
}

function createSignedApplicationFixture(): {
  readonly appRoot: string;
  readonly resourcesPath: string;
  readonly helper: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-darwin-supervisor-app-"),
  );
  temporaryDirectories.push(root);
  const appRoot = path.join(root, "NexusIDE.app");
  const contents = path.join(appRoot, "Contents");
  const resourcesPath = path.join(contents, "Resources");
  const macos = path.join(contents, "MacOS");
  const utilityContents = path.join(
    contents,
    "Frameworks",
    "NexusIDE Helper.app",
    "Contents",
  );
  const utilityMacos = path.join(utilityContents, "MacOS");
  const utilityExecutable = path.join(utilityMacos, "NexusIDE Helper");
  const helper = path.join(resourcesPath, DARWIN_PTY_SUPERVISOR_NAME);
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(utilityMacos, { recursive: true });
  fs.copyFileSync("/usr/bin/true", helper);
  fs.copyFileSync("/usr/bin/true", path.join(macos, "nexus-ide"));
  fs.copyFileSync("/usr/bin/true", utilityExecutable);
  fs.chmodSync(helper, 0o755);
  fs.chmodSync(path.join(macos, "nexus-ide"), 0o755);
  fs.chmodSync(utilityExecutable, 0o755);
  fs.writeFileSync(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.nexuside.app</string>
<key>CFBundleExecutable</key><string>nexus-ide</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  );
  fs.writeFileSync(
    path.join(utilityContents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.nexuside.app.helper</string>
<key>CFBundleExecutable</key><string>NexusIDE Helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  );
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "nexus-pty-supervisor",
    helper,
  ]);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.nexuside.app.helper",
    path.dirname(utilityContents),
  ]);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.nexuside.app",
    appRoot,
  ]);
  return { appRoot, resourcesPath, helper };
}

afterEach(async () => {
  for (const terminal of [...activePtys.values()]) {
    await cleanupPty(terminal);
  }
  for (const processGroupId of [...activeProcessGroups]) {
    await cleanupProcessGroup(processGroupId);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Darwin PTY responsibility supervisor resolution", () => {
  it("selects development and packaged verification modes from the main module location", () => {
    expect(
      currentDarwinPtySupervisorRuntime(
        path.join(process.cwd(), ".vite", "build"),
      ).packaged,
    ).toBe(false);
    expect(
      currentDarwinPtySupervisorRuntime(
        path.join(
          "/Applications/NexusIDE.app/Contents/Resources",
          "app.asar",
          ".vite",
          "build",
        ),
      ).packaged,
    ).toBe(true);
    expect(
      currentDarwinPtySupervisorRuntime(
        path.join(
          "/Applications/NexusIDE.app/Contents/Resources",
          "app.asar",
          ".vite",
          "build",
        ),
        DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
      ).trustProfile,
    ).toBe(DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE);
  });

  it("wraps an absolute command with the fixed development helper protocol", () => {
    const { helper, runtime } = temporaryRuntime();
    const signedHelper = installSignedDevelopmentHelper(helper);

    expect(supervisedPtyCommand(runtime, "/usr/bin/true", ["--flag"])).toEqual({
      file: "/usr/bin/perl",
      args: stageZeroArgs(signedHelper, [
        "supervise",
        "--",
        "/usr/bin/true",
        "--flag",
      ]),
    });
  });

  it("places the authenticated supervisor inside the existing Seatbelt plan", () => {
    const { helper, runtime } = temporaryRuntime();
    const signedHelper = installSignedDevelopmentHelper(helper);
    const profile =
      "(version 1)(allow default)(deny network*)" +
      '(with-filter (process-path "/opt/vendor/codex")(allow network*))';

    expect(
      supervisedPtyCommand(
        runtime,
        "/usr/bin/sandbox-exec",
        ["-p", profile, sealedCodex.executablePath, "--version"],
        sealedCodex,
      ),
    ).toEqual({
      file: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        profile,
        "/usr/bin/perl",
        ...stageZeroArgs(signedHelper, [
          "supervise-authenticated",
          "--identifier",
          "codex",
          "--team-id",
          "2DC432GLL2",
          "--cdhash",
          "c9da028e2080a684d2c355e6f40ffc53c21ff7ee",
          "--",
          "/opt/vendor/codex",
          "--version",
        ]),
      ],
    });
  });

  it("builds qualification probes through the live authenticated barrier", () => {
    const { helper, runtime } = temporaryRuntime();
    const signedHelper = installSignedDevelopmentHelper(helper);

    expect(
      authenticatedDarwinSupervisorCommand(
        runtime,
        sealedCodex,
        ["--version"],
        { qualificationProbe: true },
      ),
    ).toEqual({
      file: "/usr/bin/perl",
      args: stageZeroArgs(
        signedHelper,
        [
          "supervise-authenticated",
          "--identifier",
          "codex",
          "--team-id",
          "2DC432GLL2",
          "--cdhash",
          "c9da028e2080a684d2c355e6f40ffc53c21ff7ee",
          "--",
          "/opt/vendor/codex",
          "--version",
        ],
        2,
      ),
    });
  });

  it("seals a direct Darwin provider launch before node-pty", () => {
    const { helper, runtime } = temporaryRuntime();
    const signedHelper = installSignedDevelopmentHelper(helper);

    expect(
      supervisedPtyCommand(
        runtime,
        sealedCodex.executablePath,
        ["--version"],
        sealedCodex,
      ),
    ).toEqual({
      file: "/usr/bin/perl",
      args: stageZeroArgs(signedHelper, [
        "supervise-authenticated",
        "--identifier",
        "codex",
        "--team-id",
        "2DC432GLL2",
        "--cdhash",
        "c9da028e2080a684d2c355e6f40ffc53c21ff7ee",
        "--",
        "/opt/vendor/codex",
        "--version",
      ]),
    });
  });

  it("rejects a target mismatch or malformed live-code seal before node-pty", () => {
    const { helper, runtime } = temporaryRuntime();
    installSignedDevelopmentHelper(helper);

    expect(() =>
      supervisedPtyCommand(
        runtime,
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", "/tmp/substitute"],
        sealedCodex,
      ),
    ).toThrow(/does not target the sealed executable/i);
    expect(() =>
      supervisedPtyCommand(runtime, sealedCodex.executablePath, [], {
        ...sealedCodex,
        cdHash: "not-a-cdhash",
      }),
    ).toThrow(/seal is malformed/i);
  });

  it("fails closed when the Darwin helper is absent or not executable", () => {
    const { helper, runtime } = temporaryRuntime();
    expect(() => resolveDarwinPtySupervisor(runtime)).toThrow(
      /missing, non-executable/i,
    );

    fs.writeFileSync(helper, "fixture", { mode: 0o644 });
    expect(() => resolveDarwinPtySupervisor(runtime)).toThrow(
      /missing, non-executable/i,
    );
  });

  it("never mints a packaged smoke provider seal from a development helper", () => {
    const { helper, runtime } = temporaryRuntime();
    installSignedDevelopmentHelper(helper);
    expect(() => resolvePackagedDarwinPtySmokeProviderSeal(runtime)).toThrow(
      /requires the packaged Nexus helper/i,
    );
  });

  it("does not admit an ad-hoc seal without the local smoke profile or for another command", () => {
    const packagedRuntime = {
      platform: "darwin" as const,
      packaged: true,
      resourcesPath: "/Applications/NexusIDE.app/Contents/Resources",
      cwd: "/tmp",
      moduleDir:
        "/Applications/NexusIDE.app/Contents/Resources/app.asar/.vite/build",
    };
    expect(() =>
      supervisedPtyCommand(
        packagedRuntime,
        sealedAdHocSmokeProvider.executablePath,
        [DARWIN_PTY_PROVIDER_PROBE_MODE],
        sealedAdHocSmokeProvider,
      ),
    ).toThrow(/restricted to the packaged local smoke provider probe/i);
    const smokeRuntime = {
      ...packagedRuntime,
      trustProfile: DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
    };
    expect(() =>
      supervisedPtyCommand(
        smokeRuntime,
        sealedAdHocSmokeProvider.executablePath,
        ["inventory"],
        sealedAdHocSmokeProvider,
      ),
    ).toThrow(/restricted to the packaged Nexus helper probe/i);
    expect(() =>
      supervisedPtyCommand(
        smokeRuntime,
        sealedCodex.executablePath,
        ["--version"],
        sealedCodex,
      ),
    ).toThrow(/restricted to the packaged Nexus helper probe/i);
    expect(() =>
      authenticatedDarwinSupervisorCommand(
        smokeRuntime,
        sealedCodex,
        ["--version"],
      ),
    ).toThrow(/cannot enter the general authenticated CLI launcher/i);
  });

  it("rejects symlinks and never accepts an environment-selected helper", () => {
    const { root, helper, runtime } = temporaryRuntime();
    const outside = path.join(root, "outside-helper");
    fs.writeFileSync(outside, "fixture", { mode: 0o755 });
    fs.symlinkSync(outside, helper);

    expect(() => resolveDarwinPtySupervisor(runtime)).toThrow(
      /regular application-owned file/i,
    );
  });

  it("preserves direct node-pty spawn semantics off Darwin", () => {
    expect(
      supervisedPtyCommand(
        {
          platform: "linux",
          packaged: false,
          cwd: "/tmp",
          moduleDir: "/app",
        },
        "/bin/bash",
        ["-l"],
      ),
    ).toEqual({ file: "/bin/bash", args: ["-l"] });
    expect(() =>
      supervisedPtyCommand(
        {
          platform: "linux",
          packaged: false,
          cwd: "/tmp",
          moduleDir: "/app",
        },
        sealedCodex.executablePath,
        [],
        sealedCodex,
      ),
    ).toThrow(/no immutable launcher/i);
  });

  it("rejects relative or NUL-bearing Darwin commands before spawn", () => {
    const { runtime } = temporaryRuntime();
    expect(() => supervisedPtyCommand(runtime, "bash", [])).toThrow(
      /absolute/i,
    );
    expect(() => supervisedPtyCommand(runtime, "/bin/ba\0sh", [])).toThrow(
      /NUL-free/i,
    );
  });

  it("accepts only normal helper exit as a responsibility proof receipt", () => {
    expect(isProvenDarwinPtySupervisorExit({ exitCode: 143, signal: 0 })).toBe(
      false,
    );
    expect(isProvenDarwinPtySupervisorExit({ exitCode: 137 })).toBe(false);
    expect(isProvenDarwinPtySupervisorExit({ exitCode: 159 })).toBe(false);
    expect(isProvenDarwinPtySupervisorExit({ exitCode: 128 })).toBe(true);
    expect(isProvenDarwinPtySupervisorExit({ exitCode: 23 })).toBe(true);
    expect(isProvenDarwinPtySupervisorExit({ exitCode: 124 })).toBe(true);
    expect(isProvenDarwinPtySupervisorExit({ exitCode: 125 })).toBe(true);
    expect(isProvenDarwinPtySupervisorExit({ exitCode: 0, signal: 9 })).toBe(
      false,
    );
    expect(
      isProvenDarwinPtySupervisorExit({ exitCode: null, signal: null }),
    ).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "rejects an ad-hoc-signed helper and app in packaged mode",
    () => {
      const { resourcesPath, helper } = createSignedApplicationFixture();
      const runtime = {
        platform: "darwin" as const,
        packaged: true,
        resourcesPath,
        cwd: path.join(path.dirname(resourcesPath), "untrusted-cwd"),
        moduleDir: path.join(resourcesPath, "app.asar", ".vite", "build"),
      };
      expect(() => resolveDarwinPtySupervisor(runtime)).toThrow(
        /Team ID 35P5XL3JN6/i,
      );
      expect(fs.existsSync(helper)).toBe(true);
    },
  );

  it("requires exact release identifiers, requirements, and Team IDs", () => {
    const helper = {
      identifier: "nexus-pty-supervisor",
      teamIdentifier: "35P5XL3JN6",
      designatedRequirement:
        'identifier "nexus-pty-supervisor" and anchor apple generic ' +
        "and certificate leaf[subject.OU] = 35P5XL3JN6",
    };
    const app = {
      identifier: "com.nexuside.app",
      teamIdentifier: "35P5XL3JN6",
      designatedRequirement:
        'identifier "com.nexuside.app" and anchor apple generic ' +
        "and certificate leaf[subject.OU] = 35P5XL3JN6",
    };
    expect(satisfiesPackagedDarwinSupervisorSignaturePolicy(helper, app)).toBe(
      true,
    );
    expect(
      satisfiesPackagedDarwinSupervisorSignaturePolicy(
        { ...helper, teamIdentifier: null },
        app,
      ),
    ).toBe(false);
    expect(
      satisfiesPackagedDarwinSupervisorSignaturePolicy(helper, {
        ...app,
        teamIdentifier: "AAAAAAAAAA",
      }),
    ).toBe(false);
  });

  it("accepts only an entirely ad-hoc packaged smoke chain", () => {
    const helper = {
      identifier: "nexus-pty-supervisor",
      teamIdentifier: null,
      cdHash: "a".repeat(40),
      designatedRequirement: `cdhash H"${"a".repeat(40)}"`,
    };
    const app = {
      identifier: "com.nexuside.app",
      teamIdentifier: null,
      cdHash: "b".repeat(40),
      designatedRequirement: `cdhash H"${"b".repeat(40)}"`,
    };
    const utility = {
      identifier: NEXUS_UTILITY_HELPER_IDENTIFIER,
      teamIdentifier: null,
      cdHash: "c".repeat(40),
      designatedRequirement: `cdhash H"${"c".repeat(40)}"`,
    };

    expect(
      satisfiesPackagedDarwinAdHocSmokeSignaturePolicy(
        helper,
        app,
        utility,
      ),
    ).toBe(true);
    expect(
      satisfiesPackagedDarwinAdHocSmokeSignaturePolicy(
        { ...helper, teamIdentifier: "35P5XL3JN6" },
        app,
        utility,
      ),
    ).toBe(false);
    expect(
      satisfiesPackagedDarwinAdHocSmokeSignaturePolicy(
        {
          ...helper,
          designatedRequirement: `cdhash H"${"f".repeat(40)}"`,
        },
        app,
        utility,
      ),
    ).toBe(false);
    expect(
      satisfiesPackagedDarwinAdHocSmokeSignaturePolicy(
        {
          identifier: helper.identifier,
          teamIdentifier: helper.teamIdentifier,
          designatedRequirement: helper.designatedRequirement,
        },
        app,
        utility,
      ),
    ).toBe(false);
    expect(
      satisfiesPackagedDarwinRuntimeOwnershipPolicy(
        app,
        utility,
        utility,
        app,
        null,
      ),
    ).toBe(true);
  });

  it("binds distinct live main and utility identities to one exact signed bundle", () => {
    const app = {
      identifier: "com.nexuside.app",
      teamIdentifier: "35P5XL3JN6",
      designatedRequirement:
        'identifier "com.nexuside.app" and anchor apple generic ' +
        "and certificate leaf[subject.OU] = 35P5XL3JN6",
      cdHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const utility = {
      identifier: NEXUS_UTILITY_HELPER_IDENTIFIER,
      teamIdentifier: "35P5XL3JN6",
      designatedRequirement:
        `identifier "${NEXUS_UTILITY_HELPER_IDENTIFIER}" and anchor apple generic ` +
        "and certificate leaf[subject.OU] = 35P5XL3JN6",
      cdHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };

    expect(
      satisfiesPackagedDarwinRuntimeOwnershipPolicy(app, utility, app, null),
    ).toBe(true);
    expect(
      satisfiesPackagedDarwinRuntimeOwnershipPolicy(app, utility, utility, app),
    ).toBe(true);
    expect(
      satisfiesPackagedDarwinRuntimeOwnershipPolicy(
        app,
        utility,
        {
          ...utility,
          cdHash: "cccccccccccccccccccccccccccccccccccccccc",
        },
        app,
      ),
    ).toBe(false);
    expect(
      satisfiesPackagedDarwinRuntimeOwnershipPolicy(app, utility, utility, {
        ...app,
        cdHash: "cccccccccccccccccccccccccccccccccccccccc",
      }),
    ).toBe(false);
    expect(
      satisfiesPackagedDarwinRuntimeOwnershipPolicy(
        app,
        utility,
        {
          ...utility,
          identifier: "com.nexuside.app.helper.Renderer",
        },
        app,
      ),
    ).toBe(false);
  });

  it("never falls back to a development helper in packaged mode", () => {
    const { helper, runtime } = temporaryRuntime();
    fs.writeFileSync(helper, "fixture", { mode: 0o755 });
    expect(() =>
      resolveDarwinPtySupervisor({ ...runtime, packaged: true }),
    ).toThrow(/Packaged Darwin/i);
  });
});

describe.runIf(process.platform === "darwin")(
  "Darwin packaged local-smoke native barrier",
  () => {
    it("admits only the exact ad-hoc helper self-probe through stage zero", () => {
      const helper = createPackagedNativeSmokeHelper([
        "NEXUS_TEST_EXECUTION_LOG=1",
      ]);
      const markerSource = path.join(helper.root, "foreign-provider.c");
      const foreignProvider = path.join(helper.root, "foreign-provider");
      buildAdHocMarkerExecutable(markerSource, foreignProvider);

      const runProbe = (
        name: string,
        helperArgs: readonly string[],
        extraEnvironment: NodeJS.ProcessEnv = {},
      ) => {
        const executionLog = path.join(helper.root, `${name}.executions`);
        const result = spawnSync(
          "/usr/bin/perl",
          stageZeroArgs(helper, helperArgs),
          {
            encoding: "utf8",
            env: {
              ...process.env,
              ...extraEnvironment,
              NEXUS_TEST_EXECUTION_LOG: executionLog,
            },
            timeout: 8_000,
          },
        );
        expect(result.error).toBeUndefined();
        const executions = fs.existsSync(executionLog)
          ? fs
              .readFileSync(executionLog, "utf8")
              .split("\n")
              .filter(Boolean)
          : [];
        return { result, executions };
      };
      const localSmokeArgs = (
        cdHash: string,
        provider = helper.realPath,
        mode = DARWIN_PTY_PROVIDER_PROBE_MODE,
        extra: readonly string[] = [],
      ) => [
        "supervise-local-smoke",
        "--cdhash",
        cdHash,
        "--",
        provider,
        mode,
        ...extra,
      ];

      const accepted = runProbe(
        "accepted",
        localSmokeArgs(helper.cdHash),
      );
      expect(accepted.result).toMatchObject({ status: 0, signal: null });
      expect(accepted.result.stdout).toContain(
        DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
      );
      // bootstrap -> disclaimed supervisor -> exact self-provider
      expect(accepted.executions).toHaveLength(3);

      const wrongCdHash = runProbe(
        "wrong-cdhash",
        localSmokeArgs("0".repeat(40)),
      );
      expect(wrongCdHash.result).toMatchObject({ status: 76, signal: null });
      expect(wrongCdHash.result.stdout).not.toContain(
        DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
      );
      expect(wrongCdHash.executions).toHaveLength(2);

      const foreignMarker = path.join(helper.root, "foreign-provider.marker");
      const wrongProvider = runProbe(
        "wrong-provider",
        localSmokeArgs(helper.cdHash, foreignProvider),
        { NEXUS_STAGE0_SWAP_MARKER: foreignMarker },
      );
      expect(wrongProvider.result).toMatchObject({
        status: 76,
        signal: null,
      });
      expect(wrongProvider.result.stdout).not.toContain(
        DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
      );
      expect(wrongProvider.executions).toHaveLength(2);
      expect(fs.existsSync(foreignMarker)).toBe(false);

      for (const [name, args] of [
        [
          "extra-argv",
          localSmokeArgs(
            helper.cdHash,
            helper.realPath,
            DARWIN_PTY_PROVIDER_PROBE_MODE,
            ["unexpected"],
          ),
        ],
        [
          "inventory",
          localSmokeArgs(
            helper.cdHash,
            helper.realPath,
            "inventory",
          ),
        ],
      ] as const) {
        const rejected = runProbe(name, args);
        // The helper itself returns usage before self-exec; stage zero maps
        // that missing responsibility transition to its fail-closed identity
        // rejection receipt.
        expect(rejected.result).toMatchObject({ status: 76, signal: null });
        expect(rejected.result.stdout).not.toContain(
          DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
        );
        // Invalid argv is rejected by the first helper before self-exec/spawn.
        expect(rejected.executions).toHaveLength(1);
      }
    }, 30_000);

    it.runIf(hasExpectedDeveloperIdentity)(
      "rejects a Developer ID helper from the ad-hoc local-smoke profile",
      () => {
        const helper = createPackagedNativeSmokeHelper([
          "NEXUS_TEST_EXECUTION_LOG=1",
        ]);
        execFileSync("/usr/bin/codesign", [
          "--force",
          "--sign",
          EXPECTED_DEVELOPER_IDENTITY,
          "--identifier",
          DARWIN_PTY_SUPERVISOR_NAME,
          "--timestamp=none",
          helper.realPath,
        ]);
        const signedHelper = {
          realPath: helper.realPath,
          cdHash: readDarwinCdHash(helper.realPath),
        };
        const executionLog = path.join(
          helper.root,
          "developer-id.executions",
        );
        const result = spawnSync(
          "/usr/bin/perl",
          stageZeroArgs(
            signedHelper,
            [
              "supervise-local-smoke",
              "--cdhash",
              signedHelper.cdHash,
              "--",
              signedHelper.realPath,
              DARWIN_PTY_PROVIDER_PROBE_MODE,
            ],
            0,
            EXPECTED_TEAM_IDENTIFIER,
          ),
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NEXUS_TEST_EXECUTION_LOG: executionLog,
            },
            timeout: 8_000,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result).toMatchObject({ status: 76, signal: null });
        expect(result.stdout).not.toContain(
          DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
        );
        expect(
          fs
            .readFileSync(executionLog, "utf8")
            .split("\n")
            .filter(Boolean),
        ).toHaveLength(1);
      },
      20_000,
    );
  },
);

describe.runIf(process.platform === "darwin")(
  "Darwin stage-zero live helper barrier",
  () => {
    it("preserves a real foreground PTY, input, output, and provider PATH", async () => {
      const { root, helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper);
      const command = supervisedPtyCommand(runtime, "/bin/sh", [
        "-c",
        'IFS= read -r line; printf "STAGE0_INPUT=%s PATH=%s\\n" "$line" "$PATH"',
      ]);
      let terminal: nodePty.IPty | undefined;
      try {
        const launch = darwinNodePtyBootstrapLaunch(
          root,
          command.file,
          command.args,
          {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            ),
            PATH: "/nexus/provider-path:/usr/bin:/bin",
            TERM: "xterm-256color",
          },
        );
        terminal = nodePty.spawn(launch.file, [...launch.args], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: launch.cwd,
          env: launch.env,
        });
        activePtys.set(terminal.pid, terminal);
        const output: string[] = [];
        terminal.onData((chunk) => output.push(chunk));
        const exit = new Promise<{ exitCode: number }>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("stage-zero PTY did not exit")),
            8_000,
          );
          terminal?.onExit((event) => {
            clearTimeout(timeout);
            resolve(event);
          });
        });
        terminal.write("nexus-stage-zero\r");
        await expect(exit).resolves.toMatchObject({ exitCode: 0 });
        expect(output.join("")).toContain("STAGE0_INPUT=nexus-stage-zero");
        expect(output.join("")).toContain(
          "PATH=/nexus/provider-path:/usr/bin:/bin",
        );
      } finally {
        await cleanupPty(terminal);
      }
    }, 20_000);

    it("rejects a swapped helper under 5,000 SIGCONT signals before its constructor runs", async () => {
      const { root, helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper);
      const command = supervisedPtyCommand(runtime, "/usr/bin/true", []);
      const marker = path.join(root, "stage-zero-swap.marker");
      const replacementSource = path.join(root, "replacement-helper.c");
      const replacement = path.join(root, "replacement-helper");
      fs.writeFileSync(
        replacementSource,
        [
          "#include <fcntl.h>",
          "#include <stdlib.h>",
          "#include <unistd.h>",
          "__attribute__((constructor)) static void mark(void) {",
          '  const char *path = getenv("NEXUS_STAGE0_SWAP_MARKER");',
          "  if (path == 0) return;",
          "  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);",
          '  if (fd >= 0) { (void)write(fd, "executed", 8); close(fd); }',
          "}",
          "int main(void) { return 0; }",
        ].join("\n"),
      );
      execFileSync("xcrun", [
        "--sdk",
        "macosx",
        "clang",
        "-arch",
        process.arch === "x64" ? "x86_64" : "arm64",
        replacementSource,
        "-o",
        replacement,
      ]);
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--identifier",
        "nexus-pty-supervisor",
        replacement,
      ]);
      fs.copyFileSync(replacement, helper);
      fs.chmodSync(helper, 0o755);

      const sourceIndex = command.args.indexOf(DARWIN_PTY_STAGE_ZERO_SOURCE);
      expect(sourceIndex).toBeGreaterThan(0);
      command.args[sourceIndex] = DARWIN_PTY_STAGE_ZERO_SOURCE.replace(
        "wait_for_exec_trap();\nvalidate_live_helper();",
        "wait_for_exec_trap();\n" +
          "select(undef, undef, undef, 1.5);\n" +
          "validate_live_helper();",
      );
      let launch: ReturnType<typeof collectSpawn> | undefined;
      let helperPid: number | undefined;
      try {
        launch = collectSpawn(command.file, command.args, {
          env: { ...process.env, NEXUS_STAGE0_SWAP_MARKER: marker },
        });
        helperPid = await waitForValue(() => {
          const result = spawnSync(
            "/usr/bin/pgrep",
            ["-P", String(launch?.child.pid)],
            { encoding: "utf8" },
          );
          const parsed = Number.parseInt(result.stdout.trim(), 10);
          return Number.isInteger(parsed) && parsed > 0 ? parsed : false;
        });
        for (let index = 0; index < 5_000; index += 1) {
          process.kill(helperPid, "SIGCONT");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(fs.existsSync(marker)).toBe(false);
        const exit = await launch.completion;
        expect(exit).toMatchObject({ status: 76, signal: null });
        expect(exit.stderr).toContain("live helper identity rejected");
        expect(fs.existsSync(marker)).toBe(false);
        expect(processExists(helperPid)).toBe(false);
      } finally {
        if (launch?.child.pid) {
          await cleanupProcessGroup(launch.child.pid);
        }
      }
    }, 20_000);

    it("rejects a helper swapped between its initial and responsibility exec", async () => {
      const { root, helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper, [
        "NEXUS_TEST_PRE_SELF_EXEC_HOLD_MS=1200",
      ]);
      const command = supervisedPtyCommand(runtime, "/usr/bin/true", []);
      const ready = path.join(root, "stage-zero-self-exec.ready");
      const marker = path.join(root, "stage-zero-self-exec.marker");
      const replacementSource = path.join(root, "self-exec-replacement.c");
      const replacement = path.join(root, "self-exec-replacement");
      fs.writeFileSync(
        replacementSource,
        [
          "#include <fcntl.h>",
          "#include <stdlib.h>",
          "#include <unistd.h>",
          "__attribute__((constructor)) static void mark(void) {",
          '  const char *path = getenv("NEXUS_STAGE0_SWAP_MARKER");',
          "  if (path == 0) return;",
          "  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);",
          '  if (fd >= 0) { (void)write(fd, "executed", 8); close(fd); }',
          "}",
          "int main(void) { return 0; }",
        ].join("\n"),
      );
      execFileSync("xcrun", [
        "--sdk",
        "macosx",
        "clang",
        "-arch",
        process.arch === "x64" ? "x86_64" : "arm64",
        replacementSource,
        "-o",
        replacement,
      ]);
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--identifier",
        "nexus-pty-supervisor",
        replacement,
      ]);

      let launch: ReturnType<typeof collectSpawn> | undefined;
      try {
        launch = collectSpawn(command.file, command.args, {
          env: {
            ...process.env,
            NEXUS_TEST_PRE_SELF_EXEC_READY: ready,
            NEXUS_STAGE0_SWAP_MARKER: marker,
          },
        });
        await waitForValue(() => fs.existsSync(ready) || false);
        const trusted = `${helper}.trusted`;
        fs.renameSync(helper, trusted);
        fs.copyFileSync(replacement, helper);
        fs.chmodSync(helper, 0o755);
        const rejected = await launch.completion;
        expect(rejected.stderr).toContain("live helper identity rejected");
        expect(rejected).toMatchObject({ status: 76, signal: null });
        expect(fs.existsSync(marker)).toBe(false);
      } finally {
        if (launch?.child.pid) {
          await cleanupProcessGroup(launch.child.pid);
        }
      }
    }, 20_000);

    it("kills a traced helper if the Perl tracer is SIGKILLed before its responsibility exec", async () => {
      const { root, helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper, [
        "NEXUS_TEST_PRE_SELF_EXEC_HOLD_MS=3000",
      ]);
      const command = supervisedPtyCommand(runtime, "/usr/bin/true", []);
      const ready = path.join(root, "stage-zero-tracer-death.ready");
      const marker = path.join(root, "stage-zero-tracer-death.marker");
      const replacementSource = path.join(root, "tracer-death-replacement.c");
      const replacement = path.join(root, "tracer-death-replacement");
      buildAdHocMarkerExecutable(replacementSource, replacement);

      let launch: ReturnType<typeof collectSpawn> | undefined;
      let helperPid: number | undefined;
      try {
        launch = collectSpawn(command.file, command.args, {
          env: {
            ...process.env,
            NEXUS_TEST_PRE_SELF_EXEC_READY: ready,
            NEXUS_STAGE0_SWAP_MARKER: marker,
          },
        });
        await waitForValue(() => fs.existsSync(ready) || false);
        helperPid = await waitForValue(() => {
          const result = spawnSync(
            "/usr/bin/pgrep",
            ["-P", String(launch?.child.pid)],
            { encoding: "utf8" },
          );
          const parsed = Number.parseInt(result.stdout.trim(), 10);
          return Number.isInteger(parsed) && parsed > 0 ? parsed : false;
        });

        const trusted = `${helper}.trusted`;
        fs.renameSync(helper, trusted);
        fs.copyFileSync(replacement, helper);
        fs.chmodSync(helper, 0o755);

        launch.child.kill("SIGKILL");
        await expect(launch.completion).resolves.toMatchObject({
          status: null,
          signal: "SIGKILL",
        });
        expect(
          await waitForProcessGroupAbsence(launch.child.pid ?? 0, 5_000),
        ).toBe(true);
        expect(fs.existsSync(marker)).toBe(false);
        expect(processExists(helperPid)).toBe(false);
      } finally {
        if (launch?.child.pid) {
          await cleanupProcessGroup(launch.child.pid);
        }
      }
    }, 20_000);

    it("rejects physical proof when the authenticated helper is SIGKILLed after provider detach", async () => {
      const { root, helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper);
      const providerPidFile = path.join(root, "killed-helper-provider.pid");
      const python = [
        "import os,time",
        `provider_file=${JSON.stringify(providerPidFile)}`,
        'with open(provider_file,"w") as f: f.write(str(os.getpid()))',
        "time.sleep(30)",
      ].join("\n");
      const command = supervisedPtyCommand(runtime, "/usr/bin/python3", [
        "-c",
        python,
      ]);
      let launch: ReturnType<typeof collectSpawn> | undefined;
      try {
        launch = collectSpawn(command.file, command.args, {
          cwd: root,
          env: process.env,
        });
        await waitForValue(() => fs.existsSync(providerPidFile) || false);
        const helperPid = await waitForValue(() => {
          const result = spawnSync(
            "/usr/bin/pgrep",
            ["-P", String(launch?.child.pid)],
            { encoding: "utf8" },
          );
          const parsed = Number.parseInt(result.stdout.trim(), 10);
          return Number.isInteger(parsed) && parsed > 0 ? parsed : false;
        });

        process.kill(helperPid, "SIGKILL");
        const killed = await launch.completion;
        expect(killed).toMatchObject({ status: 137, signal: null });
        expect(
          isProvenDarwinPtySupervisorExit({
            exitCode: killed.status,
            signal: killed.signal,
          }),
        ).toBe(false);
      } finally {
        if (launch?.child.pid) {
          await cleanupProcessGroup(launch.child.pid);
        }
      }
    }, 20_000);

    it("maps a proven provider exit in the reserved signal band to an unambiguous receipt", async () => {
      const { helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper);
      const command = supervisedPtyCommand(runtime, "/bin/sh", [
        "-c",
        "exit 137",
      ]);
      const launch = collectSpawn(command.file, command.args, {
        env: process.env,
      });

      const result = await launch.completion;
      expect(result).toMatchObject({ status: 125, signal: null });
      expect(
        isProvenDarwinPtySupervisorExit({
          exitCode: result.status,
          signal: result.signal,
        }),
      ).toBe(true);
    }, 20_000);

    it("rejects physical proof when the authenticated helper dies during teardown proof", async () => {
      const { root, helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper, [
        "NEXUS_TEST_PRE_TERMINATION_PROOF_HOLD_MS=3000",
      ]);
      const providerPidFile = path.join(
        root,
        "teardown-helper-death-provider.pid",
      );
      const proofReadyFile = path.join(root, "teardown-helper-death.ready");
      const python = [
        "import os,time",
        `provider_file=${JSON.stringify(providerPidFile)}`,
        'with open(provider_file,"w") as f: f.write(str(os.getpid()))',
        "time.sleep(30)",
      ].join("\n");
      const command = supervisedPtyCommand(runtime, "/usr/bin/python3", [
        "-c",
        python,
      ]);
      let launch: ReturnType<typeof collectSpawn> | undefined;
      try {
        launch = collectSpawn(command.file, command.args, {
          cwd: root,
          env: {
            ...process.env,
            NEXUS_TEST_PRE_TERMINATION_PROOF_READY: proofReadyFile,
          },
        });
        await waitForValue(() => fs.existsSync(providerPidFile) || false);

        launch.child.kill("SIGTERM");
        const helperPid = await waitForValue(() => {
          if (!fs.existsSync(proofReadyFile)) return false;
          const parsed = Number.parseInt(
            fs.readFileSync(proofReadyFile, "utf8"),
            10,
          );
          return Number.isInteger(parsed) && parsed > 0 ? parsed : false;
        });
        process.kill(helperPid, "SIGKILL");

        const result = await launch.completion;
        expect(result).toMatchObject({ status: 159, signal: null });
        expect(
          isProvenDarwinPtySupervisorExit({
            exitCode: result.status,
            signal: result.signal,
          }),
        ).toBe(false);
      } finally {
        if (launch?.child.pid) {
          await cleanupProcessGroup(launch.child.pid);
        }
      }
    }, 20_000);

    it("times out through EINTR and leaves no provider or descendant", async () => {
      const { root, helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper);
      const childPidFile = path.join(root, "timeout-child.pid");
      const descendantPidFile = path.join(root, "timeout-descendant.pid");
      const python = [
        "import os,signal,time",
        `child_file=${JSON.stringify(childPidFile)}`,
        `descendant_file=${JSON.stringify(descendantPidFile)}`,
        "descendant=os.fork()",
        "if descendant == 0:",
        "  signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        '  with open(descendant_file,"w") as f: f.write(str(os.getpid()))',
        "  time.sleep(30)",
        "  os._exit(0)",
        'with open(child_file,"w") as f: f.write(str(os.getpid()))',
        "time.sleep(30)",
      ].join("\n");
      const command = supervisedPtyCommand(runtime, "/usr/bin/python3", [
        "-c",
        python,
      ]);
      const timeoutIndex = command.args.indexOf("--timeout-seconds");
      command.args[timeoutIndex + 1] = "2";
      let launch: ReturnType<typeof collectSpawn> | undefined;
      try {
        launch = collectSpawn(command.file, command.args, {
          cwd: root,
          env: process.env,
        });
        const [childPid, descendantPid] = await waitForValue(() => {
          if (
            !fs.existsSync(childPidFile) ||
            !fs.existsSync(descendantPidFile)
          ) {
            return false;
          }
          return [
            Number.parseInt(fs.readFileSync(childPidFile, "utf8"), 10),
            Number.parseInt(fs.readFileSync(descendantPidFile, "utf8"), 10),
          ] as const;
        });
        const result = await launch.completion;
        expect(result).toMatchObject({ status: 124, signal: null });
        expect(
          isProvenDarwinPtySupervisorExit({
            exitCode: result.status,
            signal: result.signal,
          }),
        ).toBe(true);
        await waitForValue(
          () =>
            (!processExists(childPid) && !processExists(descendantPid)) ||
            false,
        );
        expect(processExists(childPid)).toBe(false);
        expect(processExists(descendantPid)).toBe(false);
      } finally {
        if (launch?.child.pid) {
          await cleanupProcessGroup(launch.child.pid);
        }
      }
    }, 20_000);

    it("forwards SIGTERM through the exact helper and leaves no orphan", async () => {
      const { root, helper, runtime } = temporaryRuntime();
      buildNativeDevelopmentHelper(helper);
      const childPidFile = path.join(root, "term-child.pid");
      const descendantPidFile = path.join(root, "term-descendant.pid");
      const python = [
        "import os,signal,time",
        `child_file=${JSON.stringify(childPidFile)}`,
        `descendant_file=${JSON.stringify(descendantPidFile)}`,
        "descendant=os.fork()",
        "if descendant == 0:",
        "  signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        '  with open(descendant_file,"w") as f: f.write(str(os.getpid()))',
        "  time.sleep(30)",
        "  os._exit(0)",
        'with open(child_file,"w") as f: f.write(str(os.getpid()))',
        "time.sleep(30)",
      ].join("\n");
      const command = supervisedPtyCommand(runtime, "/usr/bin/python3", [
        "-c",
        python,
      ]);
      let launch: ReturnType<typeof collectSpawn> | undefined;
      try {
        launch = collectSpawn(command.file, command.args, {
          cwd: root,
          env: process.env,
        });
        const [childPid, descendantPid] = await waitForValue(() => {
          if (
            !fs.existsSync(childPidFile) ||
            !fs.existsSync(descendantPidFile)
          ) {
            return false;
          }
          return [
            Number.parseInt(fs.readFileSync(childPidFile, "utf8"), 10),
            Number.parseInt(fs.readFileSync(descendantPidFile, "utf8"), 10),
          ] as const;
        });
        launch.child.kill("SIGTERM");
        await expect(launch.completion).resolves.toMatchObject({
          status: 0,
          signal: null,
        });
        await waitForValue(
          () =>
            (!processExists(childPid) && !processExists(descendantPid)) ||
            false,
        );
      } finally {
        if (launch?.child.pid) {
          await cleanupProcessGroup(launch.child.pid);
        }
      }
    }, 20_000);
  },
);
