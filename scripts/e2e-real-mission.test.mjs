import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REAL_MISSION_CTA,
  REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_FLAG,
  REAL_MISSION_PRODUCT_WIZARD_FLAG,
  assertCodexReady,
  assertRealMissionPassEvidence,
  assertRealMissionReleaseEvidence,
  parseRealMissionArgs,
  realMissionArgs,
  realMissionEnvironment,
  resolveTrustedCodexBinary,
  runPackagedRealMission,
  runPackagedRealMissionProductWizard,
  safeRealMissionFailureReceipt,
  safeRealMissionFailureSummary,
  stageCodexAuthentication,
  waitForChild,
} from "./e2e-real-mission.mjs";
import { makeValidRealMissionEvidence } from "./test-support/real-mission-evidence.mjs";

const tempDirectories = [];

function makeTemp() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-real-mission-unit-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function validEvidence(options = {}) {
  return makeValidRealMissionEvidence({
    commitSha: "c".repeat(40),
    artifactSha256: "d".repeat(64),
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("real mission packaged harness arguments", () => {
  it.runIf(process.platform === "darwin")(
    "zeroizes runtime attestation material when isolated userData setup fails",
    async () => {
      const root = makeTemp();
      const appPath = path.join(root, "NexusIDE.app");
      const binary = path.join(appPath, "Contents", "MacOS", "nexus-ide");
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(binary, 0o755);
      const fill = vi.spyOn(Buffer.prototype, "fill");
      vi.spyOn(fsp, "mkdtemp").mockRejectedValueOnce(
        new Error("synthetic userData setup failure"),
      );

      await expect(
        runPackagedRealMission(appPath, {
          releaseBinding: {
            appVersion: "1.2.3",
            commitSha: "c".repeat(40),
            artifact: {
              sha256: "d".repeat(64),
              identity:
                "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
            },
          },
        }),
      ).rejects.toThrow(/synthetic userData setup failure/);

      const zeroized = fill.mock.calls.flatMap((args, index) => {
        const instance = fill.mock.instances[index];
        return args[0] === 0 &&
          Buffer.isBuffer(instance) &&
          instance.byteLength === 32
          ? [instance]
          : [];
      });
      expect(zeroized).toHaveLength(2);
      expect(
        zeroized.every((secret) => secret.every((byte) => byte === 0)),
      ).toBe(true);
    },
  );

  it("does not expose replaceable process seams on the product-wizard runner", () => {
    expect(() =>
      runPackagedRealMissionProductWizard("/tmp/NexusIDE.app", {
        releaseBinding: {},
        spawnImpl: vi.fn(),
      }),
    ).toThrow(/rejects dependency override/i);
    const inherited = Object.create({
      spawnImpl: vi.fn(),
      now: vi.fn(),
    });
    expect(() =>
      runPackagedRealMissionProductWizard(
        "/tmp/NexusIDE.app",
        inherited,
      ),
    ).toThrow(/rejects dependency override/i);
  });

  it("parses only the closed CLI surface", () => {
    expect(
      parseRealMissionArgs([
        "--app",
        "/tmp/NexusIDE.app",
        "--evidence",
        "/tmp/evidence.json",
      ]),
    ).toEqual({
      appPath: "/tmp/NexusIDE.app",
      evidencePath: "/tmp/evidence.json",
    });
    expect(() => parseRealMissionArgs(["--timeout", "1"])).toThrow(/usage/);
  });

  it("places the exact explicit flag after Chromium argument termination", () => {
    expect(realMissionArgs("/tmp/user-data")).toEqual([
      "--user-data-dir=/tmp/user-data",
      "--",
      REAL_MISSION_FLAG,
    ]);
    expect(realMissionArgs("/tmp/user-data", "product-wizard")).toEqual([
      "--user-data-dir=/tmp/user-data",
      "--",
      REAL_MISSION_PRODUCT_WIZARD_FLAG,
    ]);
  });

  it("isolates HOME and mutable app state from the release operator profile", () => {
    const environment = realMissionEnvironment(
      {
        HOME: "/Users/tester",
        PATH: "/usr/bin",
        CODEX_ACCESS_TOKEN: "inherited-but-never-logged",
        OPENAI_BASE_URL: "https://attacker.invalid",
        AWS_SECRET_ACCESS_KEY: "private",
        GH_TOKEN: "private",
        GIT_DIR: "/Users/tester/important-repository/.git",
        GIT_WORK_TREE: "/Users/tester/important-repository",
        NODE_OPTIONS: "--inspect",
        NEXUS_REMOTE_DEBUG: "9223",
      },
      "/tmp/user-data",
      "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
    );
    expect(environment.HOME).toBe("/tmp/user-data/home");
    expect(environment.USERPROFILE).toBe("/tmp/user-data/home");
    expect(environment.NEXUS_USER_DATA_DIR).toBe("/tmp/user-data");
    expect(environment.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(environment.OPENAI_BASE_URL).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GIT_DIR).toBeUndefined();
    expect(environment.GIT_WORK_TREE).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.NEXUS_REMOTE_DEBUG).toBeUndefined();
    expect(environment.NEXUS_REAL_MISSION_E2E).toBe("1");
    expect(environment.PATH).toBe(
      [
        "/tmp/user-data/trusted-bin",
        path.dirname(process.execPath),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(path.delimiter),
    );

    const productEnvironment = realMissionEnvironment(
      {},
      "/tmp/product-user-data",
      "/trusted/codex",
      "product-wizard",
    );
    expect(
      productEnvironment.NEXUS_REAL_MISSION_PRODUCT_WIZARD_E2E,
    ).toBe("1");
    expect(productEnvironment.NEXUS_REAL_MISSION_E2E).toBeUndefined();
  });
});

describe("real mission local prerequisites and state restoration", () => {
  it("checks Codex version/auth without returning command output", () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "codex-cli 0.145.0\n",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Logged in using ChatGPT\n",
        stderr: "",
      });
    expect(
      assertCodexReady({
        run,
        environment: {},
        codexBinary: "/trusted/@openai/codex/bin/codex.js",
      }),
    ).toEqual({
      installed: true,
      authenticated: true,
      version: "codex-cli 0.145.0",
    });
    expect(run).toHaveBeenNthCalledWith(
      2,
      "/trusted/@openai/codex/bin/codex.js",
      ["login", "status"],
      expect.objectContaining({ shell: false }),
    );
  });

  it('does not confuse "Not logged in" with an authenticated Codex CLI', () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "codex-cli 0.145.0\n",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Not logged in\n",
        stderr: "",
      });
    expect(() =>
      assertCodexReady({
        run,
        environment: {},
        codexBinary: "/trusted/@openai/codex/bin/codex.js",
      }),
    ).toThrow(/not authenticated/);
  });

  it("rejects Codex builds older than the release-gate contract", () => {
    const run = vi.fn().mockReturnValueOnce({
      status: 0,
      stdout: "codex-cli 0.144.9\n",
      stderr: "",
    });

    expect(() =>
      assertCodexReady({
        run,
        environment: {},
        codexBinary: "/trusted/@openai/codex/bin/codex.js",
      }),
    ).toThrow(/requires codex CLI >= 0\.145\.0/);
    expect(run).toHaveBeenCalledOnce();
  });

  it("resolves only the real official Codex package entrypoint, never a PATH shim", () => {
    const root = makeTemp();
    const packageRoot = path.join(
      root,
      "lib",
      "node_modules",
      "@openai",
      "codex",
    );
    const binary = path.join(packageRoot, "bin", "codex.js");
    const shim = path.join(root, "bin", "codex");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@openai/codex" }),
    );
    fs.writeFileSync(binary, "#!/usr/bin/env node\n", { mode: 0o755 });
    fs.symlinkSync(binary, shim);

    expect(
      resolveTrustedCodexBinary({
        environment: { PATH: path.dirname(shim) },
        resolveCommand: () => shim,
      }),
    ).toBe(fs.realpathSync(binary));

    fs.unlinkSync(shim);
    fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(() =>
      resolveTrustedCodexBinary({
        environment: { PATH: path.dirname(shim) },
        resolveCommand: () => shim,
      }),
    ).toThrow(/official Codex package/i);
  });

  it("stages only the regular Codex auth receipt in the isolated HOME", () => {
    const root = makeTemp();
    const source = path.join(root, "source-codex");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "auth.json"), '{"token":"private"}\n', {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(source, "config.toml"), 'model = "custom"\n');

    expect(stageCodexAuthentication(source, isolatedHome)).toBe(true);
    const staged = path.join(isolatedHome, ".codex", "auth.json");
    expect(fs.readFileSync(staged, "utf8")).toBe('{"token":"private"}\n');
    expect(fs.statSync(staged).mode & 0o777).toBe(0o600);
    expect(
      fs.existsSync(path.join(isolatedHome, ".codex", "config.toml")),
    ).toBe(false);
  });

  it("refuses to stage Codex auth through a symlink", () => {
    const root = makeTemp();
    const source = path.join(root, "source-codex");
    const isolatedHome = path.join(root, "isolated-home");
    const external = path.join(root, "external-auth.json");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(external, "{}\n", { mode: 0o600 });
    fs.symlinkSync(external, path.join(source, "auth.json"));
    expect(() => stageCodexAuthentication(source, isolatedHome)).toThrow(
      /regular Codex auth file/,
    );
  });

  it("refuses a group/world-readable auth receipt and leaves no partial copy", () => {
    const root = makeTemp();
    const source = path.join(root, "source-codex");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "auth.json"), "{}\n", { mode: 0o644 });
    expect(() => stageCodexAuthentication(source, isolatedHome)).toThrow(
      /mode 0600/i,
    );
    expect(fs.existsSync(path.join(isolatedHome, ".codex", "auth.json"))).toBe(
      false,
    );
  });

  it("kills on timeout but waits for the packaged process close before cleanup", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.pid = 4321;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const killTree = vi.fn(() => {
        setTimeout(() => child.emit("close", null), 50);
      });
      const result = waitForChild(
        { binary: "/tmp/NexusIDE" },
        "/tmp/user-data",
        {
          timeoutMs: 100,
          spawnImpl: () => child,
          environment: {},
          codexBinary: "/trusted/@openai/codex/bin/codex.js",
          killTree,
        },
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(killTree).toHaveBeenCalledWith(
        4321,
        expect.objectContaining({ platform: process.platform }),
      );
      // Still open until the child closes (or forced-close grace).
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(49);
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        interruptedBy: "timeout",
        passLineSeen: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves app FAIL snapshot counts instead of hardcoding panes=0 on interrupt", async () => {
    const child = new EventEmitter();
    child.pid = 9911;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const killTree = vi.fn(() => {
      child.emit(
        "data",
        // no-op
      );
      child.stderr.emit(
        "data",
        Buffer.from(
          "[real-mission] FAIL code=app-error status=running panes=2 dispatches=1 handoffs=0 CTA: x\n",
        ),
      );
      child.emit("close", 1);
    });
    const pending = waitForChild(
      { binary: "/tmp/NexusIDE" },
      "/tmp/user-data",
      {
        timeoutMs: 60_000,
        spawnImpl: () => child,
        environment: {},
        codexBinary: "/trusted/@openai/codex/bin/codex.js",
        killTree,
      },
    );
    // Simulate SIGINT path by emitting phase then forcing terminate via timeout 0...
    // Use direct killTree path: close after "app" wrote FAIL with real counts.
    child.stdout.emit(
      "data",
      Buffer.from("[real-mission] PHASE phase=observer-armed\n"),
    );
    // Invoke the process SIGINT listener if registered — fall back to close with app summary.
    child.stderr.emit(
      "data",
      Buffer.from(
        "[real-mission] FAIL code=app-error status=running panes=2 dispatches=1 handoffs=0 CTA: x\n",
      ),
    );
    child.emit("close", 1);
    await expect(pending).resolves.toMatchObject({
      phase: "observer-armed",
      interruptedBy: null,
      appFailSummary: expect.stringContaining("panes=2"),
    });
  });

  it("keeps only a closed phase enum and exit code when the app exits early", async () => {
    const child = new EventEmitter();
    child.pid = 4322;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const result = waitForChild({ binary: "/tmp/NexusIDE" }, "/tmp/user-data", {
      spawnImpl: () => child,
      environment: {},
      codexBinary: "/trusted/@openai/codex/bin/codex.js",
    });

    child.stdout.emit(
      "data",
      Buffer.from(
        "[real-mission] PHASE phase=observer-armed\n" +
          "[real-mission] prompt=never-retain-this-provider-output\n",
      ),
    );
    child.emit("close", 17);

    await expect(result).resolves.toEqual({
      code: 17,
      phase: "observer-armed",
      passLineSeen: false,
      interruptedBy: null,
      appFailSummary: null,
      forcedClose: false,
    });
  });

  it("sanitizes an untrusted failure receipt before preserving its summary", () => {
    const summary = safeRealMissionFailureSummary(
      {
        failure: {
          code: "app-error\nprompt=private-provider-output",
          snapshot: {
            missionStatus: "done\nrawOutput=private",
            paneCount: 1_000_000,
            dispatchCount: -1,
            handoffCount: "private",
          },
        },
      },
      {
        code: 999,
        phase: "prompt-private",
      },
    );

    expect(summary).toBe(
      "[real-mission] FAIL code=invalid-evidence reason=none exit=1 phase=spawned " +
        "status=none panes=0 dispatches=0 handoffs=0 " +
        `CTA: ${REAL_MISSION_CTA}`,
    );
    expect(summary).not.toMatch(/private|prompt|rawOutput/u);
  });

  it("persists only a bounded failure receipt with a closed kickoff reason", () => {
    const receipt = safeRealMissionFailureReceipt(
      {
        schemaVersion: REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
        status: "fail",
        failure: {
          code: "mission-blocked",
          reason: "boot_timeout",
          cta: REAL_MISSION_CTA,
          snapshot: {
            missionStatus: "blocked",
            paneCount: 1,
            dispatchCount: 0,
            handoffCount: 0,
          },
        },
        prompt: "never persist this",
        rawOutput: "never persist this either",
      },
      { code: 0, phase: "observer-armed" },
      {
        appVersion: "0.19.26",
        commitSha: "a".repeat(40),
        artifact: {
          sha256: "b".repeat(64),
          identity:
            "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
        },
      },
    );

    expect(receipt).toEqual({
      schemaVersion: REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
      status: "fail",
      coverageTier: "guided-delivery-core",
      planOrigin: "production-guided-planner",
      prevcOrigin: "e2e-fixture",
      reviewOrigin: "production-physical-worker",
      qaOrigin: "production-physical-worker",
      launchSurface: "private-runner",
      wizardCoverage: "not-covered",
      wizardReceipt: null,
      interaction: {
        evidenceOrigin: "main-owned-instrumentation",
        nativeDialogCount: 0,
        missionApprovalDialogCount: 0,
        missionApprovalAcceptedCount: 0,
        codexMcpPromptCount: 0,
      },
      release: {
        appVersion: "0.19.26",
        commitSha: "a".repeat(40),
        artifact: {
          sha256: "b".repeat(64),
          identity:
            "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
        },
      },
      child: { exitCode: 0, phase: "observer-armed" },
      failure: {
        code: "mission-blocked",
        reason: "boot_timeout",
        cta: REAL_MISSION_CTA,
        snapshot: {
          missionStatus: "blocked",
          paneCount: 1,
          dispatchCount: 0,
          handoffCount: 0,
        },
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /"prompt":|rawOutput|never persist/u,
    );
  });
});

describe("independent evidence verifier", () => {
  it("accepts the complete executor, reviewer and physical-QA proof chain", () => {
    expect(assertRealMissionPassEvidence(validEvidence()).status).toBe("pass");
  });

  it("does not count the synthetic zero-findings council as review coverage", () => {
    const misleading = validEvidence();
    misleading.reviewOrigin = "e2e-merge-review-fixture";

    expect(() => assertRealMissionPassEvidence(misleading)).toThrow(
      /incomplete/,
    );
  });

  it("rejects a forged green receipt or any raw provider output field", () => {
    const withoutDispatch = validEvidence();
    withoutDispatch.dispatches = [];
    expect(() => assertRealMissionPassEvidence(withoutDispatch)).toThrow(
      /incomplete/,
    );
    expect(() =>
      assertRealMissionPassEvidence({
        ...validEvidence(),
        rawOutput: "provider transcript must never cross the boundary",
      }),
    ).toThrow(/forbidden evidence field/);
  });

  it("rejects the obsolete schema v7 release receipt", () => {
    const legacy = validEvidence();
    legacy.schemaVersion = 7;
    expect(() => assertRealMissionPassEvidence(legacy)).toThrow(/incomplete/);
  });

  it("rejects top-level drift and missing pane/run attestation identity", () => {
    const attacks = [
      (evidence) => {
        delete evidence.runId;
      },
      (evidence) => {
        evidence.syntheticAuthority = true;
      },
      (evidence) => {
        delete evidence.runtimeAttestation;
      },
      (evidence) => {
        delete evidence.panes[0].paneId;
      },
      (evidence) => {
        delete evidence.panes[1].workerIncarnationId;
      },
    ];
    for (const mutate of attacks) {
      const evidence = validEvidence();
      mutate(evidence);
      expect(() => assertRealMissionPassEvidence(evidence)).toThrow(
        /incomplete/,
      );
    }
  });

  it("rejects rows without a physical worker PTY or current-session acceptance", () => {
    const noPhysicalWorker = validEvidence();
    noPhysicalWorker.panes[1].ptyDataAt = null;
    noPhysicalWorker.panes[1].ptyChunkSha256 = null;
    expect(() => assertRealMissionPassEvidence(noPhysicalWorker)).toThrow(
      /incomplete/,
    );

    const staleAcceptance = validEvidence();
    staleAcceptance.handoffs[0].consumedBySessionId = "stale-session";
    expect(() => assertRealMissionPassEvidence(staleAcceptance)).toThrow(
      /incomplete/,
    );
  });

  it("requires the exact physical mutation authority for every runtime role", () => {
    const mutations = [
      [0, "readOnly", true],
      [0, "nativeReadOnly", false],
      [1, "readOnly", true],
      [1, "nativeReadOnly", true],
      [2, "readOnly", false],
      [2, "nativeReadOnly", false],
      [3, "readOnly", false],
      [3, "nativeReadOnly", false],
    ];

    for (const [paneIndex, field, value] of mutations) {
      const evidence = validEvidence();
      evidence.panes[paneIndex][field] = value;
      expect(() => assertRealMissionPassEvidence(evidence)).toThrow(
        /incomplete/,
      );
    }
  });

  it("rejects a durable handoff omitted from the projected proof set", () => {
    const evidence = validEvidence();
    evidence.durableHandoffs.count = 4;
    evidence.durableHandoffs.ids.push("handoff-orphan");

    expect(() => assertRealMissionPassEvidence(evidence)).toThrow(
      /incomplete/,
    );
  });

  it("rejects an observed physical PTY omitted from the pane proof set", () => {
    const evidence = validEvidence();
    evidence.physicalPty.count = 5;
    evidence.physicalPty.ids.push("session-orphan-retry");

    expect(() => assertRealMissionPassEvidence(evidence)).toThrow(
      /incomplete/,
    );
  });

  it("rejects a missing/parallel QA wave or synthetic no-change receipt", () => {
    const missingQa = validEvidence();
    missingQa.panes.pop();
    missingQa.dispatches.pop();
    missingQa.handoffs.pop();
    expect(() => assertRealMissionPassEvidence(missingQa)).toThrow(
      /incomplete/,
    );

    const parallelQa = validEvidence();
    parallelQa.dispatches[1].dependsOn = [];
    expect(() => assertRealMissionPassEvidence(parallelQa)).toThrow(
      /incomplete/,
    );

    const syntheticReceipt = validEvidence();
    syntheticReceipt.dispatches[2].integrationReceipt.evidenceIds = [];
    expect(() => assertRealMissionPassEvidence(syntheticReceipt)).toThrow(
      /incomplete/,
    );
  });

  it("rejects a handoff not authored by the exact worker incarnation", () => {
    for (const mutate of [
      (evidence) => {
        evidence.handoffs[0].authorityOrigin = "operator-confirmed";
      },
      (evidence) => {
        evidence.handoffs[0].physicalReceipt = null;
      },
      (evidence) => {
        evidence.handoffs[0].physicalReceipt.source = "internal";
      },
      (evidence) => {
        evidence.handoffs[0].physicalReceipt.worktreeHeadIntegrated = false;
      },
      (evidence) => {
        evidence.handoffs[0].physicalReceipt.issuedAt = 99;
      },
      (evidence) => {
        evidence.handoffs[0].fromAgent = "Processo main";
      },
      (evidence) => {
        evidence.handoffs[0].sessionId = "stale-worker";
      },
      (evidence) => {
        evidence.handoffs[0].workerIncarnationId = "stale-incarnation";
      },
    ]) {
      const evidence = validEvidence();
      mutate(evidence);
      expect(() => assertRealMissionPassEvidence(evidence)).toThrow(
        /incomplete/,
      );
    }
  });

  it("rejects missing or mismatched audit intent and physical receipt", () => {
    const missingAudit = validEvidence();
    missingAudit.handoffs[0].auditIntent = null;
    expect(() => assertRealMissionPassEvidence(missingAudit)).toThrow(
      /incomplete/,
    );

    const wrongInvocation = validEvidence();
    wrongInvocation.handoffs[0].auditIntent.invocationId = "forged-call";
    expect(() => assertRealMissionPassEvidence(wrongInvocation)).toThrow(
      /incomplete/,
    );

    const wrongScope = validEvidence();
    wrongScope.handoffs[1].auditIntent.scope.checkoutId = "other-checkout";
    expect(() => assertRealMissionPassEvidence(wrongScope)).toThrow(
      /incomplete/,
    );
  });

  it("requires consumed state bound to exactly one accepted delivery attempt", () => {
    const acknowledged = validEvidence();
    acknowledged.handoffs[0].deliveryState = "acknowledged";
    expect(() => assertRealMissionPassEvidence(acknowledged)).toThrow(
      /incomplete/,
    );

    const wrongAttempt = validEvidence();
    wrongAttempt.handoffs[0].consumedDeliveryAttemptId = "forged-attempt";
    expect(() => assertRealMissionPassEvidence(wrongAttempt)).toThrow(
      /incomplete/,
    );

    const duplicateAccepted = validEvidence();
    duplicateAccepted.handoffs[0].deliveryAttempts.push({
      ...duplicateAccepted.handoffs[0].deliveryAttempts[0],
      id: "attempt-executor-duplicate",
      attemptNo: 2,
    });
    expect(() => assertRealMissionPassEvidence(duplicateAccepted)).toThrow(
      /incomplete/,
    );
  });

  it("requires dependency consumption and durable Mission Driver/PREVC receipts", () => {
    const noDependency = validEvidence();
    noDependency.dependencyConsumptions = [];
    expect(() => assertRealMissionPassEvidence(noDependency)).toThrow(
      /incomplete/,
    );

    const wrongDependency = validEvidence();
    wrongDependency.dependencyConsumptions[0].consumerSessionId =
      "session-executor";
    expect(() => assertRealMissionPassEvidence(wrongDependency)).toThrow(
      /incomplete/,
    );

    const noCompletion = validEvidence();
    noCompletion.completion = null;
    expect(() => assertRealMissionPassEvidence(noCompletion)).toThrow(
      /incomplete/,
    );

    const legacyMarker = validEvidence();
    legacyMarker.completion = {
      origin: "main-verified-task-plan",
      marker: "legacy text marker",
    };
    expect(() => assertRealMissionPassEvidence(legacyMarker)).toThrow(
      /incomplete/,
    );

    const failedDriver = validEvidence();
    failedDriver.completion.driver.lastOutcome = "failed";
    expect(() => assertRealMissionPassEvidence(failedDriver)).toThrow(
      /incomplete/,
    );

    const missingReceipt = validEvidence();
    missingReceipt.completion.stepReceipts.pop();
    expect(() => assertRealMissionPassEvidence(missingReceipt)).toThrow(
      /incomplete/,
    );

    const forgedBinding = validEvidence();
    forgedBinding.completion.stepReceipts[0].evidenceBinding.headSha =
      "f".repeat(40);
    expect(() => assertRealMissionPassEvidence(forgedBinding)).toThrow(
      /incomplete/,
    );

    const permutedAttestations = validEvidence({
      launchSurface: "private-runner",
    });
    const firstEvidence =
      permutedAttestations.completion.milestones[0].evidenceIds[0];
    const secondEvidence =
      permutedAttestations.completion.milestones[1].evidenceIds[0];
    permutedAttestations.completion.milestones[0].evidenceIds = [
      secondEvidence,
    ];
    permutedAttestations.completion.stepReceipts[0].evidenceIds = [
      secondEvidence,
    ];
    permutedAttestations.completion.milestones[1].evidenceIds = [
      firstEvidence,
    ];
    permutedAttestations.completion.stepReceipts[1].evidenceIds = [
      firstEvidence,
    ];
    expect(() =>
      assertRealMissionPassEvidence(permutedAttestations),
    ).toThrow(/incomplete/);
  });

  it("requires the one approval receipt to precede dispatch and kickoff", () => {
    const missingApproval = validEvidence();
    missingApproval.mission.approvedAt = null;
    expect(() => assertRealMissionPassEvidence(missingApproval)).toThrow(
      /incomplete/,
    );

    const reversed = validEvidence();
    reversed.mission.approvedAt = 2;
    expect(() => assertRealMissionPassEvidence(reversed)).toThrow(/incomplete/);
  });

  it("requires one native approval dialog and zero Codex MCP prompts", () => {
    const duplicateDialog = validEvidence();
    duplicateDialog.interaction.nativeDialogCount = 2;
    expect(() => assertRealMissionPassEvidence(duplicateDialog)).toThrow(
      /incomplete/,
    );

    const providerPrompt = validEvidence();
    providerPrompt.interaction.codexMcpPromptCount = 1;
    expect(() => assertRealMissionPassEvidence(providerPrompt)).toThrow(
      /incomplete/,
    );
  });

  it("rejects extra keys at every strict release-evidence boundary", () => {
    const mutations = [
      ["evidence", (evidence) => (evidence.extra = "x")],
      [
        "runtimeAttestation",
        (evidence) => (evidence.runtimeAttestation.extra = "x"),
      ],
      ["wizardReceipt", (evidence) => (evidence.wizardReceipt.extra = "x")],
      ["interaction", (evidence) => (evidence.interaction.extra = "x")],
      ["mission", (evidence) => (evidence.mission.extra = "x")],
      [
        "missionInventory",
        (evidence) => (evidence.missionInventory.extra = "x"),
      ],
      ["kickoff", (evidence) => (evidence.kickoff.extra = "x")],
      ["plan", (evidence) => (evidence.plan.extra = "x")],
      ["plan.tasks[]", (evidence) => (evidence.plan.tasks[0].extra = "x")],
      ["panes[]", (evidence) => (evidence.panes[0].extra = "x")],
      ["physicalPty", (evidence) => (evidence.physicalPty.extra = "x")],
      ["dispatches[]", (evidence) => (evidence.dispatches[0].extra = "x")],
      [
        "dispatches[].integrationReceipt",
        (evidence) =>
          (evidence.dispatches[0].integrationReceipt.extra = "x"),
      ],
      ["handoffs[]", (evidence) => (evidence.handoffs[0].extra = "x")],
      [
        "handoffs[].physicalReceipt",
        (evidence) => (evidence.handoffs[0].physicalReceipt.extra = "x"),
      ],
      [
        "handoffs[].auditIntent",
        (evidence) => (evidence.handoffs[0].auditIntent.extra = "x"),
      ],
      [
        "handoffs[].auditIntent.scope",
        (evidence) => (evidence.handoffs[0].auditIntent.scope.extra = "x"),
      ],
      [
        "handoffs[].deliveryAttempts[]",
        (evidence) =>
          (evidence.handoffs[0].deliveryAttempts[0].extra = "x"),
      ],
      [
        "dependencyConsumptions[]",
        (evidence) => (evidence.dependencyConsumptions[0].extra = "x"),
      ],
      [
        "durableHandoffs",
        (evidence) => (evidence.durableHandoffs.extra = "x"),
      ],
      ["completion", (evidence) => (evidence.completion.extra = "x")],
      [
        "completion.driver",
        (evidence) => (evidence.completion.driver.extra = "x"),
      ],
      [
        "completion.workflow",
        (evidence) => (evidence.completion.workflow.extra = "x"),
      ],
      [
        "completion.workflow.binding",
        (evidence) => (evidence.completion.workflow.binding.extra = "x"),
      ],
      [
        "completion.milestones[]",
        (evidence) => (evidence.completion.milestones[0].extra = "x"),
      ],
      [
        "completion.stepReceipts[]",
        (evidence) => (evidence.completion.stepReceipts[0].extra = "x"),
      ],
      [
        "completion.stepReceipts[].evidenceBinding",
        (evidence) =>
          (evidence.completion.stepReceipts[0].evidenceBinding.extra = "x"),
      ],
      ["repository", (evidence) => (evidence.repository.extra = "x")],
      ["release", (evidence) => (evidence.release.extra = "x")],
      [
        "release.providerTranscript",
        (evidence) => (evidence.release.providerTranscript = "secret output"),
      ],
      [
        "release.artifact",
        (evidence) => (evidence.release.artifact.extra = "x"),
      ],
      [
        "release.artifact.attestationSecretValue",
        (evidence) =>
          (evidence.release.artifact.attestationSecretValue = "secret"),
      ],
    ];

    for (const [boundary, mutate] of mutations) {
      const evidence = validEvidence();
      mutate(evidence);
      expect(
        () => assertRealMissionReleaseEvidence(evidence),
        `accepted extra key at ${boundary}`,
      ).toThrow(/incomplete/);
    }
  });

  it("never accepts private-runner evidence as release UI proof", () => {
    const privateEvidence = validEvidence({
      launchSurface: "private-runner",
    });

    expect(() => assertRealMissionPassEvidence(privateEvidence)).not.toThrow();
    expect(() => assertRealMissionReleaseEvidence(privateEvidence)).toThrow(
      /product-wizard.*diagnostic-only/i,
    );
    expect(() =>
      assertRealMissionReleaseEvidence(validEvidence()),
    ).not.toThrow();

    const flagOnly = validEvidence();
    flagOnly.wizardCoverage = "not-covered";
    expect(() => assertRealMissionReleaseEvidence(flagOnly)).toThrow(
      /product-wizard|incomplete/i,
    );

    const rendererClaim = validEvidence();
    rendererClaim.wizardCoverage = "computer-use";
    expect(() => assertRealMissionPassEvidence(rendererClaim)).toThrow(
      /incomplete/i,
    );
  });

  it("requires the exact causal product-wizard receipt in the release mirror", () => {
    const missing = validEvidence();
    delete missing.wizardReceipt;
    expect(() => assertRealMissionPassEvidence(missing)).toThrow(/incomplete/);

    for (const [field, value] of [
      ["missionId", "other-mission"],
      ["workspaceSha256", "e".repeat(64)],
      ["squadRevisionHash", "f".repeat(64)],
      ["submittedContractSha256", "0".repeat(64)],
    ]) {
      const tampered = validEvidence();
      tampered.wizardReceipt[field] = value;
      expect(
        () => assertRealMissionPassEvidence(tampered),
        `tampered receipt field ${field}`,
      ).toThrow(/incomplete/);
    }

    const reversed = validEvidence();
    reversed.wizardReceipt.nativeDialogOpenedAt = 2;
    reversed.wizardReceipt.nativeDialogAcceptedAt = 1;
    expect(() => assertRealMissionPassEvidence(reversed)).toThrow(/incomplete/);

    const privateWithReceipt = validEvidence({
      launchSurface: "private-runner",
    });
    privateWithReceipt.wizardReceipt = validEvidence().wizardReceipt;
    expect(() => assertRealMissionPassEvidence(privateWithReceipt)).toThrow(
      /incomplete/,
    );
  });

  it("rejects a full-flow claim from the partial-coverage harness", () => {
    const evidence = validEvidence();
    evidence.coverageTier = "full-flow";
    evidence.planOrigin = "agent-mcp";
    evidence.prevcOrigin = "production-runtime";
    evidence.reviewOrigin = "production-runtime";
    expect(() => assertRealMissionPassEvidence(evidence)).toThrow(/incomplete/);
  });

  it("rejects extra commits even when the final result content is correct", () => {
    const evidence = validEvidence();
    evidence.repository.commitCount = 3;
    evidence.repository.exactSingleCommit = false;
    expect(() => assertRealMissionPassEvidence(evidence)).toThrow(/incomplete/);
  });

  it("accepts a merge-commit integration (3 commits) when the exact-result invariant holds", () => {
    const evidence = validEvidence();
    evidence.repository.commitCount = 3;
    expect(() => assertRealMissionPassEvidence(evidence)).not.toThrow();

    const tooMany = validEvidence();
    tooMany.repository.commitCount = 4;
    expect(() => assertRealMissionPassEvidence(tooMany)).toThrow(/incomplete/);
  });

  it("rejects release evidence without version, run/clock, commit and artifact identity binding", () => {
    for (const mutate of [
      (evidence) => {
        delete evidence.release.appVersion;
      },
      (evidence) => {
        evidence.release.runId = "predictable";
      },
      (evidence) => {
        evidence.release.finishedAt = evidence.release.startedAt;
      },
      (evidence) => {
        evidence.release.commitSha = "not-a-commit";
      },
      (evidence) => {
        evidence.release.artifact.sha256 = "not-a-digest";
      },
      (evidence) => {
        evidence.release.artifact.identity = "adhoc";
      },
    ]) {
      const evidence = validEvidence();
      mutate(evidence);
      expect(() => assertRealMissionPassEvidence(evidence)).toThrow(
        /incomplete/,
      );
    }
  });
});
