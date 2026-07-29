import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_SIGNING_IDENTITY,
  RESPONSIBILITY_SUPERVISOR_NAME,
  assertResponsibilitySupervisorSignatureMetadata,
  assertSignatureMetadata,
  parseCodesignMetadata,
} from "../verify-macos-release.mjs";

export const EXPECTED_FAST_MISSION_TEAM_ID = "35P5XL3JN6";
export const EXPECTED_FAST_MISSION_AUTHORITY =
  `${DEFAULT_SIGNING_IDENTITY} (${EXPECTED_FAST_MISSION_TEAM_ID})`;

export const SIGNED_PACKAGE_GUIDANCE = [
  "O E2E físico nunca roda sobre pacote ad-hoc.",
  "Assine e notarize o app localmente antes de repetir:",
  "env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \\",
  "  NEXUS_MAC_PUBLISH_RELEASE=1 \\",
  `  APPLE_TEAM_ID=${EXPECTED_FAST_MISSION_TEAM_ID} \\`,
  "  APPLE_KEYCHAIN_PROFILE='nexus-notary' \\",
  '  PATH="$PWD/scripts/codesign-retry-bin:$PATH" \\',
  "  npm run package",
  "O certificado Developer ID Application e o perfil local nexus-notary " +
    "precisam existir no Keychain; veja build/notarize.md.",
].join("\n");

function runCodesignCommand(args) {
  const result = spawnSync("/usr/bin/codesign", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `/usr/bin/codesign ${args.join(" ")} exited ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function preflightFailure(stage, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `[fast] ${stage}. Assinatura ad-hoc ou Developer ID divergente é ` +
      `recusada antes de criar a missão.\n${detail}\n\n${SIGNED_PACKAGE_GUIDANCE}`,
    { cause: error },
  );
}

function assertExactSupervisorFile(appPath) {
  const supervisorPath = path.join(
    path.resolve(appPath),
    "Contents",
    "Resources",
    RESPONSIBILITY_SUPERVISOR_NAME,
  );
  const stats = fs.lstatSync(supervisorPath);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o111) === 0
  ) {
    throw new Error(
      `${RESPONSIBILITY_SUPERVISOR_NAME} must be one regular executable file ` +
        `at ${supervisorPath}`,
    );
  }
  return supervisorPath;
}

export function assertFastRealMissionAppSignature(
  appPath,
  { runCodesign = runCodesignCommand } = {},
) {
  const resolvedAppPath = path.resolve(appPath);
  let supervisorPath;
  try {
    const appStats = fs.lstatSync(resolvedAppPath);
    if (appStats.isSymbolicLink() || !appStats.isDirectory()) {
      throw new Error(`expected a regular app bundle at ${resolvedAppPath}`);
    }
    supervisorPath = assertExactSupervisorFile(resolvedAppPath);
  } catch (error) {
    throw preflightFailure("invalid packaged app layout", error);
  }

  try {
    runCodesign([
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      resolvedAppPath,
    ]);
  } catch (error) {
    throw preflightFailure("deep codesign verification failed", error);
  }

  let appMetadata;
  try {
    appMetadata = parseCodesignMetadata(
      runCodesign(["-dv", "--verbose=4", resolvedAppPath]),
    );
    assertSignatureMetadata(
      appMetadata,
      EXPECTED_FAST_MISSION_TEAM_ID,
      DEFAULT_SIGNING_IDENTITY,
    );
  } catch (error) {
    throw preflightFailure(
      "app TeamIdentifier/Authority verification failed",
      error,
    );
  }

  try {
    runCodesign([
      "--verify",
      "--strict",
      "--verbose=2",
      supervisorPath,
    ]);
    const supervisorMetadata = parseCodesignMetadata(
      runCodesign(["-dv", "--verbose=4", supervisorPath]),
    );
    assertResponsibilitySupervisorSignatureMetadata(
      supervisorMetadata,
      EXPECTED_FAST_MISSION_TEAM_ID,
      DEFAULT_SIGNING_IDENTITY,
    );
  } catch (error) {
    throw preflightFailure(
      "nexus-pty-supervisor TeamIdentifier/Authority verification failed",
      error,
    );
  }

  return {
    identity: appMetadata.authorities[0],
    supervisorPath,
    teamIdentifier: appMetadata.teamIdentifier,
  };
}
