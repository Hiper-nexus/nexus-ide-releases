import type { Mission } from '../../shared/orch-types';
import { missionHasLiveRuntime } from '../lib/mission-rail-groups';

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
  | 'discard'
  | 'remove'
  | 'none';

export function missionListAction(
  mission: Mission,
  hasVisiblePanes: boolean,
): MissionListAction {
  if (missionHasLiveRuntime(mission, hasVisiblePanes)) return 'close-runtime';
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

/** @deprecated use removeMissionPrompt — kept for tests migrating off archive */
export const archiveMissionPrompt = removeMissionPrompt;
