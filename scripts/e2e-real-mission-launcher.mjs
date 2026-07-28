import { spawnSync } from "node:child_process";
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
  "omp",
  "claude",
]);

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
 * (material absent, onSkip fired) or "credentialless" (opencode without auth,
 * which still works via credentialless models).
 */
export function stageAdvisorAuthentication(
  isolatedHome,
  {
    onSkip = () => {},
    sourceHome = os.homedir(),
    environment = process.env,
    run = spawnSync,
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

  // grok: ~/.grok/auth.json (+ config.toml when present). config.toml is not
  // a secret, so its source mode is tolerated; the staged copy is still 0600.
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
    statuses.grok = report("grok", "staged");
  }

  // kimi: ~/.kimi-code/credentials/kimi-code.json
  const kimiStaged = stageAdvisorAuthFile(
    path.join(source, ".kimi-code", "credentials", "kimi-code.json"),
    path.join(home, ".kimi-code", "credentials"),
    { label: "Kimi Code credentials file", privateRoot: home },
  );
  // Credentials alone are not enough to run: kimi refuses any model that its
  // config.toml does not declare, and dies at startup with
  //   [config.invalid] Model "<id>" is not configured in config.toml
  // The isolated HOME has no config, so the advisor is spawned and then
  // immediately fails. Stage the operator's config next to the credentials.
  if (kimiStaged) {
    stageAdvisorAuthFile(
      path.join(source, ".kimi-code", "config.toml"),
      path.join(home, ".kimi-code"),
      {
        label: "Kimi Code model configuration",
        requirePrivateMode: false,
        privateRoot: home,
      },
    );
  }
  statuses.kimi = report("kimi", kimiStaged ? "staged" : "skipped");

  // omp: ~/.omp/agent/agent.db (+ sqlite -shm/-wal sidecars when present)
  const ompSourceAgent = path.join(source, ".omp", "agent");
  const ompDestination = path.join(home, ".omp", "agent");
  const ompStaged = stageAdvisorAuthFile(
    path.join(ompSourceAgent, "agent.db"),
    ompDestination,
    {
      label: "omp agent database",
      maxBytes: ADVISOR_DATABASE_MAX_BYTES,
      privateRoot: home,
    },
  );
  if (!ompStaged) {
    statuses.omp = report("omp", "skipped");
  } else {
    for (const suffix of ["-shm", "-wal"]) {
      stageAdvisorAuthFile(
        path.join(ompSourceAgent, `agent.db${suffix}`),
        ompDestination,
        {
          label: `omp agent database ${suffix} sidecar`,
          maxBytes: ADVISOR_DATABASE_MAX_BYTES,
          privateRoot: home,
        },
      );
    }
    statuses.omp = report("omp", "staged");
  }

  // agy: like claude, the OAuth secret lives in the macOS keychain (service
  // "gemini", account "antigravity"), readable by the child as the same user.
  // The governed home overlay only links non-secret identity entries, so
  // stage those (plus oauth_creds.json when it exists) — never the whole
  // antigravity tree (it carries binaries, caches and conversations).
  if (process.platform !== "darwin") {
    statuses.agy = report("agy", "skipped");
  } else {
    const lookup = run(
      "/usr/bin/security",
      ["find-generic-password", "-s", "gemini", "-a", "antigravity"],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        shell: false,
        timeout: 10_000,
      },
    );
    const geminiDestination = path.join(home, ".gemini");
    stageAdvisorAuthFile(
      path.join(source, ".gemini", "google_accounts.json"),
      geminiDestination,
      {
        label: "agy google accounts identity",
        requirePrivateMode: false,
        privateRoot: home,
      },
    );
    stageAdvisorAuthFile(
      path.join(source, ".gemini", "installation_id"),
      geminiDestination,
      {
        label: "agy installation id",
        requirePrivateMode: false,
        privateRoot: home,
      },
    );
    stageAdvisorAuthFile(
      path.join(source, ".gemini", "oauth_creds.json"),
      geminiDestination,
      { label: "agy oauth credentials", privateRoot: home },
    );
    statuses.agy = report(
      "agy",
      lookup.status === 0 ? "staged" : "skipped",
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

  // claude: the OAuth secret lives in the macOS keychain, readable by the
  // child (same user), but the native adapter also needs the non-secret
  // login identity (~/.claude.json oauthAccount/userID) or it falls into
  // /login. "staged" requires both; nothing secret is ever copied.
  if (process.platform !== "darwin") {
    statuses.claude = report("claude", "skipped");
  } else {
    const lookup = run(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        shell: false,
        timeout: 10_000,
      },
    );
    const identityStaged = stageClaudeNativeIdentity(home, {
      sourceHome: source,
    });
    statuses.claude = report(
      "claude",
      lookup.status === 0 && identityStaged ? "staged" : "skipped",
    );
  }

  return statuses;
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
    const resolved = resolveCommand(cli, environment);
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
