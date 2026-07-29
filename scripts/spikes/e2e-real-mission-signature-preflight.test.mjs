import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXPECTED_FAST_MISSION_AUTHORITY,
  SIGNED_PACKAGE_GUIDANCE,
  assertFastRealMissionAppSignature,
} from "./e2e-real-mission-signature-preflight.mjs";

const temporaryRoots = [];

function createAppFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-fast-signature-preflight-"),
  );
  temporaryRoots.push(root);
  const appPath = path.join(root, "NexusIDE.app");
  const supervisorPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "nexus-pty-supervisor",
  );
  fs.mkdirSync(path.dirname(supervisorPath), { recursive: true });
  fs.writeFileSync(supervisorPath, "fixture");
  fs.chmodSync(supervisorPath, 0o755);
  return { appPath, supervisorPath };
}

function signatureMetadata({
  identifier = "com.nexuside.app",
  authority = EXPECTED_FAST_MISSION_AUTHORITY,
  teamIdentifier = "35P5XL3JN6",
  runtime = false,
} = {}) {
  return [
    `Identifier=${identifier}`,
    `CodeDirectory v=20500 size=777 flags=${runtime ? "0x10000(runtime)" : "0x0"}`,
    `Authority=${authority}`,
    "Authority=Developer ID Certification Authority",
    "Timestamp=28 Jul 2026 at 23:58:00",
    `TeamIdentifier=${teamIdentifier}`,
  ].join("\n");
}

function createCodesignDouble({
  appMetadata = signatureMetadata(),
  supervisorMetadata = signatureMetadata({
    identifier: "nexus-pty-supervisor",
    runtime: true,
  }),
  failingInvocation = null,
} = {}) {
  const calls = [];
  const runCodesign = (args) => {
    calls.push(args);
    if (failingInvocation?.(args)) {
      throw new Error("code object is not signed at all");
    }
    if (args.includes("-dv")) {
      return args.at(-1).endsWith("nexus-pty-supervisor")
        ? supervisorMetadata
        : appMetadata;
    }
    return "";
  };
  return { calls, runCodesign };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("fast real-mission Developer ID preflight", () => {
  it("deep-verifies the app and verifies exact metadata for app and supervisor", () => {
    const { appPath, supervisorPath } = createAppFixture();
    const codesign = createCodesignDouble();

    const result = assertFastRealMissionAppSignature(appPath, {
      runCodesign: codesign.runCodesign,
    });

    expect(result).toEqual({
      identity: EXPECTED_FAST_MISSION_AUTHORITY,
      supervisorPath,
      teamIdentifier: "35P5XL3JN6",
    });
    expect(codesign.calls).toEqual([
      ["--verify", "--deep", "--strict", "--verbose=2", appPath],
      ["-dv", "--verbose=4", appPath],
      ["--verify", "--strict", "--verbose=2", supervisorPath],
      ["-dv", "--verbose=4", supervisorPath],
    ]);
  });

  it("refuses ad-hoc or mismatched signatures and explains how to sign locally", () => {
    const { appPath } = createAppFixture();
    const adHoc = createCodesignDouble({
      appMetadata: [
        "Identifier=com.nexuside.app",
        "Signature=adhoc",
        "TeamIdentifier=not set",
      ].join("\n"),
    });

    expect(() =>
      assertFastRealMissionAppSignature(appPath, {
        runCodesign: adHoc.runCodesign,
      }),
    ).toThrow(
      new RegExp(
        `ad-hoc[\\s\\S]*APPLE_TEAM_ID=35P5XL3JN6[\\s\\S]*npm run package`,
        "iu",
      ),
    );
    expect(SIGNED_PACKAGE_GUIDANCE).toContain(
      "APPLE_KEYCHAIN_PROFILE='nexus-notary'",
    );

    const wrongSupervisor = createCodesignDouble({
      supervisorMetadata: signatureMetadata({
        authority: "Developer ID Application: Mallory (35P5XL3JN6)",
        identifier: "nexus-pty-supervisor",
        runtime: true,
      }),
    });
    expect(() =>
      assertFastRealMissionAppSignature(appPath, {
        runCodesign: wrongSupervisor.runCodesign,
      }),
    ).toThrow(/supervisor[\s\S]*Authority mismatch/iu);
  });

  it("stops when deep bundle verification fails before inspecting the helper", () => {
    const { appPath } = createAppFixture();
    const codesign = createCodesignDouble({
      failingInvocation: (args) => args.includes("--deep"),
    });

    expect(() =>
      assertFastRealMissionAppSignature(appPath, {
        runCodesign: codesign.runCodesign,
      }),
    ).toThrow(/deep codesign verification failed/iu);
    expect(codesign.calls).toEqual([
      ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    ]);
  });
});
