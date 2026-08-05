import type { ProjectExecutionScope } from '../../shared/types';
import type { WaveConcurrencyDiagnosis } from './mission-scheduler';
import { emitWaveConcurrencyVerdictEvent } from './mission-event-emit';

/**
 * Edge-triggered visibility for the scheduler's wave width.
 *
 * The scheduler ticks every ~5s; emitting a verdict per tick would bury the
 * signal it exists to deliver. A verdict is therefore emitted only when the
 * SHAPE of the wave changes — the ceiling, the binding constraint, the phase,
 * or the eligible backlog. Prose is deliberately excluded from the signature so
 * rewording a message never replays it to the operator.
 */
const lastSignature = new Map<string, string>();

export function waveConcurrencyVerdictSignature(
  diagnosis: WaveConcurrencyDiagnosis,
): string {
  return [
    diagnosis.phase,
    diagnosis.binding,
    diagnosis.effectiveCap,
    diagnosis.readyCount,
    diagnosis.deferredByCap,
  ].join('|');
}

export function shouldEmitWaveConcurrencyVerdict(
  missionId: string,
  diagnosis: WaveConcurrencyDiagnosis,
): boolean {
  const signature = waveConcurrencyVerdictSignature(diagnosis);
  if (lastSignature.get(missionId) === signature) return false;
  lastSignature.set(missionId, signature);
  return true;
}

/** Test seam — reset edge-trigger memory between cases. */
export function resetWaveConcurrencyVerdictForTests(): void {
  lastSignature.clear();
}

/**
 * Production entry point wired into the scheduler tick. A `parallel` wave with
 * nothing deferred is the uninteresting steady state and stays quiet; every
 * throttle and every legitimately sequential phase becomes visible exactly once
 * per change. Never throws — visibility must not be able to fail a tick.
 */
export function reportWaveConcurrency(
  scope: ProjectExecutionScope,
  missionId: string,
  diagnosis: WaveConcurrencyDiagnosis,
): void {
  if (diagnosis.phase === 'parallel') return;
  if (!shouldEmitWaveConcurrencyVerdict(missionId, diagnosis)) return;
  try {
    emitWaveConcurrencyVerdictEvent(scope, missionId, diagnosis);
  } catch (err) {
    console.warn('[mission-events] wave concurrency verdict failed:', err);
  }
}
