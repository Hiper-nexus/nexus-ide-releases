import type { Mission } from '../../shared/orch-types';
import { askConfirm } from '../state/confirm-store';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { hardReopenWouldKillAgents } from './mission-auth-conflict';
import {
  hardReopenWouldDisplaceLayout,
  isIntentFirstMissionShell,
  livePaneIdsForMission,
  reopenMission,
  type MissionReopenResult,
} from './mission-reopen';
import { missionResumeRoute } from './mission-resume-route';

/**
 * Replace an intent-first shell through canonical Mission Setup Review using
 * the exact saved squad. The old shell remains until replacement start wins.
 */
export function resumeIntentFirstMissionShell(
  mission: Mission,
): MissionReopenResult {
  const setup = useMissionSetupStore.getState();
  setup.clearEntryContext();
  const squadId = mission.squadId?.trim();
  if (!squadId) {
    return {
      ok: false,
      error:
        'Esta missão ainda não tem squad. Abra Nova Missão e escolha o time de novo.',
    };
  }
  const squad = useOrchStore
    .getState()
    .squads.find((candidate) => candidate.id === squadId);
  if (!squad) {
    return {
      ok: false,
      error:
        'A equipe salva desta missão não está mais disponível. Escolha outra equipe antes de continuar.',
    };
  }
  const workspace = useWorkspaceStore.getState().current;
  if (!workspace) {
    return {
      ok: false,
      error: 'Abra o workspace desta missão antes de continuar.',
    };
  }

  const goal =
    mission.intentContract?.goal?.trim() ||
    mission.description?.trim() ||
    '';
  if (!goal) {
    return {
      ok: false,
      error: 'A missão antiga não possui um objetivo recuperável.',
    };
  }
  const lane = mission.intentContract?.lane ?? 'standard';
  setup.setWorkspace(workspace.path);
  useProductNavigationStore.getState().openMissionSetup();
  const seeded = useMissionSetupStore
    .getState()
    .beginLegacyReplacementReview({
      workspacePath: workspace.path,
      supersededMissionId: mission.id,
      objective: goal,
      title: mission.title,
      contextPaths: mission.intentContract?.contextPaths ?? [],
      roster: squad.agents,
      acceptanceCriteria: [
        ...(mission.intentContract?.acceptanceCriteria ?? []),
      ],
      lane,
    });
  if (!seeded) {
    return {
      ok: false,
      error: 'Não foi possível restaurar esta missão na revisão canônica.',
    };
  }
  return { ok: true, panes: 0, intentShell: true };
}

/**
 * Shared reopen entry for retained mission callers. Soft-focus when already
 * live; confirm only when an exclusive-auth kill is required.
 *
 * Intent-first shells with no pane evidence enter canonical replacement
 * Review instead of failing with "sem panes".
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
  // Prova de trabalho que sobrevive à morte de todo sinal de pane (B-246): a
  // fila do plano de controle. Falha de leitura não pode reabilitar o
  // assistente, então o desconhecido conta como zero e as demais provas
  // decidem.
  let plannedWork = 0;
  try {
    const controlPlane = await window.nexus.orch.missionControlPlane(
      mission.id,
    );
    plannedWork = controlPlane?.queue.length ?? 0;
  } catch {
    plannedWork = 0;
  }
  const route = missionResumeRoute({
    livePanes: livePaneIdsForMission(mission.id).length,
    recordedPanes,
    isArmedShell: isIntentFirstMissionShell(mission),
    plannedWork,
  });
  // Replacement Review only with proof of zero panes; an unrecognized state
  // stays in place with a notice and never falls through to Setup.
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
      // A racing empty list for a recognized shell still uses replacement Review.
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
