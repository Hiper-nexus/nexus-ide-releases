import path from 'node:path';
import {
  ACTIVE_WORKTREE_STATUSES,
  ALL_WORKTREE_STATUSES,
  DIGEST_PATTERN,
  SHA_PATTERN,
  assertIdentifier,
  cloneWorktreeRecord,
  digest,
  exclusiveOwnershipOverlap,
  hasOwnershipOverlap,
  normalizeOwnership,
  sameValues,
  worktreeTaskKey,
  type WorktreeOwnership,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
} from './worktree-contract';

interface WorktreeStateValidationOptions {
  readonly scopeKey: string;
  readonly worktreesRoot: string;
}

function invalidState(message = 'invalid worktree state record'): never {
  throw new Error(message);
}

function isOptionalSha(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && SHA_PATTERN.test(value));
}

function isOptionalFailureReason(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length <= 2_048 && !value.includes('\0'))
  );
}

function isIntegrationRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock')
  );
}

function hasValidStatusFields(record: WorktreeRecord): boolean {
  if (
    (record.status === 'reserved' || record.status === 'ready') &&
    (record.taskHeadSha !== undefined || record.integratedSha !== undefined)
  ) {
    return false;
  }
  if (
    record.status === 'queued' &&
    (!record.taskHeadSha || record.integratedSha !== undefined)
  ) {
    return false;
  }
  if (
    record.status === 'integrated' &&
    (!record.taskHeadSha || !record.integratedSha || record.failureReason !== undefined)
  ) {
    return false;
  }
  return true;
}

function validateRecord(
  value: unknown,
  options: WorktreeStateValidationOptions,
): WorktreeRecord {
  if (!value || typeof value !== 'object') invalidState();
  const record = value as WorktreeRecord;
  let normalizedOwnership: WorktreeOwnership;
  try {
    normalizedOwnership = normalizeOwnership(record.ownership);
    assertIdentifier(record.projectId, 'stored projectId');
    assertIdentifier(record.checkoutId, 'stored checkoutId');
    assertIdentifier(record.missionId, 'stored missionId');
    assertIdentifier(record.taskId, 'stored taskId');
    assertIdentifier(record.workerId, 'stored workerId');
  } catch {
    invalidState();
  }

  const expectedTaskKey = worktreeTaskKey(record.missionId, record.taskId);
  const expectedScopeKey = digest(
    'worktree-scope',
    record.projectId,
    record.checkoutId,
  );
  const projectKey = digest('worktree-project', record.projectId);
  const checkoutKey = digest(
    'worktree-checkout',
    record.projectId,
    record.checkoutId,
  );
  const expectedPath = path.join(
    options.worktreesRoot,
    `project-${projectKey}`,
    `checkout-${checkoutKey}`,
    `task-${expectedTaskKey}`,
  );
  const expectedBranch =
    `refs/heads/nexus/${projectKey.slice(0, 16)}/${expectedTaskKey.slice(0, 32)}`;
  const dependencies = record.dependencies;

  if (
    record.scopeKey !== options.scopeKey ||
    record.scopeKey !== expectedScopeKey ||
    record.taskKey !== expectedTaskKey ||
    record.id !== `worktree-${expectedTaskKey}` ||
    record.worktreePath !== expectedPath ||
    record.branchRef !== expectedBranch ||
    typeof record.rootRealPath !== 'string' ||
    !path.isAbsolute(record.rootRealPath) ||
    path.resolve(record.rootRealPath) !== record.rootRealPath ||
    !isIntegrationRef(record.integrationRef) ||
    !ALL_WORKTREE_STATUSES.has(record.status) ||
    typeof record.baseSha !== 'string' ||
    !SHA_PATTERN.test(record.baseSha) ||
    !isOptionalSha(record.taskHeadSha) ||
    !isOptionalSha(record.integratedSha) ||
    !isOptionalFailureReason(record.failureReason) ||
    !Array.isArray(dependencies) ||
    dependencies.some(
      (dependency) =>
        typeof dependency !== 'string' ||
        !DIGEST_PATTERN.test(dependency) ||
        dependency === expectedTaskKey,
    ) ||
    new Set(dependencies).size !== dependencies.length ||
    !sameValues([...dependencies].sort(), dependencies) ||
    !sameValues(normalizedOwnership.files, record.ownership.files) ||
    !sameValues(normalizedOwnership.symbols, record.ownership.symbols) ||
    !sameValues(normalizedOwnership.domains, record.ownership.domains) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < record.createdAt ||
    !hasValidStatusFields(record)
  ) {
    invalidState();
  }
  return cloneWorktreeRecord(record);
}

export function validateWorktreeStateSnapshot(
  value: unknown,
  options: WorktreeStateValidationOptions,
): WorktreeStateSnapshot {
  if (!value || typeof value !== 'object') {
    invalidState('invalid worktree state snapshot');
  }
  const snapshot = value as WorktreeStateSnapshot;
  if (
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Array.isArray(snapshot.records)
  ) {
    invalidState('invalid worktree state snapshot');
  }

  const records = snapshot.records.map((record) => validateRecord(record, options));
  const taskKeys = new Set<string>();
  const paths = new Set<string>();
  const branches = new Set<string>();
  for (const record of records) {
    if (
      taskKeys.has(record.taskKey) ||
      paths.has(record.worktreePath) ||
      branches.has(record.branchRef)
    ) {
      invalidState();
    }
    taskKeys.add(record.taskKey);
    paths.add(record.worktreePath);
    branches.add(record.branchRef);
  }

  for (const record of records) {
    if (record.dependencies.some((dependency) => !taskKeys.has(dependency))) {
      invalidState();
    }
    for (const other of records) {
      if (record.taskKey >= other.taskKey) continue;
      if (
        ACTIVE_WORKTREE_STATUSES.has(record.status) &&
        ACTIVE_WORKTREE_STATUSES.has(other.status) &&
        // Same exclusivity rule the reservation fence applies. If this
        // disagreed with `#assertNoOwnershipConflict`, the manager would write
        // a state it could never read back.
        hasOwnershipOverlap(
          exclusiveOwnershipOverlap(record.ownership, other.ownership, {
            sameMission: record.missionId === other.missionId,
          }),
        ) &&
        !record.dependencies.includes(other.taskKey) &&
        !other.dependencies.includes(record.taskKey)
      ) {
        invalidState();
      }
    }
  }

  const roots = new Set(records.map((record) => record.rootRealPath));
  const integrationRefs = new Set(records.map((record) => record.integrationRef));
  if (roots.size > 1 || integrationRefs.size > 1) invalidState();

  return Object.freeze({
    revision: snapshot.revision,
    records: Object.freeze(records),
  });
}
