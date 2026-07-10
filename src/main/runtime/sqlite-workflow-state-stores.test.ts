import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from './project-runtime-manager';
import {
  SqliteMergeQueueStateStore,
  SqliteWorktreeStateStore,
} from './sqlite-workflow-state-stores';
import { digest } from './worktree-contract';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workflow-state-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('SQLite worktree/merge CAS state', () => {
  it('persists empty CAS revisions and rejects stale writers', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const key = digest('worktree-scope', scope.projectId, scope.checkoutId);
    const worktrees = new SqliteWorktreeStateStore(manager, scope);
    const merges = new SqliteMergeQueueStateStore(manager, scope);

    expect(worktrees.compareAndSwap(key, 0, [])).toBe(true);
    expect(worktrees.compareAndSwap(key, 0, [])).toBe(false);
    expect(worktrees.read(key)).toEqual({ revision: 1, records: [] });
    expect(merges.compareAndSwap(key, 0, {
      activeTaskKey: null, blocked: null, events: [], entries: [],
    })).toBe(true);
    expect(merges.compareAndSwap(key, 0, {
      activeTaskKey: null, blocked: null, events: [], entries: [],
    })).toBe(false);
    expect(merges.read(key)).toMatchObject({ revision: 1, entries: [] });
  });

  it('physically isolates checkouts and rejects a foreign scope key', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scopeA = testProjectScope({ checkoutId: 'a' });
    const scopeB = testProjectScope({ checkoutId: 'b' });
    const keyA = digest('worktree-scope', scopeA.projectId, scopeA.checkoutId);
    const storeA = new SqliteWorktreeStateStore(manager, scopeA);
    const storeB = new SqliteWorktreeStateStore(manager, scopeB);
    expect(storeA.compareAndSwap(keyA, 0, [])).toBe(true);
    expect(() => storeB.read(keyA)).toThrow(/scope/i);
    const keyB = digest('worktree-scope', scopeB.projectId, scopeB.checkoutId);
    expect(storeB.read(keyB).revision).toBe(0);
  });
});
