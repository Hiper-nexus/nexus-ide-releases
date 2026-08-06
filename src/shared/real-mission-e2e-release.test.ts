import { describe, expect, it } from "vitest";

import {
  REAL_MISSION_E2E_CTA,
  parseRealMissionE2EEvidence,
  parseReleaseEligibleRealMissionE2EEvidence,
} from "./real-mission-e2e";
import { sha, validPassEvidence } from "./real-mission-e2e-test-support";

describe("real mission E2E release eligibility and adversarial receipts", () => {
  it("requires the single approval receipt to precede dispatch and kickoff", () => {
    const missingApproval = validPassEvidence();
    (missingApproval.mission as Record<string, unknown>).approvedAt = null;
    expect(() => parseRealMissionE2EEvidence(missingApproval)).toThrow(
      /real-mission invariants/,
    );

    const reversed = validPassEvidence();
    (reversed.mission as Record<string, unknown>).approvedAt = 12;
    expect(() => parseRealMissionE2EEvidence(reversed)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires ZERO native dialogs and zero Codex MCP prompts (promptless contract)", () => {
    const duplicateDialog = validPassEvidence();
    (
      duplicateDialog.interaction as Record<string, unknown>
    ).nativeDialogCount = 2;
    expect(() => parseRealMissionE2EEvidence(duplicateDialog)).toThrow(
      /real-mission invariants/,
    );

    const providerPrompt = validPassEvidence();
    (
      providerPrompt.interaction as Record<string, unknown>
    ).codexMcpPromptCount = 1;
    expect(() => parseRealMissionE2EEvidence(providerPrompt)).toThrow(
      /real-mission invariants/,
    );
  });

  it("keeps private runner evidence diagnostic-only for release", () => {
    const privateEvidence = validPassEvidence();
    expect(() =>
      parseReleaseEligibleRealMissionE2EEvidence(privateEvidence),
    ).toThrow(/physical product wizard/i);

    const productEvidence = validPassEvidence("product-wizard");
    expect(() =>
      parseReleaseEligibleRealMissionE2EEvidence(productEvidence),
    ).not.toThrow();

    const flagOnly = structuredClone(productEvidence);
    flagOnly.wizardCoverage = "not-covered";
    expect(() =>
      parseReleaseEligibleRealMissionE2EEvidence(flagOnly),
    ).toThrow(/real-mission invariants|physical product wizard/i);
  });

  it("binds product-wizard coverage to the exact main-owned causal receipt", () => {
    const missing = validPassEvidence("product-wizard");
    missing.wizardReceipt = null;
    expect(() => parseRealMissionE2EEvidence(missing)).toThrow(
      /causal main-owned receipt|real-mission invariants/i,
    );

    for (const [field, value] of [
      ["missionId", "other-mission"],
      ["workspaceSha256", sha("other-workspace")],
      ["squadRevisionHash", sha("other-squad")],
      ["submittedContractSha256", sha("other-submitted-contract")],
    ] as const) {
      const tampered = validPassEvidence("product-wizard");
      (tampered.wizardReceipt as Record<string, unknown>)[field] = value;
      expect(
        () => parseRealMissionE2EEvidence(tampered),
        `tampered receipt field ${field}`,
      ).toThrow();
    }

    const reversed = validPassEvidence("product-wizard");
    const reversedReceipt = reversed.wizardReceipt as Record<string, unknown>;
    reversedReceipt.nativeDialogOpenedAt = 12;
    reversedReceipt.nativeDialogAcceptedAt = 10;
    expect(() => parseRealMissionE2EEvidence(reversed)).toThrow();

    const privateWithReceipt = validPassEvidence();
    privateWithReceipt.wizardReceipt = validPassEvidence(
      "product-wizard",
    ).wizardReceipt;
    expect(() => parseRealMissionE2EEvidence(privateWithReceipt)).toThrow(
      /private runner cannot carry a product-wizard receipt/i,
    );
  });

  it("requires a main-owned exact single-mission inventory", () => {
    const evidence = validPassEvidence();
    const inventory = evidence.missionInventory as Record<string, unknown>;
    inventory.observedMissionCount = 2;
    inventory.observedMissionIds = ["mission-e2e", "mission-extra"];
    inventory.exactSingleProductMission = false;

    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/i,
    );
  });

  it("rejects QA completion without the physical no-change receipt evidence", () => {
    const evidence = validPassEvidence();
    const qa = (evidence.dispatches as Array<Record<string, unknown>>).find(
      (dispatch) => dispatch.plannerId === "guided-quality-gate",
    )!;
    const receipt = qa.integrationReceipt as Record<string, unknown>;
    receipt.evidenceIds = [];
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow();

    const wrongHead = validPassEvidence();
    const qaReceipt = (
      (wrongHead.dispatches as Array<Record<string, unknown>>).find(
        (dispatch) => dispatch.plannerId === "guided-quality-gate",
      )!.integrationReceipt as Record<string, unknown>
    );
    qaReceipt.reference = `no-change:${"d".repeat(40)}:${sha("qa-clean-diff")}`;
    expect(() => parseRealMissionE2EEvidence(wrongHead)).toThrow(
      /real-mission invariants/,
    );
  });

  it("never permits this harness to claim full-flow coverage", () => {
    const evidence = validPassEvidence();
    evidence.coverageTier = "full-flow";
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /cannot claim full-flow/i,
    );
  });

  it("rejects a stale-session handoff acceptance and a non-exact commit", () => {
    const staleAcceptance = validPassEvidence();
    (
      staleAcceptance.handoffs as Array<Record<string, unknown>>
    )[0].consumedBySessionId = "stale-orchestrator-session";
    expect(() => parseRealMissionE2EEvidence(staleAcceptance)).toThrow(
      /real-mission invariants/,
    );

    const extraCommit = validPassEvidence();
    (extraCommit.repository as Record<string, unknown>).commitCount = 3;
    (extraCommit.repository as Record<string, unknown>).exactSingleCommit =
      false;
    expect(() => parseRealMissionE2EEvidence(extraCommit)).toThrow(
      /real-mission invariants/,
    );
  });

  it("accepts a merge-commit integration (3 commits) when the exact-result invariant holds", () => {
    // The engine may integrate as fast-forward (2 commits) or as a real merge
    // commit (initial + worker result + merge = 3). Either is a PASS as long
    // as exactSingleCommit proved HEAD descends from the initial commit and
    // only resultado.txt changed.
    const mergeCommit = validPassEvidence();
    (mergeCommit.repository as Record<string, unknown>).commitCount = 3;
    expect(() => parseRealMissionE2EEvidence(mergeCommit)).not.toThrow();

    const tooMany = validPassEvidence();
    (tooMany.repository as Record<string, unknown>).commitCount = 4;
    expect(() => parseRealMissionE2EEvidence(tooMany)).toThrow(
      /real-mission invariants/,
    );
  });

  it("keeps failures closed and actionable without raw output fields", () => {
    const evidence = validPassEvidence();
    evidence.status = "fail";
    const failure = {
      code: "timeout",
      reason: "boot_timeout",
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: "running",
        paneCount: 1,
        dispatchCount: 0,
        handoffCount: 0,
      },
    };
    evidence.failure = failure;
    expect(parseRealMissionE2EEvidence(evidence).status).toBe("fail");
    expect(() =>
      parseRealMissionE2EEvidence({
        ...evidence,
        failure: {
          ...failure,
          reason: "prompt=private-provider-output",
        },
      }),
    ).toThrow();
    expect(() =>
      parseRealMissionE2EEvidence({
        ...evidence,
        rawOutput: "must never be persisted",
      }),
    ).toThrow();
  });
});
