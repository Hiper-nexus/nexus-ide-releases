import { normalizeWavePackFile } from "../../shared/mission-wave-pack";

/**
 * A fan-out story as the plan graph sees it: its own task id, the tasks it
 * declares a dependency on, and the files its writer owns.
 */
export interface DisjointStoryNode {
  readonly taskId: string;
  readonly dependsOn: readonly string[];
  readonly ownership: { readonly files: readonly string[] };
}

/**
 * Teach the dependency graph the fan-out invariant: two stories whose file
 * footprints are disjoint have NO reason to serialize, so they must not declare
 * a dependency on each other — a disjoint pair chained together would silently
 * collapse the parallel wave back to a single writer. Stories that share a file
 * are exempt: their overlap is a legitimate reason to run in sequence.
 */
export function assertDisjointStoriesIndependent(
  stories: readonly DisjointStoryNode[],
): void {
  const filesById = new Map<string, ReadonlySet<string>>();
  for (const story of stories) {
    filesById.set(
      story.taskId,
      new Set(story.ownership.files.map(normalizeWavePackFile)),
    );
  }
  const filesOverlap = (a: string, b: string): boolean => {
    const left = filesById.get(a);
    const right = filesById.get(b);
    if (!left || !right) return false;
    for (const file of left) if (right.has(file)) return true;
    return false;
  };
  for (const story of stories) {
    for (const dependencyId of story.dependsOn) {
      if (!filesById.has(dependencyId)) continue;
      if (!filesOverlap(story.taskId, dependencyId)) {
        throw new Error(
          `wave_pack_disjoint_serialized: ${story.taskId} depende de ` +
            `${dependencyId} mas seus arquivos são disjuntos — stories ` +
            "disjuntas devem rodar em paralelo, não em série",
        );
      }
    }
  }
}

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
    // O escritor same_checkout entregou DIRETO no checkout primário e
    // concluiu com receipt same_checkout_validated: como o read_only, ele não
    // possui WorktreeRecord — o receipt de conclusão (já exigido acima) é a
    // dependência satisfeita; não há worktree a integrar antes do dependente.
    if (dispatch.executionMode === "same_checkout") continue;
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
