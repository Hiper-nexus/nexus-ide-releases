import { describe, expect, it } from 'vitest';

import type { Mission, TodoList } from '../../shared/orch-types';
import { planBoardClear } from './board-clear-plan';

function mission(id: string, status: Mission['status']): Mission {
  return {
    id,
    status,
  } as Mission;
}

function list(id: string, statuses: TodoList['items'][number]['status'][]): TodoList {
  return {
    id,
    updatedAt: 1,
    items: statuses.map((status, index) => ({
      id: `${id}-item-${index}`,
      name: `${id} etapa ${index + 1}`,
      status,
      createdAt: index,
    })),
  };
}

describe('planBoardClear', () => {
  it('missão viva: remove SÓ os itens concluídos, o plano em curso permanece', () => {
    const plan = planBoardClear({
      missions: [mission('m-live', 'running')],
      todoLists: [list('m-live', ['done', 'done', 'in_progress', 'todo'])],
    });

    expect(plan.listsToRemove).toEqual([]);
    expect(plan.itemsToRemove).toHaveLength(1);
    expect(plan.itemsToRemove[0]?.listId).toBe('m-live');
    expect(plan.itemsToRemove[0]?.itemIds).toEqual([
      'm-live-item-0',
      'm-live-item-1',
    ]);
  });

  it('missão terminal: a lista inteira sai do quadro (histórico da missão fica nas tabelas dela)', () => {
    const plan = planBoardClear({
      missions: [mission('m-done', 'done'), mission('m-fail', 'failed')],
      todoLists: [
        list('m-done', ['done', 'done']),
        list('m-fail', ['done', 'in_progress']),
      ],
    });

    expect(plan.listsToRemove.sort()).toEqual(['m-done', 'm-fail']);
    expect(plan.itemsToRemove).toEqual([]);
  });

  it('lista órfã (sem missão e sem ser a global) sai inteira; global perde só concluídos', () => {
    const plan = planBoardClear({
      missions: [],
      todoLists: [
        list('global', ['done', 'in_progress']),
        list('leftover-junk', ['done', 'todo']),
      ],
    });

    expect(plan.listsToRemove).toEqual(['leftover-junk']);
    expect(plan.itemsToRemove).toEqual([
      { listId: 'global', itemIds: ['global-item-0'] },
    ]);
  });

  it('quadro sem concluídos não planeja nada (botão pode desabilitar)', () => {
    const plan = planBoardClear({
      missions: [mission('m-live', 'running')],
      todoLists: [list('m-live', ['in_progress', 'todo'])],
    });

    expect(plan.listsToRemove).toEqual([]);
    expect(plan.itemsToRemove).toEqual([]);
  });

  it('pendências (pending/blocked) contam como vivas: só itens concluídos', () => {
    for (const status of ['pending', 'blocked'] as const) {
      const plan = planBoardClear({
        missions: [mission('m-x', status)],
        todoLists: [list('m-x', ['done', 'in_progress'])],
      });
      expect(plan.listsToRemove).toEqual([]);
      expect(plan.itemsToRemove[0]?.itemIds).toEqual(['m-x-item-0']);
    }
  });
});
