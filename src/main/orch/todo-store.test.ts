import { beforeEach, describe, expect, it } from 'vitest';
import {
  addTask,
  getTodoList,
  initTodoStore,
  markAllDone,
  moveToTask,
  setTasks,
} from './todo-store';

describe('todo-store (nexus_todo_manager semantics)', () => {
  beforeEach(() => initTodoStore(null)); // in-memory only

  it('set_tasks puts the first task in_progress and the rest todo', () => {
    const list = setTasks(['one', 'two', 'three']);
    expect(list.items.map((i) => i.status)).toEqual([
      'in_progress',
      'todo',
      'todo',
    ]);
  });

  it('move_to_task completes everything before the target', () => {
    setTasks(['one', 'two', 'three']);
    const list = moveToTask('three');
    expect(list?.items.map((i) => i.status)).toEqual([
      'done',
      'done',
      'in_progress',
    ]);
  });

  it('move_to_task accepts task ids as well as names', () => {
    const initial = setTasks(['one', 'two']);
    const second = initial.items[1];
    const list = moveToTask(second.id);
    expect(list?.items[1].status).toBe('in_progress');
  });

  it('move_to_task returns null for an unknown task', () => {
    setTasks(['one']);
    expect(moveToTask('missing')).toBeNull();
  });

  it('add_task appends as todo without disturbing progress', () => {
    setTasks(['one', 'two']);
    const list = addTask('three');
    expect(list.items).toHaveLength(3);
    expect(list.items[0].status).toBe('in_progress');
    expect(list.items[2].status).toBe('todo');
  });

  it('mark_all_done completes everything', () => {
    setTasks(['one', 'two']);
    const list = markAllDone();
    expect(list.items.every((i) => i.status === 'done')).toBe(true);
  });

  it('keeps lists isolated by listId (mission-scoped lists)', () => {
    setTasks(['global task']);
    setTasks(['mission task'], 'mission-1');
    expect(getTodoList().items[0].name).toBe('global task');
    expect(getTodoList('mission-1').items[0].name).toBe('mission task');
  });
});
