import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { TodoItem, TodoList } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedEntity,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from './scoped-store';

export const DEFAULT_TODO_LIST = 'global';

const todoStatusSchema = z.enum(['todo', 'in_progress', 'done']);
const listIdSchema = z.string().min(1).max(256);
const itemIdSchema = z.string().min(1).max(256);
const itemNameSchema = z.string().min(1).max(1_024);
const taskNamesSchema = z.array(itemNameSchema).max(256);

const todoListRowSchema = z
  .object({
    id: listIdSchema,
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

const todoRowSchema = z
  .object({
    id: itemIdSchema,
    list_id: listIdSchema,
    name: itemNameSchema,
    status: todoStatusSchema,
    position: z.number().int().nonnegative(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type ScopedTodoList = ScopedEntity<TodoList>;

interface StoredListResult {
  list: ScopedTodoList;
  exists: boolean;
}

function cloneList(list: ScopedTodoList): ScopedTodoList {
  return {
    ...list,
    items: list.items.map((item) => ({ ...item })),
  };
}

export class ScopedTodoStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  get(rawListId = DEFAULT_TODO_LIST): ScopedTodoList {
    const listId = listIdSchema.parse(rawListId);
    return cloneList(this.#readList(this.#binding.readDatabase(), listId).list);
  }

  list(): ScopedTodoList[] {
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare('SELECT id, updated_at FROM todo_lists ORDER BY updated_at DESC, id ASC')
      .all();
    return rows.map((rawRow) => {
      let row: z.infer<typeof todoListRowSchema>;
      try {
        row = todoListRowSchema.parse(rawRow);
      } catch (error) {
        throw new ScopedStoreCorruptionError('todo list', { cause: error });
      }
      return cloneList(this.#readList(db, row.id).list);
    });
  }

  /** Replaces a complete list; the first item starts in progress. */
  setTasks(
    rawNames: string[],
    rawListId = DEFAULT_TODO_LIST,
  ): ScopedTodoList {
    const names = taskNamesSchema.parse(rawNames);
    const listId = listIdSchema.parse(rawListId);
    const db = this.#binding.writeDatabase();
    const list = db.transaction(() => {
      const now = this.#binding.now();
      const items: TodoItem[] = names.map((name, index) => ({
        id: this.#binding.makeId('todo'),
        name,
        status: index === 0 ? 'in_progress' : 'todo',
        createdAt: now,
      }));
      return this.#replaceItems(db, listId, items, now);
    })();
    this.#binding.emitChange();
    return cloneList(list);
  }

  moveToTask(
    rawTaskRef: string,
    rawListId = DEFAULT_TODO_LIST,
  ): ScopedTodoList | null {
    const taskRef = z.string().min(1).max(1_024).parse(rawTaskRef);
    const listId = listIdSchema.parse(rawListId);
    const db = this.#binding.writeDatabase();
    const list = db.transaction(() => {
      const current = this.#readList(db, listId);
      const targetIndex = current.list.items.findIndex(
        (item) => item.id === taskRef || item.name === taskRef,
      );
      if (targetIndex < 0) return null;
      const items = current.list.items.map((item, index): TodoItem => ({
        ...item,
        status:
          index < targetIndex
            ? 'done'
            : index === targetIndex
              ? 'in_progress'
              : 'todo',
      }));
      return this.#replaceItems(db, listId, items, this.#binding.now());
    })();
    if (!list) return null;
    this.#binding.emitChange();
    return cloneList(list);
  }

  setItemStatus(
    rawListId: string,
    rawItemId: string,
    rawStatus: TodoItem['status'],
  ): ScopedTodoList | null {
    const listId = listIdSchema.parse(rawListId);
    const itemId = itemIdSchema.parse(rawItemId);
    const status = todoStatusSchema.parse(rawStatus);
    const db = this.#binding.writeDatabase();
    const list = db.transaction(() => {
      const current = this.#readList(db, listId);
      if (
        !current.exists ||
        !current.list.items.some((item) => item.id === itemId)
      ) {
        return null;
      }
      const items = current.list.items.map((item): TodoItem =>
        item.id === itemId ? { ...item, status } : item,
      );
      return this.#replaceItems(db, listId, items, this.#binding.now());
    })();
    if (!list) return null;
    this.#binding.emitChange();
    return cloneList(list);
  }

  addTask(
    rawName: string,
    rawListId = DEFAULT_TODO_LIST,
  ): ScopedTodoList {
    const name = itemNameSchema.parse(rawName);
    const listId = listIdSchema.parse(rawListId);
    const db = this.#binding.writeDatabase();
    const list = db.transaction(() => {
      const current = this.#readList(db, listId).list;
      const now = this.#binding.now();
      return this.#replaceItems(
        db,
        listId,
        [
          ...current.items,
          {
            id: this.#binding.makeId('todo'),
            name,
            status: 'todo',
            createdAt: now,
          },
        ],
        now,
      );
    })();
    this.#binding.emitChange();
    return cloneList(list);
  }

  markAllDone(rawListId = DEFAULT_TODO_LIST): ScopedTodoList {
    const listId = listIdSchema.parse(rawListId);
    const db = this.#binding.writeDatabase();
    const list = db.transaction(() => {
      const items = this.#readList(db, listId).list.items.map(
        (item): TodoItem => ({ ...item, status: 'done' }),
      );
      return this.#replaceItems(db, listId, items, this.#binding.now());
    })();
    this.#binding.emitChange();
    return cloneList(list);
  }

  #readList(db: Database.Database, listId: string): StoredListResult {
    const rawList = db
      .prepare('SELECT id, updated_at FROM todo_lists WHERE id = ?')
      .get(listId);
    if (rawList === undefined) {
      return {
        exists: false,
        list: {
          id: listId,
          items: [],
          updatedAt: 0,
          ...this.#binding.coordinates,
        },
      };
    }
    let listRow: z.infer<typeof todoListRowSchema>;
    try {
      listRow = todoListRowSchema.parse(rawList);
    } catch (error) {
      throw new ScopedStoreCorruptionError('todo list', { cause: error });
    }
    const rawItems = db
      .prepare(
        `SELECT id, list_id, name, status, position, created_at, updated_at
         FROM todos WHERE list_id = ? ORDER BY position ASC`,
      )
      .all(listId);
    const items = rawItems.map((rawItem, expectedPosition): TodoItem => {
      let item: z.infer<typeof todoRowSchema>;
      try {
        item = todoRowSchema.parse(rawItem);
      } catch (error) {
        throw new ScopedStoreCorruptionError('todo item', { cause: error });
      }
      if (item.list_id !== listId || item.position !== expectedPosition) {
        throw new ScopedStoreCorruptionError('todo item ordering');
      }
      return {
        id: item.id,
        name: item.name,
        status: item.status,
        createdAt: item.created_at,
      };
    });
    return {
      exists: true,
      list: {
        id: listRow.id,
        items,
        updatedAt: listRow.updated_at,
        ...this.#binding.coordinates,
      },
    };
  }

  #replaceItems(
    db: Database.Database,
    listId: string,
    items: readonly TodoItem[],
    updatedAt: number,
  ): ScopedTodoList {
    db.prepare(
      `INSERT INTO todo_lists (id, updated_at) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(listId, updatedAt);
    db.prepare('DELETE FROM todos WHERE list_id = ?').run(listId);
    const mission = db
      .prepare('SELECT id FROM missions WHERE id = ?')
      .get(listId) as { id: string } | undefined;
    const insert = db.prepare(
      `INSERT INTO todos
         (id, list_id, mission_id, task_id, name, status, position,
          created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item, position) => {
      insert.run(
        item.id,
        listId,
        mission?.id ?? null,
        item.name,
        item.status,
        position,
        item.createdAt,
        updatedAt,
      );
    });
    return {
      id: listId,
      items: items.map((item) => ({ ...item })),
      updatedAt,
      ...this.#binding.coordinates,
    };
  }
}

export function createScopedTodoStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedTodoStore {
  return new ScopedTodoStore(runtimeManager, scope, options);
}
