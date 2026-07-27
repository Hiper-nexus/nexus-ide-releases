export interface MissionSchedulerLaunchPassOptions<TSnapshot, TResult> {
  /** Converge terminal handoffs/merges into durable task state. */
  readonly reconcile: () => Promise<void> | void;
  /** Prove exact worker exit before freeing the scheduler slot. */
  readonly retireWorkers: () => Promise<void> | void;
  /** Read a new snapshot only after both durable boundaries above complete. */
  readonly snapshot: () => TSnapshot;
  readonly launchNext: (snapshot: TSnapshot) => Promise<TResult> | TResult;
}

/**
 * One same-tick scheduler pass. The pre-reconciliation task projection is
 * never carried across completion/retirement: dependency admission is decided
 * exclusively from the freshly re-read durable snapshot.
 */
export async function runMissionSchedulerLaunchPass<TSnapshot, TResult>(
  options: MissionSchedulerLaunchPassOptions<TSnapshot, TResult>,
): Promise<TResult> {
  await options.reconcile();
  await options.retireWorkers();
  return options.launchNext(options.snapshot());
}
