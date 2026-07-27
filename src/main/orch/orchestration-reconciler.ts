/**
 * One adaptive clock for every orchestration supervisor.
 *
 * Participants keep their domain decisions/IO, while this coordinator owns
 * cadence, single-flight execution, error isolation and trailing event wakes.
 * There is never more than one armed timer and never more than one pass.
 */

export interface OrchestrationReconcileParticipant {
  readonly id: string;
  readonly cadenceMs: number;
  /**
   * Maximum time the shared pass waits for this participant. Timing out does
   * not make it safe to start the participant again: its original promise
   * remains observed and single-flight until it really settles.
   */
  readonly timeoutMs?: number;
  readonly run: (now: number, signal?: AbortSignal) => void | Promise<void>;
}

export interface OrchestrationReconcilerOptions {
  readonly now?: () => number;
  readonly warn?: (message: string, error: unknown) => void;
  readonly defaultParticipantTimeoutMs?: number;
  /**
   * Maximum time a shutdown may wait for an effect that ignored AbortSignal.
   * Expiry rejects stop(): callers must keep stores/services alive and may
   * retry only after the original effect has physically settled.
   */
  readonly shutdownSettlementTimeoutMs?: number;
}

export interface OrchestrationReconciler {
  start(): void;
  stop(): Promise<void>;
  request(participantId?: string): boolean;
  isRunning(): boolean;
}

interface ParticipantState {
  readonly participant: OrchestrationReconcileParticipant;
  dueAt: number;
  inFlight: ParticipantFlight | null;
  lastWarningFingerprint: string | null;
}

interface ParticipantFlight {
  readonly controller: AbortController;
  settlement: Promise<void>;
  detachedReason: 'stop' | 'timeout' | null;
}

const DEFAULT_PARTICIPANT_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_SETTLEMENT_TIMEOUT_MS = 30_000;

function warningFingerprint(message: string, error: unknown): string {
  let detail: string;
  try {
    detail =
      error instanceof Error
        ? `${error.name}:${error.message}`
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);
  } catch {
    detail = String(error);
  }
  return `${message}\0${detail ?? String(error)}`.slice(0, 8_192);
}

export function createOrchestrationReconciler(
  participants: readonly OrchestrationReconcileParticipant[],
  options: OrchestrationReconcilerOptions = {},
): OrchestrationReconciler {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string, error: unknown) => {
    console.warn(message, error);
  });
  const reportWarning = (message: string, error: unknown) => {
    try {
      warn(message, error);
    } catch {
      // A diagnostic sink must never become orchestration control flow.
    }
  };
  const defaultParticipantTimeoutMs =
    options.defaultParticipantTimeoutMs ?? DEFAULT_PARTICIPANT_TIMEOUT_MS;
  const shutdownSettlementTimeoutMs =
    options.shutdownSettlementTimeoutMs ??
    DEFAULT_SHUTDOWN_SETTLEMENT_TIMEOUT_MS;
  if (
    !Number.isFinite(defaultParticipantTimeoutMs)
    || defaultParticipantTimeoutMs <= 0
  ) {
    throw new Error('invalid default reconciler participant timeout');
  }
  if (
    !Number.isFinite(shutdownSettlementTimeoutMs) ||
    shutdownSettlementTimeoutMs <= 0
  ) {
    throw new Error('invalid reconciler shutdown settlement timeout');
  }
  const states = new Map<string, ParticipantState>();
  for (const participant of participants) {
    if (!participant.id.trim()) throw new Error('reconciler participant id is required');
    if (!Number.isFinite(participant.cadenceMs) || participant.cadenceMs <= 0) {
      throw new Error(`invalid cadence for reconciler participant ${participant.id}`);
    }
    if (
      participant.timeoutMs !== undefined
      && (!Number.isFinite(participant.timeoutMs) || participant.timeoutMs <= 0)
    ) {
      throw new Error(`invalid timeout for reconciler participant ${participant.id}`);
    }
    if (states.has(participant.id)) {
      throw new Error(`duplicate reconciler participant: ${participant.id}`);
    }
    states.set(participant.id, {
      participant,
      dueAt: Number.POSITIVE_INFINITY,
      inFlight: null,
      lastWarningFingerprint: null,
    });
  }

  let started = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt = Number.POSITIVE_INFINITY;
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let stopFlight: Promise<void> | null = null;

  const clearArmedTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    timerDueAt = Number.POSITIVE_INFINITY;
  };

  const launchDrain = () => {
    if (inFlight) return;
    const pass = drain(generation);
    inFlight = pass;
    const finish = () => {
      if (inFlight === pass) inFlight = null;
      schedule();
    };
    void pass.then(finish, finish);
  };

  const schedule = () => {
    if (!started || running || states.size === 0) return;
    const nextDueAt = Math.min(...[...states.values()].map((state) => state.dueAt));
    if (!Number.isFinite(nextDueAt)) return;
    if (timer && timerDueAt <= nextDueAt) return;
    clearArmedTimer();
    timerDueAt = nextDueAt;
    timer = setTimeout(() => {
      timer = null;
      timerDueAt = Number.POSITIVE_INFINITY;
      launchDrain();
    }, Math.max(0, nextDueAt - now()));
    timer.unref?.();
  };

  const timeoutError = (
    participant: OrchestrationReconcileParticipant,
    timeoutMs: number,
  ): Error => {
    const error = new Error(
      `participant ${participant.id} exceeded ${timeoutMs}ms`,
    );
    error.name = 'TimeoutError';
    return error;
  };

  const reportParticipantWarning = (
    state: ParticipantState,
    message: string,
    error: unknown,
  ) => {
    const fingerprint = warningFingerprint(message, error);
    if (state.lastWarningFingerprint === fingerprint) return;
    state.lastWarningFingerprint = fingerprint;
    reportWarning(message, error);
  };

  const startParticipant = (
    state: ParticipantState,
    runAt: number,
  ): ParticipantFlight => {
    const flight: ParticipantFlight = {
      controller: new AbortController(),
      settlement: Promise.resolve(),
      detachedReason: null,
    };
    state.inFlight = flight;

    let result: void | Promise<void>;
    try {
      result = state.participant.run(runAt, flight.controller.signal);
    } catch (error) {
      result = Promise.reject(error);
    }

    const outcome = Promise.resolve(result).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    flight.settlement = outcome.then((settled) => {
      if (!settled.ok && flight.detachedReason === null) {
        reportParticipantWarning(
          state,
          `[orchestration-reconciler] participant ${state.participant.id} failed:`,
          settled.error,
        );
      } else if (settled.ok) {
        // A healthy pass closes the incident. If the same failure returns
        // later it is a new episode and deserves one fresh diagnostic.
        state.lastWarningFingerprint = null;
      }
      if (state.inFlight !== flight) return;
      state.inFlight = null;
      // A cadence/request that became due while the participant was still in
      // flight is represented by Infinity to avoid a zero-delay timer loop.
      // Once the old effect is truly over, let the current epoch reconsider it.
      if (started && !Number.isFinite(state.dueAt)) {
        state.dueAt = now();
        schedule();
      }
    });
    return flight;
  };

  const waitForParticipant = async (
    state: ParticipantState,
    flight: ParticipantFlight,
  ): Promise<'settled' | 'stopped' | 'timed-out'> => {
    const timeoutMs =
      state.participant.timeoutMs ?? defaultParticipantTimeoutMs;
    let timerHandle: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener = () => {};
    const boundary = new Promise<'stopped' | 'timed-out'>((resolve) => {
      const onAbort = () => {
        resolve(
          flight.detachedReason === 'timeout' ? 'timed-out' : 'stopped',
        );
      };
      if (flight.controller.signal.aborted) {
        onAbort();
        return;
      }
      flight.controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => {
        flight.controller.signal.removeEventListener('abort', onAbort);
      };
      timerHandle = setTimeout(() => {
        if (flight.detachedReason !== null) return;
        flight.detachedReason = 'timeout';
        flight.controller.abort(timeoutError(state.participant, timeoutMs));
      }, timeoutMs);
      timerHandle.unref?.();
    });

    try {
      return await Promise.race([
        flight.settlement.then(() => 'settled' as const),
        boundary,
      ]);
    } finally {
      if (timerHandle) clearTimeout(timerHandle);
      removeAbortListener();
    }
  };

  async function drain(passGeneration: number): Promise<void> {
    if (!started || running) return;
    running = true;
    try {
      const passNow = now();
      const due = [...states.values()].filter((state) => state.dueAt <= passNow);
      await Promise.all(
        due.map(async (state) => {
          if (!started || generation !== passGeneration) return;
          if (state.inFlight) {
            // Do not spin an overdue zero-delay timer and, critically, do not
            // overlap a timed-out effect that ignored its AbortSignal.
            state.dueAt = Number.POSITIVE_INFINITY;
            return;
          }
          // Set the ordinary next cadence before IO. Every due participant is
          // started before this pass awaits any sibling, while each participant
          // retains its own singleflight and timeout boundary.
          const runAt = now();
          state.dueAt = runAt + state.participant.cadenceMs;
          const flight = startParticipant(state, runAt);
          const outcome = await waitForParticipant(state, flight);
          if (outcome === 'timed-out') {
            reportParticipantWarning(
              state,
              `[orchestration-reconciler] participant ${state.participant.id} timed out:`,
              timeoutError(
                state.participant,
                state.participant.timeoutMs ?? defaultParticipantTimeoutMs,
              ),
            );
          }
        }),
      );
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) return;
      if (
        stopFlight ||
        [...states.values()].some((state) => state.inFlight !== null)
      ) {
        throw new Error(
          'reconciler cannot start while the previous epoch is still settling',
        );
      }
      generation += 1;
      started = true;
      const startAt = now();
      for (const state of states.values()) state.dueAt = startAt;
      schedule();
    },

    stop() {
      if (stopFlight) return stopFlight;
      const settle = async (): Promise<void> => {
        generation += 1;
        started = false;
        clearArmedTimer();
        const participantFlights: ParticipantFlight[] = [];
        for (const state of states.values()) {
          state.dueAt = Number.POSITIVE_INFINITY;
          const flight = state.inFlight;
          if (!flight) continue;
          participantFlights.push(flight);
          if (flight.detachedReason === null) {
            flight.detachedReason = 'stop';
            flight.controller.abort(
              new Error(
                `reconciler stopped during participant ${state.participant.id}`,
              ),
            );
          }
        }
        // The shared drain may return as soon as AbortSignal is raised. Store
        // teardown is safe only after every original participant promise has
        // really settled, even when a participant ignored cancellation.
        await (inFlight ?? Promise.resolve());
        if (participantFlights.length === 0) return;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            Promise.all(
              participantFlights.map((flight) => flight.settlement),
            ).then(() => undefined),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                const error = new Error(
                  'orchestration shutdown timed out waiting for physical effect settlement',
                );
                error.name = 'ShutdownTimeoutError';
                reject(error);
              }, shutdownSettlementTimeoutMs);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      };
      const current = settle();
      stopFlight = current;
      const clear = () => {
        if (stopFlight === current) stopFlight = null;
      };
      void current.then(clear, clear);
      return current;
    },

    request(participantId) {
      if (!started) return false;
      const requestAt = now();
      if (participantId !== undefined) {
        const state = states.get(participantId);
        if (!state) return false;
        state.dueAt = Math.min(state.dueAt, requestAt);
      } else {
        for (const state of states.values()) {
          state.dueAt = Math.min(state.dueAt, requestAt);
        }
      }
      schedule();
      return true;
    },

    isRunning() {
      return started;
    },
  };
}
