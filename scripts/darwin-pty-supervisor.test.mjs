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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as nodePty from "@lydell/node-pty";
import { buildDarwinPtySupervisor } from "./build-darwin-pty-supervisor.mjs";
import { darwinNodePtyBootstrapLaunch } from "../src/main/pty/darwin-node-pty-bootstrap.ts";
import { supervisedPtyCommand } from "../src/main/pty/darwin-pty-supervisor.ts";

const isDarwin = process.platform === "darwin";
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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
    `child_pid_file=${JSON.stringify(childPidFile)}`,
    `descendant_pid_file=${JSON.stringify(descendantPidFile)}`,
    'def keep_running_after_interrupt(_signal, _frame): os.write(1,b"CHILD_KEPT_RUNNING\\n")',
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    ...(keepRunningOnInterrupt
      ? ["signal.signal(signal.SIGINT, keep_running_after_interrupt)"]
      : []),
    "descendant=os.fork()",
    "if descendant == 0:",
    '  with open(descendant_pid_file,"w") as f: f.write(str(os.getpid()))',
    "  time.sleep(30)",
    "  os._exit(0)",
    'with open(child_pid_file,"w") as f: f.write(str(os.getpid()))',
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
        Number.parseInt(readFileSync(childPidFile, "utf8"), 10) &&
        Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10),
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
    childPid: Number.parseInt(readFileSync(childPidFile, "utf8"), 10),
    descendantPid: Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10),
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

  it("is the authenticated supervisor behind a real node-pty session", async () => {
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
    () => {
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

  signedSuite.each([
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
    (_label, mutateIdentity) => {
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
    async () => {
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
        const parsed = Number.parseInt(readFileSync(ready, "utf8"), 10);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : false;
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
    async () => {
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
          const parsed = Number.parseInt(readFileSync(ready, "utf8"), 10);
          return Number.isInteger(parsed) && parsed > 0 ? parsed : false;
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
    () => {
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
    async () => {
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

  it("reaps the direct child and entire responsibility cohort after SIGTERM", async () => {
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

  it("delivers Ctrl-C to a continuing child without closing the pane, then reaps on SIGTERM", async () => {
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

  it("owns and reaps a double-forked, setsid, PPID-1 daemon before preserving the CLI exit", async () => {
    const daemonPidFile = path.join(fixtureRoot, "daemon.pid");
    const readyFile = path.join(fixtureRoot, "root.ready");
    const releaseFile = path.join(fixtureRoot, "root.release");
    const python = [
      "import os,signal,sys,time",
      `pid_file=${JSON.stringify(daemonPidFile)}`,
      `ready_file=${JSON.stringify(readyFile)}`,
      `release_file=${JSON.stringify(releaseFile)}`,
      "first=os.fork()",
      "if first == 0:",
      "  os.setsid()",
      "  daemon=os.fork()",
      "  if daemon > 0: os._exit(0)",
      "  signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      '  with open(pid_file,"w") as f: f.write(str(os.getpid()))',
      "  time.sleep(30)",
      "  os._exit(0)",
      "os.waitpid(first,0)",
      'with open(ready_file,"w") as f: f.write("ready")',
      "while not os.path.exists(release_file): time.sleep(0.02)",
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
        Number.parseInt(readFileSync(daemonPidFile, "utf8"), 10),
    );
    const daemonPid = Number.parseInt(readFileSync(daemonPidFile, "utf8"), 10);
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
});
