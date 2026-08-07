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
import {
  describeMissionDegradation,
  describeMissionDegradationNetwork,
  type MissionDegradation,
  type MissionDegradationPath,
} from './mission-degradation';

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

/**
 * Persist the named lower-tier decision. This is the main-owned restart
 * authority for a degradation; the mission description remains the operator
 * surface, never the source of permission to bypass a gate.
 */
export function emitMissionDegradation(
  scope: ProjectExecutionScope,
  missionId: string,
  degradation: MissionDegradation,
  intentVersion?: number,
): boolean {
  if (!degradation.path) return false;
  const reason = describeMissionDegradation(degradation).slice(0, 2_048);
  return emitMissionEvent(scope, {
    missionId,
    runId: `degradation-${missionId}`,
    type: 'custom',
    origin: 'main',
    idempotencyKey: boundedIdempotencyKey(
      `mission_degraded:${missionId}:${degradation.path}:${intentVersion ?? 0}:${degradation.why}`,
    ),
    payload: {
      kind: 'mission_degraded',
      path: degradation.path,
      what: degradation.what.slice(0, 256),
      reducedTo: degradation.reducedTo.slice(0, 512),
      why: degradation.why.slice(0, 1_024),
      description: reason,
      recoverable: degradation.recoverable,
      ...(intentVersion === undefined ? {} : { intentVersion }),
    },
  });
}

/**
 * Record the companion nudge/inactivity network. The event is deliberately
 * separate from the downgrade so a consumer can distinguish "reduced tier"
 * from "the supervisor is still responsible for re-engaging it".
 */
export function emitMissionDegradationNudge(
  scope: ProjectExecutionScope,
  missionId: string,
  degradation: MissionDegradation,
  intentVersion?: number,
): boolean {
  if (!degradation.path) return false;
  return emitMissionEvent(scope, {
    missionId,
    runId: `degradation-${missionId}`,
    type: 'custom',
    origin: 'main',
    idempotencyKey: boundedIdempotencyKey(
      `mission_degraded_nudge:${missionId}:${degradation.path}:${intentVersion ?? 0}:${degradation.why}`,
    ),
    payload: {
      kind: 'mission_degraded_nudge',
      path: degradation.path,
      network: 'nudge-or-inactivity',
      detail: describeMissionDegradationNetwork(degradation),
      ...(intentVersion === undefined ? {} : { intentVersion }),
    },
  });
}

/**
 * Read the main-owned downgrade after a process restart. If the journal is
 * unavailable we return false: callers must then retain their physical
 * fail-closed authority instead of trusting a renderer-editable description.
 */
export function hasPersistedMissionDegradation(
  scope: ProjectExecutionScope,
  missionId: string,
  path: MissionDegradationPath,
  intentVersion?: number,
): boolean {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.missionEventJournal) ||
    !runtimeManager
  ) {
    return false;
  }
  try {
    const journal = new MissionEventJournal(runtimeManager, scope);
    let afterSequence = 0;
    for (;;) {
      const events = journal.replay({
        missionId,
        afterSequence,
        limit: 1_000,
      });
      const found = events.some((event) => {
        if (event.type !== 'custom') return false;
        const payload = event.payload as Record<string, unknown>;
        return (
          payload.kind === 'mission_degraded' &&
          payload.path === path &&
          (intentVersion === undefined ||
            payload.intentVersion === intentVersion)
        );
      });
      if (found) return true;
      const last = events.at(-1);
      if (!last || events.length < 1_000) return false;
      afterSequence = last.sequence;
    }
  } catch (error) {
    console.warn('[mission-events] degradation lookup failed:', error);
    return false;
  }
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

/**
 * P0-9 visibility: the scheduler's wave width, named. Silent throttling is
 * itself a bug — a mission running 2 panes on an 11-story plan must say whether
 * that is the approved `maxWorkers`, the host cores, the layout pane budget, or
 * a legitimately sequential phase. Callers are edge-triggered (see
 * `reportWaveConcurrency`), so this never floods the 5s tick. Never throws.
 */
/**
 * N1: a ação destrutiva rodou sem perguntar — e o operador lê AQUI como desfazer.
 *
 * Mesma superfície do veredito de teto de propósito: foi ela que transformou
 * "está travado" em "está trabalhando", e o problema aqui é da mesma família —
 * "aconteceu sem me perguntar" precisa virar "aconteceu e eu sei desfazer".
 *
 * `reversible: false` NÃO é um erro a suprimir: é o único aviso que o operador
 * vai ter de que aquele efeito não tem volta. Nunca throws.
 */
/**
 * Mudança PERSISTENTE feita durante uma missão — agenda, hoje.
 *
 * Separado de `destructive_reversal_prepared` de propósito: criar um cron não
 * destrói nada, mas sobrevive à missão que o criou e continua disparando depois.
 * Chamar isso de "destrutivo" ensinaria o operador a ignorar a palavra no dia em
 * que ela for literal. Nunca throws.
 */
export function emitPersistentChangeReversalEvent(
  missionId: string,
  input: { readonly surface: string; readonly revertPath: string },
): void {
  try {
    emitMissionIntentEvent({
      name: 'persistent_change_reversal',
      missionId,
      reason: input.revertPath.slice(0, 200),
      meta: { surface: input.surface },
    });
  } catch (err) {
    console.warn(
      '[mission-events] persistent_change_reversal intent failed:',
      err,
    );
  }
}

export function emitDestructiveReversalEvent(
  missionId: string,
  input: {
    readonly toolName: string;
    readonly revertPath: string;
    readonly reversible: boolean;
  },
): void {
  try {
    emitMissionIntentEvent({
      name: 'destructive_reversal_prepared',
      missionId,
      reason: input.revertPath.slice(0, 200),
      meta: {
        toolName: input.toolName,
        reversible: input.reversible,
      },
    });
  } catch (err) {
    console.warn(
      '[mission-events] destructive_reversal_prepared intent failed:',
      err,
    );
  }
}

export function emitWaveConcurrencyVerdictEvent(
  scope: ProjectExecutionScope,
  missionId: string,
  diagnosis: {
    readonly phase: string;
    readonly binding: string;
    readonly effectiveCap: number;
    readonly readyCount: number;
    readonly deferredByCap: number;
    readonly operatorRaisable: boolean;
    readonly summary: string;
  },
): void {
  try {
    emitMissionIntentEvent({
      name: 'wave_concurrency_verdict',
      missionId,
      reason: diagnosis.summary.slice(0, 200),
      meta: {
        phase: diagnosis.phase,
        binding: diagnosis.binding,
        effectiveCap: diagnosis.effectiveCap,
        readyCount: diagnosis.readyCount,
        deferredByCap: diagnosis.deferredByCap,
        operatorRaisable: diagnosis.operatorRaisable,
      },
    });
  } catch (err) {
    console.warn('[mission-events] wave_concurrency_verdict intent failed:', err);
  }
  emitMissionEvent(scope, {
    missionId,
    runId: `wave-concurrency-${missionId}`,
    type: 'custom',
    origin: 'main',
    idempotencyKey: boundedIdempotencyKey(
      `wave_concurrency:${missionId}:${diagnosis.phase}:${diagnosis.binding}:` +
        `${diagnosis.effectiveCap}:${diagnosis.readyCount}:${diagnosis.deferredByCap}`,
    ),
    payload: {
      kind: 'wave_concurrency_verdict',
      phase: diagnosis.phase,
      binding: diagnosis.binding,
      effectiveCap: diagnosis.effectiveCap,
      readyCount: diagnosis.readyCount,
      deferredByCap: diagnosis.deferredByCap,
      operatorRaisable: diagnosis.operatorRaisable,
      summary: diagnosis.summary.slice(0, 200),
    },
  });
}

/** Test helper re-export. */
export { createMissionEventFixture };
