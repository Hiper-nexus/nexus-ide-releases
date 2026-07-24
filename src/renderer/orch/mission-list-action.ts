import type { Mission } from '../../shared/orch-types';
import { missionHasLiveRuntime } from '../lib/mission-rail-groups';

/**
 * Durable mission rows are audit/history records. The renderer never decides
 * what may be deleted: it only offers the gesture for rows with no live
 * runtime, and main refuses (with its own message) anything that still holds
 * receipts — handoffs, tasks, deliveries.
 */
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
  | 'archive'
  | 'none';

export function missionListAction(
  mission: Mission,
  hasVisiblePanes: boolean,
): MissionListAction {
  // Encerrar só existe enquanto há runtime físico para encerrar.
  if (missionHasLiveRuntime(mission, hasVisiblePanes)) return 'close-runtime';
  // Rascunho nunca despachado não guarda nada: sai da base de verdade.
  if (canDiscardMission(mission)) return 'discard';
  // Missão já despachada carrega receipts que o main se recusa (corretamente)
  // a apagar. Arquivar tira da vista sem tocar em nada durável — é a única
  // saída honesta para o operador que encerrou tudo e quer a lista limpa.
  return 'archive';
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
    case 'archive':
      return {
        verb: 'Arquivar',
        title: 'Arquivar: some da lista, histórico preservado',
      };
    default:
      return { verb: 'Missão', title: '' };
  }
}

/** Cópia honesta: o rascunho some da base; a arquivada some só da vista. */
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

export function archiveMissionPrompt(mission: Mission): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  return {
    title: `Arquivar "${mission.title}"?`,
    body:
      'A missão sai da lista de trabalho. Nada é apagado: tasks, entregas, ' +
      'receipts e histórico continuam salvos, e ela reaparece em ' +
      '“Arquivadas” — de onde dá pra desarquivar ou retomar quando quiser.',
    confirmLabel: 'Arquivar missão',
  };
}
