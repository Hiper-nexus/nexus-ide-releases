import { describe, expect, it } from "vitest";

import {
  REAL_MISSION_E2E_CTA,
  parseRealMissionE2EEvidence,
} from "./real-mission-e2e";
import { sha, validPassEvidence } from "./real-mission-e2e-test-support";

describe("real mission E2E PASS graph", () => {
  it("parses a complete PASS receipt", () => {
    expect(parseRealMissionE2EEvidence(validPassEvidence()).status).toBe(
      "pass",
    );
  });

  it("cannot label the synthetic zero-findings council as review coverage", () => {
    const misleading = validPassEvidence();
    misleading.reviewOrigin = "e2e-merge-review-fixture";

    expect(() => parseRealMissionE2EEvidence(misleading)).toThrow();
  });

  it("rejects the obsolete schema v7 receipt", () => {
    const legacy = validPassEvidence();
    legacy.schemaVersion = 7;
    expect(() => parseRealMissionE2EEvidence(legacy)).toThrow();
  });

  it("rejects the obsolete schema v8 receipt", () => {
    const legacy = validPassEvidence();
    legacy.schemaVersion = 8;
    expect(() => parseRealMissionE2EEvidence(legacy)).toThrow();
  });

  it("rejects green evidence without route, handoff, or integration proof", () => {
    const evidence = validPassEvidence();
    evidence.dispatches = [];
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires the exact fan-out roots and sequential review chain", () => {
    const missingQa = validPassEvidence();
    (missingQa.dispatches as unknown[]).pop();
    (missingQa.handoffs as unknown[]).pop();
    (missingQa.panes as unknown[]).pop();
    expect(() => parseRealMissionE2EEvidence(missingQa)).toThrow(
      /real-mission invariants/,
    );

    const serializedRoot = validPassEvidence();
    const serializedDispatches = serializedRoot.dispatches as Array<
      Record<string, unknown>
    >;
    const executor = serializedDispatches.find(
      (dispatch) => dispatch.plannerId === "guided-execution",
    )!;
    const advisory = serializedDispatches.find(
      (dispatch) =>
        typeof dispatch.plannerId === "string" &&
        dispatch.plannerId.startsWith("guided-advisory-"),
    )!;
    executor.dependsOn = [advisory.taskId];
    expect(() => parseRealMissionE2EEvidence(serializedRoot)).toThrow(
      /real-mission invariants/,
    );

    const detachedReview = validPassEvidence();
    const detachedDispatches = detachedReview.dispatches as Array<
      Record<string, unknown>
    >;
    detachedDispatches.find(
      (dispatch) =>
        dispatch.plannerId === "guided-review-1-e2e-reviewer",
    )!.dependsOn = [];
    expect(() => parseRealMissionE2EEvidence(detachedReview)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects durable rows that never came from a physical worker PTY", () => {
    const evidence = validPassEvidence();
    const worker = (evidence.panes as Array<Record<string, unknown>>)[1];
    worker.ptySpawnedAt = null;
    worker.ptyDataAt = null;
    worker.ptyChunkSha256 = null;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
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
    ] as const;

    for (const [paneIndex, field, value] of mutations) {
      const evidence = validPassEvidence();
      const pane = (evidence.panes as Array<Record<string, unknown>>)[
        paneIndex
      ]!;
      pane[field] = value;
      expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
        /real-mission invariants/,
      );
    }
  });

  it("rejects a durable handoff omitted from the projected proof set", () => {
    const evidence = validPassEvidence();
    const durableHandoffs = evidence.durableHandoffs as {
      count: number;
      ids: string[];
    };
    durableHandoffs.count = 4;
    durableHandoffs.ids.push("handoff-orphan");

    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects an observed physical PTY omitted from the pane proof set", () => {
    const evidence = validPassEvidence();
    const physicalPty = evidence.physicalPty as {
      count: number;
      ids: string[];
    };
    physicalPty.count = 5;
    physicalPty.ids.push("session-orphan-retry");

    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects direct store rows without the exact MCP provenance receipt", () => {
    const evidence = validPassEvidence();
    (evidence.handoffs as Array<Record<string, unknown>>)[0].physicalReceipt =
      null;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );

    const afterIntegration = validPassEvidence();
    const provenance = (
      afterIntegration.handoffs as Array<Record<string, unknown>>
    )[0].physicalReceipt as Record<string, unknown>;
    provenance.issuedAt = 31;
    expect(() => parseRealMissionE2EEvidence(afterIntegration)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires the exact correlated HTTP audit intent for each physical receipt", () => {
    const missingAudit = validPassEvidence();
    (missingAudit.handoffs as Array<Record<string, unknown>>)[0].auditIntent =
      null;
    expect(() => parseRealMissionE2EEvidence(missingAudit)).toThrow(
      /real-mission invariants/,
    );

    const wrongInvocation = validPassEvidence();
    const audit = (wrongInvocation.handoffs as Array<Record<string, unknown>>)[0]
      .auditIntent as Record<string, unknown>;
    audit.invocationId = "another-tool-call";
    expect(() => parseRealMissionE2EEvidence(wrongInvocation)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires consumed delivery bound to the one exact accepted attempt", () => {
    const acknowledgedOnly = validPassEvidence();
    (acknowledgedOnly.handoffs as Array<Record<string, unknown>>)[0]
      .deliveryState = "acknowledged";
    expect(() => parseRealMissionE2EEvidence(acknowledgedOnly)).toThrow(
      /real-mission invariants/,
    );

    const wrongAttempt = validPassEvidence();
    (wrongAttempt.handoffs as Array<Record<string, unknown>>)[0]
      .consumedDeliveryAttemptId = "attempt-forged";
    expect(() => parseRealMissionE2EEvidence(wrongAttempt)).toThrow(
      /real-mission invariants/,
    );

    const duplicateAccepted = validPassEvidence();
    const handoff = (
      duplicateAccepted.handoffs as Array<Record<string, unknown>>
    )[0];
    const attempts = handoff.deliveryAttempts as Array<Record<string, unknown>>;
    attempts.push({
      ...attempts[0],
      id: "attempt-executor-duplicate",
      attemptNo: 2,
    });
    expect(() => parseRealMissionE2EEvidence(duplicateAccepted)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires reviewer consumption of the exact executor dependency receipt", () => {
    const missing = validPassEvidence();
    missing.dependencyConsumptions = [];
    expect(() => parseRealMissionE2EEvidence(missing)).toThrow(
      /real-mission invariants/,
    );

    const wrongHash = validPassEvidence();
    (
      wrongHash.dependencyConsumptions as Array<Record<string, unknown>>
    )[0].handoffSummarySha256 = sha("forged-summary");
    expect(() => parseRealMissionE2EEvidence(wrongHash)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires the exact main-owned Mission Driver PREVC completion proof", () => {
    const missing = validPassEvidence();
    missing.completion = null;
    expect(() => parseRealMissionE2EEvidence(missing)).toThrow(
      /real-mission invariants/,
    );

    const forged = validPassEvidence();
    const forgedWorkflow = (forged.completion as Record<string, unknown>)
      .workflow as Record<string, unknown>;
    const forgedBinding = forgedWorkflow.binding as Record<string, unknown>;
    forgedBinding.contractHash = sha("forged-contract");
    expect(() => parseRealMissionE2EEvidence(forged)).toThrow(
      /real-mission invariants/,
    );

    const legacy = validPassEvidence();
    legacy.completion = {
      origin: "main-verified-task-plan",
      marker: "legacy text marker",
    };
    expect(() => parseRealMissionE2EEvidence(legacy)).toThrow();

    const failedDriver = validPassEvidence();
    const driver = (
      failedDriver.completion as {
        driver: Record<string, unknown>;
      }
    ).driver;
    driver.lastOutcome = "failed";
    expect(() => parseRealMissionE2EEvidence(failedDriver)).toThrow();

    const missingReceipt = validPassEvidence();
    (
      missingReceipt.completion as {
        stepReceipts: unknown[];
      }
    ).stepReceipts.pop();
    expect(() => parseRealMissionE2EEvidence(missingReceipt)).toThrow(
      /real-mission invariants/,
    );
  });

});

describe("real mission E2E v9 advisor participation", () => {
  it("requires the participation array in the strict envelope", () => {
    const evidence = validPassEvidence();
    delete evidence.participation;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow();
  });

  it("requires every credentialed advisor to prove PTY, nexus_* tool and handoff", () => {
    const missing = validPassEvidence();
    (missing.participation as Array<Record<string, unknown>>)[1]!.handoffAt =
      null;
    expect(() => parseRealMissionE2EEvidence(missing)).toThrow(
      /real-mission invariants/,
    );

    const forged = validPassEvidence();
    (forged.participation as Array<Record<string, unknown>>)[0]!.handoffAt =
      999;
    expect(() => parseRealMissionE2EEvidence(forged)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects a mislabeled confinement tier or an out-of-order roster", () => {
    const wrongTier = validPassEvidence();
    (wrongTier.participation as Array<Record<string, unknown>>)[1]!.tier =
      "mechanically-confined";
    expect(() => parseRealMissionE2EEvidence(wrongTier)).toThrow(
      /canonical harness roster/,
    );

    const reordered = validPassEvidence();
    const rows = reordered.participation as Array<Record<string, unknown>>;
    [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    expect(() => parseRealMissionE2EEvidence(reordered)).toThrow(
      /canonical harness roster/,
    );
  });

  it("passes with env-skipped advisors inside and outside the fan-out groups", () => {
    expect(() =>
      parseRealMissionE2EEvidence(
        validPassEvidence("private-runner", {
          skipAdvisorClis: ["kimi", "opencode"],
        }),
      ),
    ).not.toThrow();

    // Sem nenhuma advisor credenciada a cadeia codex v8 continua exata.
    const codexOnly = validPassEvidence("private-runner", {
      skipAdvisorClis: [
        "grok",
        "kimi",
        "agy",
        "opencode",
        "claude",
        "glm",
      ],
    });
    const parsed = parseRealMissionE2EEvidence(codexOnly);
    expect(parsed.status).toBe("pass");
    expect(parsed.plan?.tasks).toHaveLength(3);
    expect(parsed.dispatches).toHaveLength(3);
    expect(parsed.handoffs).toHaveLength(3);
    expect(parsed.dependencyConsumptions).toHaveLength(2);
    expect(
      parsed.participation.every((row) => row.skipped === "no-credential"),
    ).toBe(true);
  });

  it("rejects PASS evidence whose skipped advisor still executed", () => {
    const evidence = validPassEvidence("private-runner", {
      skipAdvisorClis: ["kimi"],
    });
    const rows = evidence.participation as Array<Record<string, unknown>>;
    rows[1]!.spawnedAt = 100;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /canonical harness roster|real-mission invariants/,
    );
  });

  it("accepts advisor-absent as a closed failure code", () => {
    const evidence = validPassEvidence();
    evidence.status = "fail";
    evidence.failure = {
      code: "advisor-absent",
      reason: null,
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: "done",
        paneCount: 4,
        dispatchCount: 9,
        handoffCount: 8,
      },
    };
    expect(parseRealMissionE2EEvidence(evidence).failure?.code).toBe(
      "advisor-absent",
    );
  });

  it("closes product-wizard FAIL evidence without the causal wizard receipt", () => {
    // O wizard nunca executou (timeout/setup): o FAIL fecha com receipt nulo
    // em vez de derrubar o processo com ZodError no attester.
    const evidence = validPassEvidence("product-wizard");
    evidence.status = "fail";
    evidence.wizardCoverage = "not-covered";
    evidence.wizardReceipt = null;
    evidence.failure = {
      code: "timeout",
      reason: null,
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: null,
        paneCount: 0,
        dispatchCount: 0,
        handoffCount: 0,
      },
    };
    const parsed = parseRealMissionE2EEvidence(evidence);
    expect(parsed.status).toBe("fail");
    expect(parsed.failure?.code).toBe("timeout");

    // No PASS, a cadeia causal continua obrigatória.
    const forgedPass = validPassEvidence("product-wizard");
    forgedPass.wizardCoverage = "not-covered";
    forgedPass.wizardReceipt = null;
    expect(() => parseRealMissionE2EEvidence(forgedPass)).toThrow(
      /causal main-owned receipt|real-mission invariants/i,
    );
  });
});

describe("real mission E2E v9 claude orchestrator variant", () => {
  it("parses the claude-orchestrator PASS evidence with the reserved advisor", () => {
    const parsed = parseRealMissionE2EEvidence(
      validPassEvidence("private-runner", { orchestratorCli: "claude" }),
    );

    expect(parsed.status).toBe("pass");
    // Sem advisor Claude: 4 scouts + executor + revisor + grok + QA.
    expect(parsed.plan?.tasks).toHaveLength(8);
    expect(parsed.dispatches).toHaveLength(8);
    expect(parsed.handoffs).toHaveLength(8);
    expect(parsed.dependencyConsumptions).toHaveLength(3);
    expect(
      parsed.participation.find((row) => row.cli === "claude")?.skipped,
    ).toBe("orchestrator-reserved");
    expect(parsed.completion?.milestones).toHaveLength(10);
    const orchestrator = parsed.panes.find(
      (pane) => pane.role === "orchestrator",
    );
    expect(orchestrator?.adapterId).toBe("claude");
  });

  it("rejects a claude orchestrator whose advisor was not reserved", () => {
    const evidence = validPassEvidence("private-runner", {
      orchestratorCli: "claude",
    });
    (evidence.participation as Array<Record<string, unknown>>).find(
      (row) => row.cli === "claude",
    )!.skipped = "no-credential";
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects a codex orchestrator carrying the orchestrator-reserved mark", () => {
    const evidence = validPassEvidence("private-runner", {
      skipAdvisorClis: ["claude"],
    });
    (evidence.participation as Array<Record<string, unknown>>).find(
      (row) => row.cli === "claude",
    )!.skipped = "orchestrator-reserved";
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects the codex criteria list on the claude variant run", () => {
    const evidence = validPassEvidence("private-runner", {
      orchestratorCli: "claude",
    });
    // Remove o critério extra da variante: a missão selada tinha 10 marcos.
    const completion = evidence.completion as {
      milestones: unknown[];
      stepReceipts: unknown[];
    };
    completion.milestones.pop();
    completion.stepReceipts.pop();
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });
});
