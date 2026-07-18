/**
 * After the operator promotes lane plan → standard, tell the live
 * orchestrator that design mode is over and PREVC code tools are open.
 */
import type { PaneModel } from '../../shared/types';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import {
  getPaneSessionId,
  submitPromptToPane,
} from '../terminal/terminal-host';

export function buildPlanPromotedKickoff(goal: string): string {
  const g = goal.trim().slice(0, 400);
  return [
    '## Lane promovida: plan → standard (PREVC)',
    'O operador aprovou o plan.md e autorizou implementação.',
    g ? `Objetivo: ${g}` : '',
    '',
    'A partir de agora podes usar worktrees, file_write, terminal, merge e o PREVC completo.',
    'Lê plan.md (ou docs/plan.md), regista tarefas e executa. Não fiques em modo design.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Find the live orchestrator pane for a mission (if any).
 */
export function orchestratorPaneIdForMission(
  missionId: string,
  panes: readonly Pick<PaneModel, 'id' | 'kind' | 'role'>[],
  paneMissions: Readonly<Record<string, string>>,
): string | null {
  for (const pane of panes) {
    if (
      pane.kind === 'cli-agent' &&
      pane.role === 'orchestrator' &&
      paneMissions[pane.id] === missionId
    ) {
      return pane.id;
    }
  }
  // Fallback: any live pane bound to the mission (solo plan runs).
  for (const pane of panes) {
    if (pane.kind === 'cli-agent' && paneMissions[pane.id] === missionId) {
      return pane.id;
    }
  }
  return null;
}

/**
 * Best-effort: inject promote kickoff into the mission orchestrator PTY.
 * Returns true if a prompt was submitted.
 */
export function notifyOrchestratorPlanPromoted(input: {
  missionId: string;
  goal: string;
}): boolean {
  const { paneMissions } = useOrchStore.getState();
  const panes = listPanes(useLayoutStore.getState().root);
  const paneId = orchestratorPaneIdForMission(
    input.missionId,
    panes,
    paneMissions,
  );
  if (!paneId) return false;
  if (!getPaneSessionId(paneId)) return false;
  return submitPromptToPane(paneId, buildPlanPromotedKickoff(input.goal));
}
