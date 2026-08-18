import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
  type ProjectMigration,
} from '../runtime/project-runtime-schema';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedTodoStore } from './todo-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(migrations?: readonly ProjectMigration[]): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
    ...(migrations ? { migrations } : {}),
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-todo-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped todo store', () => {
  it('preserves set/move/add/mark semantics without an in-memory source of truth', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let sequence = 0;
    const todos = createScopedTodoStore(runtimeManager, scope, {
      now: () => 100,
      idFactory: () => `todo-${++sequence}`,
    });

    const initial = todos.setTasks(['one', 'two', 'three']);
    expect(initial.items.map((item) => item.status)).toEqual([
      'in_progress',
      'todo',
      'todo',
    ]);
    expect(todos.moveToTask(initial.items[2].id)?.items.map((item) => item.status)).toEqual([
      'done',
      'done',
      'in_progress',
    ]);
    expect(todos.addTask('four').items.at(-1)?.status).toBe('todo');
    expect(todos.markAllDone().items.every((item) => item.status === 'done')).toBe(true);

    runtimeManager.close(scope);
    const restored = createScopedTodoStore(runtimeManager, scope).get();
    expect(restored.items).toHaveLength(4);
    expect(restored).toMatchObject({
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    });
  });

  it('supports item status updates and returns immutable snapshots', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const todos = createScopedTodoStore(runtimeManager, scope);
    const initial = todos.setTasks(['one', 'two'], 'mission-list');
    initial.items[0].name = 'mutated outside';

    const updated = todos.setItemStatus(
      'mission-list',
      initial.items[1].id,
      'done',
    );
    expect(updated?.items).toEqual([
      expect.objectContaining({ name: 'one', status: 'in_progress' }),
      expect.objectContaining({ name: 'two', status: 'done' }),
    ]);
    expect(todos.setItemStatus('missing', 'missing', 'done')).toBeNull();
  });

  it('persists empty lists and isolates lists plus observers by checkout', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const todosA = createScopedTodoStore(runtimeManager, scopeA);
    const todosB = createScopedTodoStore(runtimeManager, scopeB);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    todosA.onChange(listenerA);
    todosB.onChange(listenerB);

    todosA.setTasks([], 'empty-list');

    expect(todosA.list()).toEqual([
      expect.objectContaining({ id: 'empty-list', items: [] }),
    ]);
    expect(todosB.list()).toEqual([]);
    expect(listenerA).toHaveBeenCalledWith({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
    });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('upgrades v1 todo rows into a durable global list', () => {
    const scope = testProjectScope({ checkoutId: 'upgrade-v1' });
    const firstManager = manager([INITIAL_PROJECT_MIGRATIONS[0]]);
    const runtime = firstManager.open(scope);
    runtime.db
      .prepare(
        `INSERT INTO missions
           (id, title, description, status, created_at, updated_at)
         VALUES (?, ?, '', 'running', ?, ?)`,
      )
      .run('mission-v1', 'Legacy mission', 1, 1);
    const insertLegacy = runtime.db.prepare(
      `INSERT INTO todos
         (id, mission_id, text, completed, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertLegacy.run('legacy-todo', null, 'legacy row', 1, 0, 10, 20);
    insertLegacy.run(
      'legacy-mission-todo',
      'mission-v1',
      'mission row',
      0,
      0,
      11,
      21,
    );
    firstManager.closeAll();

    const upgraded = manager();
    expect(createScopedTodoStore(upgraded, scope).get()).toMatchObject({
      id: 'global',
      updatedAt: 20,
      items: [
        expect.objectContaining({
          id: 'legacy-todo',
          name: 'legacy row',
          status: 'done',
        }),
      ],
    });
    expect(createScopedTodoStore(upgraded, scope).get('mission-v1')).toMatchObject({
      id: 'mission-v1',
      updatedAt: 21,
      items: [
        expect.objectContaining({
          id: 'legacy-mission-todo',
          name: 'mission row',
          status: 'todo',
        }),
      ],
    });
  });

  it('allows inspection but rejects every mutation in safe read-only mode', () => {
    const scope = testProjectScope({ checkoutId: 'read-only-todos' });
    const writable = manager();
    const saved = createScopedTodoStore(writable, scope).setTasks(['preserved']);
    writable.closeAll();

    const original = INITIAL_PROJECT_MIGRATIONS[0];
    const changed = createProjectMigration({
      id: original.id,
      schemaVersion: original.schemaVersion,
      appVersion: original.appVersion,
      sql: `${original.sql}\n-- immutable checksum changed`,
    });
    const readOnly = manager([changed]);
    const todos = createScopedTodoStore(readOnly, scope);

    expect(todos.get().items).toHaveLength(1);
    expect(() => todos.setTasks(['forbidden'])).toThrow(/read-only/i);
    expect(() =>
      todos.setItemStatus('global', saved.items[0].id, 'done'),
    ).toThrow(/read-only/i);
    expect(todos.get().items[0].status).toBe('in_progress');
  });

  it('removeItems apaga só os itens pedidos, transacional, sem tocar o resto', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const todos = createScopedTodoStore(runtimeManager, scope);
    todos.setTasks(['alpha', 'beta', 'gamma'], 'mission-live');
    todos.setItemStatus('mission-live', 'alpha', 'done');
    const betaId = todos.get('mission-live').items[1].id;
    const gammaId = todos.get('mission-live').items[2].id;

    const after = todos.removeItems('mission-live', ['nonexistent', betaId]);
    expect(after?.items.map((item) => item.name)).toEqual(['alpha', 'gamma']);
    expect(todos.get('mission-live').items.map((item) => item.id)).toEqual(
      after?.items.map((item) => item.id),
    );

    // Ids inválidos rejeitados com erro de validação, nada escrito.
    expect(() => todos.removeItems('mission-live', [gammaId, ''])).toThrow();

    runtimeManager.close(scope);
    const restored = createScopedTodoStore(runtimeManager, scope).get('mission-live');
    expect(restored.items.map((item) => item.name)).toEqual(['alpha', 'gamma']);
  });

  it('removeList apaga a lista inteira; lista inexistente é idempotente', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const todos = createScopedTodoStore(runtimeManager, scope);
    todos.setTasks(['one', 'two'], 'mission-terminal');
    todos.setTasks(['stay'], 'mission-other');

    expect(todos.removeList('mission-terminal')).toBe(true);
    expect(todos.get('mission-terminal').items).toHaveLength(0);
    expect(todos.get('mission-other').items.map((item) => item.name)).toEqual([
      'stay',
    ]);

    // Segunda chamada: nada existe mais, segue ok (idempotente).
    expect(todos.removeList('mission-terminal')).toBe(false);
    expect(() => todos.removeList('')).toThrow();

    runtimeManager.close(scope);
    const restored = createScopedTodoStore(runtimeManager, scope).list();
    expect(restored.map((list) => list.id)).toEqual(['mission-other']);
  });
});
