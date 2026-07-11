import type { Mission, MissionPaneSpec } from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { createPane, listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { markResumeOnSpawn, waitForSession } from '../terminal/terminal-host';
import {
  conflictingOrchestratorPanes,
  hardReopenWouldKillAgents,
  killConflictingOrchestrators,
  killLiveAgents,
} from './mission-launcher';

/**
 * One-click mission reopen: rebuild / merge the grid from the mission's
 * recorded pane composition — orchestrator first, then workers — with every
 * CLI re-spawned using resume flags so previous conversations continue.
 *
 * Soft focus: if the mission already has live panes, only focus them.
 * Soft multi: if another mission is live and there is no shared-login
 * conflict (e.g. dual Claude orch), merge panes — no kill of the other
 * mission (Orca-style parallel work).
 * Hard: forceHard or exclusive-auth conflict → kill conflicting (or all)
 * then restore this mission's composition.
 */

const MAX_REOPEN_PANES = 12;
const MAX_MERGED_PANES = 16;

export interface MissionReopenResult {
  ok: boolean;
  panes?: number;
  error?: string;
  /** True when we only focused existing panes (no hard reopen). */
  soft?: boolean;
  /** True when other live panes were kept (multi-mission). */
  multi?: boolean;
}

/** Live pane ids currently bound to this mission and present in the layout. */
export function livePaneIdsForMission(missionId: string): string[] {
  const { paneMissions } = useOrchStore.getState();
  const liveIds = Object.entries(paneMissions)
    .filter(([, mid]) => mid === missionId)
    .map(([paneId]) => paneId);
  if (liveIds.length === 0) return [];
  const present = new Set(listPanes(useLayoutStore.getState().root).map((p) => p.id));
  return liveIds.filter((id) => present.has(id));
}

/**
 * True when hard reopen would replace an existing layout (shells, browsers,
 * and/or CLI agents). Soft focus short-circuits when this mission is already live.
 */
export function hardReopenWouldDisplaceLayout(missionId: string): boolean {
  if (livePaneIdsForMission(missionId).length > 0) return false;
  return listPanes(useLayoutStore.getState().root).length > 0;
}

/** @deprecated use hardReopenWouldDisplaceLayout */
export function hardReopenWouldDisplaceAgents(missionId: string): boolean {
  return hardReopenWouldDisplaceLayout(missionId);
}

export { hardReopenWouldKillAgents };

function specsToPanes(specs: MissionPaneSpec[], fallbackCwd?: string): PaneModel[] {
  const ordered = specs.slice(0, MAX_REOPEN_PANES);
  return ordered.map((spec) => {
    const base = createPane(
      'cli-agent',
      spec.cwd ?? fallbackCwd,
      spec.adapterId,
      spec.model,
    );
    // Reusa o paneId ORIGINAL da missão: a captura de session-id do resume é
    // chaveada por (cwd, paneId) — com id novo o resume direcionado nunca
    // acertava e o --continue genérico retomava a conversa da OUTRA missão.
    const paneId = spec.paneId ?? base.id;
    markResumeOnSpawn(paneId);
    return {
      ...base,
      id: paneId,
      title: spec.title,
      accountId: spec.accountId,
      effort: spec.effort,
      role: spec.role,
      agentName: spec.agentName,
    };
  });
}

function primaryOrchestratorAdapter(specs: MissionPaneSpec[]): string | undefined {
  const orch = specs.find((s) => s.role === 'orchestrator');
  return orch?.adapterId ?? specs[0]?.adapterId;
}

/**
 * Soft focus when the mission is already open; otherwise reopen with
 * multi-mission merge when safe (no exclusive-auth dual orch).
 */
export async function reopenMission(
  mission: Mission,
  options?: { forceHard?: boolean },
): Promise<MissionReopenResult> {
  if (!options?.forceHard) {
    const live = livePaneIdsForMission(mission.id);
    if (live.length > 0) {
      useLayoutStore.getState().focus(live[0]!);
      return { ok: true, panes: live.length, soft: true };
    }
  }

  let specs: MissionPaneSpec[] = [];
  try {
    specs = await window.nexus.orch.listMissionPanes(mission.id);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'falha ao ler os panes da missão',
    };
  }
  if (specs.length === 0) {
    return {
      ok: false,
      error:
        'Esta missão não tem panes registrados (criada antes do histórico de composição).',
    };
  }

  const fallbackCwd = getActiveWorkspacePath() ?? undefined;
  const panes = specsToPanes(specs, fallbackCwd);
  const incomingAdapter = primaryOrchestratorAdapter(specs);
  const existing = listPanes(useLayoutStore.getState().root);
  const forceHard = options?.forceHard === true;
  const conflicts = conflictingOrchestratorPanes(incomingAdapter);
  // Exclude conflicts that are panes we're about to re-bind with same id.
  const newIds = new Set(panes.map((p) => p.id));
  const foreignConflicts = conflicts.filter((p) => !newIds.has(p.id));

  if (forceHard) {
    killLiveAgents();
    useLayoutStore.getState().setPanes(panes);
  } else if (foreignConflicts.length > 0) {
    // Exclusive shared-login: kill only conflicting orchestrators, keep others.
    const killedIds = new Set(killConflictingOrchestrators(incomingAdapter));
    // Also drop killed panes from the tree so reconcile doesn't double-kill
    // mid-flight; sessions already killed above.
    const kept = existing.filter((p) => !killedIds.has(p.id) && !newIds.has(p.id));
    const merged = [...kept, ...panes].slice(0, MAX_MERGED_PANES);
    useLayoutStore.getState().setPanes(merged);
  } else {
    // Safe multi-mission: keep every live pane, append this mission's panes.
    // (reconcileHosts only kills hosts for panes removed from the tree.)
    const kept = existing.filter((p) => !newIds.has(p.id));
    if (kept.length === 0) {
      useLayoutStore.getState().setPanes(panes);
    } else {
      const merged = [...kept, ...panes].slice(0, MAX_MERGED_PANES);
      useLayoutStore.getState().setPanes(merged);
    }
  }

  for (const pane of panes) {
    useOrchStore.getState().bindPaneMission(pane.id, mission.id);
  }

  if (specs[0]?.role === 'orchestrator' || panes[0]) {
    const orchPaneId = panes[0]!.id;
    void waitForSession(orchPaneId).then((sessionId) => {
      if (sessionId) {
        void window.nexus.orch.rebindMissionOrchestrator(mission.id, sessionId);
      }
    });
  }

  // Focus the reopened mission's orchestrator (first pane).
  useLayoutStore.getState().focus(panes[0]!.id);

  const multi = !forceHard && existing.length > 0;
  return {
    ok: true,
    panes: panes.length,
    soft: false,
    multi,
  };
}

