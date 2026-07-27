import { describe, expect, it } from "vitest";

import { parseRealMissionE2EEvidence } from "./real-mission-e2e";
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

  it("rejects the obsolete schema v6 receipt", () => {
    const legacy = validPassEvidence();
    legacy.schemaVersion = 6;
    expect(() => parseRealMissionE2EEvidence(legacy)).toThrow();
  });

  it("rejects green evidence without route, handoff, or integration proof", () => {
    const evidence = validPassEvidence();
    evidence.dispatches = [];
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires all three sequential production-guided worker waves", () => {
    const missingQa = validPassEvidence();
    (missingQa.dispatches as unknown[]).pop();
    (missingQa.handoffs as unknown[]).pop();
    (missingQa.panes as unknown[]).pop();
    expect(() => parseRealMissionE2EEvidence(missingQa)).toThrow(
      /real-mission invariants/,
    );

    const parallelQa = validPassEvidence();
    const dispatches = parallelQa.dispatches as Array<Record<string, unknown>>;
    dispatches[1]!.dependsOn = [];
    expect(() => parseRealMissionE2EEvidence(parallelQa)).toThrow(
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
