import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { scheduleProjectOrientationAfterMerge } from '../context/orientation/orientation-service';
import { retainTrustedMemoryBestEffort } from '../memory/trusted-memory';
import { classifyOperationalFailure } from './operational-failure-policy';
import { findStalledActiveMergeEntry } from './merge-stall-watchdog';
import { rollbackIntegrationCheckout } from './merge-integration-rollback';
import {
  GitCommandError,
  ProcessGitRunner,
  WorktreeManager,
  WorktreeStateConflictError,
  assertSafeLocalGitConfig,
  worktreeTaskKey,
  type GitRunner,
  type PreparedWorktreeIntegration,
  type WorktreeRecord,
} from './worktree-manager';
import {
  MergeAuthorityRevokedError,
  MergeCasError,
  MergeConflictError,
  MergeOperationAbortedError,
  MergeQueueBlockedError,
  MergeQueueStateError,
  MergeValidationRejectedError,
  type EnqueueMergeInput,
  type MergeQueueBlock,
  type MergeQueueOptions,
  type MergeQueueReconciliationResult,
  type MergeQueueResult,
  type MergeQueueStateSnapshot,
  type RetryMergeInput,
  type MergeValidationContext,
  type MergeValidationDecision,
  type MergeValidationPhase,
} from './merge-queue-contract';
import {
  MergeQueueStateController,
  type MergeQueueClaim,
} from './merge-queue-state-controller';
import { MergeQueueRecovery } from './merge-queue-recovery';

export * from './merge-queue-contract';

const SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const QUEUED_MERGE_ABORTED = Symbol('queued-merge-aborted');

function mergeOperationAbortedError(
  signal: AbortSignal,
): MergeOperationAbortedError {
  const reason =
    signal.reason ??
    Object.assign(new Error('merge operation was aborted'), {
      name: 'AbortError',
    });
  return new MergeOperationAbortedError(reason);
}

interface CandidateCheckout {
  readonly path: string;
  readonly treeSha: string;
  readonly candidateSha: string;
  readonly diffHash: string;
}

interface IntegrateResume {
  readonly claimed: MergeQueueClaim;
  readonly expectedTaskHeadSha: string;
  readonly acknowledgementEvidenceIds: readonly string[];
}

function assertSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function ensureDirectory(directory: string, parent?: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`merge runtime path is not a real directory: ${directory}`);
  }
  const real = fs.realpathSync(directory);
  if (parent) {
    const relative = path.relative(parent, real);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('merge runtime path escapes its parent');
    }
  }
  fs.chmodSync(real, 0o700);
  return real;
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
  try {
    return boundedText(
      error instanceof Error ? error.message : error,
      'merge failed with an unknown error',
      2_048,
    );
  } catch {
    return 'merge failed with an unknown error';
  }
}

function errorName(error: unknown): string {
  try {
    return boundedText(
      error instanceof Error ? error.name : 'UnknownError',
      'UnknownError',
      256,
    );
  } catch {
    return 'UnknownError';
  }
}

function retainApprovedMerge(
  input: EnqueueMergeInput,
  result: MergeQueueResult,
): void {
  retainTrustedMemoryBestEffort(input.scope, {
    type: 'approved-merge',
    summary:
      `Task ${input.taskId} was integrated after candidate and ` +
      'post-integration validation approval.',
    missionId: input.missionId,
    reference: result.integratedSha,
    ...(result.evidenceIds.length > 0
      ? { evidenceIds: result.evidenceIds.slice(0, 32) }
      : {}),
  });
}

export class MergeQueue {
  readonly runtimeRoot: string;
  readonly candidatesRoot: string;
  readonly #state: MergeQueueStateController;
  readonly #worktrees: WorktreeManager;
  readonly #git: GitRunner;
  readonly #now: () => number;
  readonly #recovery: MergeQueueRecovery;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: MergeQueueOptions) {
    if (!options.worktreeManager) {
      throw new Error('a worktree manager is required');
    }
    this.runtimeRoot = ensureDirectory(path.resolve(options.runtimeRoot));
    this.candidatesRoot = ensureDirectory(
      path.join(this.runtimeRoot, 'merge-candidates'),
      this.runtimeRoot,
    );
    this.#state = new MergeQueueStateController(options.stateStore);
    this.#worktrees = options.worktreeManager;
    this.#git = options.gitRunner ?? new ProcessGitRunner();
    this.#now = options.now ?? Date.now;
    this.#recovery = new MergeQueueRecovery({
      candidatesRoot: this.candidatesRoot,
      state: this.#state,
      worktreeManager: this.#worktrees,
      gitRunner: this.#git,
      now: this.#now,
    });
  }

  enqueue(input: EnqueueMergeInput): Promise<MergeQueueResult> {
    return this.#schedule(input.scope, input.signal, () => {
      this.#assertCurrentAuthority(input);
      return this.#integrate(input);
    });
  }

  retry(input: RetryMergeInput): Promise<MergeQueueResult> {
    return this.#schedule(input.scope, input.signal, () => {
      this.#assertCurrentAuthority(input);
      return this.#retry(input);
    });
  }

  /**
   * Main-owned retry lane. Technical failures reuse the exact durable block
   * revision automatically; quality rejection waits for a changed task commit.
   * Terminal blocks remain available only to explicit recovery tooling.
   */
  retryRecoverable(input: EnqueueMergeInput): Promise<MergeQueueResult> {
    return this.#schedule(input.scope, input.signal, () => {
      this.#assertCurrentAuthority(input);
      return this.#retryRecoverable(input);
    });
  }

  snapshot(scope: ProjectExecutionScope): MergeQueueStateSnapshot {
    return this.#state.snapshot(this.#worktrees.scopeKey(scope));
  }

  reconcile(scope: ProjectExecutionScope): MergeQueueReconciliationResult {
    return this.#recovery.reconcile(scope);
  }

  /**
   * Same-process recovery for an attempt whose durable state became
   * temporarily unreadable after Git was integrated. Never interrupts a local
   * operation still owned by this queue instance.
   */
  reconcileIfIdle(
    scope: ProjectExecutionScope,
  ): MergeQueueReconciliationResult {
    const scopeKey = this.#worktrees.scopeKey(scope);
    if (this.#tails.has(scopeKey)) {
      return Object.freeze({ action: 'none' });
    }
    return this.#recovery.reconcile(scope);
  }

  /**
   * Watchdog do merge abandonado NO MESMO processo. `reconcileIfIdle` respeita
   * o tail vivo por contrato — mas um tail cuja entrada ativa não anda há mais
   * que o maior bound legítimo de validação está provadamente encravado
   * (flagrado ao vivo em 31/07: candidate-validating parado 22,7 min, blocked
   * null, nenhum validador existindo). Aqui a idade vence a posse: o tail é
   * descartado e a recovery trata a tentativa como interrompida — a mesma
   * máquina de disposição do reinício, que já sabe classificar cada status.
   */
  reconcileIfStalled(
    scope: ProjectExecutionScope,
    nowMs: number = Date.now(),
  ): MergeQueueReconciliationResult {
    const scopeKey = this.#worktrees.scopeKey(scope);
    const stalled = findStalledActiveMergeEntry(
      this.#state.snapshot(scopeKey),
      nowMs,
    );
    if (!stalled) return Object.freeze({ action: 'none' });
    console.warn(
      `[merge-queue] tentativa de merge estagnada há ` +
        `${Math.round((nowMs - stalled.updatedAt) / 60_000)} min em ` +
        `${stalled.status} (${stalled.missionId}/${stalled.taskId}); ` +
        'descartando a posse local e reconciliando como interrompida',
    );
    this.#tails.delete(scopeKey);
    return this.#recovery.reconcile(scope);
  }

  /**
   * Lifts a durable scope block whose owning mission no longer exists.
   *
   * A block is acknowledgeable only by its exact blocked task; once that
   * task's mission is removed, nothing can ever acknowledge it and every
   * future mission of the scope inherits MergeQueueBlockedError forever. The
   * blocked entry and its events stay untouched as audit evidence — only the
   * scope-level block is lifted, recorded as a restart-reconciled event.
   */
  retireOrphanedMissionBlock(
    scope: ProjectExecutionScope,
    isMissionAlive: (missionId: string) => boolean,
  ): MergeQueueBlock | null {
    const scopeKey = this.#worktrees.scopeKey(scope);
    if (this.#tails.has(scopeKey)) return null;
    const snapshot = this.snapshot(scope);
    const block = snapshot.blocked;
    if (!block) return null;
    const entry = snapshot.entries.find(
      (candidate) => candidate.taskKey === block.taskKey,
    );
    if (!entry || isMissionAlive(entry.missionId)) return null;
    const now = this.#now();
    this.#state.mutate(
      scopeKey,
      (state, nextRevision) => {
        if (
          !state.blocked ||
          state.blocked.taskKey !== block.taskKey ||
          state.blocked.blockedAt !== block.blockedAt
        ) {
          throw new MergeQueueStateError(
            'merge queue block changed before orphan retirement',
          );
        }
        return {
          ...state,
          blocked: null,
          events: [
            ...state.events,
            this.#state.event(
              scopeKey,
              entry,
              'restart-reconciled',
              nextRevision,
              now,
              {
                fromStatus: 'blocked',
                integrationState: 'not-integrated',
                errorName: block.errorName,
                reason:
                  `bloqueio órfão retirado: a missão ${entry.missionId} foi ` +
                  'removida e ninguém poderia mais reconhecer o bloqueio',
              },
            ),
          ],
        };
      },
      snapshot.revision,
    );
    return block;
  }

  #schedule(
    scope: ProjectExecutionScope,
    signal: AbortSignal | undefined,
    run: () => Promise<MergeQueueResult>,
  ): Promise<MergeQueueResult> {
    const scopeKey = this.#worktrees.scopeKey(scope);
    const previous = this.#tails.get(scopeKey) ?? Promise.resolve();
    let isWaiting = true;
    let isCanceled = false;
    let removeAbortListener: (() => void) | undefined;
    let resolveOperation!: (result: MergeQueueResult) => void;
    let rejectOperation!: (reason?: unknown) => void;
    const operation = new Promise<MergeQueueResult>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    const queued = previous.then(async () => {
      if (isCanceled) return QUEUED_MERGE_ABORTED;
      isWaiting = false;
      removeAbortListener?.();
      removeAbortListener = undefined;
      return run();
    });
    void queued.then(
      (result) => {
        if (result !== QUEUED_MERGE_ABORTED) resolveOperation(result);
      },
      (error: unknown) => rejectOperation(error),
    );
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(scopeKey, tail);
    void tail.then(() => {
      if (this.#tails.get(scopeKey) === tail) this.#tails.delete(scopeKey);
    });
    if (signal) {
      const onAbort = () => {
        if (!isWaiting || isCanceled) return;
        isCanceled = true;
        removeAbortListener?.();
        removeAbortListener = undefined;
        rejectOperation(mergeOperationAbortedError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () =>
        signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    }
    return operation;
  }

  async #integrate(
    input: EnqueueMergeInput,
    resume?: IntegrateResume,
  ): Promise<MergeQueueResult> {
    const taskKey = worktreeTaskKey(input.missionId, input.taskId);
    let claimed: MergeQueueClaim | null = null;
    let prepared: PreparedWorktreeIntegration | null = null;
    let candidate: CandidateCheckout | null = null;
    let candidateAttached = false;
    let integrationApplied = false;
    let integrationBaseSha: string | null = null;
    let evidenceIds: readonly string[] =
      resume?.acknowledgementEvidenceIds ?? [];

    try {
      claimed = resume?.claimed ?? this.#state.claim(
        this.#worktrees.scopeKey(input.scope),
        input.missionId,
        input.taskId,
        taskKey,
        this.#timestamp(),
      );
      this.#assertCurrentAuthority(input);
      if (resume) {
        const retryRecord = this.#worktrees.get(
          input.scope,
          input.missionId,
          input.taskId,
        );
        if (retryRecord?.status === 'failed') {
          this.#worktrees.reopenFailedForRetry(
            input.scope,
            input.missionId,
            input.taskId,
            resume.expectedTaskHeadSha,
          );
        } else {
          const retryPrepared = this.#worktrees.prepareRecoveryIntegration(
            input.scope,
            input.missionId,
            input.taskId,
          );
          if (retryPrepared.taskHeadSha !== resume.expectedTaskHeadSha) {
            throw new MergeCasError(
              'task HEAD changed before recoverable merge retry',
            );
          }
        }
      }
      prepared = this.#worktrees.prepareIntegration(
        input.scope,
        input.missionId,
        input.taskId,
      );
      const physicalTaskHeadSha =
        input.expectedTaskHeadSha === undefined
          ? resume?.expectedTaskHeadSha
          : assertSha(input.expectedTaskHeadSha, 'expected task HEAD SHA');
      if (
        resume &&
        input.expectedTaskHeadSha !== undefined &&
        physicalTaskHeadSha !== resume.expectedTaskHeadSha
      ) {
        throw new MergeCasError(
          'retry task HEAD authority diverged from the physical handoff',
        );
      }
      if (
        physicalTaskHeadSha !== undefined &&
        prepared.taskHeadSha !== physicalTaskHeadSha
      ) {
        throw new MergeCasError(
          'task HEAD does not match the physical handoff HEAD',
        );
      }
      this.#worktrees.markQueued(
        input.scope,
        input.missionId,
        input.taskId,
        prepared.taskHeadSha,
      );
      const integration = this.#worktrees.integrationSnapshot(prepared.record);
      integrationBaseSha = integration.headSha;
      this.#state.updateEntry(claimed, (entry) => ({
        ...entry,
        status: 'candidate-validating',
        taskHeadSha: prepared?.taskHeadSha,
        integrationBaseSha: integration.headSha,
        diffHash: prepared?.diffHash,
        updatedAt: this.#timestamp(),
      }));

      candidate = this.#buildCandidate(
        prepared,
        integration.headSha,
        claimed.scopeKey,
      );
      assertSafeLocalGitConfig(this.#git, prepared.record.rootRealPath);
      this.#git.run(prepared.record.rootRealPath, [
        'worktree',
        'add',
        '--detach',
        candidate.path,
        candidate.candidateSha,
      ]);
      candidateAttached = true;
      this.#assertCheckout(candidate.path, candidate.candidateSha, candidate.treeSha);

      const candidateDecision = await input.validate(
        this.#validationContext(
          'candidate',
          input,
          prepared,
          integration.headSha,
          candidate,
          candidate.path,
        ),
      );
      this.#assertCurrentAuthority(input);
      evidenceIds = Object.freeze([
        ...new Set([
          ...evidenceIds,
          ...this.#approvedEvidence(candidateDecision, 'candidate'),
        ]),
      ]);
      this.#assertCheckout(candidate.path, candidate.candidateSha, candidate.treeSha);
      this.#git.run(prepared.record.rootRealPath, [
        'worktree',
        'remove',
        candidate.path,
      ]);
      candidateAttached = false;

      this.#assertTaskUnchanged(input, prepared);
      this.#assertIntegrationCas(
        prepared.record,
        integration.headSha,
        'integration HEAD changed during candidate validation',
      );
      this.#assertCurrentAuthority(input);
      this.#state.updateEntry(claimed, (entry) => ({
        ...entry,
        status: 'integrating',
        candidateSha: candidate?.candidateSha,
        diffHash: candidate?.diffHash,
        evidenceIds,
        updatedAt: this.#timestamp(),
      }));

      const isFastForward = this.#git.run(
        prepared.record.rootRealPath,
        [
          'merge-base',
          '--is-ancestor',
          integration.headSha,
          candidate.candidateSha,
        ],
        { allowFailure: true },
      );
      if (isFastForward.status !== 0) {
        throw new MergeCasError('candidate is not a fast-forward descendant');
      }
      const refUpdate = this.#git.run(
        prepared.record.rootRealPath,
        [
          'update-ref',
          '-m',
          `Nexus integrate ${prepared.record.taskKey}`,
          prepared.record.integrationRef,
          candidate.candidateSha,
          integration.headSha,
        ],
        { allowFailure: true },
      );
      if (refUpdate.status !== 0) {
        throw new MergeCasError('exact fast-forward compare-and-swap failed', {
          cause: new GitCommandError(
            'git update-ref compare-and-swap failed',
            [
              'update-ref',
              prepared.record.integrationRef,
              candidate.candidateSha,
              integration.headSha,
            ],
            refUpdate,
          ),
        });
      }
      integrationApplied = true;
      const materialize = this.#git.run(
        prepared.record.rootRealPath,
        [
          'read-tree',
          '-u',
          '-m',
          integration.headSha,
          candidate.candidateSha,
        ],
        { allowFailure: true },
      );
      if (materialize.status !== 0) {
        throw new MergeCasError(
          'fast-forward ref succeeded but checkout materialization failed',
          {
            cause: new GitCommandError(
              'git read-tree materialization failed',
              [
                'read-tree',
                '-u',
                '-m',
                integration.headSha,
                candidate.candidateSha,
              ],
              materialize,
            ),
          },
        );
      }
      this.#assertTaskUnchanged(input, prepared);
      this.#assertIntegrationCas(
        prepared.record,
        candidate.candidateSha,
        'integrated checkout does not match the approved candidate',
      );
      this.#state.updateEntry(claimed, (entry) => ({
        ...entry,
        status: 'post-validating',
        integratedSha: candidate?.candidateSha,
        updatedAt: this.#timestamp(),
      }));

      this.#assertCurrentAuthority(input);
      const postDecision = await input.validate(
        this.#validationContext(
          'post-integration',
          input,
          prepared,
          integration.headSha,
          candidate,
          prepared.record.rootRealPath,
        ),
      );
      this.#assertCurrentAuthority(input);
      evidenceIds = Object.freeze([
        ...new Set([
          ...evidenceIds,
          ...this.#approvedEvidence(postDecision, 'post-integration'),
        ]),
      ]);
      this.#assertTaskUnchanged(input, prepared);
      this.#assertIntegrationCas(
        prepared.record,
        candidate.candidateSha,
        'post-integration validation changed the integrated checkout',
      );
      this.#assertCurrentAuthority(input);
      this.#state.updateEntry(claimed, (entry) => ({
        ...entry,
        status: 'finalizing',
        integratedSha: candidate?.candidateSha,
        evidenceIds,
        updatedAt: this.#timestamp(),
      }));
      this.#worktrees.markIntegrated(
        input.scope,
        input.missionId,
        input.taskId,
        candidate.candidateSha,
      );
      const result = Object.freeze({
        taskKey,
        taskHeadSha: prepared.taskHeadSha,
        integrationBaseSha: integration.headSha,
        candidateSha: candidate.candidateSha,
        integratedSha: candidate.candidateSha,
        diffHash: candidate.diffHash,
        evidenceIds,
      });
      this.#assertCurrentAuthority(input);
      this.#state.complete(
        claimed,
        candidate.candidateSha,
        evidenceIds,
        this.#timestamp(),
      );
      const finalization = input.finalize?.(result);
      if (
        finalization &&
        typeof (finalization as PromiseLike<void>).then === 'function'
      ) {
        await finalization;
      }
      retainApprovedMerge(input, result);
      scheduleProjectOrientationAfterMerge(input.scope, {
        integrationBaseSha: integration.headSha,
        integratedSha: candidate.candidateSha,
        changedFiles: prepared.changedFiles,
      });
      return result;
    } catch (caught) {
      let error = caught;
      let integrationRolledBack = false;
      const ownsAttempt = claimed
        ? this.#ownsRollbackAuthority(claimed)
        : false;
      if (
        integrationApplied &&
        prepared &&
        candidate &&
        integrationBaseSha &&
        ownsAttempt
      ) {
        try {
          rollbackIntegrationCheckout({
            scope: input.scope,
            missionId: input.missionId,
            taskId: input.taskId,
            taskHeadSha: prepared.taskHeadSha,
            integrationBaseSha,
            candidateSha: candidate.candidateSha,
            record: prepared.record,
            git: this.#git,
            worktrees: this.#worktrees,
          });
          integrationApplied = false;
          integrationRolledBack = true;
        } catch (rollbackError) {
          error = rollbackError;
        }
      }
      if (candidateAttached && candidate && prepared) {
        try {
          this.#assertCheckout(
            candidate.path,
            candidate.candidateSha,
            candidate.treeSha,
          );
          this.#git.run(prepared.record.rootRealPath, [
            'worktree',
            'remove',
            candidate.path,
          ]);
        } catch {
          // Never force-remove a candidate whose identity or cleanliness changed.
        }
      }
      if (claimed && ownsAttempt) {
        const disposition = classifyOperationalFailure(error);
        if (disposition === 'terminal') {
          try {
            this.#worktrees.markFailed(
              input.scope,
              input.missionId,
              input.taskId,
              errorMessage(error),
              integrationApplied ? candidate?.candidateSha : undefined,
            );
          } catch {
            // Queue persistence below remains the fail-closed authority.
          }
        }
        this.#blockAttempt(
          claimed,
          error,
          disposition,
          integrationApplied ? candidate?.candidateSha : undefined,
          integrationRolledBack,
        );
      }
      throw error;
    }
  }

  async #retry(input: RetryMergeInput): Promise<MergeQueueResult> {
    this.#assertCurrentAuthority(input);
    const attempt = this.#recovery.acknowledge(input);
    this.#assertCurrentAuthority(input);
    if (attempt.mode === 'full') {
      return this.#integrate(input, {
        claimed: attempt.claimed,
        expectedTaskHeadSha:
          input.expectedTaskHeadSha ?? attempt.prepared.taskHeadSha,
        acknowledgementEvidenceIds: attempt.acknowledgementEvidenceIds,
      });
    }
    const result = await this.#recovery.resumePostIntegration(input, attempt);
    retainApprovedMerge(input, result);
    scheduleProjectOrientationAfterMerge(input.scope, {
      integrationBaseSha: result.integrationBaseSha,
      integratedSha: result.integratedSha,
      changedFiles: attempt.prepared.changedFiles,
    });
    return result;
  }

  async #retryRecoverable(
    input: EnqueueMergeInput,
  ): Promise<MergeQueueResult> {
    const snapshot = this.snapshot(input.scope);
    const disposition = snapshot.blocked?.disposition ?? 'terminal';
    if (!snapshot.blocked || disposition === 'terminal') {
      if (snapshot.blocked) throw new MergeQueueBlockedError(snapshot.blocked);
      throw new MergeQueueStateError('merge queue has no recoverable block');
    }
    return this.#retry({
      ...input,
      expectedStateRevision: snapshot.revision,
      acknowledgement:
        disposition === 'retryable'
          ? { revisionId: `automatic-retry:${snapshot.revision}` }
          : {},
    });
  }

  #buildCandidate(
    prepared: PreparedWorktreeIntegration,
    integrationHeadSha: string,
    scopeKey: string,
  ): CandidateCheckout {
    assertSafeLocalGitConfig(this.#git, prepared.record.rootRealPath);
    const merge = this.#git.run(
      prepared.record.rootRealPath,
      [
        'merge-tree',
        '--write-tree',
        '--messages',
        integrationHeadSha,
        prepared.taskHeadSha,
      ],
      { allowFailure: true },
    );
    if (merge.status === 1) throw new MergeConflictError();
    if (merge.status !== 0) {
      throw new GitCommandError(
        'Git could not construct an integration candidate',
        [
          'merge-tree',
          '--write-tree',
          '--messages',
          integrationHeadSha,
          prepared.taskHeadSha,
        ],
        merge,
      );
    }
    const treeSha = assertSha(
      merge.stdout.split(/\r?\n/, 1)[0]?.trim() ?? '',
      'candidate tree SHA',
    );
    const timestamp = Math.floor(this.#timestamp() / 1_000);
    const commit = this.#git.run(
      prepared.record.rootRealPath,
      [
        'commit-tree',
        treeSha,
        '-p',
        integrationHeadSha,
        '-p',
        prepared.taskHeadSha,
        '-m',
        `Nexus integration ${prepared.record.taskKey}`,
      ],
      {
        env: {
          GIT_AUTHOR_NAME: 'Nexus Integration',
          GIT_AUTHOR_EMAIL: 'nexus@localhost',
          GIT_COMMITTER_NAME: 'Nexus Integration',
          GIT_COMMITTER_EMAIL: 'nexus@localhost',
          GIT_AUTHOR_DATE: `${timestamp} +0000`,
          GIT_COMMITTER_DATE: `${timestamp} +0000`,
        },
      },
    );
    const candidateSha = assertSha(commit.stdout.trim(), 'candidate commit SHA');
    const scopeDirectory = ensureDirectory(
      path.join(this.candidatesRoot, `scope-${scopeKey}`),
      this.candidatesRoot,
    );
    const candidatePath = path.join(
      scopeDirectory,
      `candidate-${this.#candidateKey(
        scopeKey,
        prepared.record.taskKey,
        integrationHeadSha,
        prepared.taskHeadSha,
      )}`,
    );
    try {
      fs.lstatSync(candidatePath);
      throw new MergeQueueStateError('derived candidate path already exists');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    const diff = this.#git.run(prepared.record.rootRealPath, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--full-index',
      integrationHeadSha,
      candidateSha,
    ]).stdout;
    return Object.freeze({
      path: candidatePath,
      treeSha,
      candidateSha,
      diffHash: createHash('sha256').update(diff).digest('hex'),
    });
  }

  #validationContext(
    phase: MergeValidationPhase,
    input: EnqueueMergeInput,
    prepared: PreparedWorktreeIntegration,
    integrationBaseSha: string,
    candidate: CandidateCheckout,
    checkoutPath: string,
  ): MergeValidationContext {
    return Object.freeze({
      phase,
      scope: Object.freeze({ ...input.scope }),
      missionId: input.missionId,
      taskId: input.taskId,
      taskKey: prepared.record.taskKey,
      checkoutPath,
      integrationBaseSha,
      taskHeadSha: prepared.taskHeadSha,
      candidateSha: candidate.candidateSha,
      diffHash: candidate.diffHash,
      changedFiles: Object.freeze([...prepared.changedFiles]),
      ...(input.signal ? { signal: input.signal } : {}),
      assertCurrentAuthority: () => this.#assertCurrentAuthority(input),
    });
  }

  #approvedEvidence(
    decision: MergeValidationDecision,
    phase: MergeValidationPhase,
  ): readonly string[] {
    if (
      !decision ||
      !Array.isArray(decision.evidenceIds) ||
      decision.evidenceIds.length === 0 ||
      decision.evidenceIds.length > 4_096 ||
      decision.evidenceIds.some(
        (id) =>
          typeof id !== 'string' ||
          id.length === 0 ||
          id.length > 256 ||
          id.includes('\0'),
      )
    ) {
      throw new MergeValidationRejectedError(phase);
    }
    const evidenceIds = Object.freeze([...new Set(decision.evidenceIds)]);
    if (
      decision.sensorsPassed !== true ||
      decision.reviewPassed !== true
    ) {
      throw new MergeValidationRejectedError(phase, evidenceIds);
    }
    return evidenceIds;
  }

  #assertCheckout(
    checkoutPath: string,
    expectedHeadSha: string,
    expectedTreeSha: string,
  ): void {
    const real = fs.realpathSync(checkoutPath);
    if (real !== checkoutPath) {
      throw new MergeCasError('candidate checkout path identity changed');
    }
    assertSafeLocalGitConfig(this.#git, real);
    const topLevel = fs.realpathSync(
      this.#git.run(real, ['rev-parse', '--show-toplevel']).stdout.trim(),
    );
    if (topLevel !== real) {
      throw new MergeCasError('candidate Git top-level changed');
    }
    const headSha = assertSha(
      this.#git.run(real, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim(),
      'candidate HEAD',
    );
    const treeSha = assertSha(
      this.#git.run(real, ['rev-parse', '--verify', 'HEAD^{tree}']).stdout.trim(),
      'candidate tree',
    );
    const status = this.#git.run(real, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]).stdout;
    if (
      headSha !== expectedHeadSha ||
      treeSha !== expectedTreeSha ||
      status.length > 0
    ) {
      throw new MergeCasError('candidate checkout changed during validation');
    }
  }

  #assertIntegrationCas(
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

  #assertTaskUnchanged(
    input: EnqueueMergeInput,
    expected: PreparedWorktreeIntegration,
  ): void {
    const current = this.#worktrees.prepareIntegration(
      input.scope,
      input.missionId,
      input.taskId,
    );
    if (
      current.taskHeadSha !== expected.taskHeadSha ||
      current.diffHash !== expected.diffHash
    ) {
      throw new MergeCasError('task diff changed after candidate validation');
    }
  }

  #assertCurrentAuthority(input: EnqueueMergeInput): void {
    if (input.signal?.aborted) {
      throw mergeOperationAbortedError(input.signal);
    }
    if (!input.assertCurrentAuthority) return;
    try {
      input.assertCurrentAuthority();
    } catch (error) {
      throw new MergeAuthorityRevokedError(error);
    }
  }

  #ownsRollbackAuthority(claimed: MergeQueueClaim): boolean {
    const snapshot = this.#state.snapshot(claimed.scopeKey);
    const current = snapshot.entries.find(
      (entry) => entry.id === claimed.entry.id,
    );
    return (
      current?.attempt === claimed.entry.attempt &&
      snapshot.activeTaskKey === claimed.entry.taskKey
    );
  }

  #blockAttempt(
    claimed: MergeQueueClaim,
    error: unknown,
    disposition: ReturnType<typeof classifyOperationalFailure>,
    integratedSha?: string,
    integrationRolledBack = false,
  ): void {
    this.#state.block(claimed, {
      errorName: errorName(error),
      reason: errorMessage(error),
      now: this.#timestamp(),
      disposition,
      integratedSha,
      integrationRolledBack,
      rejectedEvidenceIds:
        error instanceof MergeValidationRejectedError
          ? error.evidenceIds
          : [],
    });
  }

  #candidateKey(
    scopeKey: string,
    taskKey: string,
    integrationBaseSha: string,
    taskHeadSha: string,
  ): string {
    return createHash('sha256')
      .update(scopeKey)
      .update('\0')
      .update(taskKey)
      .update('\0')
      .update(integrationBaseSha)
      .update('\0')
      .update(taskHeadSha)
      .digest('hex');
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('merge queue clock returned an invalid timestamp');
    }
    return value;
  }
}
