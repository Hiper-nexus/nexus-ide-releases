import { describe, expect, it } from 'vitest';
import {
  findStalledActiveMergeEntry,
  MERGE_VALIDATION_UPPER_BOUND_MS,
  STALL_DEADLINE_BUFFER_MS,
  STALLED_MERGE_ATTEMPT_MS,
} from './merge-stall-watchdog';
import type { MergeQueueEntry } from './merge-queue-contract';

const NOW = 10_000_000;

function entry(overrides: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    id: 'merge-1',
    taskKey: 'key-1',
    taskId: 'task-1',
    missionId: 'mission-1',
    attempt: 1,
    status: 'candidate-validating',
    createdAt: NOW - STALLED_MERGE_ATTEMPT_MS - 60_000,
    updatedAt: NOW - STALLED_MERGE_ATTEMPT_MS - 1,
    evidenceIds: [],
    ...overrides,
  } as MergeQueueEntry;
}

describe('findStalledActiveMergeEntry', () => {
  it('derives the deadline as operation timeout + buffer, never smaller than the timeout', () => {
    // Regra do buzz (crates/buzz-acp/src/queue.rs): deadline = timeout da
    // operação + buffer. Um deadline menor que o timeout mataria validações
    // vivas por construção.
    expect(STALL_DEADLINE_BUFFER_MS).toBeGreaterThan(0);
    expect(STALLED_MERGE_ATTEMPT_MS).toBe(
      MERGE_VALIDATION_UPPER_BOUND_MS + STALL_DEADLINE_BUFFER_MS,
    );
  });

  it('flags the exact live incident: candidate-validating parked past the bound', () => {
    const stalled = findStalledActiveMergeEntry(
      { activeTaskKey: 'key-1', entries: [entry()] },
      NOW,
    );
    expect(stalled?.taskKey).toBe('key-1');
  });

  it('never touches a validation still inside the legitimate bound', () => {
    // O merge council do gate empacotado tem bound de 20 min: aos 20min01s a
    // validação ainda é legítima e o watchdog não pode matá-la.
    const healthy = entry({ updatedAt: NOW - 20 * 60_000 - 1_000 });
    expect(
      findStalledActiveMergeEntry(
        { activeTaskKey: 'key-1', entries: [healthy] },
        NOW,
      ),
    ).toBeNull();
  });

  it('ignores a queue with no active attempt', () => {
    expect(
      findStalledActiveMergeEntry(
        { activeTaskKey: null, entries: [entry()] },
        NOW,
      ),
    ).toBeNull();
  });

  it('ignores an entry already terminal even when ancient', () => {
    const blocked = entry({ status: 'blocked' });
    expect(
      findStalledActiveMergeEntry(
        { activeTaskKey: 'key-1', entries: [blocked] },
        NOW,
      ),
    ).toBeNull();
  });

  it('covers every in-flight status, not just the observed one', () => {
    for (const status of [
      'candidate-validating',
      'integrating',
      'post-validating',
      'finalizing',
    ] as const) {
      expect(
        findStalledActiveMergeEntry(
          { activeTaskKey: 'key-1', entries: [entry({ status })] },
          NOW,
        )?.status,
      ).toBe(status);
    }
  });

  it('refuses a corrupt timestamp instead of treating it as infinitely old', () => {
    const corrupt = entry({ updatedAt: Number.NaN });
    expect(
      findStalledActiveMergeEntry(
        { activeTaskKey: 'key-1', entries: [corrupt] },
        NOW,
      ),
    ).toBeNull();
  });
});
