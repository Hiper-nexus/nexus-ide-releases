import type { Mission, MissionStatus } from '../../shared/orch-types';
import type { RailSectionId } from './mission-rail-prefs';

export interface RailSection {
  id: RailSectionId;
  label: string;
  missions: Mission[];
}

/**
 * Group missions into Orca-style sections:
 * pinned → active (live in grid) → queue (pending/running/blocked not live) → done/failed
 */
export function groupMissionsForRail(opts: {
  missions: Mission[];
  openMissionIds: ReadonlySet<string>;
  pinnedIds: readonly string[];
  query: string;
}): RailSection[] {
  const q = opts.query.trim().toLowerCase();
  const filtered = q
    ? opts.missions.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.status.toLowerCase().includes(q),
      )
    : opts.missions;

  const pinnedSet = new Set(opts.pinnedIds);
  const byUpdated = (a: Mission, b: Mission) => b.updatedAt - a.updatedAt;

  const pinned = filtered
    .filter((m) => pinnedSet.has(m.id))
    .sort(byUpdated);

  const active = filtered
    .filter((m) => opts.openMissionIds.has(m.id) && !pinnedSet.has(m.id))
    .sort(byUpdated);

  const terminal: MissionStatus[] = ['done', 'failed'];
  const done = filtered
    .filter(
      (m) =>
        terminal.includes(m.status) &&
        !opts.openMissionIds.has(m.id) &&
        !pinnedSet.has(m.id),
    )
    .sort(byUpdated);

  const queue = filtered
    .filter(
      (m) =>
        !pinnedSet.has(m.id) &&
        !opts.openMissionIds.has(m.id) &&
        !terminal.includes(m.status),
    )
    .sort(byUpdated);

  return [
    { id: 'pinned', label: 'Fixadas', missions: pinned },
    { id: 'active', label: 'Em progresso', missions: active },
    { id: 'queue', label: 'Na fila', missions: queue },
    { id: 'done', label: 'Concluídas', missions: done },
  ];
}

export function statusLabel(s: MissionStatus): string {
  return (
    {
      pending: 'na fila',
      running: 'rodando',
      blocked: 'travada',
      done: 'concluída',
      failed: 'falhou',
    }[s] ?? s
  );
}
