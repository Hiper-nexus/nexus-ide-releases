/**
 * After the operator promotes lane plan → standard, tell the live
 * orchestrator that design mode is over and PREVC code tools are open.
 * If no live pane, soft-focus / reopen mission panes then inject.
 */
import type { Mission } from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import {
  getPaneSessionId,
  submitPromptToPane,
} from '../terminal/terminal-host';
import { reopenMission } from './mission-reopen';

export function buildPlanPromotedKickoff(goal: string): string {
  const g = goal.trim().slice(0, 400);
  return [
    '## Lane promovida: plan → standard (PREVC)',
    'O operador aprovou o plan.md e autorizou implementação.',
    g ? `Objetivo: ${g}` : '',
    '',
    'A partir de agora podes usar worktrees, file_write, terminal, merge e o PREVC completo.',
    '1. Lê plan.md (ou docs/plan.md) com file_read / nexus_plan_read.',
    '2. Congele o contrato se ainda não estiver frozen (nexus_mission_freeze_contract).',
    '3. Regista tarefas e despacha specialists (worktrees + route + spawn).',
    '4. Jobs longos: nexus_bg_run + nexus_bg_wait.',
    'Não fiques em modo design — a lane já é standard.',
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
  useLayoutStore.getState().focus(paneId);
  return submitPromptToPane(paneId, buildPlanPromotedKickoff(input.goal));
}

export type PlanPromoteNotifyResult = 'injected' | 'reopened' | 'none';

/**
 * Inject kickoff if orch is live; otherwise reopen mission panes and focus,
 * then inject when a session is available.
 */
export async function ensureOrchestratorAfterPlanPromote(input: {
  mission: Mission;
  goal: string;
}): Promise<PlanPromoteNotifyResult> {
  if (
    notifyOrchestratorPlanPromoted({
      missionId: input.mission.id,
      goal: input.goal,
    })
  ) {
    return 'injected';
  }
  try {
    const reopened = await reopenMission(input.mission);
    if (!reopened.ok || (reopened.panes ?? 0) === 0) return 'none';
    // Soft reopen focuses immediately; hard reopen may need a tick for PTY.
    await new Promise((r) => setTimeout(r, 400));
    if (
      notifyOrchestratorPlanPromoted({
        missionId: input.mission.id,
        goal: input.goal,
      })
    ) {
      return 'reopened';
    }
    // Panes restored but inject still failed — do not claim success as reopened.
    return 'none';
  } catch {
    return 'none';
  }
}
