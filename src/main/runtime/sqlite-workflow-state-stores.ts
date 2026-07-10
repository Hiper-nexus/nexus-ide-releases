import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from './project-runtime-manager';
import { ScopedStoreBinding, ScopedStoreCorruptionError } from '../orch/scoped-store';
import { canonicalJson } from '../context/canonical-json';
import {
  digest,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from './worktree-contract';
import { validateWorktreeStateSnapshot } from './worktree-state';
import type {
  MergeQueueStateSnapshot,
  MergeQueueStateStore,
} from './merge-queue-contract';
import { validateMergeQueueStateSnapshot } from './merge-queue-state';

function parseJson(raw: string, label: string): unknown {
  try {
    if (Buffer.byteLength(raw, 'utf8') > 16 * 1024 * 1024) {
      throw new Error('state exceeds 16 MiB');
    }
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}

function expectedScopeKey(scope: ProjectExecutionScope): string {
  return digest('worktree-scope', scope.projectId, scope.checkoutId);
}

function assertScopeKey(scope: ProjectExecutionScope, scopeKey: string): void {
  if (scopeKey !== expectedScopeKey(scope)) {
    throw new Error('workflow state key does not match project scope');
  }
}

export class SqliteWorktreeStateStore implements WorktreeStateStore {
  readonly #binding: ScopedStoreBinding;
  readonly #worktreesRoot: string;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope);
    this.#worktreesRoot = path.join(runtimeManager.locationFor(scope).directory, 'worktrees');
  }

  read(scopeKey: string): WorktreeStateSnapshot {
    assertScopeKey(this.#binding.scope, scopeKey);
    const row = this.#binding.readDatabase()
      .prepare('SELECT revision, records_json FROM worktree_state WHERE scope_key = ?')
      .get(scopeKey) as { revision: number; records_json: string } | undefined;
    if (!row) return Object.freeze({ revision: 0, records: Object.freeze([]) });
    try {
      return validateWorktreeStateSnapshot(
        { revision: row.revision, records: parseJson(row.records_json, 'worktree state') },
        { scopeKey, worktreesRoot: this.#worktreesRoot },
      );
    } catch (error) {
      if (error instanceof ScopedStoreCorruptionError) throw error;
      throw new ScopedStoreCorruptionError('worktree state', { cause: error });
    }
  }

  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean {
    assertScopeKey(this.#binding.scope, scopeKey);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('invalid expected worktree revision');
    }
    const candidate = validateWorktreeStateSnapshot(
      { revision: expectedRevision + 1, records },
      { scopeKey, worktreesRoot: this.#worktreesRoot },
    );
    const db = this.#binding.writeDatabase();
    return db.transaction(() => {
      if (expectedRevision === 0) {
        const result = db.prepare(
          `INSERT OR IGNORE INTO worktree_state
             (scope_key, revision, records_json, updated_at)
           VALUES (?, 1, ?, ?)`,
        ).run(scopeKey, canonicalJson(candidate.records), Date.now());
        return result.changes === 1;
      }
      const result = db.prepare(
        `UPDATE worktree_state
         SET revision = ?, records_json = ?, updated_at = ?
         WHERE scope_key = ? AND revision = ?`,
      ).run(
        candidate.revision,
        canonicalJson(candidate.records),
        Date.now(),
        scopeKey,
        expectedRevision,
      );
      return result.changes === 1;
    })();
  }
}

export class SqliteMergeQueueStateStore implements MergeQueueStateStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope);
  }

  read(scopeKey: string): MergeQueueStateSnapshot {
    assertScopeKey(this.#binding.scope, scopeKey);
    const row = this.#binding.readDatabase()
      .prepare('SELECT revision, state_json FROM merge_queue_state WHERE scope_key = ?')
      .get(scopeKey) as { revision: number; state_json: string } | undefined;
    if (!row) {
      return Object.freeze({
        revision: 0,
        activeTaskKey: null,
        blocked: null,
        events: Object.freeze([]),
        entries: Object.freeze([]),
      });
    }
    try {
      const state = parseJson(row.state_json, 'merge queue state') as Record<string, unknown>;
      return validateMergeQueueStateSnapshot({ revision: row.revision, ...state });
    } catch (error) {
      if (error instanceof ScopedStoreCorruptionError) throw error;
      throw new ScopedStoreCorruptionError('merge queue state', { cause: error });
    }
  }

  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    state: Omit<MergeQueueStateSnapshot, 'revision'>,
  ): boolean {
    assertScopeKey(this.#binding.scope, scopeKey);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('invalid expected merge queue revision');
    }
    const candidate = validateMergeQueueStateSnapshot({
      ...state,
      revision: expectedRevision + 1,
    });
    const serialized = canonicalJson({
      activeTaskKey: candidate.activeTaskKey,
      blocked: candidate.blocked,
      events: candidate.events,
      entries: candidate.entries,
    });
    const db = this.#binding.writeDatabase();
    return db.transaction(() => {
      if (expectedRevision === 0) {
        const result = db.prepare(
          `INSERT OR IGNORE INTO merge_queue_state
             (scope_key, revision, state_json, updated_at)
           VALUES (?, 1, ?, ?)`,
        ).run(scopeKey, serialized, Date.now());
        return result.changes === 1;
      }
      const result = db.prepare(
        `UPDATE merge_queue_state
         SET revision = ?, state_json = ?, updated_at = ?
         WHERE scope_key = ? AND revision = ?`,
      ).run(
        candidate.revision,
        serialized,
        Date.now(),
        scopeKey,
        expectedRevision,
      );
      return result.changes === 1;
    })();
  }
}
