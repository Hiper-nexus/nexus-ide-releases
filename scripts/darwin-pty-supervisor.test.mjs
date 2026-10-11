import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { OwnedCommandProcesses } from "../src/main/pty/owned-command-process.ts";
import { watchDarwinHeavyCommand } from "../src/main/pty/darwin-heavy-command.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as nodePty from "@lydell/node-pty";
import { buildDarwinPtySupervisor } from "./build-darwin-pty-supervisor.mjs";
import { darwinNodePtyBootstrapLaunch } from "../src/main/pty/darwin-node-pty-bootstrap.ts";
import { supervisedPtyCommand, supervisedJobCommand, nestedHeavyJobBaseCommand } from "../src/main/pty/darwin-pty-supervisor.ts";
import { nestedPtySupervisorSkipReason } from "../src/test/nested-pty-supervisor.ts";

// F-715/F-1217: a pane (or any process under a nexus-pty-supervisor) inherits
// its supervisor's responsibility, which main.c rejects as
// responsible_is_supervisor. Central detector: src/test/nested-pty-supervisor.ts.
const nexusPaneSkipReason = nestedPtySupervisorSkipReason();

// F-715: a write-denying sandbox (the Nexus regression gate's Seatbelt profile)
// cannot open /dev/ptmx and refuses setuid exec ("spawn EPERM"), so the cases
// that need a real PTY, a detached daemon or a setuid process cannot run there.
// A denied posix_openpt is the marker; probed once, on first use.
let ptySkipProbe;
function ptySkipReason() {
  if (ptySkipProbe) return ptySkipProbe.reason;
  ptySkipProbe = { reason: undefined };
  try {
    nodePty.spawn("/usr/bin/true", [], {}).kill();
  } catch (error) {
    if (/posix_openpt failed: Operation not permitted/.test(String(error?.message))) {
      ptySkipProbe.reason = "AMBIENTE-SANDBOX (F-715): this sandbox denies posix_openpt and setuid exec, so the real supervisor fixture cannot run; run outside the sandbox.";
    }
  }
  return ptySkipProbe.reason;
}

const isDarwin = process.platform === "darwin";
it.runIf(isDarwin)('committed zombie disappearance does not falsely fail signalling or prove an empty cohort', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-zombie-signal-'));
  const source = path.join(root, 'probe.c'), output = path.join(root, 'probe');
  const mainSource = path.join(process.cwd(), 'native/darwin-pty-supervisor/main.c');
  writeFileSync(source, `
#define proc_pidinfo fixture_proc_pidinfo
#define kill fixture_kill
#define main original_supervisor_main
#include ${JSON.stringify(mainSource)}
#undef main
int fixture_kill(pid_t pid, int signal_number) { (void)pid; (void)signal_number; return 0; }
int fixture_proc_pidinfo(int pid, int flavor, uint64_t argument, void *buffer, int size) {
  (void)pid; (void)argument; memset(buffer, 0, (size_t)size);
  if (flavor == PROC_PIDUNIQIDENTIFIERINFO_PRIVATE) { struct nexus_proc_uniqidentifierinfo *info = buffer; info->p_uniqueid = 101; info->p_idversion = 1; return (int)sizeof(*info); }
  if (flavor == PROC_PIDTBSDINFO) { ((struct proc_bsdinfo *)buffer)->pbi_status = SZOMB; return (int)sizeof(struct proc_bsdinfo); }
  return 0;
}
static pid_t gone_pid(pid_t pid) { (void)pid; errno = ESRCH; return 0; }
static uint64_t gone_unique(pid_t pid) { (void)pid; errno = ESRCH; return 0; }
int main(void) {
  struct responsibility_api api = { .responsible_pid = gone_pid, .responsible_unique_id = gone_unique, .set_disclaim = NULL };
  struct process_record record = { .pid = 123, .process_unique_id = 101, .process_id_version = 1 };
  struct responsibility_anchor anchor = { .pid = 123, .process_unique_id = 101, .process_id_version = 1, .responsible_pid = 123, .responsible_unique_id = 101 };
  if (!signal_if_still_owned(&api, &record, &anchor, SIGTERM)) return 10;
  if (prove_group_empty_twice(&api, &anchor)) return 11;
  return 0;
}
`);
  try {
    execFileSync('xcrun', ['--sdk', 'macosx', 'clang', '-std=c11', '-O1', '-Wall', '-Wextra', '-Werror', source, '-lproc', '-framework', 'CoreFoundation', '-framework', 'Security', '-o', output], { stdio: 'pipe' });
    expect(spawnSync(output, [], { encoding: 'utf8' }).status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const suite = isDarwin ? describe : describe.skip;
const developerSigningIdentity = isDarwin
  ? (() => {
      const result = spawnSync(
        "/usr/bin/security",
        ["find-identity", "-v", "-p", "codesigning"],
        { encoding: "utf8" },
      );
      if (result.status !== 0) return null;
      return (
        /"([^"]*Developer ID Application:[^"]*)"/u.exec(
          `${result.stdout}\n${result.stderr}`,
        )?.[1] ?? null
      );
    })()
  : null;
const signedSuite = developerSigningIdentity ? it : it.skip;
let fixtureRoot = "";
let helper = "";
let sigcontHeldHelper = "";
let sealedFixture = "";
let sealedFixtureIdentity = null;
let sealedReplacement = "";
let sealedReplacementIdentity = null;

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
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const cdHash = /^CDHash=([0-9a-f]{40})$/imu.exec(output)?.[1]?.toLowerCase();
  if (
    !identifier ||
    !teamIdentifier ||
    teamIdentifier === "not set" ||
    !cdHash
  ) {
    throw new Error(`incomplete code signature metadata for ${target}`);
  }
  return { identifier, teamIdentifier, cdHash };
}

function authenticatedArguments(identity, executable, args = []) {
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

function buildSigcontHeldHelper(output) {
  execFileSync("xcrun", [
    "--sdk",
    "macosx",
    "clang",
    "-arch",
    "arm64",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wpedantic",
    "-mmacosx-version-min=11.0",
    "-DNEXUS_TEST_TRACED_AUTH_HOLD_MS=1500",
    path.join(process.cwd(), "native", "darwin-pty-supervisor", "main.c"),
    "-lproc",
    "-framework",
    "CoreFoundation",
    "-framework",
    "Security",
    "-o",
    output,
  ]);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "nexus-pty-supervisor",
    "--timestamp=none",
    output,
  ]);
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

function spawnDetachedResult(file, args, options = {}) {
  const child = spawn(file, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise((resolve, reject) => {
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
  return { child, completion };
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcessGroup(processGroupId, signal) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function cleanupProcessGroup(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) return;
  if (!processGroupExists(processGroupId)) return;
  signalProcessGroup(processGroupId, "SIGTERM");
  try {
    await waitFor(() => !processGroupExists(processGroupId), 3_500);
    return;
  } catch {
    signalProcessGroup(processGroupId, "SIGKILL");
    signalProcessGroup(processGroupId, "SIGCONT");
  }
  await waitFor(() => !processGroupExists(processGroupId), 2_000).catch(
    () => undefined,
  );
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
        // The file/process can be between lifecycle states; poll again.
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for Darwin supervisor fixture"));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function inventory(args = []) {
  const result = spawnSync(helper, ["inventory", ...args], {
    encoding: "utf8",
  });
  expect([0, 71]).toContain(result.status);
  return JSON.parse(result.stdout);
}

function waitForOwnedInventory(
  responsiblePid,
  responsibleUniqueId,
  requiredPids,
) {
  return waitFor(() => {
    const candidate = inventory([
      "--responsible-pid",
      String(responsiblePid),
      "--responsible-unique-id",
      responsibleUniqueId,
    ]);
    const candidatePids = candidate.processes.map((record) => record.pid);
    return candidate.complete &&
      requiredPids.every((pid) => candidatePids.includes(pid))
      ? candidate
      : false;
  });
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid fixture PID: ${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Marker existence is a readiness signal: never publish the name before the
// complete PID is closed. A delayed writer exercises the old open/write race.
const PYTHON_PUBLISH_PID = [
  'def publish_pid(file, delay=0):',
  '  pending=file+".pending"',
  '  with open(pending,"w") as f:',
  '    time.sleep(delay)',
  '    f.write(str(os.getpid())+"\\n")',
  '  os.replace(pending,file)',
];

// F-1215: a fixture whose release never comes (the run died before the test
// wrote it, so neither its finally nor afterAll ran) must not wait forever: a
// setsid daemon left that way lived 31 h with ppid 1. Every wait gives up on
// its own, far past any test timeout.
const PYTHON_RELEASE_DEADLINE_S = 120;
const pythonWaitRelease = (file, interval = "0.02") =>
  `while not os.path.exists(${file}) and time.time() < ${Math.floor(Date.now() / 1000) + PYTHON_RELEASE_DEADLINE_S}: time.sleep(${interval})`;

it("F-1215: no Python fixture waits for its release file forever", () => {
  const unbounded = readFileSync(new URL(import.meta.url), "utf8")
    .split("\n")
    .filter((line) => /while not os\.path\.exists\([^)]*\):/.test(line));
  expect(unbounded).toEqual([]);
});

function readPidMarker(file) {
  const text = readFileSync(file, 'utf8');
  const pid = Number(text);
  if (!/^[1-9]\d*\r?\n$/.test(text) || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`incomplete fixture PID marker: ${path.basename(file)}`);
  }
  return pid;
}

function waitForTerminalExit(terminal, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for supervised PTY exit"));
    }, timeoutMs);
    terminal.onExit((event) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

function killFixtureProcess(pid) {
  if (!pid || !processExists(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // A concurrent supervisor reap is the successful cleanup path.
  }
}

function spawnDarwinPty(file, args, options) {
  const supervised =
    file === helper &&
    args[0] === "supervise" &&
    args[1] === "--" &&
    path.isAbsolute(args[2] ?? "")
      ? supervisedPtyCommand(
          {
            platform: "darwin",
            packaged: false,
            cwd: fixtureRoot,
            moduleDir: fixtureRoot,
          },
          args[2],
          args.slice(3),
        )
      : { file, args };
  const launch = darwinNodePtyBootstrapLaunch(
    options.cwd,
    supervised.file,
    supervised.args,
    options.env,
  );
  return nodePty.spawn(launch.file, [...launch.args], {
    ...options,
    cwd: launch.cwd,
    env: launch.env,
  });
}

async function launchLongLivedCohort(
  slug,
  { keepRunningOnInterrupt = false } = {},
) {
  const childPidFile = path.join(fixtureRoot, `${slug}-child.pid`);
  const descendantPidFile = path.join(fixtureRoot, `${slug}-descendant.pid`);
  const python = [
    "import os,signal,time",
    ...PYTHON_PUBLISH_PID,
    `child_pid_file=${JSON.stringify(childPidFile)}`,
    `descendant_pid_file=${JSON.stringify(descendantPidFile)}`,
    'def keep_running_after_interrupt(_signal, _frame): os.write(1,b"CHILD_KEPT_RUNNING\\n")',
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    ...(keepRunningOnInterrupt
      ? ["signal.signal(signal.SIGINT, keep_running_after_interrupt)"]
      : []),
    "descendant=os.fork()",
    "if descendant == 0:",
    '  publish_pid(descendant_pid_file)',
    "  time.sleep(30)",
    "  os._exit(0)",
    'publish_pid(child_pid_file)',
    "time.sleep(30)",
  ].join("\n");
  const terminal = spawnDarwinPty(
    helper,
    ["supervise", "--", "/usr/bin/python3", "-c", python],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: fixtureRoot,
      env: { ...process.env, TERM: "xterm-256color" },
    },
  );
  const output = [];
  terminal.onData((chunk) => output.push(chunk));
  try {
    await waitFor(
      () =>
        existsSync(childPidFile) &&
        existsSync(descendantPidFile) &&
        readPidMarker(childPidFile) &&
        readPidMarker(descendantPidFile),
    );
  } catch (error) {
    throw new Error(
      `long-lived cohort did not start: ${output.join("").trim()}`,
      { cause: error },
    );
  }
  return {
    terminal,
    output,
    childPid: readPidMarker(childPidFile),
    descendantPid: readPidMarker(descendantPidFile),
  };
}

async function expectOwnedCohort({ terminal, childPid, descendantPid }) {
  const childRecord = await waitFor(() => {
    const all = inventory();
    return all.processes.find((record) => record.pid === childPid) ?? false;
  });
  const anchor = await waitFor(() => {
    const all = inventory();
    return (
      all.processes.find(
        (record) => record.pid === childRecord.responsiblePid,
      ) ?? false
    );
  });
  expect(anchor).toMatchObject({
    pid: childRecord.responsiblePid,
    responsiblePid: childRecord.responsiblePid,
  });
  expect(anchor.pid).not.toBe(terminal.pid);
  const owned = await waitForOwnedInventory(
    childRecord.responsiblePid,
    anchor.responsibleUniqueId,
    [childPid, descendantPid],
  );
  expect(owned.complete).toBe(true);
  expect(owned.processes.map((record) => record.pid)).toEqual(
    expect.arrayContaining([childPid, descendantPid]),
  );
}

function cleanupCohort({ terminal, childPid, descendantPid }, terminalExited) {
  if (!terminalExited) {
    try {
      terminal.kill("SIGKILL");
    } catch {
      // The supervisor may have completed between assertion and cleanup.
    }
  }
  killFixtureProcess(childPid);
  killFixtureProcess(descendantPid);
}

suite("Darwin PTY native responsibility supervisor", () => {
  beforeAll(() => {
    fixtureRoot = mkdtempSync(
      path.join(os.tmpdir(), "nexus-darwin-supervisor-real-"),
    );
    helper = path.join(
      fixtureRoot,
      "resources",
      "native",
      "darwin",
      "nexus-pty-supervisor",
    );
    mkdirSync(path.dirname(helper), { recursive: true });
    buildDarwinPtySupervisor({ output: helper });
    sigcontHeldHelper = path.join(
      fixtureRoot,
      "nexus-pty-supervisor-sigcont-held",
    );
    buildSigcontHeldHelper(sigcontHeldHelper);
    if (developerSigningIdentity) {
      const source = path.join(fixtureRoot, "sealed-fixture.c");
      sealedFixture = path.join(fixtureRoot, "sealed-fixture");
      writeFileSync(
        source,
        [
          "#include <fcntl.h>",
          "#include <stdio.h>",
          "#include <stdlib.h>",
          "#include <unistd.h>",
          "__attribute__((constructor)) static void mark_execution(void) {",
          '  const char *marker = getenv("NEXUS_SEALED_MARKER");',
          "  if (marker == NULL || marker[0] == 0) return;",
          "  int fd = open(marker, O_WRONLY | O_CREAT | O_TRUNC, 0600);",
          "  if (fd < 0) return;",
          '  (void)write(fd, "executed", 8);',
          "  close(fd);",
          "}",
          "int main(void) {",
          '  puts("NEXUS_SEALED_EXECUTED");',
          "  return 29;",
          "}",
        ].join("\n"),
      );
      execFileSync("xcrun", [
        "--sdk",
        "macosx",
        "clang",
        "-std=c11",
        "-mmacosx-version-min=11.0",
        source,
        "-o",
        sealedFixture,
      ]);
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        developerSigningIdentity,
        "--identifier",
        "com.nexuside.sealed-spawn-fixture",
        "--options",
        "runtime",
        "--timestamp=none",
        sealedFixture,
      ]);
      sealedFixtureIdentity = codeSignatureMetadata(sealedFixture);

      const replacementSource = path.join(fixtureRoot, "sealed-replacement.c");
      sealedReplacement = path.join(fixtureRoot, "sealed-replacement");
      writeFileSync(
        replacementSource,
        [
          "#include <arpa/inet.h>",
          "#include <fcntl.h>",
          "#include <netinet/in.h>",
          "#include <stdio.h>",
          "#include <stdlib.h>",
          "#include <string.h>",
          "#include <sys/socket.h>",
          "#include <unistd.h>",
          "__attribute__((constructor)) static void attempt_effects(void) {",
          '  const char *marker = getenv("NEXUS_SEALED_MARKER");',
          "  if (marker != NULL && marker[0] != 0) {",
          "    int fd = open(marker, O_WRONLY | O_CREAT | O_TRUNC, 0600);",
          '    if (fd >= 0) { (void)write(fd, "replaced", 8); close(fd); }',
          "  }",
          '  const char *raw_port = getenv("NEXUS_SEALED_PORT");',
          "  if (raw_port == NULL || raw_port[0] == 0) return;",
          "  int fd = socket(AF_INET, SOCK_STREAM, 0);",
          "  if (fd < 0) return;",
          "  struct sockaddr_in address;",
          "  memset(&address, 0, sizeof(address));",
          "  address.sin_family = AF_INET;",
          "  address.sin_port = htons((unsigned short)atoi(raw_port));",
          "  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);",
          "  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0) {",
          '    (void)write(fd, "x", 1);',
          "  }",
          "  close(fd);",
          "}",
          "int main(void) {",
          '  puts("NEXUS_REPLACEMENT_EXECUTED");',
          "  return 31;",
          "}",
        ].join("\n"),
      );
      execFileSync("xcrun", [
        "--sdk",
        "macosx",
        "clang",
        "-std=c11",
        "-mmacosx-version-min=11.0",
        replacementSource,
        "-o",
        sealedReplacement,
      ]);
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        developerSigningIdentity,
        "--identifier",
        sealedFixtureIdentity.identifier,
        "--options",
        "runtime",
        "--timestamp=none",
        sealedReplacement,
      ]);
      sealedReplacementIdentity = codeSignatureMetadata(sealedReplacement);
      if (sealedReplacementIdentity.cdHash === sealedFixtureIdentity.cdHash) {
        throw new Error("sealed replacement unexpectedly reused the CDHash");
      }
    }
  }, 60_000);

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("is universal, executable, and ad-hoc signed", () => {
    expect(existsSync(helper)).toBe(true);
    expect((readFileSync(helper).length ?? 0) > 0).toBe(true);
    expect(() =>
      execFileSync("codesign", ["--verify", "--strict", helper]),
    ).not.toThrow();
    const signature = spawnSync(
      "codesign",
      ["--display", "--verbose=4", helper],
      { encoding: "utf8" },
    );
    expect(signature.status).toBe(0);
    expect(signature.stderr).toContain("Identifier=nexus-pty-supervisor");
    const architectures = execFileSync("xcrun", ["lipo", "-archs", helper], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/u)
      .sort();
    expect(architectures).toEqual(["arm64", "x86_64"]);
  });

  it("restores only the canonical Main heavy Bash resource before the provider", async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const directory = realpathSync(path.join(process.cwd(), 'resources/heavy-command'));
    const resource = path.join(directory, 'shell.bash');
    const malicious = path.join(fixtureRoot, 'untrusted-bash-env');
    const marker = path.join(fixtureRoot, 'untrusted-bash-loaded');
    writeFileSync(malicious, `printf bad > '${marker}'\n`);
    const result = await spawnResult(helper, ['supervise', '--', '/bin/bash', '-c', 'printf "%s" "$BASH_ENV"'], {
      env: { ...process.env, BASH_ENV: malicious, NEXUS_HEAVY_DIR: directory, NEXUS_HEAVY_BASH_ENV: resource },
    });
    expect(result).toMatchObject({ status: 0, signal: null, stdout: resource });
    expect(existsSync(marker)).toBe(false);
    const refused = await spawnResult(helper, ['supervise', '--', '/bin/bash', '-c', 'printf unauthorized'], {
      env: { ...process.env, NEXUS_HEAVY_DIR: directory, NEXUS_HEAVY_BASH_ENV: malicious },
    });
    expect(refused.status).not.toBe(0); expect(refused.stdout).toBe(''); expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("refuses to supervise when its required code signature is removed", () => {
    const unsigned = path.join(fixtureRoot, "unsigned-supervisor");
    copyFileSync(helper, unsigned);
    chmodSync(unsigned, 0o755);
    execFileSync("codesign", ["--remove-signature", unsigned]);
    const result = spawnSync(unsigned, ["supervise", "--", "/usr/bin/true"]);
    expect(result.status === 0 && result.signal === null).toBe(false);
    expect(() =>
      execFileSync("codesign", ["--verify", "--strict", unsigned]),
    ).toThrow();
  });

  it("is the authenticated supervisor behind a real node-pty session", async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    if (ptySkipReason()) skip(ptySkipReason());
    const output = [];
    const terminal = spawnDarwinPty(
      helper,
      [
        "supervise",
        "--",
        "/bin/sh",
        "-c",
        'printf "nexus-supervised-pty"; exit 17',
      ],
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: fixtureRoot,
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );
    terminal.onData((chunk) => output.push(chunk));
    const exit = await waitForTerminalExit(terminal);
    expect(exit.exitCode, output.join("")).toBe(17);
    expect(output.join("")).toContain("nexus-supervised-pty");
  });

  signedSuite(
    "continues an exact live Developer ID identity only after validation",
    ({ skip }) => {
      if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
      const marker = path.join(fixtureRoot, "sealed-exact.marker");
      const result = spawnSync(
        helper,
        authenticatedArguments(sealedFixtureIdentity, sealedFixture),
        {
          encoding: "utf8",
          env: { ...process.env, NEXUS_SEALED_MARKER: marker },
        },
      );
      expect(result).toMatchObject({ status: 29, signal: null });
      expect(result.stdout).toContain("NEXUS_SEALED_EXECUTED");
      expect(readFileSync(marker, "utf8")).toBe("executed");
    },
    60_000,
  );

  signedSuite.for([
    [
      "identifier",
      (identity) => ({ ...identity, identifier: "com.nexuside.wrong" }),
    ],
    ["Team ID", (identity) => ({ ...identity, teamIdentifier: "AAAAAAAAAA" })],
    [
      "CDHash",
      (identity) => ({
        ...identity,
        cdHash: "0000000000000000000000000000000000000000",
      }),
    ],
  ])(
    "kills a traced child on %s mismatch before constructors run",
    ([_label, mutateIdentity], { skip }) => {
      if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
      const marker = path.join(
        fixtureRoot,
        `sealed-mismatch-${_label.replaceAll(" ", "-")}.marker`,
      );
      const result = spawnSync(
        helper,
        authenticatedArguments(
          mutateIdentity(sealedFixtureIdentity),
          sealedFixture,
        ),
        {
          encoding: "utf8",
          env: { ...process.env, NEXUS_SEALED_MARKER: marker },
        },
      );
      expect(result).toMatchObject({ status: 76, signal: null });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        "NEXUS_SEALED_EXECUTED",
      );
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).toContain("live code identity rejected");
    },
    60_000,
  );

  signedSuite(
    "keeps a traced provider sealed through 5,000 external SIGCONT signals",
    async ({ skip }) => {
      if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
      const marker = path.join(fixtureRoot, "sealed-sigcont.marker");
      const ready = path.join(fixtureRoot, "sealed-sigcont.ready");
      const rejectedIdentity = {
        ...sealedFixtureIdentity,
        cdHash: "0000000000000000000000000000000000000000",
      };
      const launch = spawnResult(
        sigcontHeldHelper,
        authenticatedArguments(rejectedIdentity, sealedFixture),
        {
          env: {
            ...process.env,
            NEXUS_SEALED_MARKER: marker,
            NEXUS_TEST_TRACED_AUTH_READY: ready,
          },
        },
      );
      const tracedPid = await waitFor(() => {
        if (!existsSync(ready)) return false;
        return readPidMarker(ready);
      });

      for (let index = 0; index < 5_000; index += 1) {
        process.kill(tracedPid, "SIGCONT");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(marker)).toBe(false);

      const rejected = await launch;
      expect(rejected).toMatchObject({ status: 76, signal: null });
      expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(
        "NEXUS_SEALED_EXECUTED",
      );
      expect(existsSync(marker)).toBe(false);
    },
    60_000,
  );

  signedSuite(
    "kills a trace-stopped provider when its helper tracer is SIGKILLed",
    async ({ skip }) => {
      if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
      const marker = path.join(fixtureRoot, "sealed-tracer-death.marker");
      const ready = path.join(fixtureRoot, "sealed-tracer-death.ready");
      const launch = spawnDetachedResult(
        sigcontHeldHelper,
        authenticatedArguments(sealedFixtureIdentity, sealedFixture),
        {
          env: {
            ...process.env,
            NEXUS_SEALED_MARKER: marker,
            NEXUS_TEST_TRACED_AUTH_READY: ready,
          },
        },
      );
      let tracedPid = 0;
      try {
        tracedPid = await waitFor(() => {
          if (!existsSync(ready)) return false;
          return readPidMarker(ready);
        });

        launch.child.kill("SIGKILL");
        await expect(launch.completion).resolves.toMatchObject({
          status: null,
          signal: "SIGKILL",
        });
        await waitFor(
          () =>
            !processExists(tracedPid) && !processGroupExists(launch.child.pid),
          5_000,
        );
        expect(existsSync(marker)).toBe(false);
      } finally {
        await cleanupProcessGroup(launch.child.pid);
        killFixtureProcess(tracedPid);
      }
    },
    60_000,
  );

  signedSuite(
    "operates as the inner target of sandbox-exec while sealing the provider",
    ({ skip }) => {
      if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
      const marker = path.join(fixtureRoot, "sealed-seatbelt.marker");
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          "(version 1)(allow default)",
          helper,
          ...authenticatedArguments(sealedFixtureIdentity, sealedFixture),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, NEXUS_SEALED_MARKER: marker },
        },
      );
      expect(result).toMatchObject({ status: 29, signal: null });
      expect(result.stdout).toContain("NEXUS_SEALED_EXECUTED");
      expect(readFileSync(marker, "utf8")).toBe("executed");
    },
    60_000,
  );

  signedSuite(
    "rejects a signed pathname substitution after the seal is captured, before file or network effects",
    async ({ skip }) => {
      if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
      const trustedBackup = `${sealedFixture}.trusted`;
      const marker = path.join(fixtureRoot, "sealed-substitution.marker");
      const capturedInvocation = authenticatedArguments(
        sealedFixtureIdentity,
        sealedFixture,
      );
      let connectionCount = 0;
      const server = createServer((socket) => {
        connectionCount += 1;
        socket.destroy();
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      expect(address && typeof address === "object").toBe(true);
      const port = address.port;
      const canonicalSealedFixture = realpathSync.native(sealedFixture);
      const profile = [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        `(with-filter (process-path ${JSON.stringify(canonicalSealedFixture)})`,
        "  (allow network*))",
      ].join(" ");
      const env = {
        ...process.env,
        NEXUS_SEALED_MARKER: marker,
        NEXUS_SEALED_PORT: String(port),
      };

      renameSync(sealedFixture, trustedBackup);
      copyFileSync(sealedReplacement, sealedFixture);
      try {
        // Prove the replacement could perform both effects under the exact
        // canonical process-path exception if it were ever continued.
        const control = await spawnResult(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            profile,
            helper,
            ...authenticatedArguments(sealedReplacementIdentity, sealedFixture),
          ],
          { env },
        );
        expect(control).toMatchObject({ status: 31, signal: null });
        try {
          await waitFor(() => connectionCount === 1);
        } catch (error) {
          throw new Error(
            "process-path control did not reach loopback: " +
              JSON.stringify({
                control,
                markerExists: existsSync(marker),
                marker: existsSync(marker)
                  ? readFileSync(marker, "utf8")
                  : null,
                profile,
              }),
            { cause: error },
          );
        }
        expect(readFileSync(marker, "utf8")).toBe("replaced");
        rmSync(marker);

        const beforeRejectedLaunch = connectionCount;
        const rejected = await spawnResult(
          "/usr/bin/sandbox-exec",
          ["-p", profile, helper, ...capturedInvocation],
          { env },
        );
        expect(rejected).toMatchObject({ status: 76, signal: null });
        expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(
          "NEXUS_REPLACEMENT_EXECUTED",
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(connectionCount).toBe(beforeRejectedLaunch);
        expect(existsSync(marker)).toBe(false);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        rmSync(sealedFixture, { force: true });
        renameSync(trustedBackup, sealedFixture);
      }
    },
    60_000,
  );

  it("reaps the direct child and entire responsibility cohort after SIGTERM", async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    if (ptySkipReason()) skip(ptySkipReason());
    const cohort = await launchLongLivedCohort("term");
    let terminalExited = false;
    try {
      await expectOwnedCohort(cohort);
      const exitPromise = waitForTerminalExit(cohort.terminal);
      cohort.terminal.kill("SIGTERM");
      const exit = await exitPromise;
      terminalExited = true;
      expect(exit.exitCode).toBe(0);
      await waitFor(
        () =>
          !processExists(cohort.childPid) &&
          !processExists(cohort.descendantPid),
      );
      expect(processExists(cohort.childPid)).toBe(false);
      expect(processExists(cohort.descendantPid)).toBe(false);
    } finally {
      cleanupCohort(cohort, terminalExited);
    }
  }, 60_000);

  it("delivers Ctrl-C to a continuing child without closing the pane, then reaps on SIGTERM", async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    if (ptySkipReason()) skip(ptySkipReason());
    const cohort = await launchLongLivedCohort("ctrl-c", {
      keepRunningOnInterrupt: true,
    });
    let observedExit;
    let terminalExited = false;
    cohort.terminal.onExit((event) => {
      observedExit = event;
    });
    try {
      await expectOwnedCohort(cohort);
      cohort.terminal.write("\x03");
      await waitFor(() =>
        cohort.output.join("").includes("CHILD_KEPT_RUNNING"),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(observedExit).toBeUndefined();
      expect(processExists(cohort.childPid)).toBe(true);
      expect(processExists(cohort.descendantPid)).toBe(true);

      const exitPromise = waitForTerminalExit(cohort.terminal);
      cohort.terminal.kill("SIGTERM");
      const exit = await exitPromise;
      terminalExited = true;
      expect(exit.exitCode).toBe(0);
      await waitFor(
        () =>
          !processExists(cohort.childPid) &&
          !processExists(cohort.descendantPid),
      );
      expect(processExists(cohort.childPid)).toBe(false);
      expect(processExists(cohort.descendantPid)).toBe(false);
    } finally {
      cleanupCohort(cohort, terminalExited);
    }
  }, 60_000);

  it("owns and reaps a double-forked, setsid, PPID-1 daemon before preserving the CLI exit", async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    if (ptySkipReason()) skip(ptySkipReason());
    const daemonPidFile = path.join(fixtureRoot, "daemon.pid");
    const readyFile = path.join(fixtureRoot, "root.ready");
    const releaseFile = path.join(fixtureRoot, "root.release");
    const python = [
      "import os,signal,sys,time",
      ...PYTHON_PUBLISH_PID,
      `pid_file=${JSON.stringify(daemonPidFile)}`,
      `ready_file=${JSON.stringify(readyFile)}`,
      `release_file=${JSON.stringify(releaseFile)}`,
      "first=os.fork()",
      "if first == 0:",
      "  os.setsid()",
      "  daemon=os.fork()",
      "  if daemon > 0: os._exit(0)",
      "  signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      '  publish_pid(pid_file)',
      "  time.sleep(30)",
      "  os._exit(0)",
      "os.waitpid(first,0)",
      'with open(ready_file,"w") as f: f.write("ready")',
      pythonWaitRelease("release_file"),
      "sys.exit(23)",
    ].join("\n");

    const supervised = spawn(
      helper,
      ["supervise", "--", "/usr/bin/python3", "-c", python],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderr = [];
    supervised.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

    await waitFor(
      () =>
        existsSync(daemonPidFile) &&
        existsSync(readyFile) &&
        readPidMarker(daemonPidFile),
    );
    const daemonPid = readPidMarker(daemonPidFile);
    await waitFor(() => {
      const result = spawnSync(
        "/bin/ps",
        ["-o", "ppid=", "-p", String(daemonPid)],
        { encoding: "utf8" },
      );
      return Number.parseInt(result.stdout.trim(), 10) === 1;
    });

    const all = inventory();
    const anchor = all.processes.find(
      (record) => record.pid === supervised.pid,
    );
    expect(anchor).toMatchObject({
      pid: supervised.pid,
      responsiblePid: supervised.pid,
    });
    expect(anchor.responsibleUniqueId).toBe(anchor.processUniqueId);

    const owned = await waitForOwnedInventory(
      supervised.pid,
      anchor.responsibleUniqueId,
      [daemonPid],
    );
    expect(owned.complete).toBe(true);
    expect(
      owned.processes.find((record) => record.pid === daemonPid),
    ).toMatchObject({
      ppid: 1,
      responsiblePid: supervised.pid,
      responsibleUniqueId: anchor.responsibleUniqueId,
      startTime: {
        seconds: expect.stringMatching(/^\d+$/u),
        microseconds: expect.any(Number),
      },
      status: {
        code: expect.any(Number),
        name: expect.any(String),
      },
      pgid: expect.any(Number),
      processUniqueId: expect.stringMatching(/^\d+$/u),
      processIdVersion: expect.any(Number),
    });

    writeFileSync(releaseFile, "release");
    const exit = await new Promise((resolve, reject) => {
      supervised.once("error", reject);
      supervised.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(exit).toEqual({ code: 23, signal: null });
    await waitFor(() => !processExists(daemonPid));
    expect(processExists(daemonPid)).toBe(false);
    expect(stderr.join("")).not.toMatch(
      /private responsibility.*unavailable|not its own signed/i,
    );
  }, 60_000);

  it.for(['natural', 'killed-helper', 'killed-authority', 'killed-owner'])('native heavy-job waits for authenticated watch/grant and retains an unseen setsid descendant under the original offline sandbox (%s)', async (completion, { skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const runtime = { platform: 'darwin', packaged: false, cwd: fixtureRoot, moduleDir: fixtureRoot };
    const rootIdentity = {}; const proof = new OwnedCommandProcesses(() => ({ pid: process.pid, identity: rootIdentity }), undefined, (pid) => watchDarwinHeavyCommand(runtime, pid));
    const tag = `heavy-job-${Math.random().toString(16).slice(2)}`;
    const daemonFile = path.join(fixtureRoot, `${tag}.daemon`), primaryFile = path.join(fixtureRoot, `${tag}.primary`), releaseFile = path.join(fixtureRoot, `${tag}.release`);
    const forbidden = path.join(os.tmpdir(), `${tag}.forbidden`);
    let claim = null, grant = null, observedProof = null, helperPid = 0; const phases = [];
    const server = createHttpServer((req, res) => { let raw = ''; req.on('data', (part) => raw += part); req.on('end', () => { const value = JSON.parse(raw); observedProof = value.proof; helperPid = value.pid; phases.push('request');
      void proof.claimForRequest('s', 'request', value.pid, value.proof).then((id) => { claim = id; phases.push(id ? 'claimed' : 'claim-denied'); if (id) proof.confirmRequest('s', 'request', id);
        grant = () => { if (res.writableEnded) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ allow: Boolean(id), leaseId: 'finite-native-lease' })); }; }); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
    const python = ['import os,sys,time,signal', `daemon=${JSON.stringify(daemonFile)}`, `primary=${JSON.stringify(primaryFile)}`, `release=${JSON.stringify(releaseFile)}`,
      ...PYTHON_PUBLISH_PID,
      'first=os.fork()', 'if first == 0:', '  os.setsid()', '  second=os.fork()', '  if second > 0: os._exit(0)', '  signal.signal(signal.SIGTERM, signal.SIG_IGN)', `  publish_pid(daemon, ${completion === 'killed-helper' ? '0.15' : '0'})`, `  ${pythonWaitRelease("release", "0.01")}`, '  os._exit(0)',
      'os.waitpid(first,0)', 'publish_pid(primary)', `try: open(${JSON.stringify(forbidden)},"w").write("widened")`, 'except PermissionError: pass', ...(['killed-helper', 'killed-owner'].includes(completion) ? [pythonWaitRelease("release")] : []), 'sys.exit(23)'].join('\n');
    const base = nestedHeavyJobBaseCommand(runtime);
    const script = `const child=require('node:child_process').spawn(${JSON.stringify(base.file)},${JSON.stringify([...base.args, 'build', '--', '/usr/bin/python3', '-c', python])},{stdio:'inherit'});child.on('exit',(code)=>process.exit(code));`;
    const resources = path.join(process.cwd(), 'resources/heavy-command');
    const profile = `(version 1)(allow default)(deny network*)(with-filter (process-path "/usr/bin/curl") (allow network-outbound (remote tcp "localhost:${port}")))(deny file-write*)(allow file-write* (subpath ${JSON.stringify(realpathSync(fixtureRoot))}))`;
    const command = supervisedPtyCommand(runtime, '/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', script]);
    const job = spawn(command.file, command.args, { detached: true, env: { ...process.env, NODE_OPTIONS: '', NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: 'finite-native-watch' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let finished = false, daemonPid = 0, exitResult = null; let stderr = ''; job.stderr.on('data', (part) => stderr += part);
    const done = new Promise((resolve) => job.once('exit', (code, signal) => { finished = true; exitResult = { code, signal }; resolve(exitResult); }));
    try {
      await waitFor(() => grant !== null || finished, 8_000); expect(finished, stderr).toBe(false);
      expect(claim).toBeTypeOf('string'); expect(observedProof).toBe('darwin-job'); expect(existsSync(primaryFile)).toBe(false); expect(await proof.probe('s', claim)).toBe('live');
      grant(); phases.push('granted'); await waitFor(() => existsSync(primaryFile) && existsSync(daemonFile) || finished, 8000); expect(finished, stderr).toBe(false); phases.push('daemon-created'); daemonPid = readPidMarker(daemonFile);
      const primaryPid = readPidMarker(primaryFile);
      expect(Number.isSafeInteger(daemonPid) && daemonPid > 0).toBe(true); expect(Number.isSafeInteger(primaryPid) && primaryPid > 0).toBe(true);
      if (!['killed-helper', 'killed-owner'].includes(completion)) await waitFor(() => !processExists(primaryPid));
      expect(processExists(daemonPid)).toBe(true); expect(await proof.probe('s', claim)).toBe('live'); expect(finished).toBe(false); expect(existsSync(forbidden)).toBe(false);
      const borrowed = await proof.borrow('s', claim, daemonPid);
      const diagnostic = borrowed ? '' : JSON.stringify({ daemonPid, daemonText: readFileSync(daemonFile, 'utf8'), helperPid, claimState: await proof.probe('s', claim), processes: inventory().processes.filter(row => row.pid === daemonPid || row.pid === helperPid) });
      expect(borrowed, diagnostic).toBe(true); expect(await proof.borrow('s', claim, process.pid)).toBe(false);
      if (completion !== 'natural') {
        const authorityPid = inventory().processes.find((row) => row.pid === daemonPid).responsiblePid;
        const ownerPid = inventory().processes.find((row) => row.pid === authorityPid).ppid;
        process.kill(completion === 'killed-owner' ? ownerPid : completion === 'killed-helper' ? helperPid : authorityPid, 'SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 200)); expect(processExists(daemonPid)).toBe(true);
        if (completion === 'killed-helper' || completion === 'killed-owner') {
          expect(await proof.probe('s', claim)).toBe('live'); await proof.stop('s', claim);
          expect(await proof.probe('s', claim)).toBe('gone'); expect(processExists(daemonPid)).toBe(false);
        } else {
          expect(await proof.probe('s', claim)).toBe('unknown'); await expect(proof.stop('s', claim)).rejects.toThrow('unproved');
        }
      }
      writeFileSync(releaseFile, 'go'); phases.push('daemon-released'); expect(await done).toEqual({ code: completion === 'natural' ? 23 : completion === 'killed-owner' ? 0 : 125, signal: null });
      for (let i = 0; i < 100 && completion === 'natural' && await proof.probe('s', claim) !== 'gone'; i++) await new Promise((resolve) => setTimeout(resolve, 25)); expect(await proof.probe('s', claim)).toBe(completion === 'killed-authority' ? 'unknown' : 'gone');
    } finally {
      grant?.(); writeFileSync(releaseFile, 'go'); if (!finished) job.kill('SIGTERM'); await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2500))]); if (!finished) { console.error('native-heavy-fixture', phases, stderr); if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch {} } job.kill('SIGKILL'); await done; }
      if (daemonPid && processExists(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(forbidden, { force: true });
    }
  }, 30_000);

  it('native heavy fork preserves advanced Node IPC, target argv and nonzero target exit while borrowing one physical job', async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const runtime = { platform: 'darwin', packaged: false, cwd: fixtureRoot, moduleDir: fixtureRoot };
    const identity = {}; const proof = new OwnedCommandProcesses(() => ({ pid: process.pid, identity }), undefined, (pid) => watchDarwinHeavyCommand(runtime, pid));
    const entry = path.join(fixtureRoot, 'finite-agent.cjs'), target = path.join(fixtureRoot, 'node_modules/typescript/finite-ipc.cjs'); mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `process.on('message',m=>{process.send({same:Buffer.isBuffer(m.bytes)&&m.bytes.toString()==='finite-ipc',arg:process.argv[2]});process.exit(19)});`);
    writeFileSync(entry, `const cp=require('node:child_process');const c=cp.fork(${JSON.stringify(target)},['finite-argv'],{serialization:'advanced',env:{...process.env,NODE_OPTIONS:''}});let ok=false;c.on('message',m=>ok=m.same&&m.arg==='finite-argv');c.on('exit',code=>{console.log(ok&&code===19?'ipc-preserved':'ipc-broken:'+code);process.exit(ok&&code===19?0:1)});c.send({bytes:Buffer.from('finite-ipc')});`);
    let claim = null, grants = 0, borrows = 0;
    const server = createHttpServer((req, res) => { let raw = ''; req.on('data', (part) => raw += part); req.on('end', () => { const value = JSON.parse(raw);
      void (async () => { let allow;
        if (value.leaseId) { borrows++; allow = Boolean(claim && await proof.borrow('s', claim, value.pid)); }
        else { grants++; claim = await proof.claimForRequest('s', 'ipc-request', value.pid, value.proof); if (claim) proof.confirmRequest('s', 'ipc-request', claim); allow = Boolean(claim); }
        res.end(JSON.stringify({ allow, leaseId: 'finite-ipc-lease' })); })(); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
    const resources = path.join(process.cwd(), 'resources/heavy-command'), base = nestedHeavyJobBaseCommand(runtime);
    const command = supervisedPtyCommand(runtime, process.execPath, [entry]);
    const job = spawn(command.file, command.args, { detached: true, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(path.join(resources, 'preload.cjs'))}`, NEXUS_HEAVY_AGENT_ENTRY: entry,
      NEXUS_HEAVY_JOB_BASE: JSON.stringify(base), NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: 'finite-ipc-watch' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = ''; job.stdout.on('data', (part) => output += part); job.stderr.on('data', (part) => stderr += part);
    const done = new Promise((resolve) => job.once('exit', (code, signal) => resolve({ code, signal })));
    try { expect(await done, stderr).toEqual({ code: 0, signal: null }); expect(output.trim()).toBe('ipc-preserved'); expect(grants).toBe(1); expect(borrows).toBeGreaterThan(0);
      for (let i = 0; i < 100 && await proof.probe('s', claim) !== 'gone'; i++) await new Promise((resolve) => setTimeout(resolve, 25)); expect(await proof.probe('s', claim)).toBe('gone');
    } finally { if (job.exitCode === null && job.signalCode === null) job.kill('SIGTERM'); await done; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }, 30_000);

  it('native tool hook plus Bash startup borrow one physical job and preserve Bash command semantics', async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const runtime = { platform: 'darwin', packaged: false, cwd: fixtureRoot, moduleDir: fixtureRoot };
    const identity = {}; const proof = new OwnedCommandProcesses(() => ({ pid: process.pid, identity }), undefined, (pid) => watchDarwinHeavyCommand(runtime, pid));
    const resources = path.join(process.cwd(), 'resources/heavy-command');
    const entry = path.join(fixtureRoot, 'finite-hook-agent.cjs'), makefile = path.join(fixtureRoot, 'hook.Makefile'); writeFileSync(makefile, 'all:\n\t@printf make-completed\n');
    const original = `values=(finite bash); /usr/bin/make -f ${JSON.stringify(makefile)}; printf '\n%s\n' "\${values[1]}"`;
    writeFileSync(entry, `const cp=require('node:child_process');const r=cp.execFileSync(process.execPath,[${JSON.stringify(path.join(resources, 'tool-hook.cjs'))}],{input:JSON.stringify({tool_input:{command:${JSON.stringify(original)}}}),encoding:'utf8'});const command=JSON.parse(r).hookSpecificOutput.updatedInput.command;const c=cp.spawn('/bin/bash',['-c',command],{stdio:'inherit'});c.on('exit',code=>process.exit(code));`);
    let claim = null, grants = 0, borrows = 0;
    const server = createHttpServer((req, res) => { let raw = ''; req.on('data', (part) => raw += part); req.on('end', () => { const value = JSON.parse(raw);
      void (async () => { let allow;
        if (value.leaseId) { borrows++; allow = Boolean(claim && await proof.borrow('s', claim, value.pid)); }
        else { grants++; claim = await proof.claimForRequest('s', `hook-request-${grants}`, value.pid, value.proof); if (claim) proof.confirmRequest('s', `hook-request-${grants}`, claim); allow = Boolean(claim); }
        res.end(JSON.stringify({ allow, leaseId: 'finite-hook-lease' })); })(); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
    const command = supervisedPtyCommand(runtime, process.execPath, [entry]);
    const job = spawn(command.file, command.args, { detached: true, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(path.join(resources, 'preload.cjs'))}`, BASH_ENV: path.join(resources, 'shell.bash'), NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'), NEXUS_HEAVY_AGENT_ENTRY: entry,
      NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: 'finite-hook-watch' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = ''; job.stdout.on('data', (part) => output += part); job.stderr.on('data', (part) => stderr += part);
    const done = new Promise((resolve) => job.once('exit', (code, signal) => resolve({ code, signal })));
    try { expect(await done, stderr).toEqual({ code: 0, signal: null }); expect(output.trim()).toBe('make-completed\nbash'); expect(grants).toBe(1); expect(borrows).toBeGreaterThan(0); }
    finally { if (job.exitCode === null && job.signalCode === null) job.kill('SIGTERM'); await done; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }, 30_000);

  it('native Bash positional command retains FD3 snapshot and $0 before physical admission', async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const runtime = { platform: 'darwin', packaged: false, cwd: fixtureRoot, moduleDir: fixtureRoot };
    const identity = {}; const proof = new OwnedCommandProcesses(() => ({ pid: process.pid, identity }), undefined, (pid) => watchDarwinHeavyCommand(runtime, pid));
    const resources = path.join(process.cwd(), 'resources/heavy-command');
    const marker = path.join(fixtureRoot, 'positional-command.marker'), makefile = path.join(fixtureRoot, 'positional.Makefile');
    writeFileSync(makefile, 'all:\n\t@printf positional-completed\n');
    let claim = null, grants = 0, borrows = 0;
    const server = createHttpServer((req, res) => { let raw = ''; req.on('data', (part) => raw += part); req.on('end', () => { const value = JSON.parse(raw);
      void (async () => { let allow = false;
        if (value.leaseId) { borrows++; allow = Boolean(claim && await proof.borrow('s', claim, value.pid)); }
        else if (value.proof === 'darwin-job') {
          grants++; expect(existsSync(marker)).toBe(false);
          claim = await proof.claimForRequest('s', 'positional-request', value.pid, value.proof); if (claim) proof.confirmRequest('s', 'positional-request', claim); allow = Boolean(claim);
        }
        res.end(JSON.stringify({ allow, leaseId: 'finite-positional-lease' })); })(); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
    const expression = 'snap=$(command cat <&3); builtin eval -- "$snap"; builtin eval -- "$1"';
    const userCommand = `finite_snapshot; /usr/bin/make -f ${JSON.stringify(makefile)}; printf '\\narg0=%s\\n' "$0"`;
    const command = supervisedPtyCommand(runtime, '/bin/bash', ['-c', expression, 'finite-wrapper', userCommand]);
    const job = spawn(command.file, command.args, { detached: true, env: { ...process.env, NODE_OPTIONS: '', BASH_ENV: path.join(resources, 'shell.bash'), NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'),
      NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: 'finite-positional-watch' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    job.stdio[3].end(`finite_snapshot() { printf snapshot-preserved > ${JSON.stringify(marker)}; }\n`);
    let output = '', stderr = ''; job.stdout.on('data', (part) => output += part); job.stderr.on('data', (part) => stderr += part);
    const done = new Promise((resolve) => job.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      expect(await done, stderr).toEqual({ code: 0, signal: null }); expect(output.trim()).toBe('positional-completed\narg0=finite-wrapper'); expect(readFileSync(marker, 'utf8')).toBe('snapshot-preserved'); expect(grants).toBe(1); expect(borrows).toBeGreaterThan(0);
      for (let i = 0; i < 100 && await proof.probe('s', claim) !== 'gone'; i++) await new Promise((resolve) => setTimeout(resolve, 25)); expect(await proof.probe('s', claim)).toBe('gone');
    } finally { if (job.exitCode === null && job.signalCode === null) job.kill('SIGTERM'); await done; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }, 30_000);

  it.for(['natural', 'terminate'])('supervise-job holds a detached setsid daemon after primary exit until %s completion', async (mode, { skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const tag = `job-${Math.random().toString(16).slice(2)}`;
    const daemonFile = path.join(fixtureRoot, `${tag}.daemon`), primaryFile = path.join(fixtureRoot, `${tag}.primary`);
    const primaryRelease = path.join(fixtureRoot, `${tag}.release-primary`), daemonRelease = path.join(fixtureRoot, `${tag}.release-daemon`);
    const python = [
      'import os,signal,sys,time',
      ...PYTHON_PUBLISH_PID,
      `daemon_file=${JSON.stringify(daemonFile)}`, `primary_file=${JSON.stringify(primaryFile)}`,
      `primary_release=${JSON.stringify(primaryRelease)}`, `daemon_release=${JSON.stringify(daemonRelease)}`,
      'first=os.fork()', 'if first == 0:', '  os.setsid()', '  second=os.fork()',
      '  if second > 0: os._exit(0)', '  signal.signal(signal.SIGTERM, signal.SIG_IGN)',
      `  publish_pid(daemon_file, ${mode === 'natural' ? '0.15' : '0'})`,
      `  ${pythonWaitRelease("daemon_release")}`, '  os._exit(0)',
      'os.waitpid(first,0)', 'publish_pid(primary_file)',
      pythonWaitRelease("primary_release"), 'sys.exit(23)',
    ].join('\n');
    const job = spawn(helper, ['supervise-job', '--', '/usr/bin/python3', '-c', python], { stdio: ['ignore', 'pipe', 'pipe'] });
    let finished = false; let daemonPid = 0, primaryPid = 0, phase = 'waiting-pid-markers', stderr = '';
    job.stderr.on('data', part => { stderr = (stderr + part.toString()).slice(-4096); });
    const exit = new Promise((resolve) => job.once('exit', (code, signal) => { finished = true; resolve({ code, signal }); }));
    const diagnosticTimer = setTimeout(() => {
      try {
        const daemonText = existsSync(daemonFile) ? readFileSync(daemonFile, 'utf8') : null;
        const primaryText = existsSync(primaryFile) ? readFileSync(primaryFile, 'utf8') : null;
        console.error('supervise-job-fixture-pending', { mode, phase, daemonPid, primaryPid, daemonText, primaryText, finished, exitCode: job.exitCode, signalCode: job.signalCode, stderr,
          processes: inventory().processes.filter(row => [job.pid, daemonPid, primaryPid, Number(daemonText), Number(primaryText)].includes(row.pid)) });
      } catch (error) { console.error('supervise-job-fixture-diagnostic-unavailable', { mode, phase, error: String(error) }); }
    }, 20_000);
    try {
      await waitFor(() => { if (finished) throw new Error('supervise-job exited before starting the fixture'); return existsSync(primaryFile) && existsSync(daemonFile); });
      daemonPid = readPidMarker(daemonFile); primaryPid = readPidMarker(primaryFile); phase = 'waiting-daemon-ppid-1';
      await waitFor(() => Number(spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(daemonPid)], { encoding: 'utf8' }).stdout.trim()) === 1);
      writeFileSync(primaryRelease, 'go'); phase = 'waiting-primary-exit'; await waitFor(() => !processExists(primaryPid));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false); expect(processExists(daemonPid)).toBe(true);
      if (mode === 'natural') writeFileSync(daemonRelease, 'go'); else job.kill('SIGTERM');
      phase = 'waiting-job-exit';
      const result = await exit; expect(result).toEqual({ code: mode === 'natural' ? 23 : 0, signal: null });
      phase = 'waiting-daemon-absence';
      await waitFor(() => !processExists(daemonPid)); expect(processExists(daemonPid)).toBe(false);
    } finally {
      clearTimeout(diagnosticTimer);
      if (!finished) job.kill('SIGTERM');
      if (daemonPid && processExists(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
      await exit;
    }
  }, 30_000);

  it('supervise-job tears down its detached cohort when the exact Main owner dies through Apple stage zero', async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    const tag = `job-owner-${Math.random().toString(16).slice(2)}`;
    const daemonFile = path.join(fixtureRoot, `${tag}.daemon`), primaryFile = path.join(fixtureRoot, `${tag}.primary`), ownerReady = path.join(fixtureRoot, `${tag}.owner`), releaseFile = path.join(fixtureRoot, `${tag}.release`);
    const python = ['import os,signal,sys,time', ...PYTHON_PUBLISH_PID, `daemon_file=${JSON.stringify(daemonFile)}`, `primary_file=${JSON.stringify(primaryFile)}`, `release_file=${JSON.stringify(releaseFile)}`,
      'first=os.fork()', 'if first == 0:', '  os.setsid()', '  second=os.fork()', '  if second > 0: os._exit(0)',
      '  signal.signal(signal.SIGTERM, signal.SIG_IGN)', '  publish_pid(daemon_file)', '  time.sleep(30)', '  os._exit(0)',
      'os.waitpid(first,0)', 'publish_pid(primary_file)', pythonWaitRelease("release_file"), 'sys.exit(23)',
    ].join('\n');
    const command = supervisedJobCommand({ platform: 'darwin', packaged: false, cwd: fixtureRoot, moduleDir: fixtureRoot }, '/usr/bin/python3', ['-c', python]);
    const ownerScript = `const fs=require('node:fs');const task=require('node:child_process').spawn(${JSON.stringify(command.file)},${JSON.stringify(command.args)},{stdio:'ignore'});const marker=${JSON.stringify(ownerReady)};fs.writeFileSync(marker+'.pending',String(task.pid)+'\\n');fs.renameSync(marker+'.pending',marker);setInterval(()=>{},1000);`;
    const owner = spawn(process.execPath, ['-e', ownerScript], { stdio: 'ignore' });
    let daemonPid = 0, stagePid = 0;
    const ownerExit = new Promise((resolve) => owner.once('exit', resolve));
    try {
      await waitFor(() => existsSync(ownerReady) && existsSync(primaryFile) && existsSync(daemonFile));
      stagePid = readPidMarker(ownerReady); daemonPid = readPidMarker(daemonFile); const primaryPid = readPidMarker(primaryFile);
      writeFileSync(releaseFile, 'go'); await waitFor(() => !processExists(primaryPid));
      expect(processExists(stagePid)).toBe(true); expect(processExists(daemonPid)).toBe(true);
      owner.kill('SIGKILL'); await ownerExit;
      await waitFor(() => !processExists(daemonPid) && !processExists(stagePid));
      expect(processExists(daemonPid)).toBe(false); expect(processExists(stagePid)).toBe(false);
    } finally {
      owner.kill('SIGKILL'); await ownerExit;
      if (stagePid && processExists(stagePid)) { try { process.kill(stagePid, 'SIGTERM'); } catch {} }
      if (daemonPid && processExists(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
    }
  }, 30_000);

  it("proves the cohort empty while an unrelated setuid process born after the anchor denies lookup", async ({ skip }) => {
    if (nexusPaneSkipReason) skip(nexusPaneSkipReason);
    if (ptySkipReason()) skip(ptySkipReason());
    // Campo 26/09: o /usr/bin/login de uma janela do Ghostty nasceu depois do
    // pane e respondia EPERM à consulta de responsabilidade; o supervisor
    // ficava em laço para sempre depois que a CLI saía. Um sudo esperando
    // senha, filho deste teste, é o mesmo vizinho setuid fora da coorte.
    const readyFile = path.join(fixtureRoot, "setuid-neighbor.ready");
    const releaseFile = path.join(fixtureRoot, "setuid-neighbor.release");
    const python = [
      "import os,sys,time",
      `ready_file=${JSON.stringify(readyFile)}`,
      `release_file=${JSON.stringify(releaseFile)}`,
      'with open(ready_file,"w") as f: f.write("ready")',
      pythonWaitRelease("release_file"),
      "sys.exit(0)",
    ].join("\n");
    const supervised = spawn(
      helper,
      ["supervise", "--", "/usr/bin/python3", "-c", python],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const neighbor = { process: null };
    try {
      await waitFor(() => existsSync(readyFile));
      neighbor.process = spawn("/usr/bin/sudo", ["-k", "-S", "-v"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(releaseFile, "release");
      const exit = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("supervisor never proved its cohort empty")),
          10_000,
        );
        supervised.once("error", reject);
        supervised.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      neighbor.process?.stdin.end();
      if (supervised.exitCode === null && supervised.signalCode === null) {
        supervised.kill("SIGKILL");
      }
    }
  }, 60_000);
});
