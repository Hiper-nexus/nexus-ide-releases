import type { MissionLifecycleState } from '../../shared/mission-engine-contract';
import type { Mission } from '../../shared/orch-types';
import { hasCurrentApprovedDispatchContract } from '../../shared/mission-intent';
import {
  missionHasLiveRuntime,
  missionIsOperationallyActive,
} from '../lib/mission-rail-groups';
import {
  hasAutomaticTechnicalRecovery,
  missionAwaitsOperatorReview,
  wasMissionRuntimeClosedByOperator,
} from '../../shared/mission-recovery-policy';

const TERMINAL_BOARD_STATES: ReadonlySet<MissionLifecycleState> = new Set([
  'completed',
  'failed',
]);

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
  | 'complete'
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
  // O motor concluir NÃO encerra a missão: a entrega espera a revisão de quem
  // pediu, que pode não aprovar. Enquanto não houver o carimbo humano, a ação
  // é "Marcar como feito" — Remover continua disponível ao lado (bba8e6aa).
  if (missionAwaitsOperatorReview(mission)) return 'complete';
  // Aprovada: nada a Encerrar — o Main recusa esse caminho.
  if (mission.status === 'done') return 'remove';
  if (wasMissionRuntimeClosedByOperator(mission)) {
    if (mission.orchestratorSessionId !== undefined) return 'close-runtime';
    return 'complete';
  }
  if (missionHasLiveRuntime(mission, hasVisiblePanes)) return 'close-runtime';
  if (missionAwaitsOperatorDecision(mission)) return 'none';
  if (missionIsOperationallyActive(mission, hasVisiblePanes)) return 'none';
  if (canDiscardMission(mission)) return 'discard';
  return 'remove';
}

/**
 * Board header authority. The Pronto/Falhou badge comes from the engine
 * snapshot; Encerrar used to follow a stale orch row (leftover panes or a
 * session pointer) and Main then refused Encerrar on a done mission.
 */
export function missionBoardLifecycleAction(
  snapshotState: MissionLifecycleState | null | undefined,
  mission: Mission | null,
  hasVisiblePanes: boolean,
): MissionListAction {
  if (snapshotState && TERMINAL_BOARD_STATES.has(snapshotState)) {
    // Concluída pelo motor mas ainda não aprovada por quem pediu: o botão
    // primário é "Marcar como feito", não "Remover".
    if (
      snapshotState === 'completed' &&
      mission &&
      missionAwaitsOperatorReview(mission)
    ) {
      return 'complete';
    }
    return 'remove';
  }
  if (!mission) return 'none';
  return missionListAction(mission, hasVisiblePanes);
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
    case 'complete':
      return {
        verb: 'Marcar como feito',
        title:
          'Aprovar a entrega e dar a missão por concluída. Até você fazer ' +
          'isso ela fica aguardando a sua revisão; o histórico permanece.',
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

export function removeMissionPrompt(mission: Pick<Mission, 'title'>): {
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
