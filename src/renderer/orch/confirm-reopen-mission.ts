import type { Mission } from '../../shared/orch-types';
import { askConfirm } from '../state/confirm-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import {
  hardReopenWouldDisplaceLayout,
  hardReopenWouldKillAgents,
  isIntentFirstMissionShell,
  reopenMission,
  type MissionReopenResult,
} from './mission-reopen';

/**
 * Resume an intent-first (agentic) shell: reopen Nova Missão on the goal
 * composer with any compiled objective pre-filled. No panes to restore.
 */
export function resumeIntentFirstMissionShell(mission: Mission): MissionReopenResult {
  const squadId = mission.squadId?.trim();
  if (!squadId) {
    return {
      ok: false,
      error:
        'Esta missão ainda não tem squad. Abra Nova Missão e escolha o time de novo.',
    };
  }

  const goal =
    mission.intentContract?.goal?.trim() ||
    mission.description?.trim() ||
    '';

  useMissionWizardStore.getState().openForArmedMission(squadId, mission.id);
  // Seed draft so the wizard restores the objective on open (same path as soft-close).
  useMissionWizardStore.getState().saveDraft({
    variant: 'mission',
    step: 'intent-compose',
    mode: 'agentic',
    intent: goal,
    missionGoal: goal,
    missionLane:
      mission.intentContract?.lane === 'consult'
        ? 'consult'
        : mission.intentContract?.lane === 'plan'
          ? 'plan'
          : mission.intentContract?.lane === 'ops'
            ? 'ops'
            : 'standard',
    squadId,
    armedMissionId: mission.id,
    count: 2,
    slots: [],
    wsPath: '',
    missionAttachments: [],
  });

  return { ok: true, panes: 0, intentShell: true };
}

/**
 * Shared reopen entry for MissionRail, OpsBoard, and Orch panel.
 * Soft-focus when already live; confirm only when exclusive-auth kill
 * (e.g. second Claude orchestrator) is required. Safe multi-mission merges
 * without a confirm dialog.
 *
 * Intent-first shells (modo agêntico armado, Sem objetivo / Pronta) reopen
 * the wizard instead of failing with "sem panes".
 */
export async function confirmAndReopenMission(
  mission: Mission,
): Promise<MissionReopenResult> {
  // Fast path: armed shells never had panes — skip listMissionPanes entirely.
  if (isIntentFirstMissionShell(mission)) {
    return resumeIntentFirstMissionShell(mission);
  }

  if (hardReopenWouldDisplaceLayout(mission.id)) {
    // Peek orchestrator adapter from a lightweight hard path only when kill needed.
    // We confirm aggressively only for shared-login conflicts; pure layout merge is silent.
    let wouldKill = false;
    try {
      const specs = await window.nexus.orch.listMissionPanes(mission.id);
      const orch = specs.find((s) => s.role === 'orchestrator') ?? specs[0];
      wouldKill = hardReopenWouldKillAgents(orch?.adapterId);
      // Race: list came back empty for a shell we didn't classify — still wizard.
      if (specs.length === 0 && isIntentFirstMissionShell(mission)) {
        return resumeIntentFirstMissionShell(mission);
      }
    } catch {
      wouldKill = false;
    }

    if (wouldKill) {
      const ok = await askConfirm({
        title: `Retomar "${mission.title}"?`,
        body: 'Retomar exige encerrar o orquestrador Claude já em execução (login partilhado). Outros panes podem permanecer.',
        confirmLabel: 'Encerrar e retomar',
        danger: true,
      });
      if (!ok) {
        return { ok: false, error: 'Retoma cancelada.' };
      }
    }
  }

  const result = await reopenMission(mission);
  if (result.intentShell) {
    return resumeIntentFirstMissionShell(mission);
  }
  return result;
}
