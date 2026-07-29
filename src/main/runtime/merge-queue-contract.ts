import type { ProjectExecutionScope } from '../../shared/types';
import type { GitRunner } from './git-command';
import type { WorktreeManager } from './worktree-manager';

export type MergeQueueEntryStatus =
  | 'queued'
  | 'candidate-validating'
  | 'integrating'
  | 'post-validating'
  | 'finalizing'
  | 'integrated'
  | 'blocked';

export interface MergeQueueEntry {
  readonly id: string;
  readonly taskKey: string;
  readonly missionId: string;
  readonly taskId: string;
  /** Monotonic fencing token for this task's merge attempts. */
  readonly attempt: number;
  readonly status: MergeQueueEntryStatus;
  readonly taskHeadSha?: string;
  readonly integrationBaseSha?: string;
  readonly candidateSha?: string;
  readonly integratedSha?: string;
  readonly diffHash?: string;
  readonly evidenceIds: readonly string[];
  readonly failureReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type MergeQueueIntegrationState =
  | 'not-integrated'
  | 'candidate-integrated'
  | 'unknown';

export type MergeFailureDisposition =
  | 'retryable'
  | 'repair'
  | 'terminal';

export type MergeQueueEventType =
  | 'blocked'
  | 'retry-acknowledged'
  | 'restart-reconciled'
  | 'integrated';

/** Append-only evidence describing safety-sensitive queue transitions. */
export interface MergeQueueEvent {
  readonly id: string;
  readonly type: MergeQueueEventType;
  readonly taskKey: string;
  readonly attempt: number;
  readonly stateRevision: number;
  readonly occurredAt: number;
  readonly fromStatus?: MergeQueueEntryStatus;
  readonly integrationState?: MergeQueueIntegrationState;
  readonly errorName?: string;
  readonly reason?: string;
  readonly revisionId?: string;
  readonly taskHeadSha?: string;
  readonly candidateSha?: string;
  readonly evidenceIds: readonly string[];
}

export interface MergeQueueBlock {
  readonly taskKey: string;
  readonly errorName: string;
  readonly reason: string;
  readonly blockedAt: number;
  /**
   * Recovery authority, persisted with the block. Legacy blocks default to
   * terminal during decoding; new technical/quality blocks are never inferred
   * from mutable prose.
   */
  readonly disposition?: MergeFailureDisposition;
}

export interface MergeQueueStateSnapshot {
  readonly revision: number;
  readonly activeTaskKey: string | null;
  readonly blocked: MergeQueueBlock | null;
  readonly events: readonly MergeQueueEvent[];
  readonly entries: readonly MergeQueueEntry[];
}

/** Implementations must provide durable, process-safe atomic CAS semantics. */
export interface MergeQueueStateStore {
  read(scopeKey: string): MergeQueueStateSnapshot;
  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    state: Omit<MergeQueueStateSnapshot, 'revision'>,
  ): boolean;
}

export type MergeValidationPhase = 'candidate' | 'post-integration';

export interface MergeValidationContext {
  readonly phase: MergeValidationPhase;
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly checkoutPath: string;
  readonly integrationBaseSha: string;
  readonly taskHeadSha: string;
  readonly candidateSha: string;
  readonly diffHash: string;
  readonly changedFiles: readonly string[];
  /** Parent operation cancellation, propagated into sensors/reviewer spawns. */
  readonly signal?: AbortSignal;
  /**
   * Main-owned lifecycle fence. Validation implementations must call this
   * after every await and immediately before persisting evidence.
   */
  readonly assertCurrentAuthority?: () => void;
}

export interface MergeValidationDecision {
  readonly sensorsPassed: boolean;
  readonly reviewPassed: boolean;
  readonly evidenceIds: readonly string[];
}

export interface EnqueueMergeInput {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly taskId: string;
  /** Parent MCP/reconciler cancellation for nested validation effects. */
  readonly signal?: AbortSignal;
  /**
   * Synchronous main-owned lifecycle fence. MergeQueue invokes it immediately
   * before Git effects and again after every validation await.
   */
  readonly assertCurrentAuthority?: () => void;
  readonly validate: (
    context: MergeValidationContext,
  ) => Promise<MergeValidationDecision> | MergeValidationDecision;
  /**
   * Completes mission/task bookkeeping after the queue has durably committed
   * the approved integration. A failure here must never roll Git back: callers
   * can replay their receipt from the persisted `integrated` queue entry.
   */
  readonly finalize?: (
    result: MergeQueueResult,
  ) => Promise<void> | void;
}

export interface MergeRetryAcknowledgement {
  /** A durable external review/configuration revision, not a queue CAS value. */
  readonly revisionId?: string;
  /** Newly produced review, sensor, or test evidence. */
  readonly evidenceIds?: readonly string[];
}

export interface RetryMergeInput extends EnqueueMergeInput {
  /** Exact durable queue revision observed by the caller before acknowledging. */
  readonly expectedStateRevision: number;
  readonly acknowledgement: MergeRetryAcknowledgement;
}

export type MergeQueueReconciliationAction =
  | 'none'
  | 'already-blocked'
  | 'blocked-interrupted';

export interface MergeQueueReconciliationResult {
  readonly action: MergeQueueReconciliationAction;
  readonly taskKey?: string;
  readonly fromStatus?: MergeQueueEntryStatus;
  readonly integrationState?: MergeQueueIntegrationState;
  readonly block?: MergeQueueBlock;
}

export interface MergeQueueResult {
  readonly taskKey: string;
  readonly taskHeadSha: string;
  readonly integrationBaseSha: string;
  readonly candidateSha: string;
  readonly integratedSha: string;
  readonly diffHash: string;
  readonly evidenceIds: readonly string[];
}

export interface MergeQueueOptions {
  readonly runtimeRoot: string;
  readonly stateStore: MergeQueueStateStore;
  readonly worktreeManager: WorktreeManager;
  readonly gitRunner?: GitRunner;
  readonly now?: () => number;
}

export class MergeQueueBlockedError extends Error {
  readonly block: MergeQueueBlock;

  constructor(block: MergeQueueBlock) {
    super(`merge queue is blocked: ${block.reason}`);
    this.name = 'MergeQueueBlockedError';
    this.block = block;
  }
}

export class MergeQueueBusyError extends Error {
  constructor(activeTaskKey: string) {
    super(`merge queue is already integrating ${activeTaskKey}`);
    this.name = 'MergeQueueBusyError';
  }
}

export class MergeConflictError extends Error {
  constructor() {
    super('candidate merge has conflicts');
    this.name = 'MergeConflictError';
  }
}

export class MergeValidationRejectedError extends Error {
  readonly phase: MergeValidationPhase;
  readonly evidenceIds: readonly string[];

  constructor(phase: MergeValidationPhase, evidenceIds: readonly string[] = []) {
    super(`sensors or review rejected the ${phase} checkout`);
    this.name = 'MergeValidationRejectedError';
    this.phase = phase;
    this.evidenceIds = Object.freeze([...evidenceIds]);
  }
}

export class MergeAuthorityRevokedError extends Error {
  constructor(cause?: unknown) {
    const detail =
      cause instanceof Error && cause.message.trim()
        ? `: ${cause.message.trim()}`
        : '';
    super(`merge authority revoked${detail}`, {
      cause,
    });
    this.name = 'MergeAuthorityRevokedError';
  }
}

export class MergeRetryRequiredError extends Error {
  constructor() {
    super(
      'retry requires a new task commit, external revision, or evidence identifier',
    );
    this.name = 'MergeRetryRequiredError';
  }
}

export class MergeCasError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'MergeCasError';
  }
}

export class MergeQueueStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeQueueStateError';
  }
}

/** Durable state storage was temporarily unavailable or CAS-contended. */
export class MergeQueuePersistenceError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'MergeQueuePersistenceError';
  }
}
