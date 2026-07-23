export const MISSION_SCHEDULER_CONCURRENCY_LIMITS = Object.freeze({
  scopes: 2,
  missionsPerScope: 4,
});

export interface BoundedMissionSchedulerPassOptions<TScope, TMission> {
  readonly scopes: readonly TScope[];
  readonly scopeConcurrency: number;
  readonly missionConcurrency: number;
  readonly reconcileScope: (scope: TScope) => Promise<void> | void;
  readonly listMissions: (
    scope: TScope,
  ) => Promise<readonly TMission[]> | readonly TMission[];
  readonly runMission: (
    scope: TScope,
    mission: TMission,
  ) => Promise<void> | void;
}

async function runBoundedOperations<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('scheduler concurrency must be a positive safe integer');
  }
  let nextIndex = 0;
  const failures: unknown[] = [];
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]!;
      nextIndex += 1;
      try {
        await operation(item);
      } catch (error) {
        // One failed scope/mission must not prevent an independent queued item
        // from reaching its own durable authority boundary in this pass.
        failures.push(error);
      }
    }
  }));
  if (failures.length > 0) throw failures[0];
}

/**
 * Runs one bounded scheduler pass. A scope's recovery projection is a strict
 * fence for that scope's missions, while unrelated scopes and missions are
 * free to progress up to their explicit limits.
 */
export async function runBoundedMissionSchedulerPass<TScope, TMission>(
  options: BoundedMissionSchedulerPassOptions<TScope, TMission>,
): Promise<void> {
  await runBoundedOperations(
    options.scopes,
    options.scopeConcurrency,
    async (scope) => {
      await options.reconcileScope(scope);
      const missions = await options.listMissions(scope);
      await runBoundedOperations(
        missions,
        options.missionConcurrency,
        async (mission) => options.runMission(scope, mission),
      );
    },
  );
}
