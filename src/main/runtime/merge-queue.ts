import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
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
  MergeQueueStateError,
  MergeValidationRejectedError,
  type EnqueueMergeInput,
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
    return this.#schedule(input.scope, () => this.#integrate(input));
  }

  retry(input: RetryMergeInput): Promise<MergeQueueResult> {
    return this.#schedule(input.scope, () => this.#retry(input));
  }

  snapshot(scope: ProjectExecutionScope): MergeQueueStateSnapshot {
    return this.#state.snapshot(this.#worktrees.scopeKey(scope));
  }

  reconcile(scope: ProjectExecutionScope): MergeQueueReconciliationResult {
    return this.#recovery.reconcile(scope);
  }

  #schedule(
    scope: ProjectExecutionScope,
    run: () => Promise<MergeQueueResult>,
  ): Promise<MergeQueueResult> {
    const scopeKey = this.#worktrees.scopeKey(scope);
    const previous = this.#tails.get(scopeKey) ?? Promise.resolve();
    const operation = previous.then(run);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(scopeKey, tail);
    void tail.then(() => {
      if (this.#tails.get(scopeKey) === tail) this.#tails.delete(scopeKey);
    });
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
        this.#worktrees.reopenFailedForRetry(
          input.scope,
          input.missionId,
          input.taskId,
          resume.expectedTaskHeadSha,
        );
      }
      prepared = this.#worktrees.prepareIntegration(
        input.scope,
        input.missionId,
        input.taskId,
      );
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
      const finalization = input.finalize?.(result);
      if (
        finalization &&
        typeof (finalization as PromiseLike<void>).then === 'function'
      ) {
        await finalization;
      }
      this.#assertCurrentAuthority(input);
      this.#state.complete(
        claimed,
        candidate.candidateSha,
        evidenceIds,
        this.#timestamp(),
      );
      return result;
    } catch (caught) {
      let error = caught;
      let integrationRolledBack = false;
      if (
        error instanceof MergeAuthorityRevokedError &&
        integrationApplied &&
        prepared &&
        candidate &&
        integrationBaseSha
      ) {
        try {
          this.#rollbackRevokedIntegration(
            prepared.record,
            integrationBaseSha,
            candidate.candidateSha,
          );
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
      if (claimed) {
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
        this.#blockAttempt(
          claimed,
          error,
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
        expectedTaskHeadSha: attempt.prepared.taskHeadSha,
        acknowledgementEvidenceIds: attempt.acknowledgementEvidenceIds,
      });
    }
    return this.#recovery.resumePostIntegration(input, attempt);
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
    if (!input.assertCurrentAuthority) return;
    try {
      input.assertCurrentAuthority();
    } catch (error) {
      throw new MergeAuthorityRevokedError(error);
    }
  }

  #rollbackRevokedIntegration(
    record: WorktreeRecord,
    integrationBaseSha: string,
    candidateSha: string,
  ): void {
    this.#assertIntegrationCas(
      record,
      candidateSha,
      'cannot roll back a revoked merge because integration HEAD changed',
    );
    const refRollback = this.#git.run(
      record.rootRealPath,
      [
        'update-ref',
        '-m',
        `Nexus revoke ${record.taskKey}`,
        record.integrationRef,
        integrationBaseSha,
        candidateSha,
      ],
      { allowFailure: true },
    );
    if (refRollback.status !== 0) {
      throw new MergeCasError(
        'revoked merge rollback compare-and-swap failed',
        {
          cause: new GitCommandError(
            'git update-ref rollback compare-and-swap failed',
            [
              'update-ref',
              record.integrationRef,
              integrationBaseSha,
              candidateSha,
            ],
            refRollback,
          ),
        },
      );
    }
    const materialize = this.#git.run(
      record.rootRealPath,
      [
        'read-tree',
        '-u',
        '-m',
        candidateSha,
        integrationBaseSha,
      ],
      { allowFailure: true },
    );
    if (materialize.status !== 0) {
      throw new MergeCasError(
        'revoked merge ref rolled back but checkout rematerialization failed',
        {
          cause: new GitCommandError(
            'git read-tree rollback materialization failed',
            [
              'read-tree',
              '-u',
              '-m',
              candidateSha,
              integrationBaseSha,
            ],
            materialize,
          ),
        },
      );
    }
    this.#assertIntegrationCas(
      record,
      integrationBaseSha,
      'revoked merge checkout did not return to the exact integration base',
    );
  }

  #blockAttempt(
    claimed: MergeQueueClaim,
    error: unknown,
    integratedSha?: string,
    integrationRolledBack = false,
  ): void {
    this.#state.block(claimed, {
      errorName: errorName(error),
      reason: errorMessage(error),
      now: this.#timestamp(),
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
