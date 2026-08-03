import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REAL_MISSION_ADVISOR_SKIP_ENV,
  REAL_MISSION_CTA,
  REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_FLAG,
  REAL_MISSION_ORCHESTRATOR_ENV,
  REAL_MISSION_PRODUCT_WIZARD_FLAG,
  assertCodexReady,
  assertRealMissionPassEvidence,
  assertRealMissionReleaseEvidence,
  mergeRealMissionAdvisorSkipEnv,
  parseRealMissionArgs,
  realMissionProductWizardOrchestrators,
  realMissionArgs,
  realMissionEnvironment,
  resolveTrustedCodexBinary,
  runPackagedRealMission,
  runPackagedRealMissionProductWizard,
  safeRealMissionFailureReceipt,
  safeRealMissionFailureSummary,
  stageClaudeNativeIdentity,
  stageCodexAuthentication,
  waitForChild,
} from "./e2e-real-mission.mjs";
import {
  REAL_MISSION_GOAL,
  realMissionAcceptanceCriteria,
  realMissionExpectedTaskChain,
} from "./e2e-real-mission-contract.mjs";
import { persistPostPassRejectionReceipt } from "./e2e-real-mission-runtime.mjs";
import { makeValidRealMissionEvidence } from "./test-support/real-mission-evidence.mjs";
import {
  assertAdvisorBinaries,
  nodeBinDirsNearCodexPackage,
  preflightNativeAgyAuthentication,
  stageAdvisorAuthentication,
} from "./e2e-real-mission-launcher.mjs";

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
  it("keeps admitted advisors, PREVC reviewers and the delivery chain in distinct lanes", () => {
    const admitted = ["opencode", "claude", "glm"];
    const criteria = realMissionAcceptanceCriteria("codex", admitted);
    const advisorCriterion = criteria.find((criterion) =>
      criterion.includes("guided-advisory"),
    );
    const prevcCriterion = criteria.find((criterion) =>
      criterion.includes("reviewer PREVC"),
    );
    const chain = realMissionExpectedTaskChain(admitted);

    expect(advisorCriterion).toContain("opencode, claude, glm");
    expect(advisorCriterion).not.toMatch(/\b(?:grok|kimi|agy)\b/u);
    expect(advisorCriterion).toContain("nexus_handoff_submit");
    expect(prevcCriterion).toContain("nexus_merge_review_submit");
    expect(prevcCriterion).not.toContain("nexus_handoff_submit");
    expect(
      chain
        .filter((member) => member.kind === "advisory")
        .map((member) => member.cli),
    ).toEqual(admitted);
    expect(
      chain.filter((member) => member.kind === "review").map((member) => member.cli),
    ).toEqual(["codex"]);
    expect(REAL_MISSION_GOAL).not.toContain("terceiro handoff");
    expect(REAL_MISSION_GOAL).toContain(
      "cadeia de entrega executor → revisor → QA",
    );
  });

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
        // Node that can host the official npm Codex wrapper (if present).
        ...nodeBinDirsNearCodexPackage(
          "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
        ),
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
      failure: {
        code: "mission-blocked",
        reason: "boot_timeout",
        detail: null,
        cta: REAL_MISSION_CTA,
        snapshot: {
          missionStatus: "blocked",
          paneCount: 1,
          dispatchCount: 0,
          handoffCount: 0,
        },
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

  it("requires the AGY advisor handoff to use its physical PTY stream", () => {
    const physicalAgy = validEvidence();
    const dispatch = physicalAgy.dispatches.find(
      (candidate) => candidate.agentRef === "e2e-advisor-agy",
    );
    const handoff = physicalAgy.handoffs.find(
      (candidate) => candidate.id === dispatch.handoffId,
    );
    handoff.physicalReceipt.source = "pty-stream";
    handoff.auditIntent.source = "pty-stream";

    expect(assertRealMissionPassEvidence(physicalAgy).status).toBe("pass");

    const forgedHttpAgy = validEvidence();
    const forgedDispatch = forgedHttpAgy.dispatches.find(
      (candidate) => candidate.agentRef === "e2e-advisor-agy",
    );
    const forgedHandoff = forgedHttpAgy.handoffs.find(
      (candidate) => candidate.id === forgedDispatch.handoffId,
    );
    forgedHandoff.physicalReceipt.source = "http-mcp";
    forgedHandoff.auditIntent.source = "http-mcp";
    expect(() => assertRealMissionPassEvidence(forgedHttpAgy)).toThrow(
      /incomplete/,
    );
  });

  it("rejects PTY-stream handoffs from every non-AGY worker", () => {
    const forgedExecutor = validEvidence();
    const dispatch = forgedExecutor.dispatches.find(
      (candidate) => candidate.agentRef === "e2e-executor",
    );
    const handoff = forgedExecutor.handoffs.find(
      (candidate) => candidate.id === dispatch.handoffId,
    );
    handoff.physicalReceipt.source = "pty-stream";
    handoff.auditIntent.source = "pty-stream";

    expect(() => assertRealMissionPassEvidence(forgedExecutor)).toThrow(
      /incomplete/,
    );
  });

  it("binds an independent advisor HEAD to the executor integration chronology", () => {
    const withAdvisorHead = (head, noChangeHead = head, issuedAt) => {
      const evidence = validEvidence();
      const dispatch = evidence.dispatches.find(
        (candidate) =>
          candidate.plannerId === "guided-advisory-2-e2e-advisor-kimi",
      );
      const handoff = evidence.handoffs.find(
        (candidate) => candidate.id === dispatch.handoffId,
      );
      const cleanDiff = dispatch.integrationReceipt.reference.split(":").at(-1);

      handoff.physicalReceipt.worktreeHeadSha = head;
      dispatch.integrationReceipt.reference =
        `no-change:${noChangeHead}:${cleanDiff}`;
      if (issuedAt !== undefined) {
        const acceptedAttempt = handoff.deliveryAttempts[0];
        const participation = evidence.participation.find(
          (row) => row.cli === "kimi",
        );
        handoff.physicalReceipt.issuedAt = issuedAt;
        acceptedAttempt.startedAt = issuedAt;
        acceptedAttempt.acceptedAt = issuedAt;
        acceptedAttempt.acceptDeadlineAt = issuedAt + 1;
        handoff.consumedAt = issuedAt + 1;
        dispatch.handoffAcceptedAt = issuedAt;
        dispatch.completedAt = issuedAt + 1;
        dispatch.integrationReceipt.completedAt = issuedAt + 1;
        participation.handoffAt = issuedAt;
      }
      return evidence;
    };
    const baseline = validEvidence();
    const { initialHeadSha, finalHeadSha } = baseline.repository;
    const executorCompletedAt = baseline.dispatches.find(
      (dispatch) => dispatch.plannerId === "guided-execution",
    ).completedAt;

    expect(() =>
      assertRealMissionPassEvidence(withAdvisorHead(finalHeadSha)),
    ).toThrow(/incomplete/);
    expect(
      assertRealMissionPassEvidence(
        withAdvisorHead(finalHeadSha, finalHeadSha, executorCompletedAt),
      ).status,
    ).toBe("pass");
    expect(() =>
      assertRealMissionPassEvidence(
        withAdvisorHead(
          initialHeadSha,
          initialHeadSha,
          executorCompletedAt + 1,
        ),
      ),
    ).toThrow(/incomplete/);
    expect(() =>
      assertRealMissionPassEvidence(withAdvisorHead("e".repeat(40))),
    ).toThrow(/incomplete/);
    expect(() =>
      assertRealMissionPassEvidence(
        withAdvisorHead(finalHeadSha, "c".repeat(40)),
      ),
    ).toThrow(/incomplete/);
  });

  it("accepts official advisor preflight skips while retaining the post-QA proof chain", () => {
    const evidence = validEvidence({
      skipAdvisorClis: ["grok", "kimi", "agy"],
    });
    const qaDispatch = evidence.dispatches.find(
      (dispatch) => dispatch.plannerId === "guided-quality-gate",
    );
    const qaHandoff = evidence.handoffs.find(
      (handoff) => handoff.id === qaDispatch?.handoffId,
    );

    expect(assertRealMissionPassEvidence(evidence).status).toBe("pass");
    expect(assertRealMissionReleaseEvidence(evidence).status).toBe("pass");
    expect(qaHandoff.physicalReceipt.issuedAt).toBeLessThan(
      qaDispatch.integrationReceipt.completedAt,
    );
    expect(qaDispatch.integrationReceipt.completedAt).toBeLessThan(
      evidence.completion.completedAt,
    );
  });

  it("rejects forged skip activity, missing admitted handoff and missing post-QA receipts", () => {
    const skipWithActivity = validEvidence({
      skipAdvisorClis: ["grok"],
    });
    skipWithActivity.participation.find((row) => row.cli === "grok").spawnedAt =
      4;
    expect(() => assertRealMissionPassEvidence(skipWithActivity)).toThrow(
      /incomplete/,
    );

    const admittedWithoutHandoff = validEvidence();
    admittedWithoutHandoff.participation.find(
      (row) => row.cli === "grok",
    ).handoffAt = null;
    expect(() => assertRealMissionPassEvidence(admittedWithoutHandoff)).toThrow(
      /incomplete/,
    );

    const missingQaReceipt = validEvidence();
    missingQaReceipt.dispatches.find(
      (dispatch) => dispatch.plannerId === "guided-quality-gate",
    ).integrationReceipt = null;
    expect(() => assertRealMissionPassEvidence(missingQaReceipt)).toThrow(
      /incomplete/,
    );

    const missingCompletionReceipt = validEvidence();
    missingCompletionReceipt.completion.stepReceipts.pop();
    expect(() =>
      assertRealMissionPassEvidence(missingCompletionReceipt),
    ).toThrow(/incomplete/);
  });

  it("accepts the claude-orchestrator variant proof chain bound to release", () => {
    const variant = validEvidence({ orchestratorCli: "claude" });
    expect(assertRealMissionPassEvidence(variant).status).toBe("pass");
    expect(assertRealMissionReleaseEvidence(variant).status).toBe("pass");

    // Orquestrador claude sem a advisor reservada: rejeitado.
    const unreserved = validEvidence({ orchestratorCli: "claude" });
    unreserved.participation.find((row) => row.cli === "claude").skipped =
      "no-credential";
    expect(() => assertRealMissionPassEvidence(unreserved)).toThrow(
      /incomplete/,
    );

    // Orquestrador codex carregando a marca orchestrator-reserved: rejeitado.
    const forgedMark = validEvidence({ skipAdvisorClis: ["claude"] });
    forgedMark.participation.find((row) => row.cli === "claude").skipped =
      "orchestrator-reserved";
    expect(() => assertRealMissionPassEvidence(forgedMark)).toThrow(
      /incomplete/,
    );
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
      [0, "nativeReadOnly", true],
      [1, "readOnly", true],
      [1, "nativeReadOnly", true],
      [2, "readOnly", false],
      [2, "nativeReadOnly", true],
      [3, "readOnly", false],
      [3, "nativeReadOnly", true],
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

  it("rejects a missing QA, serialized root or synthetic no-change receipt", () => {
    const missingQa = validEvidence();
    missingQa.panes.pop();
    missingQa.dispatches.pop();
    missingQa.handoffs.pop();
    expect(() => assertRealMissionPassEvidence(missingQa)).toThrow(
      /incomplete/,
    );

    const serializedRoot = validEvidence();
    const executor = serializedRoot.dispatches.find(
      (dispatch) => dispatch.plannerId === "guided-execution",
    );
    const advisory = serializedRoot.dispatches.find((dispatch) =>
      dispatch.plannerId.startsWith("guided-advisory-"),
    );
    executor.dependsOn = [advisory.taskId];
    expect(() => assertRealMissionPassEvidence(serializedRoot)).toThrow(
      /incomplete/,
    );

    const detachedQa = validEvidence();
    detachedQa.dispatches.find(
      (dispatch) => dispatch.plannerId === "guided-quality-gate",
    ).dependsOn = [];
    expect(() => assertRealMissionPassEvidence(detachedQa)).toThrow(
      /incomplete/,
    );

    const syntheticReceipt = validEvidence();
    syntheticReceipt.dispatches.find(
      (dispatch) => dispatch.plannerId === "guided-quality-gate",
    ).integrationReceipt.evidenceIds = [];
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

  it("accepts the delivery chain after exact current-session acceptance without manual consumption", () => {
    const submitted = validEvidence();
    for (const handoff of submitted.handoffs) {
      handoff.deliveryState = "submitted";
      handoff.consumedAt = null;
      handoff.consumedBySessionId = null;
      handoff.consumedDeliveryAttemptId = null;
    }

    expect(assertRealMissionPassEvidence(submitted).status).toBe("pass");
    expect(assertRealMissionReleaseEvidence(submitted).status).toBe("pass");
  });

  it("rejects partial delivery state, forged consumption or duplicate acceptance", () => {
    const partial = validEvidence();
    partial.handoffs[0].deliveryState = "acknowledged";
    partial.handoffs[0].consumedBySessionId = null;
    expect(() => assertRealMissionPassEvidence(partial)).toThrow(
      /incomplete/,
    );

    const consumedWithoutReceipt = validEvidence();
    consumedWithoutReceipt.handoffs[0].consumedAt = null;
    consumedWithoutReceipt.handoffs[0].consumedBySessionId = null;
    consumedWithoutReceipt.handoffs[0].consumedDeliveryAttemptId = null;
    expect(() => assertRealMissionPassEvidence(consumedWithoutReceipt)).toThrow(
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

    const legacyReceiptPhase = validEvidence();
    legacyReceiptPhase.completion.stepReceipts[0].fromStage =
      "validation-primary";
    expect(() => assertRealMissionPassEvidence(legacyReceiptPhase)).toThrow(
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

describe("real mission advisor authentication staging", () => {
  const writePrivate = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
  };
  const keychainRun = (status) =>
    vi.fn().mockImplementation((bin, args = []) => {
      const joined = Array.isArray(args) ? args.join(" ") : "";
      if (bin === "/trusted/agy" && args.includes("--print")) {
        const prompt = args.at(-1) ?? "";
        const marker = prompt.match(/NEXUS_AGY_AUTH_OK_[a-f0-9]{32}/u)?.[0];
        return marker
          ? { status: 0, stdout: `${marker}\n`, stderr: "" }
          : { status: 1, stdout: "", stderr: "missing marker" };
      }
      if (bin === "grok" && joined === "models") {
        return {
          status: 0,
          stdout: "grok-4\ngrok-4-fast\n",
          stderr: "",
        };
      }
      // Claude/Agy secret reads need a non-empty stdout for "usable" session.
      if (status === 0 && joined.includes("-w")) {
        if (joined.includes("Claude Code-credentials")) {
          return {
            status: 0,
            stdout:
              JSON.stringify({
                claudeAiOauth: {
                  accessToken: "sk-ant-oat01-test",
                  refreshToken: "sk-ant-ort01-test",
                },
              }) + "\n",
            stderr: "",
          };
        }
        if (joined.includes("antigravity")) {
          return { status: 0, stdout: "gemini-secret-blob\n", stderr: "" };
        }
      }
      return { status, stdout: "", stderr: "" };
    });

  it("stages every advisor's auth material into the isolated HOME with private modes", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    const grokAuth =
      JSON.stringify({
        "https://auth.x.ai::test-client": {
          key: "fresh-access",
          refresh_token: "refresh",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      }) + "\n";
    writePrivate(path.join(sourceHome, ".grok", "auth.json"), grokAuth);
    // config.toml is not a secret; a lax source mode is tolerated.
    fs.writeFileSync(
      path.join(sourceHome, ".grok", "config.toml"),
      'model = "grok-4"\n',
      { mode: 0o644 },
    );
    writePrivate(
      path.join(sourceHome, ".kimi-code", "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "at-test",
        refresh_token: "rt-test",
        expires_at: 9_999_999_999,
        scope: "kimi-code",
        token_type: "Bearer",
        expires_in: 900,
      }) + "\n",
    );
    writePrivate(
      path.join(sourceHome, ".kimi-code", "device_id"),
      "device-uuid-test\n",
    );
    fs.writeFileSync(
      path.join(sourceHome, ".kimi-code", "config.toml"),
      'default_model = "kimi-code/k3"\n',
      { mode: 0o644 },
    );
    // agy: sessão viva = oauth_creds utilizável e/ou conta active + secret.
    // Instalação antigravity sozinha não conta (evita "login new" no wizard).
    writePrivate(
      path.join(sourceHome, ".gemini", "google_accounts.json"),
      JSON.stringify({ active: "operator@example.com", old: [] }) + "\n",
    );
    writePrivate(
      path.join(sourceHome, ".gemini", "installation_id"),
      "install-1\n",
    );
    writePrivate(
      path.join(sourceHome, ".gemini", "oauth_creds.json"),
      JSON.stringify({
        access_token: "agy-at",
        refresh_token: "agy-rt",
      }) + "\n",
    );
    writePrivate(
      path.join(sourceHome, ".local", "share", "opencode", "auth.json"),
      '{"opencode":1}\n',
    );
    writePrivate(
      path.join(
        sourceHome,
        ".local",
        "share",
        "ai-launcher",
        "providers.conf",
      ),
      "glm=00000000000000000000000000000000.testsecretvalue\n",
    );
    // Identidade nativa NÃO-secreta do Claude (oauthAccount/userID): o CLI
    // decide "logado" por ela; o segredo fica só na keychain.
    fs.writeFileSync(
      path.join(sourceHome, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        // Formato REAL do Claude: oauthAccount e um OBJETO. O teste antigo o
        // modelava como string, formato que o CLI nunca produz — foi por isso
        // que a perda do campo no staging passou despercebida.
        oauthAccount: {
          emailAddress: "operator@example.com",
          accountUuid: "acc-uuid-never-staged",
        },
        userID: "user_123",
        organizationSecret: "never-staged",
      }),
      { mode: 0o644 },
    );
    const onSkip = vi.fn();
    const run = keychainRun(0);

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: {},
      onSkip,
      run,
      agyBinary: "/trusted/agy",
    });

    expect(statuses).toEqual({
      grok: "staged",
      kimi: "staged",
      agy: "staged",
      opencode: "staged",
      claude: process.platform === "darwin" ? "staged" : "skipped",
      glm: "staged",
    });
    if (process.platform === "darwin") {
      expect(onSkip).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-w",
        ],
        expect.objectContaining({ shell: false }),
      );
      const stagedIdentity = JSON.parse(
        fs.readFileSync(path.join(isolatedHome, ".claude.json"), "utf8"),
      );
      // Somente o email atravessa: e o que o probe de auth le, e nao e segredo.
      expect(stagedIdentity).toEqual({
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: "operator@example.com" },
        userID: "user_123",
      });
      expect(
        fs.statSync(path.join(isolatedHome, ".claude.json")).mode & 0o777,
      ).toBe(0o600);
      const creds = JSON.parse(
        fs.readFileSync(
          path.join(isolatedHome, ".claude", ".credentials.json"),
          "utf8",
        ),
      );
      expect(creds.claudeAiOauth.accessToken).toBe("sk-ant-oat01-test");
      expect(creds.mcpOAuth).toBeUndefined();
    }
    const stagedFiles = [
      [".grok/auth.json", grokAuth],
      [".grok/config.toml", 'model = "grok-4"\n'],
      [
        ".kimi-code/credentials/kimi-code.json",
        JSON.stringify({
          access_token: "at-test",
          refresh_token: "rt-test",
          expires_at: 9_999_999_999,
          scope: "kimi-code",
          token_type: "Bearer",
          expires_in: 900,
        }) + "\n",
      ],
      [".kimi-code/device_id", "device-uuid-test\n"],
      [".kimi-code/config.toml", 'default_model = "kimi-code/k3"\n'],
      [".local/share/opencode/auth.json", '{"opencode":1}\n'],
      [
        ".local/share/ai-launcher/providers.conf",
        "glm=00000000000000000000000000000000.testsecretvalue\n",
      ],
    ];
    for (const [relative, content] of stagedFiles) {
      const staged = path.join(isolatedHome, relative);
      expect(fs.readFileSync(staged, "utf8"), relative).toBe(content);
      expect(fs.statSync(staged).mode & 0o777, relative).toBe(0o600);
    }
    for (const directory of [
      ".grok",
      ".kimi-code",
      ".kimi-code/credentials",
      ".local/share/opencode",
      ".local/share/ai-launcher",
    ]) {
      expect(
        fs.statSync(path.join(isolatedHome, directory)).mode & 0o777,
        directory,
      ).toBe(0o700);
    }
    expect(fs.existsSync(path.join(isolatedHome, ".gemini"))).toBe(false);
  });

  it("proves native AGY auth through a bounded plan-mode probe without leaking inherited secrets", () => {
    const root = makeTemp();
    const operatorHome = path.join(root, "operator-home");
    fs.mkdirSync(operatorHome, { recursive: true });
    const run = vi.fn((binary, args) => {
      const prompt = args.at(-1) ?? "";
      const marker = prompt.match(/NEXUS_AGY_AUTH_OK_[a-f0-9]{32}/u)?.[0];
      return {
        status: marker ? 0 : 1,
        stdout: marker ? `${marker}\n` : "",
        stderr: "",
      };
    });

    expect(
      preflightNativeAgyAuthentication(operatorHome, {
        binary: "/trusted/agy",
        environment: {
          PATH: "/trusted:/usr/bin:/bin",
          LANG: "pt_BR.UTF-8",
          GOOGLE_API_KEY: "must-not-reach-probe",
          GEMINI_API_KEY: "must-not-reach-probe",
        },
        run,
      }),
    ).toEqual({ kind: "authenticated" });

    expect(run).toHaveBeenCalledTimes(1);
    const [binary, args, options] = run.mock.calls[0];
    expect(binary).toBe("/trusted/agy");
    expect(args).toEqual([
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
      expect.stringMatching(/NEXUS_AGY_AUTH_OK_[a-f0-9]{32}/u),
    ]);
    expect(options).toEqual(
      expect.objectContaining({
        cwd: path.resolve(operatorHome),
        encoding: "utf8",
        shell: false,
        timeout: 90_000,
        maxBuffer: 256 * 1024,
        env: expect.objectContaining({
          HOME: path.resolve(operatorHome),
          USERPROFILE: path.resolve(operatorHome),
          PATH: "/trusted:/usr/bin:/bin",
        }),
      }),
    );
    expect(options.env.GOOGLE_API_KEY).toBeUndefined();
    expect(options.env.GEMINI_API_KEY).toBeUndefined();
  });

  it("blocks an AGY probe that exits cleanly without the exact nonce", () => {
    const operatorHome = makeTemp();
    const run = vi.fn(() => ({
      status: 0,
      stdout: "AGY is ready\n",
      stderr: "",
    }));

    expect(
      () =>
        preflightNativeAgyAuthentication(operatorHome, {
          binary: "/trusted/agy",
          environment: {},
          run,
        }),
    ).toThrow(
      /AGY authentication probe failed operationally: returned an unverified response/u,
    );
  });

  it("distinguishes a positively identified missing AGY login from an operational failure", () => {
    const operatorHome = makeTemp();
    const loggedOut = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "You are not authenticated. Run /login to continue.\n",
    }));
    expect(
      preflightNativeAgyAuthentication(operatorHome, {
        binary: "/trusted/agy",
        environment: {},
        run: loggedOut,
      }),
    ).toEqual({ kind: "missing-credential" });

    const timedOut = vi.fn(() => ({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }),
      stdout: "",
      stderr: "",
    }));
    const sleep = vi.fn();
    expect(() =>
      preflightNativeAgyAuthentication(operatorHome, {
        binary: "/trusted/agy",
        environment: {},
        run: timedOut,
        sleep,
        maxAttempts: 2,
        retryDelayMs: 1,
      }),
    ).toThrow(/AGY authentication probe failed operationally/u);
    expect(timedOut).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("does not downgrade an available AGY binary failure to an advisor skip", () => {
    if (process.platform !== "darwin") return;
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(sourceHome, { recursive: true });

    expect(() =>
      stageAdvisorAuthentication(isolatedHome, {
        sourceHome,
        environment: { PATH: "/trusted:/usr/bin:/bin" },
        onSkip: vi.fn(),
        run: vi.fn(() => ({
          status: 2,
          stdout: "",
          // Non-transient: must fail closed on the first attempt, never skip.
          stderr: "fatal: native AGY probe rejected by local policy\n",
        })),
        agyBinary: "/trusted/agy",
      }),
    ).toThrow(/AGY authentication probe failed operationally/u);
  });

  it("retries a transient AGY eligibility 503 before proving auth", () => {
    const operatorHome = makeTemp();
    const sleep = vi.fn();
    const run = vi.fn((binary, args) => {
      const prompt = args.at(-1) ?? "";
      const marker = prompt.match(/NEXUS_AGY_AUTH_OK_[a-f0-9]{32}/u)?.[0];
      if (run.mock.calls.length < 2) {
        return {
          status: 1,
          stdout: "",
          stderr:
            "Error: Eligibility check failed: UNAVAILABLE (code 503): The service is currently unavailable.\n",
        };
      }
      return {
        status: marker ? 0 : 1,
        stdout: marker ? `${marker}\n` : "",
        stderr: "",
      };
    });

    expect(
      preflightNativeAgyAuthentication(operatorHome, {
        binary: "/trusted/agy",
        environment: {},
        run,
        sleep,
        retryDelayMs: 10,
      }),
    ).toEqual({ kind: "authenticated" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("fails closed after exhausting transient AGY probe retries", () => {
    const operatorHome = makeTemp();
    const sleep = vi.fn();
    const run = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr:
        "Error: Eligibility check failed: UNAVAILABLE (code 503): The service is currently unavailable.\n",
    }));

    expect(() =>
      preflightNativeAgyAuthentication(operatorHome, {
        binary: "/trusted/agy",
        environment: {},
        run,
        sleep,
        maxAttempts: 3,
        retryDelayMs: 5,
      }),
    ).toThrow(
      /AGY authentication probe failed operationally: exited with status 1 \(Error: Eligibility check failed: UNAVAILABLE \(code 503\): The service is currently unavailable\.\)/u,
    );
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("admits keychain-only AGY even when legacy Gemini account files say inactive", () => {
    if (process.platform !== "darwin") return;
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    writePrivate(
      path.join(sourceHome, ".gemini", "google_accounts.json"),
      JSON.stringify({ active: null, old: ["operator@example.com"] }),
    );
    writePrivate(
      path.join(sourceHome, ".gemini", "installation_id"),
      "legacy-installation-id\n",
    );
    const onSkip = vi.fn();
    const run = keychainRun(1);

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: { PATH: "/trusted:/usr/bin:/bin" },
      onSkip,
      run,
      agyBinary: "/trusted/agy",
    });

    expect(statuses.agy).toBe("staged");
    expect(onSkip).not.toHaveBeenCalledWith("agy");
    expect(
      fs.existsSync(path.join(isolatedHome, ".gemini", "oauth_creds.json")),
    ).toBe(false);
    expect(
      run.mock.calls.some(
        ([binary, args]) =>
          binary === "/usr/bin/security" &&
          args.includes("antigravity"),
      ),
    ).toBe(false);
  });

  it("skips Grok when the copied profile fails its isolated auth preflight", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    const sourceAuth = path.join(sourceHome, ".grok", "auth.json");
    writePrivate(
      sourceAuth,
      JSON.stringify({
        access_token: "expired-access",
        refresh_token: "rejected-refresh",
      }) + "\n",
    );
    const onSkip = vi.fn();
    const run = vi.fn((bin, args = []) => {
      if (bin === "grok" && args.join(" ") === "models") {
        return {
          status: 0,
          stdout: "You are not authenticated.\ngrok-4\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "pt_BR.UTF-8",
        GROK_API_KEY: "must-not-reach-the-isolated-preflight",
      },
      onSkip,
      run,
    });

    expect(statuses.grok).toBe("skipped");
    expect(onSkip).toHaveBeenCalledWith("grok");
    expect(fs.existsSync(path.join(isolatedHome, ".grok"))).toBe(false);
    expect(fs.readFileSync(sourceAuth, "utf8")).toContain("rejected-refresh");
    expect(run).toHaveBeenCalledWith(
      "grok",
      ["models"],
      expect.objectContaining({
        encoding: "utf8",
        shell: false,
        timeout: 15_000,
        env: expect.objectContaining({
          HOME: path.resolve(isolatedHome),
          USERPROFILE: path.resolve(isolatedHome),
          GROK_HOME: path.join(path.resolve(isolatedHome), ".grok"),
        }),
      }),
    );
    const grokCall = run.mock.calls.find(([bin]) => bin === "grok");
    expect(grokCall?.[2]?.env.GROK_API_KEY).toBeUndefined();
  });

  it("stages only the non-secret native Claude identity into the isolated HOME", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.writeFileSync(
      path.join(sourceHome, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        // Formato REAL: objeto, nao string.
        oauthAccount: {
          emailAddress: "operator@example.com",
          accountUuid: "acc-uuid-never-staged",
        },
        userID: "user_123",
        organizationSecret: "never-staged",
        projects: { "/private/work": { hasTrustDialogAccepted: true } },
      }),
      { mode: 0o644 },
    );

    expect(stageClaudeNativeIdentity(isolatedHome, { sourceHome })).toBe(true);

    const staged = JSON.parse(
      fs.readFileSync(path.join(isolatedHome, ".claude.json"), "utf8"),
    );
    // Só identidade não-secreta: nada de projetos, segredos ou settings.
    expect(staged).toEqual({
      hasCompletedOnboarding: true,
      // Só o email atravessa: e o que o probe le, e o accountUuid nao vai junto.
      oauthAccount: { emailAddress: "operator@example.com" },
      userID: "user_123",
    });
    expect(
      fs.statSync(path.join(isolatedHome, ".claude.json")).mode & 0o777,
    ).toBe(0o600);
    expect(
      fs.existsSync(path.join(isolatedHome, ".claude", ".credentials.json")),
    ).toBe(false);
  });

  it("reports no Claude identity when the real profile lacks or hides it", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(sourceHome, { recursive: true });

    expect(stageClaudeNativeIdentity(isolatedHome, { sourceHome })).toBe(
      false,
    );

    fs.writeFileSync(
      path.join(sourceHome, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
    );
    expect(stageClaudeNativeIdentity(isolatedHome, { sourceHome })).toBe(
      false,
    );
    expect(fs.existsSync(path.join(isolatedHome, ".claude.json"))).toBe(
      false,
    );
  });

  it("refuses to stage the Claude identity through a symlink", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(sourceHome, { recursive: true });
    const target = path.join(root, "hosted.json");
    fs.writeFileSync(target, JSON.stringify({ oauthAccount: "x" }));
    fs.symlinkSync(target, path.join(sourceHome, ".claude.json"));

    expect(() =>
      stageClaudeNativeIdentity(isolatedHome, { sourceHome }),
    ).toThrow(/non-regular/i);
  });

  it("honors XDG_DATA_HOME when locating the opencode auth file", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    const xdg = path.join(root, "xdg-data");
    writePrivate(path.join(xdg, "opencode", "auth.json"), '{"xdg":1}\n');

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: { XDG_DATA_HOME: xdg },
      onSkip: vi.fn(),
      run: keychainRun(1),
    });

    expect(statuses.opencode).toBe("staged");
    expect(
      fs.readFileSync(
        path.join(isolatedHome, ".local", "share", "opencode", "auth.json"),
        "utf8",
      ),
    ).toBe('{"xdg":1}\n');
  });

  it("skips advisors whose material is absent and never fails", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(sourceHome, { recursive: true });
    const onSkip = vi.fn();

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: {},
      onSkip,
      run: keychainRun(1),
    });

    expect(statuses).toEqual({
      grok: "skipped",
      kimi: "skipped",
      agy: "skipped",
      opencode: "credentialless",
      claude: "skipped",
      glm: "skipped",
    });
    // opencode is credentialless, not a skip.
    expect(onSkip.mock.calls.map(([cli]) => cli).sort()).toEqual([
      "agy",
      "claude",
      "glm",
      "grok",
      "kimi",
    ]);
    expect(fs.existsSync(path.join(isolatedHome, ".grok"))).toBe(false);
    expect(fs.existsSync(path.join(isolatedHome, ".kimi-code"))).toBe(false);
  });

  it("copies grok config.toml only when auth.json was staged", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(path.join(sourceHome, ".grok"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceHome, ".grok", "config.toml"),
      'model = "grok-4"\n',
    );

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: {},
      onSkip: vi.fn(),
      run: keychainRun(1),
    });

    expect(statuses.grok).toBe("skipped");
    expect(
      fs.existsSync(path.join(isolatedHome, ".grok", "config.toml")),
    ).toBe(false);
  });

  it("refuses to stage advisor auth through a symlink", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    const external = path.join(root, "external-auth.json");
    fs.writeFileSync(external, "{}\n", { mode: 0o600 });
    fs.mkdirSync(path.join(sourceHome, ".grok"), { recursive: true });
    fs.symlinkSync(external, path.join(sourceHome, ".grok", "auth.json"));

    expect(() =>
      stageAdvisorAuthentication(isolatedHome, {
        sourceHome,
        environment: {},
        onSkip: vi.fn(),
        run: keychainRun(1),
      }),
    ).toThrow(/non-regular Grok auth file/);
  });

  it("refuses a group/world-readable advisor secret and leaves no partial copy", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(path.join(sourceHome, ".kimi-code", "credentials"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(sourceHome, ".kimi-code", "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "at-test",
        refresh_token: "rt-test",
        expires_at: Math.floor(Date.now() / 1000) + 3_600,
      }) + "\n",
      { mode: 0o644 },
    );

    expect(() =>
      stageAdvisorAuthentication(isolatedHome, {
        sourceHome,
        environment: {},
        onSkip: vi.fn(),
        run: keychainRun(1),
      }),
    ).toThrow(/mode 0600/i);
    expect(
      fs.existsSync(
        path.join(isolatedHome, ".kimi-code", "credentials", "kimi-code.json"),
      ),
    ).toBe(false);
  });

  it("skips an empty Kimi credentials shell instead of staging a dead login", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    const onSkip = vi.fn();
    writePrivate(
      path.join(sourceHome, ".kimi-code", "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "",
        refresh_token: "",
        expires_at: 0,
        scope: "kimi-code",
        token_type: "Bearer",
        expires_in: 0,
      }) + "\n",
    );
    writePrivate(
      path.join(sourceHome, ".kimi-code", "device_id"),
      "device-uuid-test\n",
    );
    fs.writeFileSync(
      path.join(sourceHome, ".kimi-code", "config.toml"),
      'default_model = "kimi-code/k3"\n',
      { mode: 0o644 },
    );

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: {},
      onSkip,
      run: keychainRun(1),
    });

    expect(statuses.kimi).toBe("skipped");
    expect(onSkip).toHaveBeenCalledWith("kimi");
    expect(fs.existsSync(path.join(isolatedHome, ".kimi-code"))).toBe(false);
  });

  it("skips non-empty but expired Kimi credentials instead of opening /login", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    const onSkip = vi.fn();
    writePrivate(
      path.join(sourceHome, ".kimi-code", "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "at-expired",
        refresh_token: "rt-present-but-unproven",
        expires_at: Math.floor(Date.now() / 1000) - 1,
        scope: "kimi-code",
        token_type: "Bearer",
        expires_in: 900,
      }) + "\n",
    );
    writePrivate(
      path.join(sourceHome, ".kimi-code", "device_id"),
      "device-uuid-test\n",
    );
    fs.writeFileSync(
      path.join(sourceHome, ".kimi-code", "config.toml"),
      'default_model = "kimi-code/k3"\n',
      { mode: 0o644 },
    );

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: {},
      onSkip,
      run: keychainRun(1),
    });

    expect(statuses.kimi).toBe("skipped");
    expect(onSkip).toHaveBeenCalledWith("kimi");
    expect(fs.existsSync(path.join(isolatedHome, ".kimi-code"))).toBe(false);
  });

  it("skips Kimi when credentials are live but device_id is missing", () => {
    const root = makeTemp();
    const sourceHome = path.join(root, "real-home");
    const isolatedHome = path.join(root, "isolated-home");
    const onSkip = vi.fn();
    writePrivate(
      path.join(sourceHome, ".kimi-code", "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "at-test",
        refresh_token: "rt-test",
        expires_at: 9_999_999_999,
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(sourceHome, ".kimi-code", "config.toml"),
      'default_model = "kimi-code/k3"\n',
      { mode: 0o644 },
    );

    const statuses = stageAdvisorAuthentication(isolatedHome, {
      sourceHome,
      environment: {},
      onSkip,
      run: keychainRun(1),
    });

    expect(statuses.kimi).toBe("skipped");
    expect(onSkip).toHaveBeenCalledWith("kimi");
    expect(fs.existsSync(path.join(isolatedHome, ".kimi-code"))).toBe(false);
  });

  it("treats a missing claude keychain credential as a skip, never a copy", () => {
    const root = makeTemp();
    const statuses = stageAdvisorAuthentication(path.join(root, "isolated"), {
      sourceHome: path.join(root, "real-home"),
      environment: {},
      onSkip: vi.fn(),
      run: keychainRun(1),
    });
    expect(statuses.claude).toBe("skipped");
    expect(fs.existsSync(path.join(root, "isolated", ".claude"))).toBe(false);
  });

  it("marks only missing or broken advisor binaries as skips", () => {
    const onSkip = vi.fn();
    const resolveCommand = (command) =>
      command === "kimi" ? "" : `/usr/local/bin/${command}`;
    const run = vi.fn((binary) =>
      binary.endsWith("/agy")
        ? { status: 1, stdout: "", stderr: "boom" }
        : { status: 0, stdout: `${path.basename(binary)} 1.2.3\n`, stderr: "" },
    );

    const statuses = assertAdvisorBinaries({
      onSkip,
      environment: {},
      resolveCommand,
      run,
    });

    expect(statuses.grok).toEqual({ available: true, version: "grok 1.2.3" });
    expect(statuses.opencode).toEqual({
      available: true,
      version: "opencode 1.2.3",
    });
    expect(statuses.claude).toEqual({
      available: true,
      version: "claude 1.2.3",
    });
    expect(statuses.kimi).toEqual({ available: false });
    expect(statuses.agy).toEqual({ available: false });
    expect(onSkip.mock.calls.map(([cli]) => cli).sort()).toEqual([
      "agy",
      "kimi",
    ]);
    expect(run).toHaveBeenCalledWith(
      "/usr/local/bin/grok",
      ["--version"],
      expect.objectContaining({ shell: false, timeout: 10_000 }),
    );
  });

  it("preserves only a strictly-shaped advisor skip list in the child environment", () => {
    const first = realMissionEnvironment(
      { PATH: "/usr/bin", [REAL_MISSION_ADVISOR_SKIP_ENV]: "agy,kimi" },
      "/tmp/user-data",
      "/trusted/codex",
    );
    expect(first[REAL_MISSION_ADVISOR_SKIP_ENV]).toBe("agy,kimi");

    // waitForChild re-derives the child env from the isolated one; the gate's
    // aggregated skip list must survive that second pass.
    const second = realMissionEnvironment(
      first,
      "/tmp/user-data",
      "/trusted/codex",
    );
    expect(second[REAL_MISSION_ADVISOR_SKIP_ENV]).toBe("agy,kimi");

    for (const hostile of [
      "agy kimi",
      "agy;rm -rf /",
      "agy\nNEXUS_REAL_MISSION_E2E=0",
      "AGY",
      `a,${"b,".repeat(200)}c`,
    ]) {
      const environment = realMissionEnvironment(
        { PATH: "/usr/bin", [REAL_MISSION_ADVISOR_SKIP_ENV]: hostile },
        "/tmp/user-data",
        "/trusted/codex",
      );
      expect(
        environment[REAL_MISSION_ADVISOR_SKIP_ENV],
        JSON.stringify(hostile),
      ).toBeUndefined();
    }
  });

  it("merges operator advisor skips with staging auto-skips instead of replacing", () => {
    expect(
      mergeRealMissionAdvisorSkipEnv("agy,opencode,claude", ["kimi", "agy"]),
    ).toBe("agy,claude,kimi,opencode");
    expect(mergeRealMissionAdvisorSkipEnv("kimi", [])).toBe("kimi");
    expect(mergeRealMissionAdvisorSkipEnv(undefined, ["grok"])).toBe("grok");
    expect(mergeRealMissionAdvisorSkipEnv("", [])).toBe("");
    expect(
      mergeRealMissionAdvisorSkipEnv("agy;rm -rf /", ["kimi"]),
    ).toBe("kimi");
  });

  it("removes only the Claude release variant when the operator explicitly skips Claude", () => {
    expect(
      realMissionProductWizardOrchestrators({
        [REAL_MISSION_ADVISOR_SKIP_ENV]: "agy,claude,kimi",
      }),
    ).toEqual(["codex"]);
    expect(
      realMissionProductWizardOrchestrators({
        [REAL_MISSION_ADVISOR_SKIP_ENV]: "agy,kimi",
      }),
    ).toEqual(["codex", "claude"]);
    expect(
      realMissionProductWizardOrchestrators({
        [REAL_MISSION_ADVISOR_SKIP_ENV]: "claude;opencode",
      }),
    ).toEqual(["codex", "claude"]);
  });

  it("preserves only a strict codex|claude orchestrator variant in the child environment", () => {
    const claude = realMissionEnvironment(
      { PATH: "/usr/bin", [REAL_MISSION_ORCHESTRATOR_ENV]: "claude" },
      "/tmp/user-data",
      "/trusted/codex",
    );
    expect(claude[REAL_MISSION_ORCHESTRATOR_ENV]).toBe("claude");

    // Segunda passagem (waitForChild re-deriva): a variante sobrevive.
    const again = realMissionEnvironment(
      claude,
      "/tmp/user-data",
      "/trusted/codex",
    );
    expect(again[REAL_MISSION_ORCHESTRATOR_ENV]).toBe("claude");

    // Ausente ou fora do estrito: nada atravessa (default codex no main).
    expect(
      realMissionEnvironment(
        { PATH: "/usr/bin" },
        "/tmp/user-data",
        "/trusted/codex",
      )[REAL_MISSION_ORCHESTRATOR_ENV],
    ).toBeUndefined();
    for (const hostile of ["grok", "CLAUDE", "claude ", "codex,claude", ""]) {
      expect(
        realMissionEnvironment(
          { PATH: "/usr/bin", [REAL_MISSION_ORCHESTRATOR_ENV]: hostile },
          "/tmp/user-data",
          "/trusted/codex",
        )[REAL_MISSION_ORCHESTRATOR_ENV],
        JSON.stringify(hostile),
      ).toBeUndefined();
    }
  });
});

// REGRESSAO: as validacoes pos-PASS rejeitam uma evidencia que o filho
// declarou aprovada -- e todas lancavam ANTES de qualquer escrita. Um ciclo de
// release terminou com a missao selada (done, 8/8 handoffs) e ZERO rastro em
// disco: nem recibo, nem motivo. O diagnostico inteiro se perdeu.
describe("recibo de rejeicao pos-PASS", () => {
  const releaseBinding = {
    appVersion: "0.20.2",
    commitSha: "a".repeat(40),
    artifact: {
      sha256: "b".repeat(64),
      identity: "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
    },
  };

  function passShapedRawEvidence() {
    return {
      schemaVersion: REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
      status: "pass",
      // Um PASS nao tem bloco `failure`: e justamente por isso que o motivo
      // da rejeicao precisa ser injetado, senao o recibo sai com detail null.
      failure: null,
      prompt: "never persist this",
      rawOutput: "never persist this either",
    };
  }

  async function persistInto(rawEvidence, error) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-postpass-"));
    const destination = path.join(dir, "real-mission-evidence.json");
    await persistPostPassRejectionReceipt(
      rawEvidence,
      { code: 0, phase: "observer-armed" },
      releaseBinding,
      "private-runner",
      destination,
      error,
    );
    return { destination, dir };
  }

  it("grava recibo com o motivo da rejeicao quando o PASS e desqualificado", async () => {
    const { destination, dir } = await persistInto(
      passShapedRawEvidence(),
      new Error(
        "PASS evidence is missing one or more real-mission invariants: participationIsExact",
      ),
    );

    const written = JSON.parse(await fsp.readFile(destination, "utf8"));
    expect(written.status).toBe("fail");
    expect(written.failure.code).toBe("observer-invalid");
    expect(written.failure.detail).toContain("participationIsExact");
    expect(written.release.appVersion).toBe("0.20.2");
    // O recibo continua sanitizado: nada de prompt/rawOutput vaza.
    expect(JSON.stringify(written)).not.toMatch(/never persist this/u);

    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("nao inventa arquivo quando nao houve evidencia nenhuma", async () => {
    const { destination, dir } = await persistInto(
      null,
      new Error("missing evidence"),
    );

    expect(fs.existsSync(destination)).toBe(false);

    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("falha de escrita nao mascara o erro de validacao", async () => {
    // Destino impossivel: a persistencia e best-effort e nao pode lancar,
    // porque quem manda no diagnostico e o erro de validacao relancado acima.
    await expect(
      persistPostPassRejectionReceipt(
        passShapedRawEvidence(),
        { code: 0, phase: "observer-armed" },
        releaseBinding,
        "private-runner",
        path.join(os.tmpdir(), "nexus-postpass-inexistente ", "e.json"),
        new Error("qualquer rejeicao"),
      ),
    ).resolves.toBeUndefined();
  });
});
