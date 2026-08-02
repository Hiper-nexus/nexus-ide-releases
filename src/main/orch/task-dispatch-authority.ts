import { sealedPlanPresence } from '../../shared/mission-plan-orphan';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

/**
 * Once a standard approved mission has a durable task plan, only the main
 * dispatcher may allocate worktrees, route/spawn workers, merge or mutate
 * execution status. The LLM remains planner/observer, never a second executor.
 *
 * Um plano ÓRFÃO (selado noutra versão da intenção) continua sendo um plano:
 * `hasPlan` da versão corrente responde `false` e devolvia a autoridade de
 * execução ao LLM justamente quando a missão estava mais frágil. Órfão conta
 * como missão gerida pelo dispatcher — a saída é re-selar, nunca improvisar.
 */
export function isTaskQueueManagedMission(
  suite: ProjectDomainStoreSuite,
  missionId: string,
): boolean {
  const mission = suite.missions.get(missionId);
  if (!mission || mission.status !== 'running') return false;
  if (mission.intentContract?.lane !== 'standard') return false;
  const intentVersion = mission.intentContract.intentVersion;
  if (suite.tasks.hasPlan(missionId, intentVersion)) return true;
  return (
    sealedPlanPresence({
      missionIntentVersion: intentVersion,
      sealedIntentVersions: suite.tasks.listPlanIntentVersions(missionId),
    }) === 'orphan'
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
