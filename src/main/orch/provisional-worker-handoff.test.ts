import { describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/orch-types";
import { isProvisionalWorkerHandoff } from "./provisional-worker-handoff";

const diagnostic: Handoff = {
  id: "diagnostic",
  status: "blocked",
  summary: "Nenhum handoff foi observado.",
  fromAgent: "nexus-handoff-enforcement",
  authorityOrigin: "agent",
  claimTrust: "untrusted",
  evidenceTrust: "unverified",
  evidenceIds: [],
  artifacts: [],
  delivered: false,
  deliveryState: "queued",
  createdAt: 1,
};

describe("provisional worker handoff policy", () => {
  it.each([
    ["enforcement block", {}, true],
    [
      "watchdog failure",
      { fromAgent: "nexus-watchdog", status: "failed" },
      true,
    ],
    ["worker block", { fromAgent: "Worker" }, false],
    ["another diagnostic author", { fromAgent: "nexus-other" }, false],
    ["operator confirmation", { authorityOrigin: "operator-confirmed" }, false],
    ["success", { status: "success" }, false],
    [
      "physical receipt",
      { mcpProvenance: {} as Handoff["mcpProvenance"] },
      false,
    ],
  ] as const)("%s", (_label, overrides, provisional) => {
    expect(isProvisionalWorkerHandoff({ ...diagnostic, ...overrides })).toBe(
      provisional,
    );
  });
});
