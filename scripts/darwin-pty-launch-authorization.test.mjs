import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildDarwinPtySupervisor } from "./build-darwin-pty-supervisor.mjs";
import {
  DARWIN_PTY_PROVIDER_PROBE_MODE,
  DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
  DARWIN_PTY_STAGE_ZERO_SOURCE,
  resolvePackagedDarwinLaunchAuthorizationReadPaths,
} from "../src/main/pty/darwin-pty-supervisor.ts";
import { buildMacosSeatbeltPlan } from "../src/main/runtime/process-sandbox.ts";
import { nestedPtySupervisorSkipReason } from "../src/test/nested-pty-supervisor.ts";

// F-715/F-1217: a pane (or any process under a nexus-pty-supervisor) inherits
// its supervisor's responsibility, which main.c rejects as
// responsible_is_supervisor. Central detector: src/test/nested-pty-supervisor.ts.
const nexusPaneSkipReason = nestedPtySupervisorSkipReason();

const isDarwin = process.platform === "darwin";
const suite = isDarwin ? describe : describe.skip;
const nexusDeveloperIdentity = isDarwin
  ? (() => {
      const result = spawnSync(
        "/usr/bin/security",
        ["find-identity", "-v", "-p", "codesigning"],
        { encoding: "utf8" },
      );
      if (result.status !== 0) return null;
      return (
        /"([^"]*Developer ID Application:[^"]*\(35P5XL3JN6\))"/u.exec(
          `${result.stdout}\n${result.stderr}`,
        )?.[1] ?? null
      );
    })()
  : null;
const packagedSuite = nexusDeveloperIdentity ? it : it.skip;

let fixtureRoot = "";
let helper = "";
let packagedHelper = "";
let packagedMain = "";
let packagedUtility = "";
let packagedUtilityPlugin = "";
let packagedUtilityGpu = "";
let packagedUtilityRenderer = "";
let sameTeamArbitrary = "";

function codeSignatureMetadata(target) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", target],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`cannot read code signature for ${target}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const identifier = /^Identifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const rawTeam = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const cdHash = /^CDHash=([0-9a-f]{40})$/imu.exec(output)?.[1]?.toLowerCase();
  if (!identifier || !rawTeam || !cdHash) {
    throw new Error(`incomplete code signature metadata for ${target}`);
  }
  return {
    identifier,
    teamIdentifier: rawTeam === "not set" ? null : rawTeam,
    cdHash,
  };
}

function stageZeroArguments(supervisor, helperArguments, timeoutSeconds = 0) {
  const identity = codeSignatureMetadata(supervisor);
  return [
    "-T",
    "-e",
    DARWIN_PTY_STAGE_ZERO_SOURCE,
    "--",
    "--helper",
    supervisor,
    "--identifier",
    identity.identifier,
    "--team-id",
    identity.teamIdentifier ?? "-",
    "--cdhash",
    identity.cdHash,
    "--timeout-seconds",
    String(timeoutSeconds),
    "--",
    ...helperArguments,
  ];
}

function authenticatedArguments(identity, executable, args = []) {
  if (!identity.teamIdentifier) {
    throw new Error("authenticated fixture requires a Team-signed identity");
  }
  return [
    "supervise-authenticated",
    "--identifier",
    identity.identifier,
    "--team-id",
    identity.teamIdentifier,
    "--cdhash",
    identity.cdHash,
    "--",
    executable,
    ...args,
  ];
}

function spawnResult(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.once("error", reject);
    child.once("exit", (status, signal) =>
      resolve({
        status,
        signal,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      }),
    );
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killFixtureProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/**
 * Real PTYs, tracers and signal cohorts: under the full suite these fixtures
 * can take far longer to settle than on a quiet machine. The waits prove the
 * fixture ARRIVES, not that it arrives fast, so ceilings are generous but bounded.
 */
function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch {
        // The short-lived fixture may be between exec/reap states.
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for launch-authorization fixture"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

const LAUNCH_OWNER_SOURCE = String.raw`
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
typedef int (*spawn_disclaim_fn)(const posix_spawnattr_t *, int);

static int executable_path(char output[PATH_MAX]) {
  uint32_t size = PATH_MAX;
  if (_NSGetExecutablePath(output, &size) != 0) return ENAMETOOLONG;
  char resolved[PATH_MAX];
  if (realpath(output, resolved) == NULL) return errno;
  size_t length = strnlen(resolved, sizeof(resolved));
  if (length == 0 || length >= PATH_MAX) return ENAMETOOLONG;
  memcpy(output, resolved, length + 1);
  return 0;
}

static void publish_child(pid_t child) {
  const char *path = getenv("NEXUS_TEST_CHILD_PID_FILE");
  if (path == NULL || path[0] != '/') return;
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return;
  char value[32];
  int length = snprintf(value, sizeof(value), "%d\n", child);
  if (length > 0 && (size_t)length < sizeof(value)) {
    (void)write(fd, value, (size_t)length);
  }
  (void)close(fd);
}

static int run_child(int argc, char **argv) {
  if (argc < 3 || argv[2][0] != '/') return 64;
  pid_t child = 0;
  int error = posix_spawn(&child, argv[2], NULL, NULL, &argv[2], environ);
  if (error != 0) return 70;
  publish_child(child);
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return 71;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 72;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "__run") == 0) {
    return run_child(argc, argv);
  }
  if (argc < 2 || argv[1][0] != '/') return 64;
  void *symbol =
      dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (symbol == NULL) {
    void *quarantine =
        dlopen("/usr/lib/system/libquarantine.dylib", RTLD_LAZY | RTLD_LOCAL);
    if (quarantine != NULL) {
      symbol = dlsym(quarantine, "responsibility_spawnattrs_setdisclaim");
    }
  }
  if (symbol == NULL) return 73;
  spawn_disclaim_fn set_disclaim = NULL;
  memcpy(&set_disclaim, &symbol, sizeof(set_disclaim));
  char self[PATH_MAX];
  if (executable_path(self) != 0) return 74;
  size_t next_count = (size_t)argc + 1;
  char **next = calloc(next_count + 1, sizeof(*next));
  if (next == NULL) return 75;
  next[0] = self;
  next[1] = "__run";
  for (int index = 1; index < argc; index += 1) {
    next[index + 1] = argv[index];
  }
  posix_spawnattr_t attributes = NULL;
  int error = posix_spawnattr_init(&attributes);
  if (error == 0) {
    error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC);
  }
  if (error == 0) error = set_disclaim(&attributes, 1);
  if (error == 0) {
    pid_t replaced = 0;
    error = posix_spawn(&replaced, self, NULL, &attributes, next, environ);
  }
  if (attributes != NULL) posix_spawnattr_destroy(&attributes);
  free(next);
  return error == 0 ? 0 : 76;
}
`;

function signFixture(target, identifier) {
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    nexusDeveloperIdentity,
    "--identifier",
    identifier,
    "--options",
    "runtime",
    "--timestamp=none",
    target,
  ]);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", target]);
}

function buildPackagedAuthorizationFixtures() {
  const appRoot = path.join(fixtureRoot, "NexusFixture.app");
  packagedMain = path.join(appRoot, "Contents", "MacOS", "nexus-ide");
  packagedUtility = path.join(
    appRoot,
    "Contents",
    "Frameworks",
    "NexusIDE Helper.app",
    "Contents",
    "MacOS",
    "NexusIDE Helper",
  );
  packagedUtilityPlugin = path.join(
    appRoot,
    "Contents",
    "Frameworks",
    "NexusIDE Helper (Plugin).app",
    "Contents",
    "MacOS",
    "NexusIDE Helper (Plugin)",
  );
  packagedUtilityGpu = path.join(
    appRoot,
    "Contents",
    "Frameworks",
    "NexusIDE Helper (GPU).app",
    "Contents",
    "MacOS",
    "NexusIDE Helper (GPU)",
  );
  packagedUtilityRenderer = path.join(
    appRoot,
    "Contents",
    "Frameworks",
    "NexusIDE Helper (Renderer).app",
    "Contents",
    "MacOS",
    "NexusIDE Helper (Renderer)",
  );
  packagedHelper = path.join(
    appRoot,
    "Contents",
    "Resources",
    "nexus-pty-supervisor",
  );
  sameTeamArbitrary = path.join(fixtureRoot, "same-team-arbitrary");
  for (const target of [
    packagedMain,
    packagedUtility,
    packagedUtilityPlugin,
    packagedUtilityGpu,
    packagedUtilityRenderer,
    packagedHelper,
    sameTeamArbitrary,
  ]) {
    mkdirSync(path.dirname(target), { recursive: true });
  }

  const source = path.join(fixtureRoot, "launch-owner-fixture.c");
  const unsigned = path.join(fixtureRoot, "launch-owner-unsigned");
  writeFileSync(source, LAUNCH_OWNER_SOURCE);
  execFileSync("xcrun", [
    "--sdk",
    "macosx",
    "clang",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wpedantic",
    "-mmacosx-version-min=11.0",
    source,
    "-o",
    unsigned,
  ]);
  copyFileSync(unsigned, packagedMain);
  copyFileSync(unsigned, packagedUtility);
  copyFileSync(unsigned, packagedUtilityPlugin);
  copyFileSync(unsigned, packagedUtilityGpu);
  copyFileSync(unsigned, packagedUtilityRenderer);
  copyFileSync(unsigned, sameTeamArbitrary);
  signFixture(packagedMain, "com.nexuside.app");
  signFixture(packagedUtility, "com.nexuside.app.helper");
  signFixture(packagedUtilityPlugin, "com.nexuside.app.helper");
  signFixture(packagedUtilityGpu, "com.nexuside.app.helper");
  signFixture(packagedUtilityRenderer, "com.nexuside.app.helper");
  signFixture(sameTeamArbitrary, "com.nexuside.same-team-arbitrary");

  buildDarwinPtySupervisor({ output: packagedHelper });
  signFixture(packagedHelper, "nexus-pty-supervisor");
}

suite("Darwin supervisor one-shot launch authorization", () => {
  beforeAll(() => {
    fixtureRoot = mkdtempSync(
      path.join(os.tmpdir(), "nexus-darwin-launch-authorization-"),
    );
    helper = path.join(fixtureRoot, "nexus-pty-supervisor");
    buildDarwinPtySupervisor({ output: helper });
    if (nexusDeveloperIdentity) {
      buildPackagedAuthorizationFixtures();
    }
  }, 150_000);

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("rejects direct helper re-entry before disclaim and leaves no orphan", async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const nestedPidFile = path.join(fixtureRoot, "nested-direct.pid");
    const nestedLog = path.join(fixtureRoot, "nested-direct.log");
    let nestedPid = 0;
    try {
      const result = await spawnResult(helper, [
        "supervise",
        "--",
        "/bin/sh",
        "-c",
        // O sh espera o helper aninhado: ao sair, o supervisor externo encerra
        // o grupo, e sob carga isso matava o aninhado antes de ele gravar a recusa.
        '"$1" supervise -- /bin/sleep 30 >"$3" 2>&1 & ' +
          'nested_pid=$!; printf "%s\\n" "$nested_pid" > "$2"; wait "$nested_pid"; exit 0',
        "nexus-nested-direct",
        helper,
        nestedPidFile,
        nestedLog,
      ]);
      expect(result).toMatchObject({ status: 0, signal: null });
      nestedPid = Number.parseInt(readFileSync(nestedPidFile, "utf8"), 10);
      expect(Number.isInteger(nestedPid) && nestedPid > 1).toBe(true);
      await waitFor(() => !processExists(nestedPid));
      expect(readFileSync(nestedLog, "utf8")).toContain(
        "launch authorization rejected before responsibility disclaim",
      );
    } finally {
      killFixtureProcess(nestedPid);
    }
  }, 150_000);

  it("rejects re-entry through Apple Perl and leaves no orphan", async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const nestedPidFile = path.join(fixtureRoot, "nested-perl.pid");
    const nestedLog = path.join(fixtureRoot, "nested-perl.log");
    const nestedArguments = stageZeroArguments(
      helper,
      ["supervise", "--", "/bin/sleep", "30"],
      3,
    );
    const provider = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      "const [pidFile, logFile, serialized] = process.argv.slice(1);",
      'const fd = fs.openSync(logFile, "w", 0o600);',
      'const child = spawn("/usr/bin/perl", JSON.parse(serialized), {',
      '  stdio: ["ignore", fd, fd], env: process.env,',
      "});",
      "fs.writeFileSync(pidFile, String(child.pid));",
      "fs.closeSync(fd);",
      'child.once("error", () => process.exit(91));',
      'child.once("exit", () => process.exit(0));',
    ].join("\n");
    let nestedPid = 0;
    try {
      const result = await spawnResult(helper, [
        "supervise",
        "--",
        process.execPath,
        "-e",
        provider,
        nestedPidFile,
        nestedLog,
        JSON.stringify(nestedArguments),
      ]);
      expect(result).toMatchObject({ status: 0, signal: null });
      nestedPid = Number.parseInt(readFileSync(nestedPidFile, "utf8"), 10);
      expect(Number.isInteger(nestedPid) && nestedPid > 1).toBe(true);
      await waitFor(() => !processExists(nestedPid));
      expect(readFileSync(nestedLog, "utf8")).toContain(
        "launch authorization rejected before responsibility disclaim",
      );
    } finally {
      killFixtureProcess(nestedPid);
    }
  }, 150_000);

  packagedSuite(
    "accepts only the exact packaged Main and Utility live code chains",
    () => {
      const helperArguments = stageZeroArguments(packagedHelper, [
        "supervise",
        "--",
        "/usr/bin/true",
      ]);
      const main = spawnSync(
        packagedMain,
        ["/usr/bin/perl", ...helperArguments],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(main).toMatchObject({ status: 0, signal: null });

      const utility = spawnSync(
        packagedMain,
        [packagedUtility, "/usr/bin/perl", ...helperArguments],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(utility).toMatchObject({ status: 0, signal: null });
    },
    150_000,
  );

  packagedSuite(
    "executes the packaged smoke provider through the live authenticated barrier",
    () => {
      const identity = codeSignatureMetadata(packagedHelper);
      const helperArguments = stageZeroArguments(
        packagedHelper,
        authenticatedArguments(identity, packagedHelper, [
          DARWIN_PTY_PROVIDER_PROBE_MODE,
        ]),
      );
      const result = spawnSync(
        packagedMain,
        ["/usr/bin/perl", ...helperArguments],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result).toMatchObject({ status: 0, signal: null });
      expect(result.stdout).toContain(DARWIN_PTY_PROVIDER_PROBE_RECEIPT);
    },
    150_000,
  );

  packagedSuite(
    "keeps authenticated launch authorization readable inside Seatbelt",
    () => {
      const workspace = path.join(fixtureRoot, "seatbelt-workspace");
      const sandbox = path.join(fixtureRoot, "seatbelt-runtime");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(sandbox, { recursive: true });
      const identity = codeSignatureMetadata(packagedHelper);
      const helperArguments = stageZeroArguments(
        packagedHelper,
        authenticatedArguments(identity, packagedHelper, [
          DARWIN_PTY_PROVIDER_PROBE_MODE,
        ]),
      );
      const runtime = {
        platform: "darwin",
        packaged: true,
        resourcesPath: path.dirname(packagedHelper),
        cwd: workspace,
        moduleDir: path.join(
          path.dirname(path.dirname(packagedHelper)),
          "app.asar",
          ".vite",
          "build",
        ),
      };
      const launchAuthorizationReads =
        resolvePackagedDarwinLaunchAuthorizationReadPaths(runtime);
      expect(launchAuthorizationReads).toEqual([
        realpathSync.native(
          path.dirname(path.dirname(path.dirname(packagedHelper))),
        ),
      ]);

      const oldMachOOnlyPlan = buildMacosSeatbeltPlan(
        {
          platform: "darwin",
          executable: "/usr/bin/perl",
          args: helperArguments,
          cwd: workspace,
          rootRealPath: workspace,
          sandboxDir: sandbox,
          env: { PATH: "/usr/bin:/bin" },
          extraReadPaths: [
            packagedHelper,
            packagedMain,
            packagedUtility,
            packagedUtilityPlugin,
            packagedUtilityGpu,
            packagedUtilityRenderer,
          ],
        },
        "/usr/bin/sandbox-exec",
      );
      const oldResult = spawnSync(
        packagedMain,
        [packagedUtility, oldMachOOnlyPlan.file, ...oldMachOOnlyPlan.args],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: oldMachOOnlyPlan.env,
        },
      );
      expect(oldResult).toMatchObject({ status: 76, signal: null });
      expect(oldResult.stderr).toContain(
        "launch authorization rejected before responsibility disclaim",
      );

      const plan = buildMacosSeatbeltPlan(
        {
          platform: "darwin",
          executable: "/usr/bin/perl",
          args: helperArguments,
          cwd: workspace,
          rootRealPath: workspace,
          sandboxDir: sandbox,
          env: { PATH: "/usr/bin:/bin" },
          extraReadPaths: [
            packagedHelper,
            ...launchAuthorizationReads,
          ],
        },
        "/usr/bin/sandbox-exec",
      );
      const result = spawnSync(
        packagedMain,
        [packagedUtility, plan.file, ...plan.args],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: plan.env,
        },
      );
      expect(
        result.status,
        JSON.stringify({
          status: result.status,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      ).toBe(0);
      expect(result.signal).toBe(null);
      expect(result.stdout).toContain(DARWIN_PTY_PROVIDER_PROBE_RECEIPT);
    },
    150_000,
  );

  packagedSuite(
    "executes the release smoke through its exact zero-effect self-probe",
    () => {
      const identity = codeSignatureMetadata(packagedHelper);
      const helperArguments = stageZeroArguments(packagedHelper, [
        "supervise-packaged-smoke",
        "--identifier",
        identity.identifier,
        "--team-id",
        identity.teamIdentifier,
        "--cdhash",
        identity.cdHash,
        "--",
        packagedHelper,
        DARWIN_PTY_PROVIDER_PROBE_MODE,
      ]);
      const result = spawnSync(
        packagedMain,
        ["/usr/bin/perl", ...helperArguments],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result).toMatchObject({ status: 0, signal: null });
      expect(result.stdout).toContain(DARWIN_PTY_PROVIDER_PROBE_RECEIPT);
    },
    150_000,
  );

  packagedSuite(
    "rejects a same-Team arbitrary responsibility before provider spawn",
    async () => {
      const stageZeroPidFile = path.join(
        fixtureRoot,
        "same-team-stage-zero.pid",
      );
      const providerPidFile = path.join(fixtureRoot, "same-team-provider.pid");
      const helperArguments = stageZeroArguments(
        packagedHelper,
        [
          "supervise",
          "--",
          "/bin/sh",
          "-c",
          `printf "%s\\n" "$$" > ${JSON.stringify(providerPidFile)}; sleep 30`,
        ],
        3,
      );
      let stageZeroPid = 0;
      try {
        const result = spawnSync(
          sameTeamArbitrary,
          ["/usr/bin/perl", ...helperArguments],
          {
            encoding: "utf8",
            timeout: 30_000,
            env: {
              ...process.env,
              NEXUS_TEST_CHILD_PID_FILE: stageZeroPidFile,
            },
          },
        );
        expect(result).toMatchObject({ status: 76, signal: null });
        expect(result.stderr).toContain(
          "launch authorization rejected before responsibility disclaim",
        );
        expect(existsSync(providerPidFile)).toBe(false);
        stageZeroPid = Number.parseInt(
          readFileSync(stageZeroPidFile, "utf8"),
          10,
        );
        expect(Number.isInteger(stageZeroPid) && stageZeroPid > 1).toBe(true);
        await waitFor(() => !processExists(stageZeroPid));
      } finally {
        killFixtureProcess(stageZeroPid);
      }
    },
    150_000,
  );
});
