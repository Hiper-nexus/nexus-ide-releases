import {
  createRealMissionE2EPlanTasks,
  REAL_MISSION_E2E_SQUAD_ID,
} from '../shared/real-mission-e2e';
import { getContextBySession } from './orch/gate';
import { planMissionTasks } from './orch/mission-task-plan-authority';
import type { ProjectDomainStoreSuite } from './orch/project-domain-store-registry';

/**
 * Main-owned seal of the exact release-gate plan.
 *
 * Codex frequently burns the first turn on tool_search + concurrent `exec`
 * MCP reads that hang. Without a sealed plan the durable scheduler never
 * dispatches the worker and the gate fails with dispatches=0. Sealing here
 * after kickoff acceptance keeps the release path product-owned while the
 * orchestrator can still ack handoffs when it recovers.
 */
export function sealRealMissionE2EPlanIfNeeded(
  suite: Pick<
    ProjectDomainStoreSuite,
    'missions' | 'tasks'
  >,
  missionId: string,
): { sealed: boolean; reason: string } {
  const mission = suite.missions.get(missionId);
  if (!mission) return { sealed: false, reason: 'mission-missing' };
  if (mission.squadId !== REAL_MISSION_E2E_SQUAD_ID) {
    return { sealed: false, reason: 'not-e2e-squad' };
  }
  if (mission.status !== 'running') {
    return { sealed: false, reason: `status-${mission.status}` };
  }
  if (!suite.missions.hasCurrentKickoffAcceptance(missionId)) {
    return { sealed: false, reason: 'kickoff-pending' };
  }
  const intentVersion = mission.intentVersion ?? 0;
  if (suite.tasks.listPlannedTasks(missionId, intentVersion).length > 0) {
    return { sealed: false, reason: 'already-sealed' };
  }
  if (suite.tasks.list(missionId).length > 0) {
    return { sealed: false, reason: 'tasks-already-exist' };
  }
  const sessionId = mission.orchestratorSessionId;
  if (!sessionId) return { sealed: false, reason: 'no-orchestrator-session' };
  const ctx = getContextBySession(sessionId);
  if (!ctx || ctx.role !== 'orchestrator' || ctx.missionId !== missionId) {
    return { sealed: false, reason: 'gate-context-unavailable' };
  }

  planMissionTasks(
    {
      action: 'plan',
      missionId,
      tasks: createRealMissionE2EPlanTasks().map((task) => ({
        ...task,
        ownership: {
          files: [...task.ownership.files],
          symbols: [...task.ownership.symbols],
          domains: [...task.ownership.domains],
        },
        dependsOn: [...task.dependsOn],
      })),
    },
    ctx,
    suite,
  );
  return { sealed: true, reason: 'sealed' };
}
