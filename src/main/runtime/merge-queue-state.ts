import {
  type MergeQueueBlock,
  type MergeQueueEntry,
  type MergeQueueEvent,
  type MergeQueueEventType,
  type MergeQueueIntegrationState,
  type MergeQueueEntryStatus,
  type MergeQueueStateSnapshot,
} from './merge-queue-contract';
import { DIGEST_PATTERN, SHA_PATTERN, worktreeTaskKey } from './worktree-contract';

const ENTRY_STATUSES = new Set<MergeQueueEntryStatus>([
  'queued',
  'candidate-validating',
  'integrating',
  'post-validating',
  'integrated',
  'blocked',
]);
const ACTIVE_ENTRY_STATUSES = new Set<MergeQueueEntryStatus>([
  'queued',
  'candidate-validating',
  'integrating',
  'post-validating',
]);
const EVENT_TYPES = new Set<MergeQueueEventType>([
  'blocked',
  'retry-acknowledged',
  'restart-reconciled',
  'integrated',
]);
const INTEGRATION_STATES = new Set<MergeQueueIntegrationState>([
  'not-integrated',
  'candidate-integrated',
  'unknown',
]);
const EVENT_ID_PATTERN = /^merge-event-[a-f0-9]{64}$/;

function invalidState(message = 'invalid merge queue state entry'): never {
  throw new Error(message);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !value.includes('\0')
  );
}

function isOptionalSha(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && SHA_PATTERN.test(value));
}

function isOptionalDigest(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && DIGEST_PATTERN.test(value));
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isEvidenceIds(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 8_192 &&
    value.every(isIdentifier) &&
    new Set(value).size === value.length
  );
}

function isOptionalFailureReason(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length <= 2_048 && !value.includes('\0'))
  );
}

function isAttempt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function hasValidStatusFields(entry: MergeQueueEntry): boolean {
  if (entry.status === 'queued') {
    return (
      entry.taskHeadSha === undefined &&
      entry.integrationBaseSha === undefined &&
      entry.candidateSha === undefined &&
      entry.integratedSha === undefined &&
      entry.diffHash === undefined &&
      entry.evidenceIds.length === 0 &&
      entry.failureReason === undefined
    );
  }
  if (entry.status === 'candidate-validating') {
    return (
      !!entry.taskHeadSha &&
      !!entry.integrationBaseSha &&
      !!entry.diffHash &&
      entry.candidateSha === undefined &&
      entry.integratedSha === undefined &&
      entry.evidenceIds.length === 0 &&
      entry.failureReason === undefined
    );
  }
  if (entry.status === 'integrating') {
    return (
      !!entry.taskHeadSha &&
      !!entry.integrationBaseSha &&
      !!entry.candidateSha &&
      !!entry.diffHash &&
      entry.integratedSha === undefined &&
      entry.evidenceIds.length > 0 &&
      entry.failureReason === undefined
    );
  }
  if (entry.status === 'post-validating' || entry.status === 'integrated') {
    return (
      !!entry.taskHeadSha &&
      !!entry.integrationBaseSha &&
      !!entry.candidateSha &&
      entry.integratedSha === entry.candidateSha &&
      !!entry.diffHash &&
      entry.evidenceIds.length > 0 &&
      entry.failureReason === undefined
    );
  }
  if (entry.status !== 'blocked' || entry.failureReason === undefined) {
    return false;
  }
  const coreFields = [
    entry.taskHeadSha,
    entry.integrationBaseSha,
    entry.diffHash,
  ];
  const hasAllCoreFields = coreFields.every((value) => value !== undefined);
  const hasNoCoreFields = coreFields.every((value) => value === undefined);
  return (
    (hasAllCoreFields || hasNoCoreFields) &&
    (entry.candidateSha === undefined || hasAllCoreFields) &&
    (entry.integratedSha === undefined ||
      entry.integratedSha === entry.candidateSha)
  );
}

export function cloneMergeQueueEntry(entry: MergeQueueEntry): MergeQueueEntry {
  return Object.freeze({
    ...entry,
    evidenceIds: Object.freeze([...entry.evidenceIds]),
  });
}

export function cloneMergeQueueEvent(event: MergeQueueEvent): MergeQueueEvent {
  return Object.freeze({
    ...event,
    evidenceIds: Object.freeze([...event.evidenceIds]),
  });
}

export function cloneMergeQueueBlock(
  block: MergeQueueBlock | null,
): MergeQueueBlock | null {
  return block ? Object.freeze({ ...block }) : null;
}

function validateEntry(value: unknown): MergeQueueEntry {
  if (!value || typeof value !== 'object') invalidState();
  const stored = value as MergeQueueEntry;
  // Queue states written before attempt fencing are safely interpreted as the
  // first attempt. The next retry increments this token before any work runs.
  const entry = {
    ...stored,
    attempt: stored.attempt ?? 1,
  } as MergeQueueEntry;
  let expectedTaskKey: string;
  try {
    expectedTaskKey = worktreeTaskKey(entry.missionId, entry.taskId);
  } catch {
    invalidState();
  }
  if (
    entry.taskKey !== expectedTaskKey ||
    entry.id !== `merge-${expectedTaskKey}` ||
    !isAttempt(entry.attempt) ||
    !ENTRY_STATUSES.has(entry.status) ||
    !isOptionalSha(entry.taskHeadSha) ||
    !isOptionalSha(entry.integrationBaseSha) ||
    !isOptionalSha(entry.candidateSha) ||
    !isOptionalSha(entry.integratedSha) ||
    !isOptionalDigest(entry.diffHash) ||
    !isEvidenceIds(entry.evidenceIds) ||
    !isOptionalFailureReason(entry.failureReason) ||
    !isTimestamp(entry.createdAt) ||
    !isTimestamp(entry.updatedAt) ||
    entry.updatedAt < entry.createdAt ||
    !hasValidStatusFields(entry)
  ) {
    invalidState();
  }
  return cloneMergeQueueEntry(entry);
}

function validateEvent(
  value: unknown,
  snapshotRevision: number,
): MergeQueueEvent {
  if (!value || typeof value !== 'object') {
    invalidState('invalid merge queue event');
  }
  const event = value as MergeQueueEvent;
  if (
    typeof event.id !== 'string' ||
    !EVENT_ID_PATTERN.test(event.id) ||
    !EVENT_TYPES.has(event.type) ||
    typeof event.taskKey !== 'string' ||
    !DIGEST_PATTERN.test(event.taskKey) ||
    !isAttempt(event.attempt) ||
    !Number.isSafeInteger(event.stateRevision) ||
    event.stateRevision < 1 ||
    event.stateRevision > snapshotRevision ||
    !isTimestamp(event.occurredAt) ||
    (event.fromStatus !== undefined && !ENTRY_STATUSES.has(event.fromStatus)) ||
    (event.integrationState !== undefined &&
      !INTEGRATION_STATES.has(event.integrationState)) ||
    (event.errorName !== undefined && !isIdentifier(event.errorName)) ||
    !isOptionalFailureReason(event.reason) ||
    (event.revisionId !== undefined && !isIdentifier(event.revisionId)) ||
    !isOptionalSha(event.taskHeadSha) ||
    !isOptionalSha(event.candidateSha) ||
    !isEvidenceIds(event.evidenceIds)
  ) {
    invalidState('invalid merge queue event');
  }
  return cloneMergeQueueEvent(event);
}

function validateBlock(
  value: unknown,
  entries: readonly MergeQueueEntry[],
): MergeQueueBlock | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') invalidState('invalid merge queue block');
  const block = value as MergeQueueBlock;
  const entry = entries.find((candidate) => candidate.taskKey === block.taskKey);
  if (
    typeof block.taskKey !== 'string' ||
    !DIGEST_PATTERN.test(block.taskKey) ||
    !isIdentifier(block.errorName) ||
    typeof block.reason !== 'string' ||
    block.reason.length > 2_048 ||
    block.reason.includes('\0') ||
    !isTimestamp(block.blockedAt) ||
    entry?.status !== 'blocked' ||
    entry.failureReason !== block.reason
  ) {
    invalidState('invalid merge queue block');
  }
  return cloneMergeQueueBlock(block);
}

export function validateMergeQueueStateSnapshot(
  value: unknown,
): MergeQueueStateSnapshot {
  if (!value || typeof value !== 'object') {
    invalidState('invalid merge queue state snapshot');
  }
  const snapshot = value as MergeQueueStateSnapshot;
  if (
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Array.isArray(snapshot.entries)
  ) {
    invalidState('invalid merge queue state snapshot');
  }

  const entries = snapshot.entries.map(validateEntry);
  const ids = new Set(entries.map((entry) => entry.id));
  const taskKeys = new Set(entries.map((entry) => entry.taskKey));
  if (ids.size !== entries.length || taskKeys.size !== entries.length) {
    invalidState('duplicate merge queue state entry');
  }
  const blocked = validateBlock(snapshot.blocked, entries);
  if (
    snapshot.activeTaskKey !== null &&
    (typeof snapshot.activeTaskKey !== 'string' ||
      !DIGEST_PATTERN.test(snapshot.activeTaskKey))
  ) {
    invalidState('invalid merge queue active task');
  }
  const activeEntries = entries.filter((entry) =>
    ACTIVE_ENTRY_STATUSES.has(entry.status),
  );
  if (
    (snapshot.activeTaskKey === null && activeEntries.length !== 0) ||
    (snapshot.activeTaskKey !== null &&
      (blocked !== null ||
        activeEntries.length !== 1 ||
        activeEntries[0]?.taskKey !== snapshot.activeTaskKey))
  ) {
    invalidState('merge queue active task is inconsistent');
  }
  const storedEvents = (snapshot as MergeQueueStateSnapshot & {
    readonly events?: unknown;
  }).events ?? [];
  if (!Array.isArray(storedEvents) || storedEvents.length > 8_192) {
    invalidState('invalid merge queue events');
  }
  const events = storedEvents.map((event) =>
    validateEvent(event, snapshot.revision),
  );
  const eventIds = new Set(events.map((event) => event.id));
  if (eventIds.size !== events.length) {
    invalidState('duplicate merge queue event');
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].stateRevision > events[index].stateRevision) {
      invalidState('merge queue events are out of revision order');
    }
  }
  const latestAttemptByTask = new Map<string, number>();
  for (const event of events) {
    const entry = entries.find((candidate) => candidate.taskKey === event.taskKey);
    const previousAttempt = latestAttemptByTask.get(event.taskKey) ?? 0;
    if (
      !entry ||
      event.attempt > entry.attempt ||
      event.attempt < previousAttempt
    ) {
      invalidState('merge queue event attempt is inconsistent');
    }
    latestAttemptByTask.set(event.taskKey, event.attempt);
  }

  return Object.freeze({
    revision: snapshot.revision,
    activeTaskKey: snapshot.activeTaskKey,
    blocked,
    events: Object.freeze(events),
    entries: Object.freeze(entries),
  });
}
