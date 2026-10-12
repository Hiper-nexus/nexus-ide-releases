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
import {
  digest,
  worktreeTaskKey,
  type WorktreeRecord,
} from './worktree-contract';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];
const legacyRoots: string[] = [];

function worktreeIdentity(
  scope: ReturnType<typeof testProjectScope>,
  missionId: string,
  taskId: string,
): {
  readonly taskKey: string;
  readonly relativePath: string;
  readonly branchRef: string;
} {
  const taskKey = worktreeTaskKey(missionId, taskId);
  const projectKey = digest('worktree-project', scope.projectId);
  const checkoutKey = digest(
    'worktree-checkout',
    scope.projectId,
    scope.checkoutId,
  );
  return {
    taskKey,
    relativePath: path.join(
      `project-${projectKey}`,
      `checkout-${checkoutKey}`,
      `task-${taskKey}`,
    ),
    branchRef:
      `refs/heads/nexus/${projectKey.slice(0, 16)}/${taskKey.slice(0, 32)}`,
  };
}

function rawRecord(input: {
  scope: ReturnType<typeof testProjectScope>;
  scopeKey: string;
  missionId: string;
  taskId: string;
  worktreePath: string;
  status?: WorktreeRecord['status'];
  ownership?: WorktreeRecord['ownership'];
}): WorktreeRecord {
  const identity = worktreeIdentity(
    input.scope,
    input.missionId,
    input.taskId,
  );
  return {
    id: `worktree-${identity.taskKey}`,
    scopeKey: input.scopeKey,
    projectId: input.scope.projectId,
    checkoutId: input.scope.checkoutId,
    missionId: input.missionId,
    taskId: input.taskId,
    taskKey: identity.taskKey,
    workerId: 'worker-legacy',
    rootRealPath: input.scope.rootRealPath,
    worktreePath: input.worktreePath,
    branchRef: identity.branchRef,
    integrationRef: 'refs/heads/main',
    baseSha: 'a'.repeat(40),
    ownership: input.ownership ?? {
      files: ['owned.txt'],
      symbols: [],
      domains: ['legacy'],
    },
    dependencies: [],
    status: input.status ?? 'ready',
    failureReason: input.status === 'failed' ? 'legacy failure' : undefined,
    createdAt: 1,
    updatedAt: 2,
  };
}

/** Merge row as a newer build would write it: one event type this build lacks. */
function futureMergeStateJson(): string {
  return JSON.stringify({
    activeTaskKey: null,
    blocked: null,
    entries: [],
    events: [{
      id: `merge-event-${'b'.repeat(64)}`,
      type: 'future-type',
      taskKey: 'c'.repeat(64),
      attempt: 1,
      stateRevision: 1,
      occurredAt: 1,
      evidenceIds: [],
    }],
  });
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workflow-state-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
  for (const root of legacyRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

  it('quarantines a canonically relocated runtime row without deleting user work', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const key = digest('worktree-scope', scope.projectId, scope.checkoutId);
    const identity = worktreeIdentity(scope, 'mission-live-copy', 'task-copy');
    const legacyRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-workflow-legacy-root-'),
    );
    legacyRoots.push(legacyRoot);
    const legacyWorktree = path.join(
      legacyRoot,
      'worktrees',
      identity.relativePath,
    );
    fs.mkdirSync(legacyWorktree, { recursive: true });
    const userArtifact = path.join(legacyWorktree, 'uncommitted-user-work.txt');
    fs.writeFileSync(userArtifact, 'preserve me\n');
    const recordsJson = JSON.stringify([
      rawRecord({
        scope,
        scopeKey: key,
        missionId: 'mission-live-copy',
        taskId: 'task-copy',
        worktreePath: legacyWorktree,
      }),
    ]);
    const db = manager.open(scope).db;
    db.prepare(
      `INSERT INTO worktree_state
         (scope_key, revision, records_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(key, 7, recordsJson, 11);
    const merges = new SqliteMergeQueueStateStore(manager, scope);
    expect(
      merges.compareAndSwap(key, 0, {
        activeTaskKey: null,
        blocked: null,
        events: [],
        entries: [],
      }),
    ).toBe(true);
    const worktrees = new SqliteWorktreeStateStore(manager, scope);

    expect(() => worktrees.read(key)).toThrow(/invalid worktree state/i);
    expect(worktrees.recoverInvalidState(key)).toMatchObject({
      action: 'quarantined',
      reason: 'relocated-runtime-binding',
      recordCount: 1,
    });
    expect(worktrees.read(key)).toEqual({ revision: 8, records: [] });
    expect(merges.read(key)).toMatchObject({ revision: 2, entries: [] });
    expect(fs.readFileSync(userArtifact, 'utf8')).toBe('preserve me\n');

    const quarantine = db
      .prepare(
        `SELECT source_records_json, merge_revision, reason
         FROM worktree_state_quarantine WHERE scope_key = ?`,
      )
      .get(key);
    expect(quarantine).toEqual({
      source_records_json: recordsJson,
      merge_revision: 1,
      reason: 'relocated-runtime-binding',
    });
  });

  it('fails closed for an invalid row that may still own a current worktree', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const key = digest('worktree-scope', scope.projectId, scope.checkoutId);
    const identity = worktreeIdentity(
      scope,
      'mission-current',
      'task-current',
    );
    const currentWorktree = path.join(
      manager.locationFor(scope).directory,
      'worktrees',
      identity.relativePath,
    );
    fs.mkdirSync(currentWorktree, { recursive: true });
    const userArtifact = path.join(currentWorktree, 'current-user-work.txt');
    fs.writeFileSync(userArtifact, 'still active\n');
    const recordsJson = JSON.stringify([
      rawRecord({
        scope,
        scopeKey: key,
        missionId: 'mission-current',
        taskId: 'task-current',
        worktreePath: currentWorktree,
        ownership: {
          files: ['../invalid-but-potentially-current'],
          symbols: [],
          domains: ['current'],
        },
      }),
    ]);
    const db = manager.open(scope).db;
    db.prepare(
      `INSERT INTO worktree_state
         (scope_key, revision, records_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(key, 3, recordsJson, 5);
    const worktrees = new SqliteWorktreeStateStore(manager, scope);

    expect(() => worktrees.read(key)).toThrow(/invalid worktree state/i);
    expect(worktrees.recoverInvalidState(key)).toEqual({
      action: 'blocked',
      reason: 'unproven-invalid-state',
    });
    expect(
      db
        .prepare(
          'SELECT revision, records_json FROM worktree_state WHERE scope_key = ?',
        )
        .get(key),
    ).toEqual({ revision: 3, records_json: recordsJson });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM worktree_state_quarantine',
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(fs.readFileSync(userArtifact, 'utf8')).toBe('still active\n');
  });

  it('archives a terminal legacy projection while preserving its checkout', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const key = digest('worktree-scope', scope.projectId, scope.checkoutId);
    const identity = worktreeIdentity(
      scope,
      'mission-terminal',
      'task-terminal',
    );
    const terminalWorktree = path.join(
      manager.locationFor(scope).directory,
      'worktrees',
      identity.relativePath,
    );
    fs.mkdirSync(terminalWorktree, { recursive: true });
    const userArtifact = path.join(terminalWorktree, 'terminal-user-work.txt');
    fs.writeFileSync(userArtifact, 'do not delete\n');
    const recordsJson = JSON.stringify([
      rawRecord({
        scope,
        scopeKey: key,
        missionId: 'mission-terminal',
        taskId: 'task-terminal',
        worktreePath: terminalWorktree,
        status: 'failed',
        ownership: {
          files: ['../legacy-invalid'],
          symbols: [],
          domains: ['terminal'],
        },
      }),
    ]);
    const db = manager.open(scope).db;
    db.prepare(
      `INSERT INTO worktree_state
         (scope_key, revision, records_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(key, 4, recordsJson, 8);
    const worktrees = new SqliteWorktreeStateStore(manager, scope);

    expect(worktrees.recoverInvalidState(key)).toMatchObject({
      action: 'quarantined',
      reason: 'terminal-legacy-state',
    });
    expect(worktrees.read(key)).toEqual({ revision: 5, records: [] });
    expect(fs.readFileSync(userArtifact, 'utf8')).toBe('do not delete\n');
  });

  it('F-1276: archives the terminal legacy projection of a mission that ended blocked', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const key = digest('worktree-scope', scope.projectId, scope.checkoutId);
    const identity = worktreeIdentity(scope, 'mission-blocked', 'task-blocked');
    const worktreePath = path.join(
      manager.locationFor(scope).directory,
      'worktrees',
      identity.relativePath,
    );
    const db = manager.open(scope).db;
    db.prepare(
      `INSERT INTO missions (id, title, status, created_at, updated_at)
       VALUES (?, ?, 'blocked', 1, 1)`,
    ).run('mission-blocked', 'mission-blocked');
    db.prepare(
      `INSERT INTO worktree_state
         (scope_key, revision, records_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(key, 4, JSON.stringify([
      rawRecord({
        scope,
        scopeKey: key,
        missionId: 'mission-blocked',
        taskId: 'task-blocked',
        worktreePath,
        status: 'failed',
        ownership: { files: ['../legacy-invalid'], symbols: [], domains: [] },
      }),
    ]), 8);
    const worktrees = new SqliteWorktreeStateStore(manager, scope);

    expect(worktrees.recoverInvalidState(key)).toMatchObject({
      action: 'quarantined',
      reason: 'terminal-legacy-state',
    });
    expect(worktrees.read(key)).toEqual({ revision: 5, records: [] });
  });

  it('F-1275: archives an unreadable merge queue row next to a valid worktree projection', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const key = digest('worktree-scope', scope.projectId, scope.checkoutId);
    const worktrees = new SqliteWorktreeStateStore(manager, scope);
    const merges = new SqliteMergeQueueStateStore(manager, scope);
    expect(worktrees.compareAndSwap(key, 0, [])).toBe(true);
    const stateJson = futureMergeStateJson();
    const db = manager.open(scope).db;
    db.prepare(
      `INSERT INTO merge_queue_state
         (scope_key, revision, state_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(key, 3, stateJson, 9);
    expect(() => merges.read(key)).toThrow(/invalid merge queue state/i);

    expect(worktrees.recoverInvalidState(key)).toMatchObject({
      action: 'quarantined',
      recordCount: 0,
    });
    expect(merges.read(key)).toEqual({
      revision: 4,
      activeTaskKey: null,
      blocked: null,
      events: [],
      entries: [],
    });
    expect(worktrees.read(key)).toEqual({ revision: 2, records: [] });
    expect(
      db
        .prepare(
          `SELECT source_revision, merge_state_json
           FROM worktree_state_quarantine WHERE scope_key = ?`,
        )
        .get(key),
    ).toEqual({ source_revision: 1, merge_state_json: stateJson });
    expect(worktrees.recoverInvalidState(key)).toEqual({ action: 'none' });
  });

  it('F-1275: keeps an unreadable merge queue fail-closed while a worktree is queued', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const key = digest('worktree-scope', scope.projectId, scope.checkoutId);
    const identity = worktreeIdentity(scope, 'mission-queued', 'task-queued');
    const worktrees = new SqliteWorktreeStateStore(manager, scope);
    expect(worktrees.compareAndSwap(key, 0, [{
      ...rawRecord({
        scope,
        scopeKey: key,
        missionId: 'mission-queued',
        taskId: 'task-queued',
        worktreePath: path.join(
          manager.locationFor(scope).directory,
          'worktrees',
          identity.relativePath,
        ),
        status: 'queued',
      }),
      taskHeadSha: 'b'.repeat(40),
    }])).toBe(true);
    const stateJson = futureMergeStateJson();
    const db = manager.open(scope).db;
    db.prepare(
      `INSERT INTO merge_queue_state
         (scope_key, revision, state_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(key, 3, stateJson, 9);

    expect(worktrees.recoverInvalidState(key)).toEqual({
      action: 'blocked',
      reason: 'unproven-invalid-state',
    });
    expect(
      db
        .prepare(
          'SELECT revision, state_json FROM merge_queue_state WHERE scope_key = ?',
        )
        .get(key),
    ).toEqual({ revision: 3, state_json: stateJson });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM worktree_state_quarantine').get(),
    ).toEqual({ count: 0 });
  });
});
