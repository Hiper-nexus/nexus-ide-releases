/**
 * Wave schedule projection for the renderer.
 *
 * Pure: no store, no IPC. Main builds the items from durable authorities
 * (sealed plan receipt, task rows, dispatch states) and never ships sealed
 * detail/prompt content — the renderer only receives identities, titles,
 * agents, status and the computed wave hint.
 */

export type MissionTaskScheduleStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'blocked'
  | 'failed';

export interface MissionTaskScheduleItem {
  readonly taskId: string;
  readonly title: string;
  readonly agentName: string | null;
  readonly agentCategory: string | null;
  /** One PT-BR word for the lane the agent occupies (implementação, revisão…). */
  readonly stage: string | null;
  readonly status: MissionTaskScheduleStatus;
  readonly dependsOn: readonly string[];
  /** 1-based topological wave; tasks in the same wave can run side by side. */
  readonly waveHint: number;
}

/**
 * Level-based topological waves: a task lands one wave after its slowest
 * known dependency. Unknown or self dependencies are ignored (a receipt for a
 * different revision must degrade to a flat schedule, never throw), and a
 * dependency cycle resolves deterministically by iteration order instead of
 * hanging — this is a UI hint, not dispatch authority.
 */
export function computeTaskWaveHints(
  items: ReadonlyArray<{
    readonly taskId: string;
    readonly dependsOn: readonly string[];
  }>,
): Map<string, number> {
  const known = new Set(items.map((item) => item.taskId));
  const byId = new Map(items.map((item) => [item.taskId, item]));
  const waves = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (taskId: string): number => {
    const cached = waves.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return 0; // cycle: let the caller win the level
    const item = byId.get(taskId);
    if (!item) return 0;
    visiting.add(taskId);
    let wave = 1;
    for (const dependency of item.dependsOn) {
      if (dependency === taskId || !known.has(dependency)) continue;
      wave = Math.max(wave, resolve(dependency) + 1);
    }
    visiting.delete(taskId);
    waves.set(taskId, wave);
    return wave;
  };

  for (const item of items) resolve(item.taskId);
  return waves;
}

/** Fills `waveHint` on every item using `computeTaskWaveHints`. */
export function withMissionTaskWaveHints<T extends MissionTaskScheduleItem>(
  items: readonly T[],
): T[] {
  const hints = computeTaskWaveHints(items);
  return items.map((item) => ({
    ...item,
    waveHint: hints.get(item.taskId) ?? 1,
  }));
}
