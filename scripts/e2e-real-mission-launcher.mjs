import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  REAL_MISSION_FLAG,
  REAL_MISSION_PRODUCT_WIZARD_FLAG,
  SAFE_CHILD_ENV_KEYS,
} from "./e2e-real-mission-contract.mjs";

export function parseRealMissionArgs(argv) {
  const result = { appPath: null, evidencePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--app" && flag !== "--evidence") {
      throw new Error(
        "usage: e2e-real-mission.mjs [--app /path/NexusIDE.app] [--evidence /path/evidence.json]",
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    if (flag === "--app") result.appPath = path.resolve(value);
    else result.evidencePath = path.resolve(value);
    index += 1;
  }
  return result;
}

export function realMissionArgs(
  userData,
  launchSurface = "private-runner",
) {
  const flag =
    launchSurface === "product-wizard"
      ? REAL_MISSION_PRODUCT_WIZARD_FLAG
      : REAL_MISSION_FLAG;
  return [`--user-data-dir=${path.resolve(userData)}`, "--", flag];
}

export function realMissionEnvironment(
  baseEnv,
  userData,
  codexBinary,
  launchSurface = "private-runner",
  attestation = null,
) {
  const environment = Object.fromEntries(
    Object.entries(baseEnv).filter(
      ([key, value]) =>
        typeof value === "string" && SAFE_CHILD_ENV_KEYS.has(key),
    ),
  );
  const isolatedUserData = path.resolve(userData);
  const home = path.join(isolatedUserData, "home");
  const tmp = path.join(isolatedUserData, "tmp");
  let attestationEnvironment = {};
  if (attestation !== null) {
    if (
      typeof attestation !== "object" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(attestation.secret ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/u.test(attestation.challenge ?? "") ||
      !/^[A-Za-z0-9_-]{16,8192}$/u.test(attestation.binding ?? "")
    ) {
      throw new Error("invalid sealed real mission runtime attestation");
    }
    attestationEnvironment = {
      NEXUS_REAL_MISSION_ATTESTATION_SECRET: attestation.secret,
      NEXUS_REAL_MISSION_ATTESTATION_CHALLENGE: attestation.challenge,
      NEXUS_REAL_MISSION_ATTESTATION_BINDING: attestation.binding,
    };
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PATH: [
      path.join(isolatedUserData, "trusted-bin"),
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(path.delimiter),
    NEXUS_USER_DATA_DIR: isolatedUserData,
    // Reliable gate marker: argv after `--` is not always visible the same way
    // across Electron packaging layers. Main-owned e2e paths read this env.
    ...(launchSurface === "product-wizard"
      ? { NEXUS_REAL_MISSION_PRODUCT_WIZARD_E2E: "1" }
      : { NEXUS_REAL_MISSION_E2E: "1" }),
    ...attestationEnvironment,
  };
}

export function stageTrustedCodexLauncher(codexBinary, userData) {
  const directory = path.join(path.resolve(userData), "trusted-bin");
  fs.mkdirSync(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const launcher = path.join(directory, "codex");
  fs.symlinkSync(path.resolve(codexBinary), launcher, "file");
  return launcher;
}

/**
 * Product-wizard E2E uses an isolated HOME. Without this seed the first-run
 * onboarding modal mounts over MissionWizard (higher z-index) and the gate
 * never creates a mission — missing-evidence at product-wizard-ready.
 */
export function stageRealMissionOnboardingComplete(isolatedHome) {
  const home = path.resolve(isolatedHome);
  if (!path.isAbsolute(home) || home.includes("\0")) {
    throw new Error("isolated HOME for onboarding seed is invalid");
  }
  const nexusDir = path.join(home, ".nexus");
  fs.mkdirSync(nexusDir, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  fs.chmodSync(nexusDir, PRIVATE_DIRECTORY_MODE);
  const file = path.join(nexusDir, "onboarding.json");
  const payload = `${JSON.stringify(
    {
      completed: true,
      skipped: false,
      victories: {
        cliDetected: Date.now(),
      },
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(file, payload, { mode: PRIVATE_FILE_MODE });
  return file;
}

function defaultResolveCommand(command, environment) {
  const result = spawnSync("/usr/bin/which", [command], {
    encoding: "utf8",
    env: {
      PATH: environment.PATH ?? "",
      LANG: environment.LANG ?? "C",
    },
    shell: false,
    timeout: 15_000,
  });
  if (result.status !== 0) return "";
  return (result.stdout ?? "").split(/\r?\n/u).find(Boolean) ?? "";
}

export function resolveTrustedCodexBinary({
  environment = process.env,
  resolveCommand = defaultResolveCommand,
} = {}) {
  const unresolved = resolveCommand("codex", environment);
  if (typeof unresolved !== "string" || !path.isAbsolute(unresolved)) {
    throw new Error("codex CLI was not found at an absolute path");
  }
  const binary = fs.realpathSync(unresolved);
  const stat = fs.statSync(binary);
  if (
    !stat.isFile() ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("refusing an untrusted or writable codex CLI binary");
  }
  if (
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid() &&
    stat.uid !== 0
  ) {
    throw new Error("refusing a codex CLI binary owned by another user");
  }
  const normalized = binary.replaceAll("\\", "/");
  const suffix = "/node_modules/@openai/codex/bin/codex.js";
  if (!normalized.endsWith(suffix)) {
    throw new Error(
      "codex binary is not the official Codex package entrypoint",
    );
  }
  const packageRoot = binary.slice(0, -"/bin/codex.js".length);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageStat = fs.lstatSync(packageJsonPath);
  if (
    packageStat.isSymbolicLink() ||
    !packageStat.isFile() ||
    (packageStat.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" &&
      packageStat.uid !== process.getuid() &&
      packageStat.uid !== 0)
  ) {
    throw new Error("codex package metadata is not trusted");
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (packageJson?.name !== "@openai/codex") {
    throw new Error("codex binary is not the official Codex package");
  }
  return binary;
}

/**
 * Copy only Codex's authentication receipt into the private disposable HOME.
 * User config, plugins, sessions and Nexus state stay outside the release gate.
 */
export function stageCodexAuthentication(sourceCodexHome, isolatedHome) {
  const source = path.join(path.resolve(sourceCodexHome), "auth.json");
  let descriptor;
  try {
    descriptor = fs.openSync(
      source,
      fs.constants.O_RDONLY |
        (typeof fs.constants.O_NOFOLLOW === "number"
          ? fs.constants.O_NOFOLLOW
          : 0),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "ELOOP") {
      throw new Error("refusing to stage a non-regular Codex auth file");
    }
    throw error;
  }
  let destination = "";
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error("refusing to stage a non-regular Codex auth file");
    }
    if ((before.mode & 0o077) !== 0) {
      throw new Error("Codex auth file must use private mode 0600");
    }
    if (
      typeof process.getuid === "function" &&
      before.uid !== process.getuid()
    ) {
      throw new Error("Codex auth file must be owned by the release operator");
    }
    if (before.size > 4 * 1024 * 1024) {
      throw new Error("refusing to stage an oversized Codex auth file");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(source);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      after.dev !== pathStat.dev ||
      after.ino !== pathStat.ino ||
      after.size !== pathStat.size
    ) {
      throw new Error("Codex auth file changed while it was being staged");
    }
    const destinationDirectory = path.join(
      path.resolve(isolatedHome),
      ".codex",
    );
    fs.mkdirSync(destinationDirectory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    fs.chmodSync(destinationDirectory, PRIVATE_DIRECTORY_MODE);
    destination = path.join(destinationDirectory, "auth.json");
    fs.writeFileSync(destination, bytes, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    fs.chmodSync(destination, PRIVATE_FILE_MODE);
    return true;
  } catch (error) {
    if (destination) {
      try {
        fs.rmSync(destination, { force: true });
      } catch {
        // Best effort only: never replace the original staging failure.
      }
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertCodexReady({
  run = spawnSync,
  environment = process.env,
  codexBinary,
} = {}) {
  if (typeof codexBinary !== "string" || !path.isAbsolute(codexBinary)) {
    throw new Error("trusted absolute codex CLI path is required");
  }
  const version = run(codexBinary, ["--version"], {
    encoding: "utf8",
    env: environment,
    shell: false,
    timeout: 15_000,
  });
  const versionMatch = (version.stdout ?? "").match(
    /^codex-cli (\d+)\.(\d+)\.(\d+)/mu,
  );
  if (version.status !== 0 || !versionMatch) {
    throw new Error("codex CLI is not installed or executable");
  }
  const installedVersion = versionMatch.slice(1, 4).map((part) => Number(part));
  const minimumVersion = [0, 145, 0];
  const belowMinimum = installedVersion.some((part, index) => {
    if (part === minimumVersion[index]) return false;
    return (
      installedVersion
        .slice(0, index)
        .every((value, prefix) => value === minimumVersion[prefix]) &&
      part < minimumVersion[index]
    );
  });
  if (belowMinimum) {
    throw new Error("real mission gate requires codex CLI >= 0.145.0");
  }
  const login = run(codexBinary, ["login", "status"], {
    encoding: "utf8",
    env: environment,
    shell: false,
    timeout: 30_000,
  });
  const loginText = `${login.stdout ?? ""}\n${login.stderr ?? ""}`;
  if (
    login.status !== 0 ||
    !/^\s*Logged in(?:\s+using\b[^\r\n]*)?\s*$/imu.test(loginText)
  ) {
    throw new Error("codex CLI is not authenticated");
  }
  return {
    installed: true,
    authenticated: true,
    version: (version.stdout ?? "").trim().slice(0, 64),
  };
}
