import { hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import type { Mission } from '../../shared/orch-types';
import type { MissionContractDraft } from '../context/context-workflow-service';

function riskFloor(risk: NonNullable<Mission['intentContract']>['risk']): string[] {
  switch (risk) {
    case 'destructive':
      return ['credential', 'security'];
    case 'sensitive':
      return ['security'];
    default:
      return [];
  }
}

/**
 * Bind an agent-authored PREVC proposal to the exact durable intent the
 * operator approved. The agent may add evidence mechanics and broaden scope,
 * but cannot rewrite the objective, reorder/narrow acceptance or lower risk.
 */
export function bindFreezeDraftToApprovedIntent(
  mission: Mission | null,
  draft: MissionContractDraft,
): MissionContractDraft {
  if (
    !mission ||
    mission.id !== draft.missionId ||
    mission.status !== 'running' ||
    !hasCurrentDispatchAuthority(mission) ||
    !mission.intentContract
  ) {
    throw new Error(
      'freeze_authority_required: a revisão atual da missão precisa estar aprovada e em execução',
    );
  }
  const approved = mission.intentContract;
  const approvedGoal = approved.goal.trim();
  if (draft.goal.trim() !== approvedGoal) {
    throw new Error(
      'freeze_goal_mismatch: o objetivo PREVC deve ser exatamente o objetivo aprovado',
    );
  }
  const approvedCriteria = approved.acceptanceCriteria.map((criterion) =>
    criterion.trim(),
  );
  if (
    draft.acceptanceCriteria.length !== approvedCriteria.length ||
    draft.acceptanceCriteria.some(
      (criterion, index) =>
        criterion.statement.trim() !== approvedCriteria[index],
    )
  ) {
    throw new Error(
      'freeze_acceptance_mismatch: os critérios PREVC devem preservar a ordem e o texto aprovados',
    );
  }

  const riskHints = [...new Set([
    ...(draft.riskHints ?? []),
    ...riskFloor(approved.risk),
  ])];
  return Object.freeze({
    ...draft,
    goal: approvedGoal,
    acceptanceCriteria: Object.freeze(
      draft.acceptanceCriteria.map((criterion, index) => Object.freeze({
        ...criterion,
        id: `criterion-${String(index + 1).padStart(4, '0')}`,
        statement: approvedCriteria[index]!,
        requiredSensorIds: Object.freeze([...criterion.requiredSensorIds]),
        invariantRefs: Object.freeze([...criterion.invariantRefs]),
        requiredArtifactIds: Object.freeze([...criterion.requiredArtifactIds]),
      })),
    ),
    riskHints: Object.freeze(riskHints),
  });
}
