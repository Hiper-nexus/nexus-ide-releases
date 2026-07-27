import { describe, expect, it } from "vitest";
import { selectMissionSchedulerWorktreeDependencies } from "./mission-scheduler-worktree-dependencies";

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
