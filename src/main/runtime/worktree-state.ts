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
  MAX_PANE_BINDINGS,
  worktreeTaskKey,
  worktreeBranchRef,
  type WorktreeOwnership,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
} from './worktree-contract';
import { acceptedWorktreePaths } from './managed-worktree-layout';

interface WorktreeStateValidationOptions {
  readonly scopeKey: string;
  readonly worktreesRoot: string;
  /** Raiz histórica do checkout; no win32 aceita registros de antes do F-654. */
  readonly legacyWorktreesRoot?: string;
}

function invalidState(message = 'invalid worktree state record'): never {
  throw new Error(message);
}

/** Quem é o writer, sem segredo: missão/task/worker já são identificadores. */
function describeWriter(record: WorktreeRecord): string {
  return `writer ${record.workerId} (mission ${record.missionId}, task ${record.taskId}, ${record.status})`;
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

/** Vínculo pane→worktree: só em writer de pane, ids únicos e limitados. */
function isOptionalPaneBinding(value: unknown, ownerKind: WorktreeRecord['ownerKind']): boolean {
  if (value === undefined) return true;
  if (ownerKind !== 'pane' || !Array.isArray(value) || value.length > MAX_PANE_BINDINGS) return false;
  if (new Set(value).size !== value.length) return false;
  try {
    for (const id of value) assertIdentifier(id as string, 'pane binding');
  } catch {
    return false;
  }
  return true;
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
  const acceptedPaths = acceptedWorktreePaths(
    options,
    record.projectId,
    record.checkoutId,
    expectedTaskKey,
  );
  const expectedBranch = worktreeBranchRef(record);
  const dependencies = record.dependencies;

  if (
    (record.ownerKind !== undefined && record.ownerKind !== "pane") ||
    record.scopeKey !== options.scopeKey ||
    record.scopeKey !== expectedScopeKey ||
    record.taskKey !== expectedTaskKey ||
    record.id !== `worktree-${expectedTaskKey}` ||
    !acceptedPaths.includes(record.worktreePath) ||
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
    (record.reservationGeneration !== undefined &&
      (typeof record.reservationGeneration !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.reservationGeneration))) ||
    !isOptionalPaneBinding(record.paneIds, record.ownerKind) ||
    !isOptionalPaneBinding(record.sessionIds, record.ownerKind) ||
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

  // F-1253: só writers ativos disputam a raiz; um encerrado fica no ref em
  // que nasceu. F-1422: o ref de integração NÃO é mais único entre os ativos.
  // Ele é o branch do checkout de coordenação no instante da reserva; quando
  // o operador (ou outro agente) troca esse branch, todo writer isolado novo
  // era recusado enquanto houvesse um ativo do branch anterior — mesmo com
  // `baseRef` explícito. Cada registro integra só no próprio `integrationRef`
  // e a fila de merge confere, na hora, que o checkout está nele
  // (`inspectIntegration` → "integration branch changed"); a retomada da
  // mesma task continua exigindo raiz e ref iguais (worktree-manager.ts).
  // Bases diferentes (`baseSha`) do mesmo ref sempre foram aceitas.
  const active = records.filter((record) => ACTIVE_WORKTREE_STATUSES.has(record.status));
  const firstRoot = active[0];
  const otherRoot = firstRoot && active.find((record) => record.rootRealPath !== firstRoot.rootRealPath);
  if (firstRoot && otherRoot) {
    invalidState(
      'active worktree writers disagree on checkout root: ' +
        `${describeWriter(firstRoot)} has ${firstRoot.rootRealPath}, ` +
        `${describeWriter(otherRoot)} has ${otherRoot.rootRealPath}`,
    );
  }

  return Object.freeze({
    revision: snapshot.revision,
    records: Object.freeze(records),
  });
}
