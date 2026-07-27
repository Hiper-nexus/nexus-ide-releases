import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from './project-runtime-manager';
import { ScopedStoreBinding, ScopedStoreCorruptionError } from '../orch/scoped-store';
import { canonicalJson } from '../context/canonical-json';
import {
  digest,
  ALL_WORKTREE_STATUSES,
  worktreeTaskKey,
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

export type WorktreeStateRecoveryReason =
  | 'relocated-runtime-binding'
  | 'terminal-legacy-state';

export type WorktreeStateRecoveryResult =
  | { readonly action: 'none' }
  | {
      readonly action: 'quarantined';
      readonly quarantineId: string;
      readonly reason: WorktreeStateRecoveryReason;
      readonly recordCount: number;
    }
  | {
      readonly action: 'blocked';
      readonly reason: 'unproven-invalid-state';
    };

interface RawWorktreeStateRow {
  readonly revision: number;
  readonly records_json: string;
  readonly updated_at: number;
}

interface RawMergeStateRow {
  readonly revision: number;
  readonly state_json: string;
  readonly updated_at: number;
}

interface RecoverableWorktreeIdentity {
  readonly missionId: string;
  readonly taskId: string;
  readonly status: string;
  readonly worktreePath: string;
  readonly expectedRelativePath: string;
}

const TERMINAL_WORKTREE_STATUSES = new Set([
  'integrated',
  'failed',
  'abandoned',
]);
const TERMINAL_MISSION_STATUSES = new Set(['done', 'failed']);
const TERMINAL_TASK_STATUSES = new Set(['done', 'failed']);
const TERMINAL_DISPATCH_STATES = new Set([
  'completed',
  'blocked',
  'failed',
  'superseded',
]);
const MAX_RECOVERY_RECORDS = 8_192;

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !value.includes('\0')
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Extract only the immutable identity needed to prove that an invalid row is
 * a relocated runtime copy or a terminal legacy projection. Any ambiguity
 * returns null and leaves the row fail-closed.
 */
function recoverableIdentities(
  raw: string,
  scope: ProjectExecutionScope,
  scopeKey: string,
): readonly RecoverableWorktreeIdentity[] | null {
  let parsed: unknown;
  try {
    if (Buffer.byteLength(raw, 'utf8') > 16 * 1024 * 1024) return null;
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_RECOVERY_RECORDS
  ) {
    return null;
  }

  const projectKey = digest('worktree-project', scope.projectId);
  const checkoutKey = digest(
    'worktree-checkout',
    scope.projectId,
    scope.checkoutId,
  );
  const identities: RecoverableWorktreeIdentity[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      record.projectId !== scope.projectId ||
      record.checkoutId !== scope.checkoutId ||
      record.rootRealPath !== scope.rootRealPath ||
      record.scopeKey !== scopeKey ||
      !isIdentifier(record.missionId) ||
      !isIdentifier(record.taskId) ||
      !isIdentifier(record.workerId) ||
      typeof record.status !== 'string' ||
      !ALL_WORKTREE_STATUSES.has(record.status as WorktreeRecord['status'])
    ) {
      return null;
    }
    const taskKey = worktreeTaskKey(record.missionId, record.taskId);
    const expectedRelativePath = path.join(
      `project-${projectKey}`,
      `checkout-${checkoutKey}`,
      `task-${taskKey}`,
    );
    const worktreePath = record.worktreePath;
    const expectedBranch =
      `refs/heads/nexus/${projectKey.slice(0, 16)}/${taskKey.slice(0, 32)}`;
    if (
      record.taskKey !== taskKey ||
      record.id !== `worktree-${taskKey}` ||
      record.branchRef !== expectedBranch ||
      typeof worktreePath !== 'string' ||
      !path.isAbsolute(worktreePath) ||
      path.resolve(worktreePath) !== worktreePath
    ) {
      return null;
    }
    identities.push({
      missionId: record.missionId,
      taskId: record.taskId,
      status: record.status,
      worktreePath,
      expectedRelativePath,
    });
  }
  return Object.freeze(identities);
}

function isCanonicalRelocatedBinding(
  identity: RecoverableWorktreeIdentity,
  worktreesRoot: string,
): boolean {
  return (
    !isInside(worktreesRoot, identity.worktreePath) &&
    identity.worktreePath.endsWith(
      `${path.sep}${identity.expectedRelativePath}`,
    )
  );
}

function hasOnlyTerminalDurableAuthority(
  db: Database.Database,
  identities: readonly RecoverableWorktreeIdentity[],
): boolean {
  const missionStatement = db.prepare(
    'SELECT status FROM missions WHERE id = ?',
  );
  const taskStatement = db.prepare(
    'SELECT status FROM tasks WHERE id = ? AND mission_id = ?',
  );
  const dispatchStatement = db.prepare(
    `SELECT state FROM task_dispatch_queue
     WHERE task_id = ? AND mission_id = ?`,
  );
  return identities.every((identity) => {
    if (!TERMINAL_WORKTREE_STATUSES.has(identity.status)) return false;
    const mission = missionStatement.get(identity.missionId) as
      | { status: string }
      | undefined;
    if (mission && !TERMINAL_MISSION_STATUSES.has(mission.status)) {
      return false;
    }
    const task = taskStatement.get(
      identity.taskId,
      identity.missionId,
    ) as { status: string } | undefined;
    if (task && !TERMINAL_TASK_STATUSES.has(task.status)) return false;
    const dispatch = dispatchStatement.get(
      identity.taskId,
      identity.missionId,
    ) as { state: string } | undefined;
    return !dispatch || TERMINAL_DISPATCH_STATES.has(dispatch.state);
  });
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

  /**
   * Startup-only repair for copied runtime roots and terminal pre-validator
   * rows. The exact raw payload is archived transactionally before the live
   * projection is reset. Ambiguous or current ownership remains fail-closed.
   *
   * This method deliberately performs no filesystem or Git mutation.
   */
  recoverInvalidState(scopeKey: string): WorktreeStateRecoveryResult {
    assertScopeKey(this.#binding.scope, scopeKey);
    try {
      this.read(scopeKey);
      return Object.freeze({ action: 'none' });
    } catch (error) {
      if (!(error instanceof ScopedStoreCorruptionError)) throw error;
    }

    const readDb = this.#binding.readDatabase();
    const row = readDb
      .prepare(
        `SELECT revision, records_json, updated_at
         FROM worktree_state WHERE scope_key = ?`,
      )
      .get(scopeKey) as RawWorktreeStateRow | undefined;
    if (
      !row ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      row.revision >= Number.MAX_SAFE_INTEGER ||
      !isSafeTimestamp(row.updated_at)
    ) {
      return Object.freeze({
        action: 'blocked',
        reason: 'unproven-invalid-state',
      });
    }
    const identities = recoverableIdentities(
      row.records_json,
      this.#binding.scope,
      scopeKey,
    );
    if (!identities) {
      return Object.freeze({
        action: 'blocked',
        reason: 'unproven-invalid-state',
      });
    }
    const relocated = identities.every((identity) =>
      isCanonicalRelocatedBinding(identity, this.#worktreesRoot),
    );
    const terminal =
      !relocated && hasOnlyTerminalDurableAuthority(readDb, identities);
    if (!relocated && !terminal) {
      return Object.freeze({
        action: 'blocked',
        reason: 'unproven-invalid-state',
      });
    }
    const reason: WorktreeStateRecoveryReason = relocated
      ? 'relocated-runtime-binding'
      : 'terminal-legacy-state';
    const merge = readDb
      .prepare(
        `SELECT revision, state_json, updated_at
         FROM merge_queue_state WHERE scope_key = ?`,
      )
      .get(scopeKey) as RawMergeStateRow | undefined;
    if (
      merge &&
      (!Number.isSafeInteger(merge.revision) ||
        merge.revision < 0 ||
        merge.revision >= Number.MAX_SAFE_INTEGER ||
        typeof merge.state_json !== 'string' ||
        Buffer.byteLength(merge.state_json, 'utf8') > 16 * 1024 * 1024 ||
        !isSafeTimestamp(merge.updated_at))
    ) {
      return Object.freeze({
        action: 'blocked',
        reason: 'unproven-invalid-state',
      });
    }

    const quarantineId = digest(
      'worktree-state-quarantine',
      scopeKey,
      String(row.revision),
      row.records_json,
      merge ? String(merge.revision) : '',
      merge?.state_json ?? '',
      reason,
    );
    const quarantinedAt = Date.now();
    if (!isSafeTimestamp(quarantinedAt)) {
      throw new Error('worktree quarantine clock returned an invalid timestamp');
    }
    const db = this.#binding.writeDatabase();
    db.transaction(() => {
      const current = db
        .prepare(
          `SELECT revision, records_json, updated_at
           FROM worktree_state WHERE scope_key = ?`,
        )
        .get(scopeKey) as RawWorktreeStateRow | undefined;
      if (
        !current ||
        current.revision !== row.revision ||
        current.records_json !== row.records_json ||
        current.updated_at !== row.updated_at
      ) {
        throw new Error(
          'worktree state changed while invalid-state recovery was proving authority',
        );
      }
      const currentMerge = db
        .prepare(
          `SELECT revision, state_json, updated_at
           FROM merge_queue_state WHERE scope_key = ?`,
        )
        .get(scopeKey) as RawMergeStateRow | undefined;
      if (
        (merge === undefined) !== (currentMerge === undefined) ||
        (merge &&
          currentMerge &&
          (merge.revision !== currentMerge.revision ||
            merge.state_json !== currentMerge.state_json ||
            merge.updated_at !== currentMerge.updated_at))
      ) {
        throw new Error(
          'merge state changed while invalid-state recovery was proving authority',
        );
      }
      db.prepare(
        `INSERT INTO worktree_state_quarantine
           (id, scope_key, source_revision, source_records_json,
            source_updated_at, merge_revision, merge_state_json,
            merge_updated_at, reason, quarantined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        quarantineId,
        scopeKey,
        row.revision,
        row.records_json,
        row.updated_at,
        merge?.revision ?? null,
        merge?.state_json ?? null,
        merge?.updated_at ?? null,
        reason,
        quarantinedAt,
      );
      const worktreeUpdate = db
        .prepare(
          `UPDATE worktree_state
           SET revision = ?, records_json = ?, updated_at = ?
           WHERE scope_key = ? AND revision = ?
             AND records_json = ? AND updated_at = ?`,
        )
        .run(
          row.revision + 1,
          canonicalJson([]),
          quarantinedAt,
          scopeKey,
          row.revision,
          row.records_json,
          row.updated_at,
        );
      if (worktreeUpdate.changes !== 1) {
        throw new Error('invalid worktree state recovery CAS did not converge');
      }
      if (merge) {
        const mergeUpdate = db
          .prepare(
            `UPDATE merge_queue_state
             SET revision = ?, state_json = ?, updated_at = ?
             WHERE scope_key = ? AND revision = ?
               AND state_json = ? AND updated_at = ?`,
          )
          .run(
            merge.revision + 1,
            canonicalJson({
              activeTaskKey: null,
              blocked: null,
              events: [],
              entries: [],
            }),
            quarantinedAt,
            scopeKey,
            merge.revision,
            merge.state_json,
            merge.updated_at,
          );
        if (mergeUpdate.changes !== 1) {
          throw new Error('invalid merge state recovery CAS did not converge');
        }
      }
    })();
    return Object.freeze({
      action: 'quarantined',
      quarantineId,
      reason,
      recordCount: identities.length,
    });
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
