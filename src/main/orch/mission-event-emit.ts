import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  MissionEventJournal,
  createMissionEventFixture,
} from './mission-event-journal';
import type { MissionEventAppendInput, MissionEventType } from '../../shared/mission-events';

/**
 * Thin production emitter for mission driver / orch lifecycle.
 * Fail-closed when flag off or runtime missing.
 */

let runtimeManager: ProjectRuntimeManager | null = null;

export function configureMissionEventEmit(
  manager: ProjectRuntimeManager | null,
): void {
  runtimeManager = manager;
}

export function emitMissionEvent(
  scope: ProjectExecutionScope,
  input: MissionEventAppendInput,
): boolean {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.missionEventJournal)
  ) {
    return false;
  }
  if (!runtimeManager) return false;
  try {
    const journal = new MissionEventJournal(runtimeManager, scope);
    journal.append(input);
    return true;
  } catch (err) {
    console.warn('[mission-events] append failed:', err);
    return false;
  }
}

/**
 * Emit a driver decision. `logicalTick` must be stable across retries of the
 * same decision (attemptCount, lastSignalAt, or similar) so journal
 * idempotency dedupes — never embed wall-clock uniqueness.
 */
export function emitDriverDecision(
  scope: ProjectExecutionScope,
  missionId: string,
  actionKind: string,
  reason: string,
  mode: 'shadow' | 'active',
  logicalTick: number | string = 0,
): boolean {
  const type: MissionEventType = 'driver.tick';
  const tick = String(logicalTick);
  const reasonKey = reason.slice(0, 48).replace(/[^A-Za-z0-9._:-]+/g, '_');
  return emitMissionEvent(scope, {
    missionId,
    runId: `drive-${missionId}`,
    type,
    origin: 'driver',
    idempotencyKey: `drive:${missionId}:${actionKind}:${reasonKey}:${tick}`,
    payload: {
      actionKind,
      reason: reason.slice(0, 512),
      mode,
      logicalTick: tick,
    },
  });
}

/** Test helper re-export. */
export { createMissionEventFixture };
