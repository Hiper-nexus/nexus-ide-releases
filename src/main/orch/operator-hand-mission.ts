import {
  compileIntentContract,
  MISSION_INTENT_GOAL_MAX_CHARS,
  type MissionIntentContract,
} from '../../shared/mission-intent';

/**
 * Contrato da missão que a mão do operador cria em Autopilot: aprovado e
 * despachado agora (é o próprio operador pedindo), em modo livre. Os
 * guardrails que não são cerimônia — containment, allowlists, 1 escritor por
 * checkout, maxWorkers — continuam valendo a jusante.
 */
export function operatorHandMissionContract(
  title: string,
  description: string | undefined,
  milestones: readonly string[],
): MissionIntentContract {
  const now = Date.now();
  const acceptanceCriteria = milestones
    .map((milestone) => milestone.trim().slice(0, 2_048))
    .filter((milestone) => milestone.length > 0)
    .slice(0, 32);
  return {
    ...compileIntentContract({
      goal: (description?.trim() || title).slice(0, MISSION_INTENT_GOAL_MAX_CHARS),
      source: 'typed',
      intentVersion: 1,
      executionMode: 'autopilot',
      contextPolicy: 'on-demand',
      freeAgentChoice: true,
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    }),
    approvedAt: now,
    dispatchedAt: now,
  };
}
