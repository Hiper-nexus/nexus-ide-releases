import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from '../runtime/project-runtime-schema';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mission-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped mission store', () => {
  it('physically isolates projects and returns explicit scope coordinates', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ projectId: 'project-b', checkoutId: 'checkout-b' });
    const storeA = createScopedMissionStore(runtimeManager, scopeA);
    const storeB = createScopedMissionStore(runtimeManager, scopeB);

    const mission = storeA.create({ title: 'Only A', milestones: ['one'] });

    expect(mission).toMatchObject({
      title: 'Only A',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
    });
    expect(storeA.list()).toEqual([mission]);
    expect(storeB.list()).toEqual([]);
    expect(runtimeManager.open(scopeA).databasePath).not.toBe(
      runtimeManager.open(scopeB).databasePath,
    );
  });

  it('persists every mutation and never exposes mutable stored arrays', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => 42,
      idFactory: () => 'mission-stable',
    });
    const created = store.create({
      title: 'Review',
      milestones: ['design'],
      orchestratorSessionId: 'session-a',
    });
    created.milestones.push('mutated-outside');

    expect(store.get('mission-stable')?.milestones).toEqual(['design']);
    expect(store.update('mission-stable', { milestones: ['tested'] })).toMatchObject({
      status: 'pending',
      milestones: ['tested'],
    });
    expect(store.setStatus('mission-stable', 'running')?.status).toBe('running');
    expect(store.setOrchestratorSession('mission-stable', 'session-b')).toMatchObject({
      orchestratorSessionId: 'session-b',
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-stable')).toMatchObject({
      status: 'running',
      orchestratorSessionId: 'session-b',
      milestones: ['tested'],
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    });
    expect(reopened.remove('mission-stable')).toBe(true);
    expect(reopened.remove('mission-stable')).toBe(false);
  });

  it('notifies only observers bound to the mutated scope', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const storeA = createScopedMissionStore(runtimeManager, scopeA);
    const storeB = createScopedMissionStore(runtimeManager, scopeB);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    storeA.onChange(listenerA);
    storeB.onChange(listenerB);

    storeA.create({ title: 'A' });

    expect(listenerA).toHaveBeenCalledWith({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
    });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('fails closed when the runtime is unavailable instead of retaining memory data', () => {
    const unavailable = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      databaseFactory: (() => {
        throw new Error('native database unavailable');
      }) as never,
    });
    managers.push(unavailable);
    const store = createScopedMissionStore(unavailable, testProjectScope());

    expect(() => store.list()).toThrow(/no persistence fallback/i);
    expect(() => store.create({ title: 'must not exist' })).toThrow(
      /no persistence fallback/i,
    );
  });

  it('allows inspection but rejects writes in engine-enforced safe read-only mode', () => {
    const scope = testProjectScope({ checkoutId: 'read-only' });
    const writableManager = manager();
    createScopedMissionStore(writableManager, scope, {
      idFactory: () => 'mission-read-only',
    }).create({ title: 'Persisted before failure' });
    writableManager.closeAll();

    const original = INITIAL_PROJECT_MIGRATIONS[0];
    const changed = createProjectMigration({
      id: original.id,
      schemaVersion: original.schemaVersion,
      appVersion: original.appVersion,
      sql: `${original.sql}\n-- immutable checksum changed`,
    });
    const safeReadOnlyManager = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      migrations: [changed],
    });
    managers.push(safeReadOnlyManager);
    const store = createScopedMissionStore(safeReadOnlyManager, scope);

    expect(store.list()).toHaveLength(1);
    expect(safeReadOnlyManager.open(scope).mode).toBe('safe-read-only');
    expect(() => store.create({ title: 'forbidden' })).toThrow(/read-only/i);
    expect(() => store.update('missing', {})).toThrow(/read-only/i);
    expect(store.list()).toHaveLength(1);
  });
});
