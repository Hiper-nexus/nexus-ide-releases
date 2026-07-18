/**
 * Pure helpers: fold omp rpc-ui mission workers into MissionRail / fleet counts.
 * No DOM, no electron — unit-tested.
 */
import type { OmpRpcSessionSummary } from '../../shared/omp-rpc-types';

export interface OmpMissionActivity {
  working: number;
  starting: number;
  idle: number;
  down: number;
  titles: string[];
}

export function summarizeOmpMissionActivity(
  sessions: readonly OmpRpcSessionSummary[],
  missionId: string,
): OmpMissionActivity {
  let working = 0;
  let starting = 0;
  let idle = 0;
  let down = 0;
  const titles: string[] = [];
  for (const row of sessions) {
    if (row.kind !== 'mission') continue;
    if (row.missionId !== missionId) continue;
    titles.push(row.title || 'Oh My Pi');
    if (row.state === 'spawning') starting += 1;
    else if (row.state === 'busy' || row.snapshot.isStreaming) working += 1;
    else if (row.state === 'exited') down += 1;
    else idle += 1;
  }
  return { working, starting, idle, down, titles };
}

/** Missions that have at least one live omp rpc mission worker. */
export function missionIdsWithOmpWorkers(
  sessions: readonly OmpRpcSessionSummary[],
): Set<string> {
  const ids = new Set<string>();
  for (const row of sessions) {
    if (row.kind !== 'mission') continue;
    if (!row.missionId) continue;
    if (row.state === 'exited') continue;
    ids.add(row.missionId);
  }
  return ids;
}

/**
 * Human meta fragment for the rail when omp rpc workers are active
 * (complements PTY agent counts).
 */
export function ompRailMetaFragment(activity: OmpMissionActivity): string | null {
  if (activity.working > 0) {
    return `${activity.working} omp trabalhando`;
  }
  if (activity.starting > 0) {
    return `${activity.starting} omp iniciando`;
  }
  if (activity.idle > 0) {
    return `${activity.idle} omp pronto`;
  }
  if (activity.down > 0) {
    return `${activity.down} omp parado`;
  }
  return null;
}
