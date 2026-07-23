import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

/**
 * Once a standard approved mission has a durable task plan, only the main
 * dispatcher may allocate worktrees, route/spawn workers, merge or mutate
 * execution status. The LLM remains planner/observer, never a second executor.
 */
export function isTaskQueueManagedMission(
  suite: ProjectDomainStoreSuite,
  missionId: string,
): boolean {
  const mission = suite.missions.get(missionId);
  if (!mission || mission.status !== 'running') return false;
  if (mission.intentContract?.lane !== 'standard') return false;
  return suite.tasks.hasPlan(
    missionId,
    mission.intentContract.intentVersion,
  );
}

export function assertMainTaskDispatcherAuthority(
  suite: ProjectDomainStoreSuite,
  missionId: string,
  operation: string,
): void {
  if (!isTaskQueueManagedMission(suite, missionId)) return;
  throw new Error(
    `task_dispatcher_authority: ${operation} é exclusivo do motor Nexus; ` +
      'o orquestrador deve somente propor/listar tasks e aguardar o dispatcher durável',
  );
}
