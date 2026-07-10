import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import type { GitRunner } from './git-command';

export const SHA_PATTERN = /^[a-f0-9]{40,64}$/;
export const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export interface WorktreeOwnership {
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];
}

export type WorktreeStatus =
  | 'reserved'
  | 'ready'
  | 'queued'
  | 'integrated'
  | 'failed'
  | 'abandoned';

export const ACTIVE_WORKTREE_STATUSES = new Set<WorktreeStatus>([
  'reserved',
  'ready',
  'queued',
]);
export const ALL_WORKTREE_STATUSES = new Set<WorktreeStatus>([
  ...ACTIVE_WORKTREE_STATUSES,
  'integrated',
  'failed',
  'abandoned',
]);

export interface WorktreeRecord {
  readonly id: string;
  readonly scopeKey: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly workerId: string;
  readonly rootRealPath: string;
  readonly worktreePath: string;
  readonly branchRef: string;
  readonly integrationRef: string;
  readonly baseSha: string;
  readonly ownership: WorktreeOwnership;
  readonly dependencies: readonly string[];
  readonly status: WorktreeStatus;
  readonly taskHeadSha?: string;
  readonly integratedSha?: string;
  readonly failureReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorktreeStateSnapshot {
  readonly revision: number;
  readonly records: readonly WorktreeRecord[];
}

/** Implementations must provide durable, process-safe atomic CAS semantics. */
export interface WorktreeStateStore {
  read(scopeKey: string): WorktreeStateSnapshot;
  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean;
}

export interface WorktreeDependencyInput {
  readonly missionId: string;
  readonly taskId: string;
}

export interface CreateWorktreeInput {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly ownership: WorktreeOwnership;
  readonly dependsOn?: readonly WorktreeDependencyInput[];
}

export interface PreparedWorktreeIntegration {
  readonly record: WorktreeRecord;
  readonly taskHeadSha: string;
  readonly changedFiles: readonly string[];
  readonly diffHash: string;
}

export interface IntegrationCheckoutSnapshot {
  readonly rootRealPath: string;
  readonly integrationRef: string;
  readonly headSha: string;
}

export interface IntegrationCheckoutInspection
  extends IntegrationCheckoutSnapshot {
  readonly clean: boolean;
}

export interface WorktreeManagerOptions {
  readonly runtimeRoot: string;
  readonly stateStore: WorktreeStateStore;
  readonly gitRunner?: GitRunner;
  readonly now?: () => number;
}

export class OwnershipOverlapError extends Error {
  readonly conflictingTaskKey: string;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];

  constructor(conflictingTaskKey: string, overlap: WorktreeOwnership) {
    super(`worktree ownership overlaps active task ${conflictingTaskKey}`);
    this.name = 'OwnershipOverlapError';
    this.conflictingTaskKey = conflictingTaskKey;
    this.files = overlap.files;
    this.symbols = overlap.symbols;
    this.domains = overlap.domains;
  }
}

export class OwnershipViolationError extends Error {
  readonly undeclaredFiles: readonly string[];

  constructor(files: readonly string[]) {
    super(`task changed files outside its ownership: ${files.join(', ')}`);
    this.name = 'OwnershipViolationError';
    this.undeclaredFiles = Object.freeze([...files]);
  }
}

export class WorktreeWorkerConflictError extends Error {
  constructor() {
    super('mission task worktree is already owned by another worker');
    this.name = 'WorktreeWorkerConflictError';
  }
}

export class WorktreeStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeStateConflictError';
  }
}

export function digest(domain: string, ...values: string[]): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(values.join('\0'))
    .digest('hex');
}

export function assertIdentifier(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 256 ||
    value.includes('\0')
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export function assertSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function normalizeFileOwnership(value: string): string {
  const raw = assertIdentifier(value, 'owned file').replaceAll('\\', '/');
  if (raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw)) {
    throw new Error(`owned file must be repository-relative: ${value}`);
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized === '.git' ||
    normalized.startsWith('.git/')
  ) {
    throw new Error(`owned file escapes repository: ${value}`);
  }
  return normalized;
}

function normalizedList(
  values: readonly string[],
  label: string,
  normalize: (value: string) => string,
): readonly string[] {
  if (!Array.isArray(values) || values.length > 2_048) {
    throw new Error(`invalid ${label} ownership`);
  }
  return Object.freeze([...new Set(values.map(normalize))].sort());
}

export function normalizeOwnership(
  value: WorktreeOwnership,
): WorktreeOwnership {
  if (!value || typeof value !== 'object') {
    throw new Error('ownership is required');
  }
  const files = normalizedList(value.files, 'file', normalizeFileOwnership);
  const symbols = normalizedList(value.symbols, 'symbol', (item) =>
    assertIdentifier(item, 'owned symbol'),
  );
  const domains = normalizedList(value.domains, 'domain', (item) =>
    assertIdentifier(item, 'owned domain').toLocaleLowerCase('en-US'),
  );
  if (files.length + symbols.length + domains.length === 0) {
    throw new Error('at least one ownership claim is required');
  }
  return Object.freeze({ files, symbols, domains });
}

export function ownershipOverlap(
  left: WorktreeOwnership,
  right: WorktreeOwnership,
): WorktreeOwnership {
  const intersection = (a: readonly string[], b: readonly string[]) => {
    const rightValues = new Set(b);
    return a.filter((value) => rightValues.has(value));
  };
  return Object.freeze({
    files: Object.freeze(intersection(left.files, right.files)),
    symbols: Object.freeze(intersection(left.symbols, right.symbols)),
    domains: Object.freeze(intersection(left.domains, right.domains)),
  });
}

export function hasOwnershipOverlap(value: WorktreeOwnership): boolean {
  return value.files.length + value.symbols.length + value.domains.length > 0;
}

export function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function cloneWorktreeRecord(
  record: WorktreeRecord,
): WorktreeRecord {
  return Object.freeze({
    ...record,
    ownership: Object.freeze({
      files: Object.freeze([...record.ownership.files]),
      symbols: Object.freeze([...record.ownership.symbols]),
      domains: Object.freeze([...record.ownership.domains]),
    }),
    dependencies: Object.freeze([...record.dependencies]),
  });
}

export function worktreeTaskKey(missionId: string, taskId: string): string {
  return digest(
    'mission-task',
    assertIdentifier(missionId, 'missionId'),
    assertIdentifier(taskId, 'taskId'),
  );
}
