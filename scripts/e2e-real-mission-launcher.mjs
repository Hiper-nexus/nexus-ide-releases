import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  REAL_MISSION_ADVISOR_SKIP_ENV,
  REAL_MISSION_ADVISOR_SKIP_PATTERN,
  REAL_MISSION_FLAG,
  REAL_MISSION_ORCHESTRATOR_ENV,
  REAL_MISSION_ORCHESTRATOR_PATTERN,
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
  // Advisor skips are computed by the gate and injected into this environment
  // before waitForChild re-derives the child env from it; preserve only a
  // strictly-shaped comma-separated id list so nothing else can ride along.
  const advisorSkips = baseEnv[REAL_MISSION_ADVISOR_SKIP_ENV];
  const advisorSkipEnvironment =
    typeof advisorSkips === "string" &&
    advisorSkips.length <= 256 &&
    REAL_MISSION_ADVISOR_SKIP_PATTERN.test(advisorSkips)
      ? { [REAL_MISSION_ADVISOR_SKIP_ENV]: advisorSkips }
      : {};
  // Orchestrator variant rides the same strict pattern: only "codex"/"claude"
  // crosses into the child; anything else falls back to the codex default.
  const orchestrator = baseEnv[REAL_MISSION_ORCHESTRATOR_ENV];
  const orchestratorEnvironment =
    typeof orchestrator === "string" &&
    REAL_MISSION_ORCHESTRATOR_PATTERN.test(orchestrator)
      ? { [REAL_MISSION_ORCHESTRATOR_ENV]: orchestrator }
      : {};
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
      // Official Codex npm entry is `#!/usr/bin/env node`. Keep the Node that
      // hosts that package on PATH so any preflight that still touches the
      // wrapper can resolve. Main still launches the sealed Darwin binary.
      ...nodeBinDirsNearCodexPackage(codexBinary),
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
    ...advisorSkipEnvironment,
    ...orchestratorEnvironment,
    ...attestationEnvironment,
  };
}

/**
 * Resolve Node bin dirs adjacent to the official `@openai/codex` package so
 * `#!/usr/bin/env node` works under the gate's restricted PATH.
 * codexBinary is expected at `.../node_modules/@openai/codex/bin/codex.js`.
 */
export function nodeBinDirsNearCodexPackage(codexBinary) {
  if (typeof codexBinary !== "string" || !path.isAbsolute(codexBinary)) {
    return [];
  }
  const normalized = codexBinary.replaceAll("\\", "/");
  const suffix = "/node_modules/@openai/codex/bin/codex.js";
  if (!normalized.endsWith(suffix)) return [];
  // hermes/local layout: <prefix>/lib/node_modules/@openai/codex/bin/codex.js
  // → <prefix>/bin/node
  const prefixLib = path.resolve(path.dirname(codexBinary), "../../../..");
  const candidates = [
    path.join(prefixLib, "bin"),
    path.join(path.dirname(prefixLib), "bin"),
  ];
  return candidates.filter((dir) => {
    try {
      const nodePath = path.join(dir, "node");
      const st = fs.statSync(nodePath);
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
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
 * Stage multi-CLI advisor (and Claude) binaries into the gate's trusted-bin.
 * The isolated child PATH only sees trusted-bin + a few system dirs — without
 * these symlinks, adapters report installed=false, the product-wizard launch
 * button stays disabled forever, and the gate hangs at product-wizard-ready.
 *
 * Missing/untrusted binaries are omitted (never a hard failure); callers that
 * already called assertAdvisorBinaries decide skip vs require.
 */
export function stageTrustedAdvisorLaunchers(
  userData,
  {
    environment = process.env,
    resolveCommand = defaultResolveCommand,
    clis = REAL_MISSION_ADVISOR_BINARIES,
  } = {},
) {
  const directory = path.join(path.resolve(userData), "trusted-bin");
  fs.mkdirSync(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const staged = {};
  for (const cli of clis) {
    if (cli === "codex") continue; // staged by stageTrustedCodexLauncher
    // glm (and future Claude-backed forks) resolve the host `claude` binary.
    const hostBin = resolveRealMissionAdvisorHostBin(cli);
    const unresolved = resolveCommand(hostBin, environment);
    if (typeof unresolved !== "string" || !path.isAbsolute(unresolved)) {
      continue;
    }
    let binary;
    try {
      binary = fs.realpathSync(unresolved);
      const stat = fs.statSync(binary);
      if (
        !stat.isFile() ||
        (stat.mode & 0o111) === 0 ||
        (stat.mode & 0o022) !== 0
      ) {
        continue;
      }
      if (
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid() &&
        stat.uid !== 0
      ) {
        continue;
      }
    } catch {
      continue;
    }
    // Stage under the adapter id (glm) and, when the host bin differs, also
    // under the host name (claude) so resolveAdapterBinary(adapter.bin) works.
    for (const linkName of new Set([cli, hostBin])) {
      const launcher = path.join(directory, linkName);
      try {
        fs.lstatSync(launcher);
        fs.unlinkSync(launcher);
      } catch {
        // absent is fine
      }
      fs.symlinkSync(binary, launcher, "file");
    }
    staged[cli] = binary;
  }
  return staged;
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

const ADVISOR_AUTH_MAX_BYTES = 4 * 1024 * 1024;
const ADVISOR_DATABASE_MAX_BYTES = 64 * 1024 * 1024;
const KIMI_ACCESS_TOKEN_MIN_TTL_SECONDS = 5 * 60;
const GROK_ACCESS_TOKEN_MIN_TTL_MS = 5 * 60_000;
const GROK_AUTH_FAILURE_PATTERN =
  /(?:you are not authenticated|not signed in|authentication required|login required|refresh[_ -]?token[_ -]?(?:rejected|expired|invalid)|re-?authorization required|token[_ -]?expired[_ -]?no[_ -]?refresh)/iu;

function grokAuthProfiles(blob) {
  try {
    const parsed = JSON.parse(blob);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const candidates = [parsed, ...Object.values(parsed)];
    return candidates.filter(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate),
    );
  } catch {
    return [];
  }
}

function grokExpiryMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1_000_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1_000;
  }
  return Date.parse(value);
}

export function grokCredentialsBlobIsFresh(
  blob,
  nowMs = Date.now(),
) {
  return grokAuthProfiles(blob).some((profile) => {
    const access =
      typeof profile.key === "string"
        ? profile.key.trim()
        : typeof profile.access_token === "string"
          ? profile.access_token.trim()
          : "";
    const expiresAt = grokExpiryMs(profile.expires_at);
    return (
      access.length > 0 &&
      Number.isFinite(expiresAt) &&
      expiresAt - nowMs > GROK_ACCESS_TOKEN_MIN_TTL_MS
    );
  });
}

function grokCredentialsCanRefresh(blob) {
  return grokAuthProfiles(blob).some(
    (profile) =>
      typeof profile.refresh_token === "string" &&
      profile.refresh_token.trim().length > 0,
  );
}

function isolatedAdvisorPreflightEnvironment(environment, home, grokHome) {
  const inherited = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        SAFE_CHILD_ENV_KEYS.has(key) && typeof value === "string",
    ),
  );
  const temporaryDirectory = path.join(home, ".tmp");
  fs.mkdirSync(temporaryDirectory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  fs.chmodSync(temporaryDirectory, PRIVATE_DIRECTORY_MODE);
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    GROK_HOME: grokHome,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    LANG: inherited.LANG ?? "C",
    LC_ALL: "C",
  };
}

/**
 * Validate only the staged Grok profile. A fresh token needs no network; an
 * expired token gets one bounded CLI refresh attempt inside the isolated HOME.
 * Grok `models` exits 0 even when logged out, so both its output and the
 * post-refresh auth file are checked.
 */
export function preflightStagedGrokAuthentication(
  isolatedHome,
  {
    binary = "grok",
    environment = process.env,
    run = spawnSync,
    nowMs = Date.now(),
  } = {},
) {
  const home = path.resolve(isolatedHome);
  const grokHome = path.join(home, ".grok");
  const authFile = path.join(grokHome, "auth.json");
  let before;
  try {
    before = fs.readFileSync(authFile, "utf8");
  } catch {
    return false;
  }
  if (grokCredentialsBlobIsFresh(before, nowMs)) return true;
  if (
    !grokCredentialsCanRefresh(before) ||
    typeof binary !== "string" ||
    !binary.trim()
  ) {
    return false;
  }
  let result;
  try {
    result = run(binary, ["models"], {
      cwd: home,
      encoding: "utf8",
      env: isolatedAdvisorPreflightEnvironment(environment, home, grokHome),
      shell: false,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
  } catch {
    return false;
  }
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  if (
    result?.error ||
    result?.signal ||
    result?.status !== 0 ||
    GROK_AUTH_FAILURE_PATTERN.test(output)
  ) {
    return false;
  }
  try {
    return grokCredentialsBlobIsFresh(
      fs.readFileSync(authFile, "utf8"),
      nowMs,
    );
  } catch {
    return false;
  }
}

const AGY_AUTH_PROBE_TIMEOUT_MS = 90_000;
const AGY_AUTH_PROBE_MAX_BUFFER_BYTES = 256 * 1024;
/** Bounded retries for transient AGY eligibility/backend blips (503/UNAVAILABLE). */
const AGY_AUTH_PROBE_MAX_ATTEMPTS = 5;
const AGY_AUTH_PROBE_RETRY_DELAY_MS = 5_000;
const AGY_MISSING_CREDENTIAL_PATTERN =
  /(?:you are not authenticated|not authenticated|not logged in|not signed in|authentication required|login required|please (?:log|sign) in|run\s+\/login|complete (?:the )?(?:google )?(?:oauth|authentication)|no (?:oauth )?credentials?)/iu;
const AGY_TRANSIENT_PROBE_PATTERN =
  /(?:UNAVAILABLE|currently unavailable|Eligibility check failed|code\s*503|\b503\b|service unavailable|temporarily unavailable|ECONNRESET|ETIMEDOUT|socket hang up)/iu;

function agyProbeOperationalFailure(reason, cause = undefined) {
  return new Error(`AGY authentication probe failed operationally: ${reason}`, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function agyProbeIsTransientFailure(result) {
  if (result?.error || result?.signal || result?.status === null) return true;
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return AGY_TRANSIENT_PROBE_PATTERN.test(output);
}

function sleepSyncMs(ms, sleep) {
  if (typeof sleep === "function") {
    sleep(ms);
    return;
  }
  if (!(ms > 0)) return;
  // Sync delay without spawning: Atomics.wait parks the thread for `ms`.
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

/**
 * AGY 1.1 authenticates from the native macOS keyring/profile. It does not use
 * the legacy Gemini CLI oauth_creds.json/google_accounts.active contract.
 * Prove the session through the already trust-checked binary while HOME still
 * points at the real operator profile. The nonce prevents a banner, cached
 * text or stale file from being mistaken for a live model response.
 *
 * Transient eligibility/backend failures (503/UNAVAILABLE) are retried a
 * bounded number of times; persistent operational failures stay fail-closed
 * and are never mislabeled as a missing login.
 */
export function preflightNativeAgyAuthentication(
  operatorHome,
  {
    binary = null,
    environment = process.env,
    run = spawnSync,
    sleep = undefined,
    maxAttempts = AGY_AUTH_PROBE_MAX_ATTEMPTS,
    retryDelayMs = AGY_AUTH_PROBE_RETRY_DELAY_MS,
  } = {},
) {
  if (
    typeof operatorHome !== "string" ||
    !path.isAbsolute(operatorHome) ||
    operatorHome.includes("\0") ||
    typeof binary !== "string" ||
    !path.isAbsolute(binary) ||
    binary.includes("\0")
  ) {
    throw agyProbeOperationalFailure("invalid native profile or trusted binary");
  }
  const home = path.resolve(operatorHome);
  try {
    if (!fs.statSync(home).isDirectory()) {
      throw agyProbeOperationalFailure("operator HOME is not a directory");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("AGY authentication probe failed operationally:")
    ) {
      throw error;
    }
    throw agyProbeOperationalFailure("operator HOME is unavailable", error);
  }
  const attempts = Math.max(1, Math.min(Number(maxAttempts) || 1, 5));
  const delayMs = Math.max(0, Number(retryDelayMs) || 0);
  const inherited = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        SAFE_CHILD_ENV_KEYS.has(key) && typeof value === "string",
    ),
  );
  let lastFailure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nonce = randomBytes(16).toString("hex");
    const marker = `NEXUS_AGY_AUTH_OK_${nonce}`;
    const prompt =
      `Sem usar ferramentas, responda exatamente ${marker} e nada mais.`;
    let result;
    try {
      result = run(
        binary,
        [
          "--model",
          "gemini-3.6-flash-low",
          "--effort",
          "low",
          "--mode",
          "plan",
          "--sandbox",
          "--output-format",
          "text",
          "--print-timeout",
          "60s",
          "--print",
          prompt,
        ],
        {
          cwd: home,
          encoding: "utf8",
          env: {
            ...inherited,
            HOME: home,
            USERPROFILE: home,
            PATH:
              typeof environment.PATH === "string" && environment.PATH
                ? environment.PATH
                : "/usr/bin:/bin:/usr/sbin:/sbin",
            LANG: inherited.LANG ?? "C",
            LC_ALL: "C",
          },
          shell: false,
          timeout: AGY_AUTH_PROBE_TIMEOUT_MS,
          maxBuffer: AGY_AUTH_PROBE_MAX_BUFFER_BYTES,
        },
      );
    } catch (error) {
      throw agyProbeOperationalFailure("trusted binary could not be executed", error);
    }
    if (result?.error || result?.signal || result?.status === null) {
      lastFailure = "process timeout, signal or spawn error";
      if (attempt < attempts && agyProbeIsTransientFailure(result)) {
        sleepSyncMs(delayMs, sleep);
        continue;
      }
      throw agyProbeOperationalFailure(lastFailure);
    }
    const stdout =
      typeof result?.stdout === "string" ? result.stdout.trim() : "";
    const stderr =
      typeof result?.stderr === "string" ? result.stderr.trim() : "";
    const output = `${stdout}\n${stderr}`;
    if (AGY_MISSING_CREDENTIAL_PATTERN.test(output)) {
      return Object.freeze({ kind: "missing-credential" });
    }
    if (result?.status === 0 && stdout === marker) {
      return Object.freeze({ kind: "authenticated" });
    }
    if (result?.status === 0) {
      throw agyProbeOperationalFailure("returned an unverified response");
    }
    const detail = stderr
      ? `${stderr.replace(/\s+/gu, " ").slice(0, 240)}`
      : "no stderr";
    lastFailure = `exited with status ${String(result?.status ?? "unknown")} (${detail})`;
    if (attempt < attempts && agyProbeIsTransientFailure(result)) {
      sleepSyncMs(delayMs, sleep);
      continue;
    }
    throw agyProbeOperationalFailure(lastFailure);
  }
  throw agyProbeOperationalFailure(lastFailure ?? "exhausted retries");
}

/**
 * True only when a Kimi credentials JSON carries a non-empty access token
 * whose declared expiry is safely in the future. A refresh token alone is not
 * proof of a live isolated session: Kimi can reject an expired/invalid refresh
 * and then erase both copied tokens, which used to leave the release gate in an
 * interactive `/login` pane.
 */
export function kimiCredentialsBlobIsUsable(
  blob,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  try {
    const parsed = JSON.parse(blob);
    const access =
      typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
    const rawExpiry = Number(parsed.expires_at);
    if (!access || !Number.isFinite(rawExpiry) || rawExpiry <= 0) return false;
    const expirySeconds =
      rawExpiry >= 1_000_000_000_000
        ? Math.floor(rawExpiry / 1000)
        : Math.floor(rawExpiry);
    return expirySeconds - nowSeconds > KIMI_ACCESS_TOKEN_MIN_TTL_SECONDS;
  } catch {
    return false;
  }
}

/** chmod 0700 every directory from `leaf` up to (and including) `root`. */
function chmodPrivateTree(root, leaf) {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(leaf);
  for (;;) {
    fs.chmodSync(current, PRIVATE_DIRECTORY_MODE);
    if (current === resolvedRoot) return;
    const parent = path.dirname(current);
    if (
      parent === current ||
      !current.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      throw new Error("private advisor directory escapes the isolated HOME");
    }
    current = parent;
  }
}

/**
 * TOCTOU-safe copy of one advisor auth file into the isolated HOME, following
 * the same discipline as stageCodexAuthentication: O_NOFOLLOW open, regular
 * file owned by the operator, private source mode (for secret material),
 * re-stat before/after the read, exclusive 0600 write, no partial copy left
 * behind. Returns false when the source simply does not exist.
 */
function stageAdvisorAuthFile(
  source,
  destinationDirectory,
  {
    label,
    maxBytes = ADVISOR_AUTH_MAX_BYTES,
    requirePrivateMode = true,
    privateRoot = null,
  } = {},
) {
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
      throw new Error(`refusing to stage a non-regular ${label}`);
    }
    throw error;
  }
  let destination = "";
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error(`refusing to stage a non-regular ${label}`);
    }
    if (requirePrivateMode && (before.mode & 0o077) !== 0) {
      throw new Error(`${label} must use private mode 0600`);
    }
    if (
      typeof process.getuid === "function" &&
      before.uid !== process.getuid()
    ) {
      throw new Error(`${label} must be owned by the release operator`);
    }
    if (before.size > maxBytes) {
      throw new Error(`refusing to stage an oversized ${label}`);
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
      throw new Error(`${label} changed while it was being staged`);
    }
    fs.mkdirSync(destinationDirectory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    if (privateRoot !== null) {
      chmodPrivateTree(privateRoot, destinationDirectory);
    } else {
      fs.chmodSync(destinationDirectory, PRIVATE_DIRECTORY_MODE);
    }
    destination = path.join(destinationDirectory, path.basename(source));
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

export const REAL_MISSION_ADVISOR_BINARIES = Object.freeze([
  "grok",
  "kimi",
  "agy",
  "opencode",
  "claude",
  "glm",
]);

/**
 * Advisor ids whose adapter.bin is not the id itself (Claude-compatible
 * forks). Resolve the host CLI for --version / trusted-bin, but keep the
 * advisor id for skip lists and evidence.
 */
export const REAL_MISSION_ADVISOR_HOST_BIN = Object.freeze({
  glm: "claude",
});

export function resolveRealMissionAdvisorHostBin(cli) {
  if (typeof cli !== "string" || !cli) return cli;
  return REAL_MISSION_ADVISOR_HOST_BIN[cli] ?? cli;
}

const CLAUDE_AUTH_IDENTITY_MAX_BYTES = 256 * 1024;

/**
 * Stage the NON-SECRET native Claude login identity into the isolated child
 * HOME. The OAuth secret lives in the macOS keychain and the CLI reads it
 * regardless of HOME, but the native adapter decides "logged in" from
 * oauthAccount/userID in ~/.claude.json (see prepareEphemeralHome /
 * readNativeClaudeAuthIdentity): without these two non-secret keys the
 * orchestrator/advisor panes would fall into /login and hang the gate. No
 * credentials file, project trust or settings are ever copied.
 */
export function stageClaudeNativeIdentity(
  isolatedHome,
  { sourceHome = os.homedir() } = {},
) {
  const home = path.resolve(isolatedHome);
  const source = path.join(path.resolve(sourceHome), ".claude.json");
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
      throw new Error("refusing to stage a non-regular Claude profile");
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error("refusing to stage a non-regular Claude profile");
    }
    if (
      typeof process.getuid === "function" &&
      before.uid !== process.getuid()
    ) {
      throw new Error("Claude profile must be owned by the release operator");
    }
    if (before.size > CLAUDE_AUTH_IDENTITY_MAX_BYTES) {
      throw new Error("refusing to stage an oversized Claude profile");
    }
    const parsed = JSON.parse(
      fs.readFileSync(descriptor, "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const identity = {};
    // `oauthAccount` is an OBJECT ({ emailAddress, ... }) in a real profile.
    // The previous string-only check dropped it silently, so the staged profile
    // never carried the one field the auth probe reads (claudeOauthEmail) and
    // Claude looked logged out inside the isolated HOME — while the operator
    // profile was perfectly authenticated. Copy ONLY the email: it identifies
    // the session for the probe and carries no secret.
    const oauthAccount = parsed.oauthAccount;
    if (
      oauthAccount &&
      typeof oauthAccount === "object" &&
      !Array.isArray(oauthAccount) &&
      typeof oauthAccount.emailAddress === "string" &&
      oauthAccount.emailAddress.includes("@")
    ) {
      identity.oauthAccount = { emailAddress: oauthAccount.emailAddress };
    }
    if (typeof parsed.userID === "string" && parsed.userID.length > 0) {
      identity.userID = parsed.userID;
    }
    if (Object.keys(identity).length === 0) return false;
    fs.mkdirSync(home, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, ...identity }, null, 2),
      { mode: PRIVATE_FILE_MODE, flag: "wx" },
    );
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Stage the real operator profile's advisor credentials into the isolated
 * child HOME so the MCP overlays (which resolve profiles relative to the
 * child's HOME) can authenticate. Missing material is a skip, never a
 * failure: the caller aggregates the skipped ids into
 * NEXUS_REAL_MISSION_ADVISOR_SKIP for the child observer. Returns a per-CLI
 * status map: "staged" (material ready in the isolated HOME; for claude this
 * means the keychain credential is present — nothing is copied), "skipped"
 * (material is positively absent, onSkip fired) or "credentialless" (opencode
 * without auth, which still works via credentialless models). An installed
 * advisor whose live probe fails operationally blocks the release instead of
 * being mislabeled as logged out.
 */
export function stageAdvisorAuthentication(
  isolatedHome,
  {
    onSkip = () => {},
    sourceHome = os.homedir(),
    environment = process.env,
    run = spawnSync,
    grokBinary = "grok",
    agyBinary = null,
  } = {},
) {
  const home = path.resolve(isolatedHome);
  if (!path.isAbsolute(home) || home.includes("\0")) {
    throw new Error("isolated HOME for advisor staging is invalid");
  }
  const source = path.resolve(sourceHome);
  const statuses = {};
  const report = (cliId, status) => {
    if (status === "skipped") onSkip(cliId);
    return status;
  };

  // grok: ~/.grok/auth.json (+ config.toml when present). Existence is not
  // authentication: validate/refresh only the isolated copy before admitting
  // this advisor to the physical release roster.
  const grokDestination = path.join(home, ".grok");
  const grokStaged = stageAdvisorAuthFile(
    path.join(source, ".grok", "auth.json"),
    grokDestination,
    { label: "Grok auth file", privateRoot: home },
  );
  if (!grokStaged) {
    statuses.grok = report("grok", "skipped");
  } else {
    stageAdvisorAuthFile(
      path.join(source, ".grok", "config.toml"),
      grokDestination,
      {
        label: "Grok config file",
        requirePrivateMode: false,
        privateRoot: home,
      },
    );
    const grokUsable = preflightStagedGrokAuthentication(home, {
      binary: grokBinary,
      environment,
      run,
    });
    if (grokUsable) {
      statuses.grok = report("grok", "staged");
    } else {
      try {
        fs.rmSync(grokDestination, { recursive: true, force: true });
      } catch {
        // Best effort: the explicit skip still prevents a physical Grok PTY.
      }
      statuses.grok = report("grok", "skipped");
    }
  }

  // kimi: ~/.kimi-code/credentials/kimi-code.json (+ device_id + config.toml).
  // An empty or expired credentials shell is NOT a login — staging it made the
  // gate spawn kimi and die with `OAuth login expired` /
  // `auth.login_required` while the file "existed".
  // device_id is mandatory for refresh in an isolated HOME; config.toml is
  // mandatory so the declared model is accepted.
  const kimiCredSource = path.join(
    source,
    ".kimi-code",
    "credentials",
    "kimi-code.json",
  );
  let kimiSourceUsable = false;
  try {
    kimiSourceUsable = kimiCredentialsBlobIsUsable(
      fs.readFileSync(kimiCredSource, "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!kimiSourceUsable) {
    statuses.kimi = report("kimi", "skipped");
  } else {
    const kimiCredStaged = stageAdvisorAuthFile(
      kimiCredSource,
      path.join(home, ".kimi-code", "credentials"),
      { label: "Kimi Code credentials file", privateRoot: home },
    );
    const kimiConfigStaged = kimiCredStaged
      ? stageAdvisorAuthFile(
          path.join(source, ".kimi-code", "config.toml"),
          path.join(home, ".kimi-code"),
          {
            label: "Kimi Code model configuration",
            requirePrivateMode: false,
            privateRoot: home,
          },
        )
      : false;
    const kimiDeviceStaged = kimiCredStaged
      ? stageAdvisorAuthFile(
          path.join(source, ".kimi-code", "device_id"),
          path.join(home, ".kimi-code"),
          { label: "Kimi Code device identity", privateRoot: home },
        )
      : false;
    if (kimiCredStaged) {
      // Best-effort oauth marker (may be a zero-byte presence file).
      stageAdvisorAuthFile(
        path.join(source, ".kimi-code", "oauth", "kimi-code"),
        path.join(home, ".kimi-code", "oauth"),
        {
          label: "Kimi Code oauth marker",
          requirePrivateMode: false,
          privateRoot: home,
        },
      );
    }
    if (kimiCredStaged && kimiConfigStaged && kimiDeviceStaged) {
      statuses.kimi = report("kimi", "staged");
    } else {
      try {
        fs.rmSync(path.join(home, ".kimi-code"), {
          recursive: true,
          force: true,
        });
      } catch {
        // Best effort: never replace the skip with a staging cleanup failure.
      }
      statuses.kimi = report("kimi", "skipped");
    }
  }

  // agy: the current Antigravity CLI uses the native keyring/profile. The
  // legacy Gemini CLI files are neither necessary nor sufficient, and copying
  // them into the isolated HOME creates a false "login new" state. Admit AGY
  // only after its trusted binary proves the real operator session. Nothing
  // from ~/.gemini is copied: the mission spawn preserves the native AGY HOME.
  if (process.platform !== "darwin" || !agyBinary) {
    statuses.agy = report("agy", "skipped");
  } else {
    const preflight = preflightNativeAgyAuthentication(source, {
      binary: agyBinary,
      environment,
      run,
    });
    statuses.agy = report(
      "agy",
      preflight.kind === "authenticated" ? "staged" : "skipped",
    );
  }

  // opencode: $XDG_DATA_HOME/opencode/auth.json, defaulting to
  // ~/.local/share. Absence is NOT a skip: opencode has credentialless models.
  const xdgDataHome =
    typeof environment.XDG_DATA_HOME === "string" &&
    environment.XDG_DATA_HOME.length > 0
      ? path.resolve(environment.XDG_DATA_HOME)
      : path.join(source, ".local", "share");
  const openCodeStaged = stageAdvisorAuthFile(
    path.join(xdgDataHome, "opencode", "auth.json"),
    path.join(home, ".local", "share", "opencode"),
    { label: "opencode auth file", privateRoot: home },
  );
  statuses.opencode = report(
    "opencode",
    openCodeStaged ? "staged" : "credentialless",
  );

  // glm: Claude-compatible CLI + z.ai token from ai-launcher providers.conf
  // (glm=… / zai=…). Main process has HOME=isolated, so loadLauncherProviderKey
  // only sees this staged file. Never log the token.
  {
    const sourceConf = path.join(
      source,
      ".local",
      "share",
      "ai-launcher",
      "providers.conf",
    );
    let glmToken = null;
    try {
      const raw = fs.readFileSync(sourceConf, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const name = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (
          (name === "glm" || name === "zai" || name === "z.ai") &&
          value.length > 0
        ) {
          glmToken = value;
          break;
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!glmToken) {
      statuses.glm = report("glm", "skipped");
    } else {
      const destDir = path.join(home, ".local", "share", "ai-launcher");
      fs.mkdirSync(destDir, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
      fs.chmodSync(destDir, PRIVATE_DIRECTORY_MODE);
      // Only the glm slot — never copy sakana/other secrets into the gate HOME.
      fs.writeFileSync(
        path.join(destDir, "providers.conf"),
        `glm=${glmToken}\n`,
        { mode: PRIVATE_FILE_MODE },
      );
      statuses.glm = report("glm", "staged");
    }
  }

  // claude: Keychain holds the OAuth secret. Product-wizard Electron runs with
  // HOME=isolated and its auth probe / isAdapterModelAuthenticated may not
  // treat keychain-only as ready (login-needed → Usar este squad disabled for
  // E2E Advisor Claude). Materialize a slim ~/.claude/.credentials.json in
  // the isolated HOME from the operator keychain so file-backed detection and
  // env materialization work. Never copy the fat mcpOAuth plugin map.
  if (process.platform !== "darwin") {
    statuses.claude = report("claude", "skipped");
  } else {
    const secret = run(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        shell: false,
        timeout: 10_000,
      },
    );
    const rawBlob =
      secret.status === 0 && typeof secret.stdout === "string"
        ? secret.stdout.trim()
        : "";
    const slimBlob = slimClaudeKeychainBlob(rawBlob);
    const identityStaged = stageClaudeNativeIdentity(home, {
      sourceHome: source,
    });
    if (!slimBlob || !identityStaged) {
      statuses.claude = report("claude", "skipped");
    } else {
      const claudeDir = path.join(home, ".claude");
      fs.mkdirSync(claudeDir, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
      fs.chmodSync(claudeDir, PRIVATE_DIRECTORY_MODE);
      fs.writeFileSync(path.join(claudeDir, ".credentials.json"), slimBlob, {
        mode: PRIVATE_FILE_MODE,
      });
      statuses.claude = report("claude", "staged");
    }
  }

  return statuses;
}

/**
 * Pure: keep only claudeAiOauth with a non-empty accessToken (matches main
 * slimClaudeCredentialBlob). Returns compact JSON without newlines, or null.
 */
export function slimClaudeKeychainBlob(blob) {
  if (typeof blob !== "string" || !blob) return null;
  try {
    const parsed = JSON.parse(blob);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
      return null;
    }
    if (typeof oauth.accessToken !== "string" || !oauth.accessToken) {
      return null;
    }
    const slimOauth = { accessToken: oauth.accessToken };
    if (typeof oauth.refreshToken === "string" && oauth.refreshToken) {
      slimOauth.refreshToken = oauth.refreshToken;
    }
    if (typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)) {
      slimOauth.expiresAt = oauth.expiresAt;
    }
    if (
      typeof oauth.refreshTokenExpiresAt === "number" &&
      Number.isFinite(oauth.refreshTokenExpiresAt)
    ) {
      slimOauth.refreshTokenExpiresAt = oauth.refreshTokenExpiresAt;
    }
    if (Array.isArray(oauth.scopes)) {
      const scopes = oauth.scopes.filter(
        (s) => typeof s === "string" && s.length > 0,
      );
      if (scopes.length > 0) slimOauth.scopes = scopes;
    } else if (typeof oauth.scopes === "string" && oauth.scopes.trim()) {
      slimOauth.scopes = oauth.scopes.trim();
    }
    return JSON.stringify({ claudeAiOauth: slimOauth });
  } catch {
    return null;
  }
}

/**
 * Verify each advisor CLI binary resolves on the operator PATH and answers
 * `--version` within a short timeout. A missing/broken binary is a skip (the
 * observer marks the advisor `skipped: no-credential`), never a gate failure.
 */
export function assertAdvisorBinaries({
  onSkip = () => {},
  environment = process.env,
  resolveCommand = defaultResolveCommand,
  run = spawnSync,
} = {}) {
  const statuses = {};
  for (const cli of REAL_MISSION_ADVISOR_BINARIES) {
    const hostBin = resolveRealMissionAdvisorHostBin(cli);
    const resolved = resolveCommand(hostBin, environment);
    if (typeof resolved !== "string" || !path.isAbsolute(resolved)) {
      onSkip(cli);
      statuses[cli] = { available: false };
      continue;
    }
    const version = run(resolved, ["--version"], {
      encoding: "utf8",
      env: environment,
      shell: false,
      timeout: 10_000,
    });
    if (version.error || version.status !== 0) {
      onSkip(cli);
      statuses[cli] = { available: false };
      continue;
    }
    statuses[cli] = {
      available: true,
      version: (version.stdout ?? "").trim().slice(0, 64),
    };
  }
  return statuses;
}
