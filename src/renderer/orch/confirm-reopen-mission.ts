import type { Mission } from '../../shared/orch-types';
import { askConfirm } from '../state/confirm-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import {
  hardReopenWouldDisplaceLayout,
  hardReopenWouldKillAgents,
  isIntentFirstMissionShell,
  livePaneIdsForMission,
  reopenMission,
  type MissionReopenResult,
} from './mission-reopen';
import { missionResumeRoute } from './mission-resume-route';

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
  // Blocked missions are owned by Main's bootstrap recovery. Renderer pane
  // inspection is both stale and misleading here: between retry attempts no
  // PTY may exist, and a persisted exclusive-login pane must not trigger an
  // "Encerrar e retomar" prompt before Main has adopted or retired it.
  if (mission.status === 'blocked') {
    const result = await reopenMission(mission);
    return result.intentShell
      ? resumeIntentFirstMissionShell(mission)
      : result;
  }

  // CONTRATO DE NAVEGAÇÃO: o destino sai da EVIDÊNCIA (panes gravados), nunca
  // da classificação de estado. A rota anterior era um atalho cego — shell
  // "armado" ia direto ao assistente sem jamais perguntar se a missão tinha
  // panes —, e foi assim que o operador acabou ejetado da página dos panes,
  // com o trabalho fora de vista e sem volta.
  let recordedPanes: number;
  try {
    recordedPanes = (await window.nexus.orch.listMissionPanes(mission.id))
      .length;
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'falha ao ler os panes da missão',
    };
  }
  const route = missionResumeRoute({
    livePanes: livePaneIdsForMission(mission.id).length,
    recordedPanes,
    isArmedShell: isIntentFirstMissionShell(mission),
  });
  // Assistente SÓ com prova de zero panes; estado não reconhecido permanece
  // na página com aviso, nunca cai no assistente por fallback.
  if (route.kind === 'wizard') return resumeIntentFirstMissionShell(mission);
  if (route.kind === 'stay') return { ok: false, error: route.notice };

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
