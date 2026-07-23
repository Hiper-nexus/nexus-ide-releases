import { createHash } from 'node:crypto';
import {
  MergeCasError,
  MergeQueueBlockedError,
  MergeQueueBusyError,
  MergeQueueStateError,
  type MergeQueueBlock,
  type MergeQueueEntry,
  type MergeQueueEntryStatus,
  type MergeQueueEvent,
  type MergeQueueEventType,
  type MergeQueueIntegrationState,
  type MergeQueueStateSnapshot,
  type MergeQueueStateStore,
} from './merge-queue-contract';
import {
  cloneMergeQueueBlock as cloneBlock,
  cloneMergeQueueEntry as cloneEntry,
  cloneMergeQueueEvent as cloneEvent,
  validateMergeQueueStateSnapshot,
} from './merge-queue-state';

const MAX_CAS_ATTEMPTS = 16;

export interface MergeQueueClaim {
  readonly scopeKey: string;
  readonly entry: MergeQueueEntry;
}

export interface MergeEventDetails {
  readonly fromStatus?: MergeQueueEntryStatus;
  readonly integrationState?: MergeQueueIntegrationState;
  readonly errorName?: string;
  readonly reason?: string;
  readonly revisionId?: string;
  readonly taskHeadSha?: string;
  readonly candidateSha?: string;
  readonly evidenceIds?: readonly string[];
}

interface BlockAttemptInput {
  readonly errorName: string;
  readonly reason: string;
  readonly now: number;
  readonly integratedSha?: string;
  /** Exact Git CAS restored candidate → integration base. */
  readonly integrationRolledBack?: boolean;
  readonly rejectedEvidenceIds?: readonly string[];
}

export class MergeQueueStateController {
  readonly #store: MergeQueueStateStore;

  constructor(store: MergeQueueStateStore) {
    if (
      !store ||
      typeof store.read !== 'function' ||
      typeof store.compareAndSwap !== 'function'
    ) {
      throw new Error('a durable merge queue state store is required');
    }
    this.#store = store;
  }

  snapshot(scopeKey: string): MergeQueueStateSnapshot {
    try {
      return validateMergeQueueStateSnapshot(this.#store.read(scopeKey));
    } catch (error) {
      throw new MergeQueueStateError(
        error instanceof Error ? error.message : 'invalid merge queue state',
      );
    }
  }

  claim(
    scopeKey: string,
    missionId: string,
    taskId: string,
    taskKey: string,
    now: number,
  ): MergeQueueClaim {
    const entry = cloneEntry({
      id: `merge-${taskKey}`,
      taskKey,
      missionId,
      taskId,
      attempt: 1,
      status: 'queued',
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
    });
    this.mutate(scopeKey, (state) => {
      if (state.blocked) throw new MergeQueueBlockedError(state.blocked);
      if (state.activeTaskKey) {
        throw new MergeQueueBusyError(state.activeTaskKey);
      }
      if (state.entries.some((existing) => existing.taskKey === taskKey)) {
        throw new MergeQueueStateError('task already has a merge queue entry');
      }
      return {
        ...state,
        activeTaskKey: taskKey,
        entries: [...state.entries, entry],
      };
    });
    return Object.freeze({ scopeKey, entry });
  }

  updateEntry(
    claimed: MergeQueueClaim,
    update: (entry: MergeQueueEntry) => MergeQueueEntry,
  ): MergeQueueEntry {
    let result: MergeQueueEntry | null = null;
    this.mutate(claimed.scopeKey, (state) => {
      if (state.activeTaskKey !== claimed.entry.taskKey) {
        throw new MergeQueueStateError('merge queue claim was lost');
      }
      const index = state.entries.findIndex(
        (entry) => entry.id === claimed.entry.id,
      );
      if (index < 0) {
        throw new MergeQueueStateError('merge queue entry disappeared');
      }
      if (state.entries[index].attempt !== claimed.entry.attempt) {
        throw new MergeQueueStateError('merge queue attempt was superseded');
      }
      result = cloneEntry(update(state.entries[index]));
      return {
        ...state,
        entries: state.entries.map((entry, candidateIndex) =>
          candidateIndex === index ? result as MergeQueueEntry : entry,
        ),
      };
    });
    if (!result) throw new MergeQueueStateError('merge queue update failed');
    return result;
  }

  complete(
    claimed: MergeQueueClaim,
    integratedSha: string,
    evidenceIds: readonly string[],
    now: number,
  ): void {
    this.mutate(claimed.scopeKey, (state, nextRevision) => {
      const current = this.#assertCurrentAttempt(state, claimed);
      const completed = cloneEntry({
        ...current,
        status: 'integrated',
        integratedSha,
        evidenceIds,
        failureReason: undefined,
        updatedAt: now,
      });
      return {
        ...state,
        activeTaskKey: null,
        events: [
          ...state.events,
          this.event(
            claimed.scopeKey,
            completed,
            'integrated',
            nextRevision,
            now,
            {
              fromStatus: current.status,
              integrationState: 'candidate-integrated',
              taskHeadSha: completed.taskHeadSha,
              candidateSha: completed.candidateSha,
              evidenceIds,
            },
          ),
        ],
        entries: state.entries.map((entry) =>
          entry.id === claimed.entry.id ? completed : entry,
        ),
      };
    });
  }

  block(claimed: MergeQueueClaim, input: BlockAttemptInput): MergeQueueBlock {
    const block = Object.freeze({
      taskKey: claimed.entry.taskKey,
      errorName: input.errorName,
      reason: input.reason,
      blockedAt: input.now,
    });
    this.mutate(claimed.scopeKey, (state, nextRevision) => {
      const current = this.#assertCurrentAttempt(state, claimed);
      const rejectedEvidenceIds = input.rejectedEvidenceIds ?? [];
      const evidenceIds = Object.freeze([
        ...new Set([...current.evidenceIds, ...rejectedEvidenceIds]),
      ]);
      const blockedEntry = cloneEntry({
        ...current,
        status: 'blocked',
        ...(input.integrationRolledBack
          ? { integratedSha: undefined }
          : input.integratedSha
          ? { integratedSha: input.integratedSha }
          : {}),
        evidenceIds,
        failureReason: block.reason,
        updatedAt: input.now,
      });
      return {
        ...state,
        activeTaskKey: null,
        blocked: block,
        events: [
          ...state.events,
          this.event(
            claimed.scopeKey,
            blockedEntry,
            'blocked',
            nextRevision,
            input.now,
            {
              fromStatus: current.status,
              integrationState:
                input.integratedSha && !input.integrationRolledBack
                ? 'candidate-integrated'
                : 'not-integrated',
              errorName: block.errorName,
              reason: block.reason,
              taskHeadSha: blockedEntry.taskHeadSha,
              candidateSha: blockedEntry.candidateSha,
              evidenceIds: rejectedEvidenceIds,
            },
          ),
        ],
        entries: state.entries.map((entry) =>
          entry.id === claimed.entry.id ? blockedEntry : entry,
        ),
      };
    });
    return block;
  }

  event(
    scopeKey: string,
    entry: MergeQueueEntry,
    type: MergeQueueEventType,
    stateRevision: number,
    occurredAt: number,
    details: MergeEventDetails = {},
  ): MergeQueueEvent {
    const evidenceIds = Object.freeze([
      ...new Set(details.evidenceIds ?? []),
    ]);
    const eventHash = createHash('sha256')
      .update(scopeKey)
      .update('\0')
      .update(entry.taskKey)
      .update('\0')
      .update(String(entry.attempt))
      .update('\0')
      .update(type)
      .update('\0')
      .update(String(stateRevision))
      .update('\0')
      .update(String(occurredAt))
      .digest('hex');
    return cloneEvent({
      id: `merge-event-${eventHash}`,
      type,
      taskKey: entry.taskKey,
      attempt: entry.attempt,
      stateRevision,
      occurredAt,
      ...details,
      evidenceIds,
    });
  }

  mutate(
    scopeKey: string,
    update: (
      state: Omit<MergeQueueStateSnapshot, 'revision'>,
      nextRevision: number,
    ) => Omit<MergeQueueStateSnapshot, 'revision'>,
    expectedRevision?: number,
  ): void {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = this.snapshot(scopeKey);
      if (
        expectedRevision !== undefined &&
        snapshot.revision !== expectedRevision
      ) {
        throw new MergeCasError(
          'merge queue revision changed before the fenced transition',
        );
      }
      const current = {
        activeTaskKey: snapshot.activeTaskKey,
        blocked: snapshot.blocked,
        events: snapshot.events,
        entries: snapshot.entries,
      };
      const nextRevision = snapshot.revision + 1;
      const next = update(current, nextRevision);
      const state = this.#validatedState(next, nextRevision);
      if (this.#store.compareAndSwap(scopeKey, snapshot.revision, state)) return;
      if (expectedRevision !== undefined) {
        throw new MergeCasError(
          'merge queue compare-and-swap rejected the fenced retry transition',
        );
      }
    }
    throw new MergeQueueStateError(
      'merge queue persistence CAS could not converge',
    );
  }

  #assertCurrentAttempt(
    state: Omit<MergeQueueStateSnapshot, 'revision'>,
    claimed: MergeQueueClaim,
  ): MergeQueueEntry {
    if (state.activeTaskKey !== claimed.entry.taskKey) {
      throw new MergeQueueStateError('merge queue claim was lost');
    }
    const current = state.entries.find(
      (entry) => entry.id === claimed.entry.id,
    );
    if (!current || current.attempt !== claimed.entry.attempt) {
      throw new MergeQueueStateError('merge queue attempt was superseded');
    }
    return current;
  }

  #validatedState(
    next: Omit<MergeQueueStateSnapshot, 'revision'>,
    revision: number,
  ): Omit<MergeQueueStateSnapshot, 'revision'> {
    try {
      const validated = validateMergeQueueStateSnapshot({
        revision,
        activeTaskKey: next.activeTaskKey,
        blocked: next.blocked,
        events: next.events,
        entries: next.entries,
      });
      return Object.freeze({
        activeTaskKey: validated.activeTaskKey,
        blocked: cloneBlock(validated.blocked),
        events: Object.freeze(validated.events.map(cloneEvent)),
        entries: Object.freeze(validated.entries.map(cloneEntry)),
      });
    } catch (error) {
      throw new MergeQueueStateError(
        error instanceof Error ? error.message : 'invalid merge queue state',
      );
    }
  }
}
