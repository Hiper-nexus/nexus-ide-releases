/**
 * Writer circuit-break 3: after spawn, a writer is not live until the PTY is
 * connected AND stdin is writable. Three failures of the same adapter/role
 * remint to the next authed adapter or skip-silent. Do not seat the dead
 * adapter a fourth time.
 *
 * Distinct from worker-mortality (death without delivery) and from the
 * adapter routing breaker. Inspired by ORCA's dispatch circuit-break of 3
 * (MIT), reimplemented for Nexus post-spawn liveness.
 */

import {
  classifySessionLiveness,
  type SessionLiveness,
} from '../pty/session-liveness';
import type { PaneSessionState } from '../../shared/types';
import { canSeat, type SeatAuthReadiness } from '../adapters/seat-auth-readiness';

export const WRITER_CIRCUIT_BREAK_FAILURES = 10;

export const WRITER_CIRCUIT_BREAK_KIND = 'writer_circuit_break' as const;

export type WriterCircuitAction = 'seat' | 'remint' | 'skip-silent';

export interface WriterCircuitKey {
  readonly adapterId: string;
  readonly role: string;
  readonly missionId?: string;
}

export function writerCircuitKey(key: WriterCircuitKey): string {
  const mission = key.missionId?.trim() || '-';
  return `${mission}::${key.adapterId}::${key.role}`;
}

export function writerIsLive(proof: {
  readonly sessionLiveness: SessionLiveness;
  readonly stdinWritable: boolean;
}): boolean {
  return proof.sessionLiveness === 'live' && proof.stdinWritable === true;
}

export function writerIsLiveFromSession(
  state: PaneSessionState | string | null | undefined,
  stdinWritable: boolean,
): boolean {
  return writerIsLive({
    sessionLiveness: classifySessionLiveness(state),
    stdinWritable,
  });
}

export interface WriterCircuitSnapshot {
  readonly key: string;
  readonly failures: number;
  readonly tripped: boolean;
}

export class WriterCircuitRegistry {
  readonly #failures = new Map<string, number>();

  failureCount(key: WriterCircuitKey): number {
    return this.#failures.get(writerCircuitKey(key)) ?? 0;
  }

  isTripped(key: WriterCircuitKey): boolean {
    return this.failureCount(key) >= WRITER_CIRCUIT_BREAK_FAILURES;
  }

  /** False after 3 deaths — no 4th seat of the dead adapter. */
  canSeat(key: WriterCircuitKey): boolean {
    return !this.isTripped(key);
  }

  recordConnectSuccess(key: WriterCircuitKey): void {
    this.#failures.delete(writerCircuitKey(key));
  }

  recordConnectFailure(key: WriterCircuitKey): number {
    const id = writerCircuitKey(key);
    const next = (this.#failures.get(id) ?? 0) + 1;
    this.#failures.set(id, next);
    return next;
  }

  /**
   * After a connect/writable failure: remint to the next authed adapter, or
   * skip-silent when the roster is exhausted.
   */
  decideAfterFailure(
    key: WriterCircuitKey,
    nextAuthedAdapters: readonly string[],
  ): WriterCircuitAction {
    if (!this.isTripped(key)) return 'seat';
    const next = nextAuthedAdapters.find(
      (adapterId) => adapterId !== key.adapterId,
    );
    return next ? 'remint' : 'skip-silent';
  }

  snapshot(key: WriterCircuitKey): WriterCircuitSnapshot {
    const failures = this.failureCount(key);
    return {
      key: writerCircuitKey(key),
      failures,
      tripped: failures >= WRITER_CIRCUIT_BREAK_FAILURES,
    };
  }

  reset(key?: WriterCircuitKey): void {
    if (key) this.#failures.delete(writerCircuitKey(key));
    else this.#failures.clear();
  }
}

/** Process-global registry. Cold start = empty (closed). */
export const writerCircuitBreakers = new WriterCircuitRegistry();

export function writerCircuitBlocksSeat(key: WriterCircuitKey): boolean {
  return writerCircuitBreakers.isTripped(key);
}

export function writerCircuitBreakEvent(input: {
  readonly key: WriterCircuitKey;
  readonly failures: number;
  readonly action: WriterCircuitAction;
  readonly sessionId?: string;
}): Record<string, unknown> {
  return {
    kind: WRITER_CIRCUIT_BREAK_KIND,
    adapterId: input.key.adapterId,
    role: input.key.role,
    missionId: input.key.missionId,
    failures: input.failures,
    action: input.action,
    sessionId: input.sessionId,
  };
}

export function writerCircuitBreakMessage(key: WriterCircuitKey): string {
  return (
    `${WRITER_CIRCUIT_BREAK_KIND}: ${key.adapterId} falhou ` +
    `${WRITER_CIRCUIT_BREAK_FAILURES}× ao ficar connected+writable — remint`
  );
}

export function nextAuthedAdapterIds(
  candidates: readonly {
    readonly adapterId: string;
    readonly readiness: SeatAuthReadiness;
  }[],
  skipAdapterId: string,
): string[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.adapterId !== skipAdapterId && canSeat(candidate.readiness),
    )
    .map((candidate) => candidate.adapterId);
}

export interface ProveWriterReadyDeps {
  getState(sessionId: string): PaneSessionState | string | null;
  isStdinWritable(sessionId: string): boolean;
  sleep(ms: number): Promise<void>;
}

export async function proveWriterConnectedAndWritable(
  sessionId: string,
  options: {
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly deps: ProveWriterReadyDeps;
  },
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      writerIsLiveFromSession(
        options.deps.getState(sessionId),
        options.deps.isStdinWritable(sessionId),
      )
    ) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await options.deps.sleep(pollMs);
  }
}
