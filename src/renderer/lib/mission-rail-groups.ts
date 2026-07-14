import type { Mission, MissionStatus } from '../../shared/orch-types';
import type { RailSectionId } from './mission-rail-prefs';

export interface RailSection {
  id: RailSectionId;
  label: string;
  missions: Mission[];
}

/** Missão “em andamento” pelo status do orquestrador (não só pelo grid). */
export function isInFlightStatus(status: MissionStatus): boolean {
  return status === 'running' || status === 'blocked';
}

/**
 * Group missions into rail sections:
 * - pinned
 * - active ("Em progresso"): panes ao vivo no grid **ou** status running/blocked
 * - queue ("Na fila"): só pending (ainda não começou de verdade)
 * - done: done/failed e sem panes ao vivo
 *
 * Antes, só panes ao vivo iam para "Em progresso". Se o bind pane↔missão
 * falhasse (ou o layout mudasse), a missão com terminal rodando caía em
 * "Na fila" ou parecia sumir — bug de UX.
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

  const isActive = (m: Mission): boolean =>
    opts.openMissionIds.has(m.id) || isInFlightStatus(m.status);

  const pinned = filtered
    .filter((m) => pinnedSet.has(m.id))
    .sort(byUpdated);

  const active = filtered
    .filter((m) => isActive(m) && !pinnedSet.has(m.id))
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

  // Na fila = ainda não começou (pending) e sem panes abertos.
  const queue = filtered
    .filter(
      (m) =>
        !pinnedSet.has(m.id) &&
        !opts.openMissionIds.has(m.id) &&
        m.status === 'pending',
    )
    .sort(byUpdated);

  return [
    { id: 'pinned', label: 'Fixadas', missions: pinned },
    { id: 'active', label: 'Em progresso', missions: active },
    { id: 'queue', label: 'Na fila', missions: queue },
    { id: 'done', label: 'Concluídas', missions: done },
  ] as const satisfies RailSection[];
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

/** Pill curta no card da rail — legível em 1 olhar. */
export type RailStatusTone =
  | 'live'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'pending';

export function railStatusDisplay(
  status: MissionStatus,
  liveInGrid: boolean,
  intentState?: Mission['intentState'],
): { label: string; tone: RailStatusTone } {
  if (liveInGrid) return { label: 'Ao vivo', tone: 'live' };
  // Terminal outcomes are authoritative. A stale intent snapshot must never
  // make a failed or completed mission look ready for dispatch again.
  // Persisted legacy rows may still carry terminal labels even though the
  // current domain union models them through the separate rail section.
  const terminalStatus = status as string;
  if (terminalStatus === 'done') return { label: 'Concluída', tone: 'done' };
  if (terminalStatus === 'failed') return { label: 'Falhou', tone: 'failed' };
  // Espera humana merece pill própria: "Na fila" esconde que a missão está
  // parada esperando VOCÊ (aprovar, dar objetivo, retomar) — o glance mais
  // importante do rail é exatamente esse.
  switch (intentState) {
    case 'awaiting_goal':
      return { label: 'Sem objetivo', tone: 'pending' };
    case 'intent_compiling':
      return { label: 'Processando', tone: 'pending' };
    case 'ready_to_start':
      return { label: 'Pronta', tone: 'pending' };
    case 'awaiting_approval':
      return { label: 'Aguarda você', tone: 'blocked' };
    case 'blocked_user':
      return { label: 'Aguarda você', tone: 'blocked' };
    default:
      break;
  }
  switch (status) {
    case 'running':
      return { label: 'Em curso', tone: 'running' };
    case 'blocked':
      return { label: 'Travada', tone: 'blocked' };
    case 'done':
      return { label: 'Concluída', tone: 'done' };
    case 'failed':
      return { label: 'Falhou', tone: 'failed' };
    case 'pending':
    default:
      return { label: 'Na fila', tone: 'pending' };
  }
}

/** Operational copy must distinguish focusing a live pane from restoring one. */
export function missionRailResumeCopy(
  status: MissionStatus,
  liveInGrid: boolean,
): { meta: string | null; title: string } {
  if (liveInGrid) {
    return {
      meta: null,
      title: 'Missão aberta no grid — clique para focar',
    };
  }
  if (status === 'running') {
    return {
      meta: 'Retomar panes salvos',
      title: 'Panes salvos — clique para retomar',
    };
  }
  if (status === 'blocked') {
    return {
      meta: null,
      title: 'Missão travada — clique para retomar',
    };
  }
  return {
    meta: null,
    title: 'Retomar esta missão',
  };
}
