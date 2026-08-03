import { describe, expect, it } from "vitest";
import {
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
  GUIDED_TASK_DOMAINS,
  parseGuidedTaskKind,
} from "./guided-task-kind";

describe("GuidedTaskKind authority parser", () => {
  it.each([
    {
      kind: "advisory",
      plannerId: "guided-advisory-1",
      agentCategory: "architect",
      executionMode: "read_only",
      domain: GUIDED_TASK_DOMAINS.advisory,
    },
    {
      kind: "independent-review",
      plannerId: "guided-review-1",
      agentCategory: "reviewer",
      executionMode: "read_only",
      domain: GUIDED_TASK_DOMAINS.independentReview,
    },
    {
      kind: "isolated-advisory",
      plannerId: "guided-advisory-opencode",
      agentCategory: "scout",
      executionMode: "isolated_worktree",
      domain: GUIDED_TASK_DOMAINS.isolatedAdvisory,
    },
    {
      kind: "implementation",
      plannerId: GUIDED_MISSION_PLANNER_TASK_ID,
      agentCategory: "executor",
      executionMode: "isolated_worktree",
      domain: GUIDED_TASK_DOMAINS.implementation,
    },
    {
      kind: "quality-gate",
      plannerId: GUIDED_MISSION_QA_TASK_ID,
      agentCategory: "reviewer",
      executionMode: "isolated_worktree",
      domain: GUIDED_TASK_DOMAINS.qualityGate,
    },
    {
      kind: "quality-gate",
      plannerId: GUIDED_MISSION_QA_TASK_ID,
      agentCategory: "reviewer",
      executionMode: "read_only",
      domain: GUIDED_TASK_DOMAINS.qualityGate,
    },
  ] as const)(
    "classifies the exact sealed $kind contract",
    ({ kind, plannerId, agentCategory, executionMode, domain }) => {
      expect(
        parseGuidedTaskKind({
          plannerId,
          agentCategory,
          executionMode,
          domains: [domain],
        }),
      ).toBe(kind);
      expect(
        parseGuidedTaskKind({
          plannerId,
          agentCategory,
          executionMode,
          domains: [domain, "sequential-only"],
        }),
      ).toBe(kind);
    },
  );

  it("returns null for a non-Guided schedule", () => {
    expect(
      parseGuidedTaskKind({
        plannerId: "legacy-task",
        agentCategory: "executor",
        executionMode: "isolated_worktree",
        domains: ["backend"],
      }),
    ).toBeNull();
  });

  it.each([
    {
      label: "wrong QA category",
      plannerId: GUIDED_MISSION_QA_TASK_ID,
      agentCategory: "executor",
      executionMode: "isolated_worktree",
      domains: [GUIDED_TASK_DOMAINS.qualityGate],
    },
    {
      label: "canonical identity impersonation",
      plannerId: "other-task",
      agentCategory: "executor",
      executionMode: "isolated_worktree",
      domains: [GUIDED_TASK_DOMAINS.implementation],
    },
    {
      label: "multiple Guided domains",
      plannerId: "other-task",
      agentCategory: "architect",
      executionMode: "read_only",
      domains: [
        GUIDED_TASK_DOMAINS.advisory,
        GUIDED_TASK_DOMAINS.independentReview,
      ],
    },
  ] as const)("fails closed for $label", (input) => {
    expect(() => parseGuidedTaskKind(input)).toThrow(
      /guided_task_kind_invalid/i,
    );
  });

  it("accepts Wave Pack story and quality-gate planner ids", () => {
    expect(
      parseGuidedTaskKind({
        plannerId: "wave-pack-story-1-1",
        agentCategory: "executor",
        executionMode: "isolated_worktree",
        domains: [GUIDED_TASK_DOMAINS.implementation, "wave-pack"],
      }),
    ).toBe("implementation");
    expect(
      parseGuidedTaskKind({
        plannerId: "wave-pack-quality-gate",
        agentCategory: "reviewer",
        executionMode: "read_only",
        domains: [GUIDED_TASK_DOMAINS.qualityGate, "wave-pack"],
      }),
    ).toBe("quality-gate");
  });
});
