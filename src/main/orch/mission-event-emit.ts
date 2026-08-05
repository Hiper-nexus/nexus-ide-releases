import { createHash } from 'node:crypto';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  MissionEventJournal,
  createMissionEventFixture,
} from './mission-event-journal';
import { emitMissionIntentEvent } from './mission-intent-events';
import type { MissionEventAppendInput, MissionEventType } from '../../shared/mission-events';
import type { BootstrapProgressStep } from '../../shared/mission-intent-projection';

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

/** For consumer IPC / diagnostics — null when not bootstrapped. */
export function getMissionEventRuntimeManager(): ProjectRuntimeManager | null {
  return runtimeManager;
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
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * The journal schema caps idempotency keys at 128 chars. A full mission UUID
 * plus a long reason routinely crossed that cap and the zod rejection was
 * swallowed as a silent `false` — several decision kinds simply never reached
 * the journal. Hash-compress deterministic long keys instead of dropping them.
 */
function boundedIdempotencyKey(key: string): string {
  if (key.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return key;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `${key.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH - 25)}#${digest}`;
}

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
    idempotencyKey: boundedIdempotencyKey(
      `drive:${missionId}:${actionKind}:${reasonKey}:${tick}`,
    ),
    payload: {
      actionKind,
      reason: reason.slice(0, 512),
      mode,
      logicalTick: tick,
    },
  });
}

/**
 * Emit a bootstrap progress step both to the in-process intent ring and to the
 * durable journal (`custom`), which is the only mission-event surface the
 * renderer already subscribes to. Never awaited by callers; never throws —
 * telemetry must not become control flow. The per-(mission,step) counter keeps
 * idempotency keys unique across recovery attempts instead of deduping them.
 */
const bootstrapStepCounters = new Map<string, number>();

export function emitBootstrapProgress(
  scope: ProjectExecutionScope,
  missionId: string,
  step: BootstrapProgressStep,
  detail?: string,
): void {
  try {
    emitMissionIntentEvent({
      name: step === 'kickoff_accepted' ? 'kickoff_accepted' : 'bootstrap_progress',
      missionId,
      reason: 'main_orchestrator_bootstrap',
      meta: {
        step,
        ...(detail ? { detail: detail.slice(0, 200) } : {}),
      },
    });
  } catch (err) {
    console.warn('[mission-events] intent progress failed:', err);
  }
  const counterKey = `${missionId}:${step}`;
  const count = (bootstrapStepCounters.get(counterKey) ?? 0) + 1;
  bootstrapStepCounters.set(counterKey, count);
  emitMissionEvent(scope, {
    missionId,
    runId: `bootstrap-${missionId}`,
    type: 'custom',
    origin: 'main',
    idempotencyKey: boundedIdempotencyKey(
      `bootstrap:${missionId}:${step}:${count}`,
    ),
    payload: {
      kind: 'bootstrap_progress',
      step,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
    },
  });
}

/** Test seam — counters must not leak idempotency uniqueness across cases. */
export function resetBootstrapProgressCountersForTests(): void {
  bootstrapStepCounters.clear();
}

/**
 * Emit a `chef_idle_awaiting_workers` marker when the orchestrator is idle
 * while workers are present — distinguishes "chef waiting" from a stall.
 * Throttled to one journal write per mission per 60s to avoid scan-tick spam.
 */
const chefIdleThrottleMs = 60_000;
const chefIdleLastEmit = new Map<string, number>();

export function emitChefIdleAwaitingWorkers(
  scope: ProjectExecutionScope,
  missionId: string,
  workerCount: number,
): void {
  const now = Date.now();
  const last = chefIdleLastEmit.get(missionId) ?? 0;
  if (now - last < chefIdleThrottleMs) return;
  chefIdleLastEmit.set(missionId, now);
  try {
    emitMissionIntentEvent({
      name: 'chef_idle_awaiting_workers',
      missionId,
      meta: { workerCount },
    });
  } catch (err) {
    console.warn('[mission-events] chef_idle intent failed:', err);
  }
  emitMissionEvent(scope, {
    missionId,
    runId: `chef-idle-${missionId}`,
    type: 'custom',
    origin: 'main',
    idempotencyKey: boundedIdempotencyKey(`chef_idle:${missionId}:${now}`),
    payload: {
      kind: 'chef_idle_awaiting_workers',
      workerCount,
    },
  });
}

/** Test seam — reset throttle state between test cases. */
export function resetChefIdleThrottleForTests(): void {
  chefIdleLastEmit.clear();
}

/**
 * P0-8 visibility: an NL guided goal that WAS decomposable into a parallel
 * fan-out but was deliberately kept single-writer by the narrow destructive-goal
 * safety valve. Surfaced (intent ring + durable journal) so the serialization
 * is never silent — the operator can see the mission ran serial ON PURPOSE, not
 * because the fan-out silently failed. Fail-closed; never throws.
 */
export function emitGuidedFanoutSerialized(
  scope: ProjectExecutionScope,
  missionId: string,
  input: { readonly storyCount: number; readonly reason: string },
): void {
  try {
    emitMissionIntentEvent({
      name: 'guided_fanout_serialized',
      missionId,
      reason: input.reason.slice(0, 200),
      meta: { storyCount: input.storyCount, reason: input.reason.slice(0, 120) },
    });
  } catch (err) {
    console.warn('[mission-events] guided_fanout_serialized intent failed:', err);
  }
  emitMissionEvent(scope, {
    missionId,
    runId: `fanout-serialized-${missionId}`,
    type: 'custom',
    origin: 'main',
    idempotencyKey: boundedIdempotencyKey(
      `fanout_serialized:${missionId}:${input.reason}`,
    ),
    payload: {
      kind: 'guided_fanout_serialized',
      storyCount: input.storyCount,
      reason: input.reason.slice(0, 200),
    },
  });
}

/** Test helper re-export. */
export { createMissionEventFixture };
