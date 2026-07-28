import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{
    file: string;
    args: string[];
    options: Record<string, unknown>;
  }>,
  metadata: new Map<
    string,
    {
      identifier: string;
      teamIdentifier: string;
      cdHash: string;
    }
  >(),
  versions: new Map<string, string>(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    spawnState.calls.push({ file, args: [...args], options });
    if (file === "/usr/bin/codesign") {
      const target = args.at(-1) ?? "";
      const metadata = spawnState.metadata.get(target);
      if (args.includes("--display")) {
        if (!metadata) {
          return {
            status: 1,
            signal: null,
            stdout: "",
            stderr: "code object is not signed at all",
          };
        }
        return {
          status: 0,
          signal: null,
          stdout: "",
          stderr:
            `Identifier=${metadata.identifier}\n` +
            `CDHash=${metadata.cdHash}\n` +
            `Authority=Developer ID Application: Fixture (${metadata.teamIdentifier})\n` +
            "Authority=Developer ID Certification Authority\n" +
            "Authority=Apple Root CA\n" +
            `TeamIdentifier=${metadata.teamIdentifier}\n`,
        };
      }
      const requirementIndex = args.indexOf("--test-requirement");
      const requirement =
        requirementIndex >= 0 ? (args[requirementIndex + 1] ?? "") : "";
      const valid = Boolean(
        metadata &&
        requirement.includes(`identifier "${metadata.identifier}"`) &&
        requirement.includes(
          `certificate leaf[subject.OU] = "${metadata.teamIdentifier}"`,
        ) &&
        requirement.includes(`cdhash H"${metadata.cdHash}"`),
      );
      return {
        status: valid ? 0 : 1,
        signal: null,
        stdout: "",
        stderr: valid ? "" : "requirement failed",
      };
    }
    const separator = args.indexOf("--");
    const supervisedTarget =
      args[0] === "supervise-authenticated" && separator >= 0
        ? args[separator + 1]
        : undefined;
    const version = spawnState.versions.get(supervisedTarget ?? file);
    return version === undefined
      ? {
          status: 127,
          signal: null,
          stdout: "",
          stderr: "unexpected executable probe",
        }
      : {
          status: 0,
          signal: null,
          stdout: `${version}\n`,
          stderr: "",
        };
  },
}));

vi.mock("./darwin-pty-supervisor", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./darwin-pty-supervisor")>();
  return {
    ...original,
    currentDarwinPtySupervisorRuntime: () => ({
      platform: "darwin" as const,
      packaged: false,
      cwd: "/fixture",
      moduleDir: "/fixture",
    }),
    authenticatedDarwinSupervisorCommand: (
      _runtime: unknown,
      seal: {
        readonly executablePath: string;
        readonly identifier: string;
        readonly teamIdentifier: string;
        readonly cdHash: string;
      },
      args: readonly string[],
    ) => ({
      file: "/fixture/nexus-pty-supervisor",
      args: [
        "supervise-authenticated",
        "--identifier",
        seal.identifier,
        "--team-id",
        seal.teamIdentifier,
        "--cdhash",
        seal.cdHash,
        "--",
        seal.executablePath,
        ...args,
      ],
    }),
  };
});

import {
  ANTHROPIC_DEVELOPER_ID_TEAM_IDENTIFIER,
  assertTrustedNativeConfinementBinary,
  clearTrustedNativeCliBinaryCacheForTests,
  OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER,
  PINNED_CLAUDE_CLI_VERSION,
  PINNED_CLAUDE_DARWIN_ARM64_CDHASH,
  PINNED_CODEX_CLI_VERSION,
  PINNED_CODEX_DARWIN_ARM64_CDHASH,
  PINNED_CODEX_PACKAGE_VERSION,
  qualifyTrustedNativeConfinementLaunch,
  revalidateTrustedNativeConfinementLaunch,
  supportsPinnedNativeConfinementAuthenticity,
  trustedNativeConfinementRuntimeReadPaths,
} from "./trusted-native-cli-binary";

const temporaryDirectories: string[] = [];
const CODEX_CDHASH = PINNED_CODEX_DARWIN_ARM64_CDHASH;
const CLAUDE_CDHASH = PINNED_CLAUDE_DARWIN_ARM64_CDHASH;

function executable(root: string, name: string, content = "fixture"): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function registerOfficialCodex(file: string): void {
  const real = fs.realpathSync.native(file);
  spawnState.metadata.set(real, {
    identifier: "codex",
    teamIdentifier: OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER,
    cdHash: CODEX_CDHASH,
  });
  spawnState.versions.set(real, PINNED_CODEX_CLI_VERSION);
}

function registerOfficialClaude(file: string): void {
  const real = fs.realpathSync.native(file);
  spawnState.metadata.set(real, {
    identifier: "com.anthropic.claude-code",
    teamIdentifier: ANTHROPIC_DEVELOPER_ID_TEAM_IDENTIFIER,
    cdHash: CLAUDE_CDHASH,
  });
  spawnState.versions.set(real, PINNED_CLAUDE_CLI_VERSION);
}

function fakeCodexNpmInstall(root: string): {
  readonly wrapper: string;
  readonly native: string;
  readonly packageRoot: string;
} {
  const packageRoot = path.join(
    root,
    "lib",
    "node_modules",
    "@openai",
    "codex",
  );
  const wrapper = path.join(packageRoot, "bin", "codex.js");
  const platformPackageRoot = path.join(
    packageRoot,
    "node_modules",
    "@openai",
    "codex-darwin-arm64",
  );
  const native = path.join(
    platformPackageRoot,
    "vendor",
    "aarch64-apple-darwin",
    "bin",
    "codex",
  );
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: PINNED_CODEX_PACKAGE_VERSION,
      optionalDependencies: {
        "@openai/codex-darwin-arm64": "npm:@openai/codex@0.145.0-darwin-arm64",
      },
    }),
  );
  fs.writeFileSync(
    path.join(platformPackageRoot, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "0.145.0-darwin-arm64",
      os: ["darwin"],
      cpu: ["arm64"],
    }),
  );
  fs.writeFileSync(wrapper, "#!/usr/bin/env node\n", { mode: 0o700 });
  fs.writeFileSync(native, "signed Mach-O fixture", { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
  fs.chmodSync(native, 0o700);
  registerOfficialCodex(native);
  return { wrapper, native, packageRoot };
}

function temporaryRoot(prefix = "nexus-native-cli-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function executableProbes(): Array<{
  file: string;
  args: string[];
  options: Record<string, unknown>;
}> {
  return spawnState.calls.filter((call) => call.file !== "/usr/bin/codesign");
}

beforeEach(() => {
  clearTrustedNativeCliBinaryCacheForTests();
  spawnState.calls.length = 0;
  spawnState.metadata.clear();
  spawnState.versions.clear();
});

afterEach(() => {
  clearTrustedNativeCliBinaryCacheForTests();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("trusted native CLI binary", () => {
  it("rejects a divergent override before either file is authenticated or run", () => {
    const root = temporaryRoot();
    const canonical = executable(root, "codex-real");
    const override = executable(root, "codex-override");

    expect(() =>
      assertTrustedNativeConfinementBinary({
        adapterId: "codex",
        requestedBinPath: override,
        canonicalBinPath: canonical,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toThrow(/diverges from canonical discovery/i);
    expect(spawnState.calls).toHaveLength(0);
  });

  it("fails closed off Darwin before any untrusted version probe", () => {
    const root = temporaryRoot();
    const canonical = executable(root, "codex-real");
    spawnState.versions.set(
      fs.realpathSync.native(canonical),
      PINNED_CODEX_CLI_VERSION,
    );

    expect(() =>
      assertTrustedNativeConfinementBinary({
        adapterId: "codex",
        requestedBinPath: canonical,
        canonicalBinPath: canonical,
        platform: "linux",
      }),
    ).toThrow(/no pinned authenticity root.*immutable spawn primitive/i);
    expect(spawnState.calls).toHaveLength(0);
  });

  it("rejects an unsigned Codex lookalike before --version", () => {
    const root = temporaryRoot();
    const lookalike = executable(root, "codex-lookalike");
    spawnState.versions.set(
      fs.realpathSync.native(lookalike),
      PINNED_CODEX_CLI_VERSION,
    );

    expect(() =>
      assertTrustedNativeConfinementBinary({
        adapterId: "codex",
        requestedBinPath: lookalike,
        canonicalBinPath: lookalike,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toThrow(/official Developer ID.*codex\/2DC432GLL2/i);
    expect(executableProbes()).toHaveLength(0);
  });

  it("rejects another same-Team binary whose CDHash is not the pinned release", () => {
    const root = temporaryRoot();
    const codex = executable(root, "codex-same-team-other-release");
    const realPath = fs.realpathSync.native(codex);
    spawnState.metadata.set(realPath, {
      identifier: "codex",
      teamIdentifier: OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER,
      cdHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    spawnState.versions.set(realPath, PINNED_CODEX_CLI_VERSION);

    expect(() =>
      qualifyTrustedNativeConfinementLaunch({
        adapterId: "codex",
        requestedBinPath: codex,
        canonicalBinPath: codex,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toThrow(/release codex-cli 0\.145\.0.*CDHash/i);
    expect(executableProbes()).toHaveLength(0);
  });

  it("fails closed for a Darwin architecture without a release CDHash root", () => {
    const root = temporaryRoot();
    const codex = executable(root, "codex-x64");
    registerOfficialCodex(codex);

    expect(() =>
      qualifyTrustedNativeConfinementLaunch({
        adapterId: "codex",
        requestedBinPath: codex,
        canonicalBinPath: codex,
        platform: "darwin",
        arch: "x64",
      }),
    ).toThrow(/no pinned release image root for darwin\/x64/i);
    expect(spawnState.calls).toHaveLength(0);
  });

  it("resolves Codex npm to the signed vendor-native and never probes the wrapper", () => {
    const root = temporaryRoot("nexus-native-cli-package-");
    const { wrapper, native } = fakeCodexNpmInstall(root);
    const nativeRealPath = fs.realpathSync.native(native);

    const launch = qualifyTrustedNativeConfinementLaunch({
      adapterId: "codex",
      requestedBinPath: wrapper,
      canonicalBinPath: wrapper,
      platform: "darwin",
      arch: "arm64",
    });

    expect(launch.executablePath).toBe(nativeRealPath);
    expect(launch.runtimeReadPaths).toEqual([nativeRealPath]);
    expect(launch.providerNetworkProcessPaths).toEqual([nativeRealPath]);
    expect(launch.darwinExecutableSeal).toEqual({
      platform: "darwin",
      executablePath: nativeRealPath,
      identifier: "codex",
      teamIdentifier: OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER,
      cdHash: CODEX_CDHASH,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(executableProbes()).toHaveLength(1);
    const versionProbe = executableProbes()[0];
    expect(path.basename(versionProbe?.file ?? "")).toBe(
      "nexus-pty-supervisor",
    );
    expect(versionProbe?.args).toEqual([
      "supervise-authenticated",
      "--identifier",
      "codex",
      "--team-id",
      OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER,
      "--cdhash",
      CODEX_CDHASH,
      "--",
      nativeRealPath,
      "--version",
    ]);
    expect(versionProbe?.options.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/var/empty",
      TMPDIR: "/private/tmp",
      LANG: "C",
      LC_ALL: "C",
    });
    expect(versionProbe?.options.cwd).toBe("/var/empty");
    expect(
      spawnState.calls.findIndex((call) => call.file === "/usr/bin/codesign"),
    ).toBeLessThan(spawnState.calls.indexOf(versionProbe!));
    expect(spawnState.calls.some((call) => call.file === nativeRealPath)).toBe(
      false,
    );
    expect(spawnState.calls.some((call) => call.file === wrapper)).toBe(false);
  });

  it("authenticates Claude against the Anthropic root before its minimal probe", () => {
    const root = temporaryRoot();
    const claude = executable(root, "claude");
    registerOfficialClaude(claude);
    const realPath = fs.realpathSync.native(claude);

    const launch = qualifyTrustedNativeConfinementLaunch({
      adapterId: "claude",
      requestedBinPath: claude,
      canonicalBinPath: claude,
      platform: "darwin",
      arch: "arm64",
    });

    expect(launch.executablePath).toBe(realPath);
    expect(launch.darwinExecutableSeal).toMatchObject({
      executablePath: realPath,
      identifier: "com.anthropic.claude-code",
      teamIdentifier: ANTHROPIC_DEVELOPER_ID_TEAM_IDENTIFIER,
      cdHash: CLAUDE_CDHASH,
    });
    expect(executableProbes()).toHaveLength(1);
    expect(spawnState.calls[0]?.file).toBe("/usr/bin/codesign");
    expect(executableProbes()[0]?.args).toEqual([
      "supervise-authenticated",
      "--identifier",
      "com.anthropic.claude-code",
      "--team-id",
      ANTHROPIC_DEVELOPER_ID_TEAM_IDENTIFIER,
      "--cdhash",
      CLAUDE_CDHASH,
      "--",
      realPath,
      "--version",
    ]);
    expect(executableProbes()[0]?.options.env).not.toHaveProperty(
      "ANTHROPIC_API_KEY",
    );
  });

  it("keys the signature cache by adapter and trust root", () => {
    const root = temporaryRoot();
    const sameFile = executable(root, "shared-binary");
    registerOfficialCodex(sameFile);

    expect(() =>
      qualifyTrustedNativeConfinementLaunch({
        adapterId: "codex",
        requestedBinPath: sameFile,
        canonicalBinPath: sameFile,
        platform: "darwin",
        arch: "arm64",
      }),
    ).not.toThrow();
    const firstCodesignCount = spawnState.calls.filter(
      (call) => call.file === "/usr/bin/codesign",
    ).length;

    expect(() =>
      qualifyTrustedNativeConfinementLaunch({
        adapterId: "claude",
        requestedBinPath: sameFile,
        canonicalBinPath: sameFile,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toThrow(/official Developer ID.*com\.anthropic\.claude-code/i);
    expect(
      spawnState.calls.filter((call) => call.file === "/usr/bin/codesign"),
    ).toHaveLength(firstCodesignCount + 2);
  });

  it("rejects adapters without a pinned signing root before probing", () => {
    const root = temporaryRoot();
    const executablePath = executable(root, "kimi");

    expect(() =>
      qualifyTrustedNativeConfinementLaunch({
        adapterId: "kimi",
        requestedBinPath: executablePath,
        canonicalBinPath: executablePath,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toThrow(/no pinned native confinement authenticity root/i);
    expect(spawnState.calls).toHaveLength(0);
  });

  it("exposes authenticity pins only for release-sealed adapters", () => {
    expect(supportsPinnedNativeConfinementAuthenticity("codex")).toBe(true);
    expect(supportsPinnedNativeConfinementAuthenticity("claude")).toBe(true);
    // Grok enforces read-only via provider argv, not a Nexus CDHash pin.
    expect(supportsPinnedNativeConfinementAuthenticity("grok")).toBe(false);
    expect(supportsPinnedNativeConfinementAuthenticity("kimi")).toBe(false);
  });

  it("grants only the vendor-native read path for Codex npm", () => {
    const root = temporaryRoot("nexus-native-cli-package-");
    const { wrapper, native } = fakeCodexNpmInstall(root);

    expect(
      trustedNativeConfinementRuntimeReadPaths({
        adapterId: "codex",
        verifiedBinaryPath: wrapper,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toEqual([fs.realpathSync.native(native)]);
  });

  it("revokes a sealed npm launch when the vendor-native path is replaced", () => {
    const root = temporaryRoot("nexus-native-cli-chain-");
    const { wrapper, native } = fakeCodexNpmInstall(root);
    const launch = qualifyTrustedNativeConfinementLaunch({
      adapterId: "codex",
      requestedBinPath: wrapper,
      canonicalBinPath: wrapper,
      platform: "darwin",
      arch: "arm64",
    });
    expect(() =>
      revalidateTrustedNativeConfinementLaunch(launch),
    ).not.toThrow();

    const replacement = executable(root, "replacement", "substitute");
    fs.renameSync(replacement, native);

    expect(() => revalidateTrustedNativeConfinementLaunch(launch)).toThrow(
      /changed after qualification/i,
    );
  });

  it("does not silently accept a changed npm metadata chain", () => {
    const root = temporaryRoot("nexus-native-cli-package-");
    const { packageRoot, wrapper } = fakeCodexNpmInstall(root);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@openai/codex", version: "0.144.0" }),
    );

    expect(() =>
      qualifyTrustedNativeConfinementLaunch({
        adapterId: "codex",
        requestedBinPath: wrapper,
        canonicalBinPath: wrapper,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toThrow(/@openai\/codex@0\.145\.0/i);
    expect(spawnState.calls).toHaveLength(0);
  });
});
