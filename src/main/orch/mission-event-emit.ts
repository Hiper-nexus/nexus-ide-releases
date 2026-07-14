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

export function emitDriverDecision(
  scope: ProjectExecutionScope,
  missionId: string,
  actionKind: string,
  reason: string,
  mode: 'shadow' | 'active',
): boolean {
  const type: MissionEventType =
    actionKind === 'wait' ? 'driver.tick' : 'driver.tick';
  return emitMissionEvent(scope, {
    missionId,
    runId: `drive-${missionId}`,
    type,
    origin: 'driver',
    idempotencyKey: `drive:${missionId}:${actionKind}:${reason.slice(0, 48)}:${Date.now()}`,
    payload: {
      actionKind,
      reason: reason.slice(0, 512),
      mode,
    },
  });
}

/** Test helper re-export. */
export { createMissionEventFixture };
