import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  MergeCasError,
  MergeQueueStateError,
  MergeRetryRequiredError,
  MergeValidationRejectedError,
  type MergeQueueEntry,
  type MergeQueueIntegrationState,
  type MergeQueueReconciliationResult,
  type MergeQueueResult,
  type RetryMergeInput,
} from './merge-queue-contract';
import { cloneMergeQueueEntry as cloneEntry } from './merge-queue-state';
import {
  type MergeQueueClaim,
  MergeQueueStateController,
} from './merge-queue-state-controller';
import {
  WorktreeManager,
  WorktreeStateConflictError,
  assertSafeLocalGitConfig,
  worktreeTaskKey,
  type GitRunner,
  type PreparedWorktreeIntegration,
  type WorktreeRecord,
} from './worktree-manager';

export interface MergeRetryAttempt {
  readonly claimed: MergeQueueClaim;
  readonly mode: 'full' | 'post-integration' | 'finalization';
  readonly prepared: PreparedWorktreeIntegration;
  readonly acknowledgementEvidenceIds: readonly string[];
}

interface MergeQueueRecoveryOptions {
  readonly candidatesRoot: string;
  readonly state: MergeQueueStateController;
  readonly worktreeManager: WorktreeManager;
  readonly gitRunner: GitRunner;
  readonly now: () => number;
}

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  try {
    const text = (typeof value === 'string' ? value : String(value))
      .replaceAll('\0', ' ')
      .slice(0, maxLength);
    return text.trim().length > 0 ? text : fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(error: unknown): string {
  return boundedText(
    error instanceof Error ? error.message : error,
    'merge failed with an unknown error',
    2_048,
  );
}

function errorName(error: unknown): string {
  return boundedText(
    error instanceof Error ? error.name : 'UnknownError',
    'UnknownError',
    256,
  );
}

export class MergeQueueRecovery {
  readonly #candidatesRoot: string;
  readonly #state: MergeQueueStateController;
  readonly #worktrees: WorktreeManager;
  readonly #git: GitRunner;
  readonly #now: () => number;

  constructor(options: MergeQueueRecoveryOptions) {
    this.#candidatesRoot = options.candidatesRoot;
    this.#state = options.state;
    this.#worktrees = options.worktreeManager;
    this.#git = options.gitRunner;
    this.#now = options.now;
  }

  reconcile(scope: ProjectExecutionScope): MergeQueueReconciliationResult {
    const scopeKey = this.#worktrees.scopeKey(scope);
    const snapshot = this.#state.snapshot(scopeKey);
    if (!snapshot.activeTaskKey) {
      if (!snapshot.blocked) return Object.freeze({ action: 'none' });
      return Object.freeze({
        action: 'already-blocked',
        taskKey: snapshot.blocked.taskKey,
        block: snapshot.blocked,
      });
    }
    const entry = snapshot.entries.find(
      (candidate) => candidate.taskKey === snapshot.activeTaskKey,
    );
    if (!entry) {
      throw new MergeQueueStateError('active merge queue entry disappeared');
    }
    const integrationState = this.#integrationState(scope, entry);
    const now = this.#timestamp();
    const reason = boundedText(
      `merge attempt ${entry.attempt} was interrupted during ${entry.status}; ` +
        `integration state is ${integrationState}`,
      'merge attempt was interrupted and requires explicit retry evidence',
      2_048,
    );
    const block = Object.freeze({
      taskKey: entry.taskKey,
      errorName: 'MergeInterruptedError',
      reason,
      blockedAt: now,
    });
    this.#state.mutate(scopeKey, (state, nextRevision) => {
      const current = state.entries.find(
        (candidate) => candidate.taskKey === entry.taskKey,
      );
      if (
        state.activeTaskKey !== entry.taskKey ||
        !current ||
        current.attempt !== entry.attempt ||
        current.status !== entry.status
      ) {
        throw new MergeQueueStateError(
          'active merge attempt changed during restart reconciliation',
        );
      }
      const blockedEntry = cloneEntry({
        ...current,
        status: 'blocked',
        integratedSha:
          integrationState === 'candidate-integrated'
            ? current.candidateSha
            : current.integratedSha,
        failureReason: reason,
        updatedAt: now,
      });
      return {
        ...state,
        activeTaskKey: null,
        blocked: block,
        events: [
          ...state.events,
          this.#state.event(
            scopeKey,
            blockedEntry,
            'restart-reconciled',
            nextRevision,
            now,
            {
              fromStatus: entry.status,
              integrationState,
              errorName: block.errorName,
              reason,
            },
          ),
        ],
        entries: state.entries.map((candidate) =>
          candidate.taskKey === entry.taskKey ? blockedEntry : candidate,
        ),
      };
    });
    try {
      this.#worktrees.markFailed(
        scope,
        entry.missionId,
        entry.taskId,
        reason,
        integrationState === 'candidate-integrated'
          ? entry.candidateSha
          : undefined,
      );
    } catch {
      // The durable queue block remains authoritative across store boundaries.
    }
    this.#cleanupCandidate(scope, scopeKey, entry);
    return Object.freeze({
      action: 'blocked-interrupted',
      taskKey: entry.taskKey,
      fromStatus: entry.status,
      integrationState,
      block,
    });
  }

  acknowledge(input: RetryMergeInput): MergeRetryAttempt {
    const { revisionId, evidenceIds } = this.#acknowledgement(input);
    const taskKey = worktreeTaskKey(input.missionId, input.taskId);
    const scopeKey = this.#worktrees.scopeKey(input.scope);
    const snapshot = this.#state.snapshot(scopeKey);
    if (snapshot.revision !== input.expectedStateRevision) {
      throw new MergeCasError(
        'merge retry acknowledgement used a stale queue revision',
      );
    }
    const blockedEntry = snapshot.entries.find(
      (entry) => entry.taskKey === taskKey,
    );
    if (
      !snapshot.blocked ||
      snapshot.blocked.taskKey !== taskKey ||
      snapshot.activeTaskKey !== null ||
      blockedEntry?.status !== 'blocked'
    ) {
      throw new MergeQueueStateError(
        'only the durably blocked task can be acknowledged for retry',
      );
    }
    const prepared = this.#worktrees.prepareRecoveryIntegration(
      input.scope,
      input.missionId,
      input.taskId,
    );
    const integratedCandidateSha = this.#integratedCandidate(
      blockedEntry,
      prepared,
    );
    const isPostIntegration = integratedCandidateSha !== undefined;
    const isFinalization = isPostIntegration && this.#wasFinalizing(
      blockedEntry,
      snapshot.events,
    );
    this.#assertRetryBasis(
      blockedEntry,
      prepared,
      snapshot.events,
      revisionId,
      evidenceIds,
      isPostIntegration,
      isFinalization,
    );

    const nextAttempt = blockedEntry.attempt + 1;
    let retriedEntry: MergeQueueEntry | null = null;
    this.#state.mutate(
      scopeKey,
      (state, nextRevision) => {
        const current = state.entries.find((entry) => entry.taskKey === taskKey);
        if (
          state.blocked?.taskKey !== taskKey ||
          state.activeTaskKey !== null ||
          current?.status !== 'blocked' ||
          current.attempt !== blockedEntry.attempt
        ) {
          throw new MergeCasError(
            'blocked merge attempt changed before retry acknowledgement',
          );
        }
        retriedEntry = this.#retryEntry(
          current,
          nextAttempt,
          evidenceIds,
          integratedCandidateSha,
          isFinalization,
        );
        return {
          ...state,
          activeTaskKey: taskKey,
          blocked: null,
          events: [
            ...state.events,
            this.#state.event(
              scopeKey,
              retriedEntry as MergeQueueEntry,
              'retry-acknowledged',
              nextRevision,
              this.#timestamp(),
              {
                fromStatus: 'blocked',
                integrationState: isPostIntegration
                  ? 'candidate-integrated'
                  : 'not-integrated',
                revisionId,
                taskHeadSha: prepared.taskHeadSha,
                candidateSha: current.candidateSha,
                evidenceIds,
              },
            ),
          ],
          entries: state.entries.map((entry) =>
            entry.taskKey === taskKey
              ? (retriedEntry as MergeQueueEntry)
              : entry,
          ),
        };
      },
      input.expectedStateRevision,
    );
    if (!retriedEntry) {
      throw new MergeQueueStateError('merge retry acknowledgement failed');
    }
    return Object.freeze({
      claimed: Object.freeze({ scopeKey, entry: retriedEntry }),
      mode: isFinalization
        ? 'finalization'
        : isPostIntegration
          ? 'post-integration'
          : 'full',
      prepared,
      acknowledgementEvidenceIds: evidenceIds,
    });
  }

  async resumePostIntegration(
    input: RetryMergeInput,
    attempt: MergeRetryAttempt,
  ): Promise<MergeQueueResult> {
    const entry = attempt.claimed.entry;
    const candidateSha = entry.candidateSha;
    const integrationBaseSha = entry.integrationBaseSha;
    const taskHeadSha = entry.taskHeadSha;
    const diffHash = entry.diffHash;
    if (
      !candidateSha ||
      entry.integratedSha !== candidateSha ||
      !integrationBaseSha ||
      !taskHeadSha ||
      !diffHash
    ) {
      throw new MergeQueueStateError(
        'post-integration retry is missing immutable candidate evidence',
      );
    }
    let evidenceIds = entry.evidenceIds;
    try {
      this.#assertTaskUnchanged(input, attempt.prepared);
      this.#assertIntegration(
        attempt.prepared.record,
        candidateSha,
        'primary checkout no longer matches the approved candidate',
      );
      if (attempt.mode !== 'finalization') {
        const decision = await input.validate(Object.freeze({
          phase: 'post-integration',
          scope: Object.freeze({ ...input.scope }),
          missionId: input.missionId,
          taskId: input.taskId,
          taskKey: entry.taskKey,
          checkoutPath: attempt.prepared.record.rootRealPath,
          integrationBaseSha,
          taskHeadSha,
          candidateSha,
          diffHash,
          changedFiles: Object.freeze([...attempt.prepared.changedFiles]),
        }));
        evidenceIds = Object.freeze([
          ...new Set([
            ...evidenceIds,
            ...this.#approvedEvidence(decision),
          ]),
        ]);
      }
      this.#assertTaskUnchanged(input, attempt.prepared);
      this.#assertIntegration(
        attempt.prepared.record,
        candidateSha,
        'post-integration retry changed the integrated checkout',
      );
      this.#worktrees.finalizeRecoveredIntegration(
        input.scope,
        input.missionId,
        input.taskId,
        taskHeadSha,
        candidateSha,
      );
      const result = Object.freeze({
        taskKey: entry.taskKey,
        taskHeadSha,
        integrationBaseSha,
        candidateSha,
        integratedSha: candidateSha,
        diffHash,
        evidenceIds,
      });
      await input.finalize?.(result);
      this.#state.complete(
        attempt.claimed,
        candidateSha,
        evidenceIds,
        this.#timestamp(),
      );
      return result;
    } catch (error) {
      try {
        this.#worktrees.markFailed(
          input.scope,
          input.missionId,
          input.taskId,
          errorMessage(error),
          candidateSha,
        );
      } catch {
        // Queue persistence below remains the fail-closed authority.
      }
      this.#state.block(attempt.claimed, {
        errorName: errorName(error),
        reason: errorMessage(error),
        now: this.#timestamp(),
        integratedSha: candidateSha,
        rejectedEvidenceIds:
          error instanceof MergeValidationRejectedError
            ? error.evidenceIds
            : [],
      });
      throw error;
    }
  }

  #acknowledgement(input: RetryMergeInput): {
    readonly revisionId?: string;
    readonly evidenceIds: readonly string[];
  } {
    if (
      !Number.isSafeInteger(input.expectedStateRevision) ||
      input.expectedStateRevision < 0 ||
      !input.acknowledgement ||
      typeof input.acknowledgement !== 'object'
    ) {
      throw new MergeRetryRequiredError();
    }
    const revisionId = input.acknowledgement.revisionId;
    if (revisionId !== undefined && !this.#isIdentifier(revisionId)) {
      throw new MergeRetryRequiredError();
    }
    const rawEvidenceIds = input.acknowledgement.evidenceIds ?? [];
    if (
      !Array.isArray(rawEvidenceIds) ||
      rawEvidenceIds.length > 4_096 ||
      rawEvidenceIds.some((id) => !this.#isIdentifier(id))
    ) {
      throw new MergeRetryRequiredError();
    }
    return Object.freeze({
      revisionId,
      evidenceIds: Object.freeze([...new Set(rawEvidenceIds)]),
    });
  }

  #integratedCandidate(
    entry: MergeQueueEntry,
    prepared: PreparedWorktreeIntegration,
  ): string | undefined {
    const candidateSha = entry.integratedSha ?? entry.candidateSha;
    if (!candidateSha) return undefined;
    if (!entry.integratedSha) {
      const integration = this.#worktrees.inspectIntegration(prepared.record);
      if (integration.headSha !== candidateSha) return undefined;
    }
    if (
      entry.candidateSha !== candidateSha ||
      entry.taskHeadSha !== prepared.taskHeadSha ||
      entry.diffHash !== prepared.diffHash
    ) {
      throw new MergeCasError(
        'already integrated candidate no longer matches its task evidence',
      );
    }
    this.#assertIntegration(
      prepared.record,
      candidateSha,
      'primary checkout no longer matches the blocked integrated candidate',
    );
    return candidateSha;
  }

  #assertRetryBasis(
    entry: MergeQueueEntry,
    prepared: PreparedWorktreeIntegration,
    events: ReturnType<MergeQueueStateController['snapshot']>['events'],
    revisionId: string | undefined,
    evidenceIds: readonly string[],
    isPostIntegration: boolean,
    isFinalization: boolean,
  ): void {
    // The exact durable state revision is itself the acknowledgement for an
    // idempotent finalizer replay. Validation already completed and its
    // evidence was persisted before the queue entered `finalizing`.
    if (isFinalization) return;
    const taskEvents = events.filter((event) => event.taskKey === entry.taskKey);
    const knownEvidenceIds = new Set([
      ...entry.evidenceIds,
      ...taskEvents.flatMap((event) => event.evidenceIds),
    ]);
    const hasNewCommit =
      !isPostIntegration &&
      entry.taskHeadSha !== undefined &&
      (prepared.taskHeadSha !== entry.taskHeadSha ||
        prepared.diffHash !== entry.diffHash);
    const hasNewRevision =
      revisionId !== undefined &&
      !taskEvents.some(
        (event) =>
          event.type === 'retry-acknowledged' &&
          event.revisionId === revisionId,
      );
    const hasNewEvidence = evidenceIds.some(
      (evidenceId) => !knownEvidenceIds.has(evidenceId),
    );
    if (!hasNewCommit && !hasNewRevision && !hasNewEvidence) {
      throw new MergeRetryRequiredError();
    }
  }

  #retryEntry(
    current: MergeQueueEntry,
    attempt: number,
    evidenceIds: readonly string[],
    integratedCandidateSha: string | undefined,
    isFinalization: boolean,
  ): MergeQueueEntry {
    if (integratedCandidateSha) {
      return cloneEntry({
        ...current,
        attempt,
        status: isFinalization ? 'finalizing' : 'post-validating',
        integratedSha: integratedCandidateSha,
        evidenceIds: Object.freeze([
          ...new Set([...current.evidenceIds, ...evidenceIds]),
        ]),
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      });
    }
    return cloneEntry({
      ...current,
      attempt,
      status: 'queued',
      taskHeadSha: undefined,
      integrationBaseSha: undefined,
      candidateSha: undefined,
      integratedSha: undefined,
      diffHash: undefined,
      evidenceIds: [],
      failureReason: undefined,
      updatedAt: this.#timestamp(),
    });
  }

  #wasFinalizing(
    entry: MergeQueueEntry,
    events: ReturnType<MergeQueueStateController['snapshot']>['events'],
  ): boolean {
    return events.some(
      (event) =>
        event.taskKey === entry.taskKey &&
        event.attempt === entry.attempt &&
        (event.type === 'blocked' || event.type === 'restart-reconciled') &&
        event.fromStatus === 'finalizing',
    );
  }

  #approvedEvidence(decision: {
    readonly sensorsPassed: boolean;
    readonly reviewPassed: boolean;
    readonly evidenceIds: readonly string[];
  }): readonly string[] {
    if (
      !decision ||
      !Array.isArray(decision.evidenceIds) ||
      decision.evidenceIds.length === 0 ||
      decision.evidenceIds.length > 4_096 ||
      decision.evidenceIds.some((id) => !this.#isIdentifier(id))
    ) {
      throw new MergeValidationRejectedError('post-integration');
    }
    const evidenceIds = Object.freeze([...new Set(decision.evidenceIds)]);
    if (!decision.sensorsPassed || !decision.reviewPassed) {
      throw new MergeValidationRejectedError('post-integration', evidenceIds);
    }
    return evidenceIds;
  }

  #assertTaskUnchanged(
    input: RetryMergeInput,
    expected: PreparedWorktreeIntegration,
  ): void {
    const current = this.#worktrees.prepareRecoveryIntegration(
      input.scope,
      input.missionId,
      input.taskId,
    );
    if (
      current.taskHeadSha !== expected.taskHeadSha ||
      current.diffHash !== expected.diffHash
    ) {
      throw new MergeCasError(
        'task diff changed during post-integration retry',
      );
    }
  }

  #assertIntegration(
    record: WorktreeRecord,
    expectedHeadSha: string,
    message: string,
  ): void {
    try {
      this.#worktrees.assertIntegrationUnchanged(record, expectedHeadSha);
    } catch (error) {
      if (error instanceof WorktreeStateConflictError) {
        throw new MergeCasError(message, { cause: error });
      }
      throw error;
    }
  }

  #integrationState(
    scope: ProjectExecutionScope,
    entry: MergeQueueEntry,
  ): MergeQueueIntegrationState {
    try {
      const record = this.#worktrees.get(
        scope,
        entry.missionId,
        entry.taskId,
      );
      if (!record) return 'unknown';
      const integration = this.#worktrees.inspectIntegration(record);
      if (entry.candidateSha === integration.headSha) {
        return 'candidate-integrated';
      }
      if (entry.integrationBaseSha === integration.headSha) {
        return 'not-integrated';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  #candidateKey(
    scopeKey: string,
    taskKey: string,
    integrationBaseSha: string,
    taskHeadSha: string,
  ): string {
    return createHash('sha256')
      .update([scopeKey, taskKey, integrationBaseSha, taskHeadSha].join('\0'))
      .digest('hex');
  }

  #cleanupCandidate(
    scope: ProjectExecutionScope,
    scopeKey: string,
    entry: MergeQueueEntry,
  ): void {
    if (
      entry.status !== 'candidate-validating' ||
      !entry.integrationBaseSha ||
      !entry.taskHeadSha
    ) return;
    const candidatePath = path.join(
      this.#candidatesRoot,
      `scope-${scopeKey}`,
      `candidate-${this.#candidateKey(
        scopeKey,
        entry.taskKey,
        entry.integrationBaseSha,
        entry.taskHeadSha,
      )}`,
    );
    try {
      if (!fs.existsSync(candidatePath)) return;
      const real = fs.realpathSync(candidatePath);
      if (real !== candidatePath || !fs.statSync(real).isDirectory()) return;
      assertSafeLocalGitConfig(this.#git, real);
      const topLevel = fs.realpathSync(
        this.#git.run(real, ['rev-parse', '--show-toplevel']).stdout.trim(),
      );
      if (topLevel !== real) return;
      const symbolic = this.#git.run(
        real,
        ['symbolic-ref', '--quiet', 'HEAD'],
        { allowFailure: true },
      );
      if (symbolic.status !== 1) return;
      const status = this.#git.run(real, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]).stdout;
      if (status.length > 0) return;
      const record = this.#worktrees.get(
        scope,
        entry.missionId,
        entry.taskId,
      );
      if (!record) return;
      this.#git.run(record.rootRealPath, ['worktree', 'remove', real]);
    } catch {
      // Never force-remove an interrupted candidate with uncertain identity.
    }
  }

  #isIdentifier(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 256 &&
      !value.includes('\0')
    );
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('merge queue clock returned an invalid timestamp');
    }
    return value;
  }
}
