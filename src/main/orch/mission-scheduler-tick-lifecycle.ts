import { throwIfMissionSchedulerAborted } from "./mission-scheduler-abort";

export interface MissionSchedulerTickLifecycle {
  /**
   * Event/interval entrypoint for the legacy public loop.
   *
   * A wake observed during the first pass is retained as one trailing pass.
   * Wakes are coalesced while that trailing pass runs so store projections
   * cannot create an unbounded immediate loop; the ordinary interval remains
   * armed by the caller.
   */
  requestLegacyPass(): void;
  /** One single-flight pass for the production orchestration reconciler. */
  reconcile(signal?: AbortSignal): Promise<void>;
  /** Revoke a pending trailing pass without overlapping an active effect. */
  reset(): void;
}

export function createMissionSchedulerTickLifecycle(deps: {
  readonly runPass: (signal?: AbortSignal) => Promise<void>;
  readonly isLegacyLoopRunning: () => boolean;
}): MissionSchedulerTickLifecycle {
  let inFlight: Promise<void> | null = null;
  let legacyWakeDirty = false;
  let legacyTrailingPass = false;
  let currentFlightAllowsTrailing = false;
  let generation = 0;

  const launch = (
    allowTrailing: boolean,
    signal?: AbortSignal,
  ): Promise<void> => {
    const flightGeneration = generation;
    legacyWakeDirty = false;
    legacyTrailingPass = false;
    currentFlightAllowsTrailing = allowTrailing;

    // Defer the effect by one microtask so `inFlight` is installed before
    // synchronous store listeners can re-enter requestLegacyPass().
    const operation = Promise.resolve().then(async () => {
      throwIfMissionSchedulerAborted(signal);
      await deps.runPass(signal);
      throwIfMissionSchedulerAborted(signal);
      if (
        !allowTrailing ||
        flightGeneration !== generation ||
        !deps.isLegacyLoopRunning() ||
        !legacyWakeDirty
      ) {
        return;
      }

      legacyWakeDirty = false;
      legacyTrailingPass = true;
      try {
        await deps.runPass(signal);
        throwIfMissionSchedulerAborted(signal);
      } finally {
        // A trailing pass is the bounded convergence attempt for this flight.
        // Any wake it emits is represented by the still-armed normal cadence.
        legacyWakeDirty = false;
        legacyTrailingPass = false;
      }
    });

    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      if (inFlight !== tracked) return;
      inFlight = null;
      currentFlightAllowsTrailing = false;
      legacyWakeDirty = false;
      legacyTrailingPass = false;
    });
    inFlight = tracked;
    return tracked;
  };

  return {
    requestLegacyPass() {
      if (!deps.isLegacyLoopRunning()) return;
      if (inFlight) {
        if (currentFlightAllowsTrailing && !legacyTrailingPass) {
          legacyWakeDirty = true;
        }
        return;
      }
      void launch(true);
    },

    reconcile(signal) {
      return inFlight ?? launch(false, signal);
    },

    reset() {
      generation += 1;
      legacyWakeDirty = false;
    },
  };
}
