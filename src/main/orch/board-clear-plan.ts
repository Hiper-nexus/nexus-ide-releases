import type { Mission, TodoList } from '../../shared/orch-types';

/**
 * Política de "Limpar concluídas" do Quadro — pura, no main, decidida ANTES
 * de qualquer escrita (bug report 18/08: o quadro acumulava etapas
 * concluídas sem nenhuma ação de limpeza).
 *
 * Regras (o operador limpa o VISÍVEL; a missão nunca é tocada):
 *  - lista de missão VIVA (pending/running/blocked): saem apenas os itens
 *    concluídos — o plano em curso segue intacto no rail;
 *  - lista de missão TERMINAL (done/failed): sai inteira — o histórico
 *    auditável vive nas tabelas da missão, não no checklist do quadro;
 *  - lista órfã (id sem missão e sem ser a global): lixo deixado por
 *    runtime antigo, sai inteira;
 *  - lista global: perde apenas os itens concluídos.
 *
 * O id da lista é o missionId por construção (todo-store grava mission_id
 * a partir do listId); a global é a lista de workspace.
 */

export interface BoardClearItemRemoval {
  readonly listId: string;
  readonly itemIds: readonly string[];
}

export interface BoardClearPlan {
  readonly listsToRemove: readonly string[];
  readonly itemsToRemove: readonly BoardClearItemRemoval[];
}

export function planBoardClear(input: {
  readonly missions: readonly Pick<Mission, 'id' | 'status'>[];
  readonly todoLists: readonly TodoList[];
}): BoardClearPlan {
  const statusById = new Map(input.missions.map((m) => [m.id, m.status]));
  const listsToRemove: string[] = [];
  const itemsToRemove: BoardClearItemRemoval[] = [];

  for (const list of input.todoLists) {
    const missionStatus = statusById.get(list.id);
    const listIsWholeRemovable =
      missionStatus === 'done' ||
      missionStatus === 'failed' ||
      (missionStatus === undefined && list.id !== 'global');
    if (listIsWholeRemovable) {
      listsToRemove.push(list.id);
      continue;
    }
    const doneIds = list.items
      .filter((item) => item.status === 'done')
      .map((item) => item.id);
    if (doneIds.length > 0) {
      itemsToRemove.push({ listId: list.id, itemIds: doneIds });
    }
  }

  return { listsToRemove, itemsToRemove };
}
