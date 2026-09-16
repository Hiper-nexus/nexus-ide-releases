import { describe, expect, it, vi } from "vitest";

import {
  assertPackagedSmokeOutput,
  assertMatchingReleaseArchitectures,
  assertMatchingCodeDirectoryHashes,
  assertNoBundledNodePtySpawnHelpers,
  assertRequiredElectronFuses,
  assertReleaseArtifacts,
  assertResponsibilitySupervisorSignatureMetadata,
  assertSingleResponsibilitySupervisorPath,
  assertSignatureMetadata,
  buildCodesignSliceInvocations,
  buildFusesReadInvocation,
  expectedEntitlementKeysForPath,
  expectedMachOArchitecturesForPath,
  parseCodesignMetadata,
  parseLipoArchitectures,
  copyCompareDetachAndSmoke,
  detachDmgWithTimeout,
} from "./verify-macos-release.mjs";

describe("macOS release artifact contract", () => {
  it("requires exactly one DMG and one ZIP because Squirrel uses the ZIP", () => {
    expect(() => assertReleaseArtifacts(["/tmp/NexusIDE.dmg"])).toThrow(/ZIP/i);
    expect(() =>
      assertReleaseArtifacts([
        "/tmp/NexusIDE.dmg",
        "/tmp/NexusIDE.zip",
        "/tmp/NexusIDE-copy.zip",
      ]),
    ).toThrow(/exactly one ZIP/i);

    expect(
      assertReleaseArtifacts(["/tmp/NexusIDE.dmg", "/tmp/NexusIDE.zip"]),
    ).toEqual({
      dmg: "/tmp/NexusIDE.dmg",
      zip: "/tmp/NexusIDE.zip",
    });
  });

  it("requires the expected Developer ID leaf and exact Apple Team ID", () => {
    const metadata = parseCodesignMetadata(
      [
        "Authority=Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
        "Authority=Developer ID Certification Authority",
        "Timestamp=23 Jul 2026 at 08:49:41",
        "TeamIdentifier=35P5XL3JN6",
      ].join("\n"),
    );

    expect(() =>
      assertSignatureMetadata(
        metadata,
        "OTHERTEAM1",
        "Developer ID Application: Cleofas Pereira rocha",
      ),
    ).toThrow(/TeamIdentifier/);
    expect(() =>
      assertSignatureMetadata(
        metadata,
        "35P5XL3JN6",
        "Developer ID Application: Mallory",
      ),
    ).toThrow(/Authority/);
    expect(() =>
      assertSignatureMetadata(
        metadata,
        "35P5XL3JN6",
        "Developer ID Application: Cleofas Pereira rocha",
      ),
    ).not.toThrow();
  });

  it("requires a secure Timestamp and rejects Signed Time as a substitute", () => {
    const signatureLines = [
      "Authority=Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
      "Authority=Developer ID Certification Authority",
      "TeamIdentifier=35P5XL3JN6",
    ];
    const secure = parseCodesignMetadata(
      [...signatureLines, "Timestamp=23 Jul 2026 at 08:49:41"].join("\n"),
    );
    const localOnly = parseCodesignMetadata(
      [...signatureLines, "Signed Time=23 Jul 2026 at 08:49:41"].join("\n"),
    );
    const missing = parseCodesignMetadata(signatureLines.join("\n"));

    expect(secure).toMatchObject({
      secureTimestamp: "23 Jul 2026 at 08:49:41",
      signedTime: "",
    });
    expect(localOnly).toMatchObject({
      secureTimestamp: "",
      signedTime: "23 Jul 2026 at 08:49:41",
    });
    expect(() =>
      assertSignatureMetadata(
        secure,
        "35P5XL3JN6",
        "Developer ID Application: Cleofas Pereira rocha",
      ),
    ).not.toThrow();
    expect(() =>
      assertSignatureMetadata(
        localOnly,
        "35P5XL3JN6",
        "Developer ID Application: Cleofas Pereira rocha",
      ),
    ).toThrow(/secure Timestamp.*Signed Time/);
    expect(() =>
      assertSignatureMetadata(
        missing,
        "35P5XL3JN6",
        "Developer ID Application: Cleofas Pereira rocha",
      ),
    ).toThrow(/secure Timestamp/);
  });

  it("preserves the mounted app identity before detaching and smoking its copy", async () => {
    const order = [];
    await copyCompareDetachAndSmoke({
      mountedApp: "/tmp/mounted/NexusIDE.app",
      copiedApp: "/tmp/copy/NexusIDE.app",
      copyApp: async () => order.push("copy"),
      readCodeDirectory: async () => ({ codeDirectoryHash: "abc123" }),
      detach: async () => order.push("detach"),
      smoke: async (appPath) => {
        order.push("smoke");
        expect(appPath).toBe("/tmp/copy/NexusIDE.app");
      },
    });

    expect(order).toEqual(["copy", "detach", "smoke"]);
    expect(() =>
      assertMatchingCodeDirectoryHashes(
        { codeDirectoryHash: "abc123" },
        { codeDirectoryHash: "different" },
      ),
    ).toThrow(/CodeDirectory mismatch/);
  });

  it("does not wait forever when hdiutil detach times out", () => {
    const runner = vi.fn(() => {
      const error = new Error("hdiutil hung");
      error.code = "ETIMEDOUT";
      throw error;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(detachDmgWithTimeout("/tmp/mount", 123, runner)).toBe(false);
    expect(runner).toHaveBeenCalledWith(
      "/usr/bin/hdiutil",
      ["detach", "-force", "/tmp/mount"],
      { timeout: 123 },
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("timed out after 123ms"),
    );
    warning.mockRestore();
  });

  it("maps Mach-O classes to the least-privilege entitlement allowlist", () => {
    const app = "/tmp/NexusIDE.app";
    expect(
      expectedEntitlementKeysForPath(`${app}/Contents/MacOS/nexus-ide`, app),
    ).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.device.audio-input",
    ]);
    expect(
      expectedEntitlementKeysForPath(
        `${app}/Contents/Frameworks/NexusIDE Helper (Renderer).app/Contents/MacOS/NexusIDE Helper (Renderer)`,
        app,
      ),
    ).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.device.audio-input",
    ]);
    expect(
      expectedEntitlementKeysForPath(
        `${app}/Contents/Frameworks/NexusIDE Helper (Plugin).app/Contents/MacOS/NexusIDE Helper (Plugin)`,
        app,
      ),
    ).toEqual(["com.apple.security.cs.allow-unsigned-executable-memory"]);
    expect(
      expectedEntitlementKeysForPath(
        `${app}/Contents/Resources/app.asar.unpacked/native.node`,
        app,
      ),
    ).toEqual([]);
    expect(
      expectedEntitlementKeysForPath(
        `${app}/Contents/Frameworks/NexusIDE Helper (Renderer).app/Contents/Frameworks/libinternal.dylib`,
        app,
      ),
    ).toEqual([]);
  });

  it("requires renderer, functional, and main-owned shutdown proof from the real app", () => {
    expect(() =>
      assertPackagedSmokeOutput("[smoke] renderer-mounted\n", "darwin"),
    ).toThrow(/functional-ready/);
    expect(() =>
      assertPackagedSmokeOutput("[smoke] functional-ready\n", "darwin"),
    ).toThrow(/renderer-mounted/);
    expect(() =>
      assertPackagedSmokeOutput(
        ["[smoke] renderer-mounted", "[smoke] functional-ready"].join("\n"),
        "darwin",
      ),
    ).toThrow(/shutdown-complete/);
    expect(() =>
      assertPackagedSmokeOutput(
        [
          "[smoke] renderer-mounted",
          "[smoke] functional-ready",
          "[smoke] shutdown-complete",
        ].join("\n"),
        "darwin",
      ),
    ).toThrow(/darwin-pty-supervisor-ready/);
    expect(() =>
      assertPackagedSmokeOutput(
        [
          "[smoke] renderer-mounted",
          "[smoke] functional-ready",
          "[smoke] darwin-pty-supervisor-ready",
          "[smoke] shutdown-complete",
        ].join("\n"),
        "darwin",
      ),
    ).not.toThrow();
  });

  it("reads Electron fuses with the locked local CLI and current Node", () => {
    const invocation = buildFusesReadInvocation("/tmp/NexusIDE.app", "/repo");
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      "/repo/node_modules/@electron/fuses/dist/bin.js",
      "read",
      "--app",
      "/tmp/NexusIDE.app",
    ]);
    expect(invocation.args).not.toContain("npx");
  });

  it("validates required Electron fuses when the CLI emits ANSI colors", () => {
    const coloredOutput = [
      "\u001b[33mRunAsNode\u001b[39m is \u001b[31mDisabled\u001b[39m",
      "\u001b[33mEnableCookieEncryption\u001b[39m is \u001b[32mEnabled\u001b[39m",
      "\u001b[33mEnableNodeOptionsEnvironmentVariable\u001b[39m is \u001b[31mDisabled\u001b[39m",
      "\u001b[33mEnableNodeCliInspectArguments\u001b[39m is \u001b[31mDisabled\u001b[39m",
      "\u001b[33mEnableEmbeddedAsarIntegrityValidation\u001b[39m is \u001b[32mEnabled\u001b[39m",
      "\u001b[33mOnlyLoadAppFromAsar\u001b[39m is \u001b[32mEnabled\u001b[39m",
      "\u001b[33mGrantFileProtocolExtraPrivileges\u001b[39m is \u001b[31mDisabled\u001b[39m",
    ].join("\n");

    expect(() => assertRequiredElectronFuses(coloredOutput)).not.toThrow();
    expect(() =>
      assertRequiredElectronFuses(
        coloredOutput.replace("Disabled", "Enabled"),
      ),
    ).toThrow(/RunAsNode is Disabled/);
  });

  it("accepts one host architecture and rejects incoherent DMG/ZIP apps", () => {
    expect(parseLipoArchitectures("arm64\n")).toEqual(["arm64"]);
    expect(parseLipoArchitectures("x86_64 arm64\n")).toEqual([
      "arm64",
      "x86_64",
    ]);
    expect(() =>
      assertMatchingReleaseArchitectures(["arm64"], ["arm64"], "arm64"),
    ).not.toThrow();
    expect(() =>
      assertMatchingReleaseArchitectures(["arm64"], ["x86_64"], "arm64"),
    ).toThrow(/DMG.*ZIP.*architecture/i);
    expect(() =>
      assertMatchingReleaseArchitectures(
        ["arm64", "x86_64"],
        ["arm64", "x86_64"],
        "arm64",
      ),
    ).toThrow(/single-architecture/i);
  });

  it("rejects empty, unknown, and duplicate lipo architecture output", () => {
    expect(() => parseLipoArchitectures(" \n")).toThrow(/did not report any/i);
    expect(() => parseLipoArchitectures("arm64 i386\n")).toThrow(
      /unsupported.*i386/i,
    );
    expect(() => parseLipoArchitectures("arm64 arm64\n")).toThrow(
      /duplicate.*arm64/i,
    );
  });

  it("requires universal architecture only for the exact native supervisor path", () => {
    const app = "/tmp/NexusIDE.app";
    expect(
      expectedMachOArchitecturesForPath(
        `${app}/Contents/Resources/nexus-pty-supervisor`,
        app,
        "arm64",
      ),
    ).toEqual(["arm64", "x86_64"]);
    expect(
      expectedMachOArchitecturesForPath(
        `${app}/Contents/Resources/tools/nexus-pty-supervisor`,
        app,
        "arm64",
      ),
    ).toEqual(["arm64"]);
    expect(
      expectedMachOArchitecturesForPath(
        `${app}/Contents/Resources/nexus-pty-supervisor-copy`,
        app,
        "arm64",
      ),
    ).toEqual(["arm64"]);
    expect(
      expectedMachOArchitecturesForPath(
        `${app}/Contents/MacOS/nexus-ide`,
        app,
        "arm64",
      ),
    ).toEqual(["arm64"]);
  });

  it("verifies signatures, metadata, and entitlements for every expected slice", () => {
    const binary = "/tmp/NexusIDE.app/Contents/Resources/nexus-pty-supervisor";
    const invocations = buildCodesignSliceInvocations(binary, [
      "arm64",
      "x86_64",
    ]);

    expect(invocations).toEqual([
      {
        architecture: "arm64",
        verify: {
          command: "/usr/bin/codesign",
          args: ["--verify", "--strict", "--verbose=2", "-a", "arm64", binary],
        },
        metadata: {
          command: "/usr/bin/codesign",
          args: ["-dv", "--verbose=4", "-a", "arm64", binary],
        },
        entitlements: {
          command: "/usr/bin/codesign",
          args: ["-d", "--entitlements", "-", "--xml", "-a", "arm64", binary],
        },
      },
      {
        architecture: "x86_64",
        verify: {
          command: "/usr/bin/codesign",
          args: ["--verify", "--strict", "--verbose=2", "-a", "x86_64", binary],
        },
        metadata: {
          command: "/usr/bin/codesign",
          args: ["-dv", "--verbose=4", "-a", "x86_64", binary],
        },
        entitlements: {
          command: "/usr/bin/codesign",
          args: ["-d", "--entitlements", "-", "--xml", "-a", "x86_64", binary],
        },
      },
    ]);
  });

  it("requires one responsibility supervisor at the exact Resources path", () => {
    const app = "/tmp/NexusIDE.app";
    const exact = `${app}/Contents/Resources/nexus-pty-supervisor`;
    expect(assertSingleResponsibilitySupervisorPath([exact], app)).toBe(exact);
    expect(() => assertSingleResponsibilitySupervisorPath([], app)).toThrow(
      /exactly one/i,
    );
    expect(() =>
      assertSingleResponsibilitySupervisorPath(
        [exact, `${app}/Contents/Resources/tools/nexus-pty-supervisor`],
        app,
      ),
    ).toThrow(/exactly one/i);
    expect(() =>
      assertSingleResponsibilitySupervisorPath(
        [`${app}/Contents/Resources/tools/nexus-pty-supervisor`],
        app,
      ),
    ).toThrow(/exactly one/i);
  });

  it("requires zero bundled node-pty spawn-helper entries", () => {
    expect(() => assertNoBundledNodePtySpawnHelpers([])).not.toThrow();
    expect(() =>
      assertNoBundledNodePtySpawnHelpers([
        "/tmp/NexusIDE.app/Contents/Resources/app.asar.unpacked/node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper",
      ]),
    ).toThrow(/forbidden node-pty spawn-helper/i);
  });

  it("requires the exact helper identifier and hardened runtime flag", () => {
    const metadata = parseCodesignMetadata(
      [
        "Identifier=nexus-pty-supervisor",
        "CodeDirectory v=20500 size=777 flags=0x10000(runtime) hashes=12+7 location=embedded",
        "Executable Segment flags=0x1",
        "Authority=Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
        "Timestamp=23 Jul 2026 at 08:49:41",
        "TeamIdentifier=35P5XL3JN6",
      ].join("\n"),
    );
    expect(metadata).toMatchObject({
      identifier: "nexus-pty-supervisor",
      codeDirectoryFlags: 0x10000,
      codeDirectoryFlagNames: ["runtime"],
    });
    expect(() =>
      assertResponsibilitySupervisorSignatureMetadata(
        metadata,
        "35P5XL3JN6",
        "Developer ID Application: Cleofas Pereira rocha",
      ),
    ).not.toThrow();
    expect(() =>
      assertResponsibilitySupervisorSignatureMetadata(
        { ...metadata, identifier: "nexus-pty-supervisor-copy" },
        "35P5XL3JN6",
        "Developer ID Application: Cleofas Pereira rocha",
      ),
    ).toThrow(/Identifier/);
    expect(() =>
      assertResponsibilitySupervisorSignatureMetadata(
        { ...metadata, codeDirectoryFlags: 0 },
        "35P5XL3JN6",
        "Developer ID Application: Cleofas Pereira rocha",
      ),
    ).toThrow(/hardened runtime/i);
  });
});
