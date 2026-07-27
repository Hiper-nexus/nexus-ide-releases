export interface MissionSchedulerDependencyDispatch {
  readonly taskId: string;
  readonly missionId: string;
  readonly state: string;
  readonly executionMode: string;
  readonly integrationReceipt?: unknown;
  readonly completedAt?: number;
}

/**
 * Translate logical task dependencies into Git/worktree dependencies.
 *
 * Every logical predecessor is still required to have a durable completion
 * receipt before the scheduler reaches this boundary. Only predecessors that
 * physically own a worktree belong in WorktreeManager's dependency graph;
 * read-only reviewers/advisors intentionally have no WorktreeRecord.
 */
export function selectMissionSchedulerWorktreeDependencies(input: {
  readonly missionId: string;
  readonly dependsOn: readonly string[];
  readonly getDispatch: (
    taskId: string,
  ) => MissionSchedulerDependencyDispatch | null;
}): readonly Readonly<{ missionId: string; taskId: string }>[] {
  const selected: Array<Readonly<{ missionId: string; taskId: string }>> = [];
  for (const taskId of input.dependsOn) {
    const dispatch = input.getDispatch(taskId);
    if (
      !dispatch ||
      dispatch.taskId !== taskId ||
      dispatch.missionId !== input.missionId ||
      dispatch.state !== "completed" ||
      dispatch.completedAt === undefined ||
      !dispatch.integrationReceipt
    ) {
      throw new Error(
        `worktree_dependency_unavailable: ${taskId} não possui receipt de conclusão`,
      );
    }
    if (dispatch.executionMode === "read_only") continue;
    if (dispatch.executionMode !== "isolated_worktree") {
      throw new Error(
        `worktree_dependency_invalid: ${taskId} usa modo ${dispatch.executionMode}`,
      );
    }
    selected.push(
      Object.freeze({
        missionId: input.missionId,
        taskId,
      }),
    );
  }
  return Object.freeze(selected);
}
