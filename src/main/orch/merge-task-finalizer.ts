import type { MergeQueueResult } from '../runtime/merge-queue';

interface MergeTaskFinalizerPorts<TAutopilot> {
  markTaskDone(missionId: string, taskId: string): void;
  driveMission(missionId: string): Promise<TAutopilot>;
}

/** Shared post-integration path for first attempt and restart/retry recovery. */
export async function finalizeIntegratedTask<TAutopilot>(
  missionId: string,
  taskId: string,
  result: MergeQueueResult,
  ports: MergeTaskFinalizerPorts<TAutopilot>,
): Promise<MergeQueueResult & { autopilot: TAutopilot }> {
  ports.markTaskDone(missionId, taskId);
  const autopilot = await ports.driveMission(missionId);
  return Object.freeze({ ...result, autopilot });
}
