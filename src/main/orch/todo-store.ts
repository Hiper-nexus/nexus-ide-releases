import type { Db } from '../persistence/db';
import type { TodoItem, TodoList } from '../../shared/orch-types';
import { ChangeHub, makeId, parseJsonColumn } from './store-util';

/**
 * Todo store backing nexus_todo_manager — user-visible task lists with
 * milestones, mirroring the Overclock todo_manager semantics:
 * set_tasks / move_to_task / add_task / read_list / mark_all_done.
 * Lists are keyed (default 'global'; missions get their own list).
 */

export const DEFAULT_TODO_LIST = 'global';

const lists = new Map<string, TodoList>();
const hub = new ChangeHub();
let db: Db | null = null;

export function initTodoStore(database: Db | null): void {
  db = database;
  lists.clear();
  if (!db) return;
  try {
    const rows = db.prepare('SELECT * FROM todo_lists').all() as Array<{
      id: string;
      items_json: string;
      updated_at: number;
    }>;
    for (const row of rows) {
      lists.set(row.id, {
        id: row.id,
        items: parseJsonColumn<TodoItem[]>(row.items_json, []),
        updatedAt: row.updated_at,
      });
    }
  } catch (err) {
    console.warn('[orch] failed to hydrate todo lists:', err);
  }
}

function persist(list: TodoList): void {
  if (!db) return;
  try {
    db.prepare(
      'INSERT OR REPLACE INTO todo_lists (id, items_json, updated_at) VALUES (?, ?, ?)',
    ).run(list.id, JSON.stringify(list.items), list.updatedAt);
  } catch (err) {
    console.warn('[orch] failed to persist todo list:', err);
  }
}

export function onTodosChange(cb: () => void): () => void {
  return hub.onChange(cb);
}

export function getTodoList(listId = DEFAULT_TODO_LIST): TodoList {
  return (
    lists.get(listId) ?? { id: listId, items: [], updatedAt: 0 }
  );
}

export function listTodoLists(): TodoList[] {
  return [...lists.values()];
}

function save(listId: string, items: TodoItem[]): TodoList {
  const list: TodoList = { id: listId, items, updatedAt: Date.now() };
  lists.set(listId, list);
  persist(list);
  hub.emit();
  return list;
}

function newItem(name: string, status: TodoItem['status'] = 'todo'): TodoItem {
  return { id: makeId('todo'), name, status, createdAt: Date.now() };
}

/** Replace the whole list; the first task starts in_progress (Overclock UX). */
export function setTasks(names: string[], listId = DEFAULT_TODO_LIST): TodoList {
  const items = names.map((name, index) =>
    newItem(name, index === 0 ? 'in_progress' : 'todo'),
  );
  return save(listId, items);
}

/**
 * Complete everything before `taskId` (or the current in_progress task when
 * moving forward), mark `taskId` in_progress.
 */
export function moveToTask(taskId: string, listId = DEFAULT_TODO_LIST): TodoList | null {
  const list = getTodoList(listId);
  const targetIndex = list.items.findIndex(
    (item) => item.id === taskId || item.name === taskId,
  );
  if (targetIndex === -1) return null;
  const items = list.items.map((item, index): TodoItem => {
    if (index < targetIndex) return { ...item, status: 'done' };
    if (index === targetIndex) return { ...item, status: 'in_progress' };
    return { ...item, status: 'todo' };
  });
  return save(listId, items);
}

export function addTask(name: string, listId = DEFAULT_TODO_LIST): TodoList {
  const list = getTodoList(listId);
  return save(listId, [...list.items, newItem(name)]);
}

export function markAllDone(listId = DEFAULT_TODO_LIST): TodoList {
  const list = getTodoList(listId);
  return save(
    listId,
    list.items.map((item): TodoItem => ({ ...item, status: 'done' })),
  );
}
