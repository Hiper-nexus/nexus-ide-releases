import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import { createScopedTaskStore } from './task-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({ baseDir, appVersion: '0.12.0-test' });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped task store', () => {
  it('persists task mutations with explicit project and checkout ownership', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Mission',
    });
    const tasks = createScopedTaskStore(runtimeManager, scope, {
      now: () => 100,
      idFactory: () => 'task-a',
    });

    const task = tasks.create({
      missionId: mission.id,
      title: 'Review contracts',
      detail: 'Read every boundary.',
    });
    expect(task).toMatchObject({
      id: 'task-a',
      status: 'pending',
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    });
    expect(tasks.update(task.id, { status: 'done', detail: 'Verified.' })).toMatchObject({
      status: 'done',
      detail: 'Verified.',
    });

    runtimeManager.close(scope);
    expect(createScopedTaskStore(runtimeManager, scope).list(mission.id)).toEqual([
      expect.objectContaining({ id: task.id, status: 'done' }),
    ]);
  });

  it('physically isolates identical task ids and observers by checkout', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const taskA = createScopedTaskStore(runtimeManager, scopeA, {
      idFactory: () => 'shared-task',
    });
    const taskB = createScopedTaskStore(runtimeManager, scopeB, {
      idFactory: () => 'shared-task',
    });
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    taskA.onChange(listenerA);
    taskB.onChange(listenerB);

    taskA.create({ title: 'A' });

    expect(taskA.list()).toHaveLength(1);
    expect(taskB.list()).toEqual([]);
    expect(listenerA).toHaveBeenCalledWith({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
    });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('fails closed when persistence is unavailable', () => {
    const runtimeManager = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      databaseFactory: (() => {
        throw new Error('native database unavailable');
      }) as never,
    });
    managers.push(runtimeManager);
    const tasks = createScopedTaskStore(runtimeManager, testProjectScope());

    expect(() => tasks.list()).toThrow(/no persistence fallback/i);
    expect(() => tasks.create({ title: 'lost' })).toThrow(/no persistence fallback/i);
  });
});
