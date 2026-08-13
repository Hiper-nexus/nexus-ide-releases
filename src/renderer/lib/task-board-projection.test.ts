import { describe, expect, it } from 'vitest';
import type { Mission, TodoList } from '../../shared/orch-types';
import {
  missionBoardColumn,
  projectTaskBoardEntries,
  taskBoardIsEmpty,
} from './task-board-projection';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-live',
    title: 'Missão rolando',
    description: '',
    status: 'running',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('task-board-projection', () => {
  it('puts running and blocked missions in Em andamento before any task exists', () => {
    expect(missionBoardColumn(mission())).toBe('in_progress');
    expect(missionBoardColumn(mission({ status: 'blocked' }))).toBe(
      'in_progress',
    );
    expect(missionBoardColumn(mission({ status: 'pending' }))).toBe('todo');
    expect(missionBoardColumn(mission({ status: 'done' }))).toBe('done');
  });

  it('shows a running mission on an otherwise empty board', () => {
    const entries = projectTaskBoardEntries({
      missions: [mission()],
      todoLists: [{ id: 'empty-list', items: [], updatedAt: 1 }],
    });
    expect(taskBoardIsEmpty(entries)).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'mission',
        name: 'Missão rolando',
        status: 'in_progress',
      }),
    ]);
  });

  it('keeps canonical todos next to the mission card', () => {
    const list: TodoList = {
      id: 'release-list',
      updatedAt: 2,
      items: [
        {
          id: 'prepare-release',
          name: 'Preparar release',
          status: 'todo',
          createdAt: 1,
        },
      ],
    };
    const entries = projectTaskBoardEntries({
      missions: [mission()],
      todoLists: [list],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(['mission', 'todo']);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Missão rolando',
      'Preparar release',
    ]);
  });

  it('is empty only when there is no mission and no task', () => {
    expect(
      taskBoardIsEmpty(
        projectTaskBoardEntries({ missions: [], todoLists: [] }),
      ),
    ).toBe(true);
  });
});
