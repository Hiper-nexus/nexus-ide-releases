import type { Mission, MissionPaneSpec } from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { createPane } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { getPaneSessionId, markResumeOnSpawn } from '../terminal/terminal-host';

/**
 * One-click mission reopen: rebuild the grid from the
 * mission's recorded pane composition — orchestrator first, then workers —
 * with every CLI re-spawned using its adapter's resume flags so the previous
 * conversations continue.
 */

const MAX_REOPEN_PANES = 12;
const SESSION_POLL_MS = 150;
const SESSION_TIMEOUT_MS = 20_000;

/** Wait for the pane's PTY session to materialize (spawn is async). */
function waitForSession(paneId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      const sessionId = getPaneSessionId(paneId);
      if (sessionId) return resolve(sessionId);
      if (Date.now() - startedAt > SESSION_TIMEOUT_MS) return resolve(null);
      setTimeout(poll, SESSION_POLL_MS);
    };
    poll();
  });
}

export interface MissionReopenResult {
  ok: boolean;
  panes?: number;
  error?: string;
}

export async function reopenMission(
  mission: Mission,
): Promise<MissionReopenResult> {
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

  // listMissionPanes already orders orchestrator-first; the cap keeps a
  // runaway mission from exploding the grid.
  const ordered = specs.slice(0, MAX_REOPEN_PANES);
  const fallbackCwd = getActiveWorkspacePath() ?? undefined;
  const panes: PaneModel[] = ordered.map((spec) => {
    const base = createPane(
      'cli-agent',
      spec.cwd ?? fallbackCwd,
      spec.adapterId,
      spec.model,
    );
    // Mark BEFORE the panes mount so the first spawn picks up the resume flag.
    markResumeOnSpawn(base.id);
    // Restore the pane's reasoning effort (task-router decision) so the
    // reopened pane re-spawns at the same effort it originally ran with.
    return {
      ...base,
      title: spec.title,
      effort: spec.effort,
      role: spec.role,
      agentName: spec.agentName,
    };
  });

  useLayoutStore.getState().setPanes(panes);
  for (const pane of panes) {
    useOrchStore.getState().bindPaneMission(pane.id, mission.id);
  }

  // The original orchestrator session is long gone — once the restored
  // orchestrator pane has a live session, point handoff delivery at it so
  // the reopened mission keeps receiving worker results.
  if (ordered[0]?.role === 'orchestrator') {
    const orchPaneId = panes[0].id;
    void waitForSession(orchPaneId).then((sessionId) => {
      if (sessionId) {
        void window.nexus.orch.rebindMissionOrchestrator(mission.id, sessionId);
      }
    });
  }

  return { ok: true, panes: panes.length };
}
