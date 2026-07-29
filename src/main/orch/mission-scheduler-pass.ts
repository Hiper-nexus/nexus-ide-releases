import { throwIfMissionSchedulerAborted } from "./mission-scheduler-abort";

export interface MissionSchedulerLaunchPassOptions<TSnapshot, TResult> {
  readonly signal?: AbortSignal;
  /** Converge terminal handoffs/merges into durable task state. */
  readonly reconcile: (signal?: AbortSignal) => Promise<void> | void;
  /** Prove exact worker exit before freeing the scheduler slot. */
  readonly retireWorkers: (signal?: AbortSignal) => Promise<void> | void;
  /** Read a new snapshot only after both durable boundaries above complete. */
  readonly snapshot: (signal?: AbortSignal) => TSnapshot;
  readonly launchNext: (
    snapshot: TSnapshot,
    signal?: AbortSignal,
  ) => Promise<TResult> | TResult;
}

/**
 * One same-tick scheduler pass. The pre-reconciliation task projection is
 * never carried across completion/retirement: dependency admission is decided
 * exclusively from the freshly re-read durable snapshot.
 */
export async function runMissionSchedulerLaunchPass<TSnapshot, TResult>(
  options: MissionSchedulerLaunchPassOptions<TSnapshot, TResult>,
): Promise<TResult> {
  throwIfMissionSchedulerAborted(options.signal);
  await options.reconcile(options.signal);
  throwIfMissionSchedulerAborted(options.signal);
  await options.retireWorkers(options.signal);
  throwIfMissionSchedulerAborted(options.signal);
  const snapshot = options.snapshot(options.signal);
  throwIfMissionSchedulerAborted(options.signal);
  const result = await options.launchNext(snapshot, options.signal);
  throwIfMissionSchedulerAborted(options.signal);
  return result;
}
