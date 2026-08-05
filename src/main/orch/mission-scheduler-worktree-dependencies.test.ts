import { describe, expect, it } from "vitest";
import {
  assertDisjointStoriesIndependent,
  selectMissionSchedulerWorktreeDependencies,
} from "./mission-scheduler-worktree-dependencies";

describe("mission scheduler logical versus Git dependencies", () => {
  it("keeps only completed isolated-worktree predecessors in the Git graph", () => {
    const modes = new Map([
      ["review", "read_only"],
      ["implementation", "isolated_worktree"],
    ]);
    expect(
      selectMissionSchedulerWorktreeDependencies({
        missionId: "mission-a",
        dependsOn: ["review", "implementation"],
        getDispatch: (taskId) => ({
          taskId,
          missionId: "mission-a",
          state: "completed",
          executionMode: modes.get(taskId)!,
          integrationReceipt: { kind: "test" },
          completedAt: 10,
        }),
      }),
    ).toEqual([
      {
        missionId: "mission-a",
        taskId: "implementation",
      },
    ]);
  });

  it("fails closed before worktree creation when any logical predecessor lacks its completion receipt", () => {
    expect(() =>
      selectMissionSchedulerWorktreeDependencies({
        missionId: "mission-a",
        dependsOn: ["review"],
        getDispatch: (taskId) => ({
          taskId,
          missionId: "mission-a",
          state: "running",
          executionMode: "read_only",
          integrationReceipt: null,
          completedAt: undefined,
        }),
      }),
    ).toThrow(/não possui receipt de conclusão/i);
  });
});

describe("disjoint stories run in parallel (no inter-dependency)", () => {
  it("accepts file-disjoint stories that declare no dependency on each other", () => {
    expect(() =>
      assertDisjointStoriesIndependent([
        { taskId: "s1", dependsOn: [], ownership: { files: ["src/a.ts"] } },
        { taskId: "s2", dependsOn: [], ownership: { files: ["src/b.ts"] } },
        { taskId: "s3", dependsOn: [], ownership: { files: ["src/c.ts"] } },
      ]),
    ).not.toThrow();
  });

  it("does not veto a real dependency between stories that share a file", () => {
    // Overlapping files legitimately serialize; only disjoint pairs must stay
    // independent, so a dependency between overlapping stories is allowed.
    expect(() =>
      assertDisjointStoriesIndependent([
        { taskId: "s1", dependsOn: [], ownership: { files: ["src/shared.ts"] } },
        {
          taskId: "s2",
          dependsOn: ["s1"],
          ownership: { files: ["src/shared.ts"] },
        },
      ]),
    ).not.toThrow();
  });

  it("fails closed when a disjoint story is secretly serialized behind a sibling", () => {
    expect(() =>
      assertDisjointStoriesIndependent([
        { taskId: "s1", dependsOn: [], ownership: { files: ["src/a.ts"] } },
        {
          taskId: "s2",
          dependsOn: ["s1"],
          ownership: { files: ["src/b.ts"] },
        },
      ]),
    ).toThrow(/wave_pack_disjoint_serialized/);
  });
});
