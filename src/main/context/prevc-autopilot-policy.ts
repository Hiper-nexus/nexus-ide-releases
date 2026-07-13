import type { WorkflowStage } from './contract-compiler';

export type PrevcAutopilotAction =
  | 'advance'
  | 'review'
  | 'validate'
  | 'wait-execution'
  | 'complete';

export function missionPlanIntegrated(
  taskIds: readonly string[],
  worktrees: readonly { taskId: string; status: string }[],
): boolean {
  if (taskIds.length === 0) return false;
  const integrated = new Set(
    worktrees
      .filter((worktree) => worktree.status === 'integrated')
      .map((worktree) => worktree.taskId),
  );
  return taskIds.every((taskId) => integrated.has(taskId));
}

export function autopilotActionFor(
  stage: WorkflowStage,
  allowExecutionExit: boolean,
  planIntegrated: boolean,
): PrevcAutopilotAction {
  if (stage === 'complete') return 'complete';
  if (stage === 'review-primary' || stage === 'review-secondary') return 'review';
  if (stage === 'validation-primary' || stage === 'validation-secondary') return 'validate';
  if (stage === 'execution' && (!allowExecutionExit || !planIntegrated)) {
    return 'wait-execution';
  }
  return 'advance';
}

/** The final PREVC edge belongs to the atomic mission-step receipt path. */
export function canAutopilotAdvanceTo(stage: WorkflowStage): boolean {
  return stage !== 'complete';
}
