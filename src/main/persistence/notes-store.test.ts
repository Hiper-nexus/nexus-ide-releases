import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ScopedStoreCorruptionError } from '../orch/scoped-store';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from '../runtime/project-runtime-schema';
import { createScopedNotesStore } from './notes-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({ baseDir, appVersion: '0.12.0-test' });
  managers.push(value);
  return value;
}

function note(id = 'note-a') {
  return {
    id,
    text: 'Review the billing invariant',
    x: 10,
    y: 20,
    w: 320,
    h: 180,
    color: 'yellow' as const,
    linkedPaneId: 'pane-a',
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-notes-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped notes store', () => {
  it('physically isolates checkouts, persists mutations and returns scope coordinates', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const storeA = createScopedNotesStore(runtimeManager, scopeA, {
      now: () => 42,
    });
    const storeB = createScopedNotesStore(runtimeManager, scopeB);

    const saved = storeA.save(note());
    saved.text = 'outside mutation';

    expect(storeA.list()).toEqual([
      expect.objectContaining({
        id: 'note-a',
        text: 'Review the billing invariant',
        projectId: scopeA.projectId,
        checkoutId: scopeA.checkoutId,
      }),
    ]);
    expect(storeB.list()).toEqual([]);

    runtimeManager.close(scopeA);
    expect(createScopedNotesStore(runtimeManager, scopeA).list()).toHaveLength(1);
    expect(storeB.remove('note-a')).toBe(false);
    expect(createScopedNotesStore(runtimeManager, scopeA).remove('note-a')).toBe(true);
    expect(createScopedNotesStore(runtimeManager, scopeA).remove('note-a')).toBe(false);
  });

  it('validates inputs and fails explicitly on a corrupted persisted row', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedNotesStore(runtimeManager, scope);

    expect(() => store.save({ ...note(), w: 0 })).toThrow();
    store.save(note());
    runtimeManager
      .open(scope)
      .db.prepare('UPDATE sticky_notes SET color = ? WHERE id = ?')
      .run('not-a-note-color', 'note-a');

    expect(() => store.list()).toThrow(ScopedStoreCorruptionError);
  });

  it('notifies only observers bound to the changed checkout', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const storeA = createScopedNotesStore(runtimeManager, scopeA);
    const storeB = createScopedNotesStore(runtimeManager, scopeB);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    storeA.onChange(listenerA);
    storeB.onChange(listenerB);

    storeA.save(note());

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
    const store = createScopedNotesStore(unavailable, testProjectScope());

    expect(() => store.list()).toThrow(/no persistence fallback/i);
    expect(() => store.save(note())).toThrow(/no persistence fallback/i);
  });

  it('allows inspection but rejects mutations in safe read-only mode', () => {
    const scope = testProjectScope({ checkoutId: 'read-only-notes' });
    const writableManager = manager();
    createScopedNotesStore(writableManager, scope).save(note());
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
    const store = createScopedNotesStore(safeReadOnlyManager, scope);

    expect(store.list()).toHaveLength(1);
    expect(() => store.save({ ...note(), text: 'forbidden' })).toThrow(
      /read-only/i,
    );
    expect(() => store.remove('missing')).toThrow(/read-only/i);
    expect(store.list()).toHaveLength(1);
  });
});
