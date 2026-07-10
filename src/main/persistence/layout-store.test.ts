import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceLayout } from '../../shared/types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ScopedStoreCorruptionError } from '../orch/scoped-store';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from '../runtime/project-runtime-schema';
import { createScopedLayoutStore } from './layout-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({ baseDir, appVersion: '0.12.0-test' });
  managers.push(value);
  return value;
}

function layout(title = 'Terminal'): WorkspaceLayout {
  return {
    root: {
      kind: 'leaf',
      id: 'leaf-a',
      pane: { id: 'pane-a', kind: 'shell', title },
    },
    focusedPaneId: 'pane-a',
    viewKind: 'canvas',
    canvasNodeLayouts: {
      'pane-a': {
        position: { x: 10, y: 20 },
        size: { width: 720, height: 480 },
        z: 1,
      },
    },
    canvasViewport: { x: 1, y: 2, zoom: 1 },
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-layout-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped layout store', () => {
  it('isolates checkouts and persists a scope-bearing immutable envelope', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const storeA = createScopedLayoutStore(runtimeManager, scopeA, {
      now: () => 77,
    });
    const storeB = createScopedLayoutStore(runtimeManager, scopeB);

    const saved = storeA.save(layout());
    saved.layout.root.id = 'outside-mutation';

    expect(storeA.load()).toMatchObject({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
      updatedAt: 77,
      layout: { root: { id: 'leaf-a' } },
    });
    expect(storeB.load()).toBeNull();

    runtimeManager.close(scopeA);
    expect(createScopedLayoutStore(runtimeManager, scopeA).load()).toMatchObject({
      layout: { root: { id: 'leaf-a' } },
    });
  });

  it('round-trips pane mission identity instead of stripping UI metadata', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedLayoutStore(runtimeManager, scope);
    const agentLayout = layout();
    if (agentLayout.root.kind !== 'leaf') throw new Error('invalid fixture');
    agentLayout.root.pane = {
      ...agentLayout.root.pane,
      kind: 'cli-agent',
      adapterId: 'codex',
      role: 'worker',
      agentName: 'Reviewer',
    };

    store.save(agentLayout);

    expect(store.load()?.layout.root).toMatchObject({
      pane: { role: 'worker', agentName: 'Reviewer' },
    });
  });

  it('validates inputs and fails explicitly on corrupted persisted JSON', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedLayoutStore(runtimeManager, scope);

    expect(() =>
      store.save({ ...layout(), canvasViewport: { x: 0, y: 0, zoom: 0 } }),
    ).toThrow();
    store.save(layout());
    runtimeManager
      .open(scope)
      .db.prepare('UPDATE workspace_layout SET layout_json = ? WHERE singleton = 1')
      .run('{not-json');

    expect(() => store.load()).toThrow(ScopedStoreCorruptionError);
  });

  it('notifies only observers bound to the changed checkout', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const storeA = createScopedLayoutStore(runtimeManager, scopeA);
    const storeB = createScopedLayoutStore(runtimeManager, scopeB);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    storeA.onChange(listenerA);
    storeB.onChange(listenerB);

    storeA.save(layout());

    expect(listenerA).toHaveBeenCalledWith({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
    });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('fails closed when the runtime is unavailable', () => {
    const unavailable = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      databaseFactory: (() => {
        throw new Error('native database unavailable');
      }) as never,
    });
    managers.push(unavailable);
    const store = createScopedLayoutStore(unavailable, testProjectScope());

    expect(() => store.load()).toThrow(/no persistence fallback/i);
    expect(() => store.save(layout())).toThrow(/no persistence fallback/i);
  });

  it('allows inspection but rejects writes in safe read-only mode', () => {
    const scope = testProjectScope({ checkoutId: 'read-only-layout' });
    const writableManager = manager();
    createScopedLayoutStore(writableManager, scope).save(layout());
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
    const store = createScopedLayoutStore(safeReadOnlyManager, scope);

    expect(store.load()).not.toBeNull();
    expect(() => store.save(layout('Forbidden'))).toThrow(/read-only/i);
    expect(store.load()?.layout.root).toMatchObject({ id: 'leaf-a' });
  });
});
