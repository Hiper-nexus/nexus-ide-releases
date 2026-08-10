import type { Mission } from '../../shared/orch-types';
import { hasCurrentApprovedDispatchContract } from '../../shared/mission-intent';
import {
  missionHasLiveRuntime,
  missionIsOperationallyActive,
} from '../lib/mission-rail-groups';
import {
  hasAutomaticTechnicalRecovery,
  wasMissionRuntimeClosedByOperator,
} from '../../shared/mission-recovery-policy';

export function canDiscardMission(mission: Mission): boolean {
  if (mission.orchestratorSessionId !== undefined) return false;
  if (mission.status !== 'pending') return false;
  return (
    mission.intentState === undefined ||
    mission.intentState === 'legacy' ||
    mission.intentState === 'awaiting_goal' ||
    mission.intentState === 'draft' ||
    mission.intentState === 'intent_compiling' ||
    mission.intentState === 'ready_to_start' ||
    mission.intentState === 'awaiting_approval'
  );
}

export type MissionListAction =
  | 'close-runtime'
  | 'stop-recovery'
  | 'discard'
  | 'remove'
  | 'none';

function missionAwaitsOperatorDecision(mission: Mission): boolean {
  return (
    mission.status === 'blocked' &&
    mission.intentState === 'blocked_user' &&
    !wasMissionRuntimeClosedByOperator(mission) &&
    hasCurrentApprovedDispatchContract(mission)
  );
}

export function missionListAction(
  mission: Mission,
  hasVisiblePanes: boolean,
): MissionListAction {
  if (hasAutomaticTechnicalRecovery(mission)) return 'stop-recovery';
  if (
    wasMissionRuntimeClosedByOperator(mission) &&
    mission.orchestratorSessionId !== undefined
  ) {
    return 'close-runtime';
  }
  if (missionHasLiveRuntime(mission, hasVisiblePanes)) return 'close-runtime';
  if (missionAwaitsOperatorDecision(mission)) return 'none';
  if (missionIsOperationallyActive(mission, hasVisiblePanes)) return 'none';
  if (canDiscardMission(mission)) return 'discard';
  return 'remove';
}

/** Rótulo curto do botão de cada ação — usado em title/aria-label. */
export function missionActionCopy(action: MissionListAction): {
  verb: string;
  title: string;
} {
  switch (action) {
    case 'close-runtime':
      return {
        verb: 'Encerrar',
        title: 'Encerrar processos e panes desta missão',
      };
    case 'stop-recovery':
      return {
        verb: 'Parar',
        title: 'Parar a recuperação automática e preservar o histórico',
      };
    case 'discard':
      return { verb: 'Descartar', title: 'Descartar este rascunho' };
    case 'remove':
      return {
        verb: 'Remover',
        title: 'Apagar missão e todo o histórico desta execução',
      };
    default:
      return { verb: 'Missão', title: '' };
  }
}

export function discardMissionPrompt(mission: Mission): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  return {
    title: `Descartar "${mission.title}"?`,
    body: 'Este rascunho ainda não foi despachado e será removido.',
    confirmLabel: 'Descartar missão',
  };
}

export function removeMissionPrompt(mission: Mission): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  return {
    title: `Remover "${mission.title}"?`,
    body:
      'Apaga a missão da base deste projeto: panes, entregas, tasks, ' +
      'receipts e histórico. Não dá para desfazer.',
    confirmLabel: 'Remover missão',
  };
}
