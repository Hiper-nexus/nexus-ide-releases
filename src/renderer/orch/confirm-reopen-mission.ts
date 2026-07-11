import type { Mission } from '../../shared/orch-types';
import {
  hardReopenWouldDisplaceLayout,
  hardReopenWouldKillAgents,
  reopenMission,
  type MissionReopenResult,
} from './mission-reopen';

/**
 * Shared reopen entry for MissionRail, OpsBoard, and Orch panel.
 * Soft-focus when already live; confirm only when exclusive-auth kill
 * (e.g. second Claude orchestrator) is required. Safe multi-mission merges
 * without a confirm dialog.
 */
export async function confirmAndReopenMission(
  mission: Mission,
): Promise<MissionReopenResult> {
  if (hardReopenWouldDisplaceLayout(mission.id)) {
    // Peek orchestrator adapter from a lightweight hard path only when kill needed.
    // We confirm aggressively only for shared-login conflicts; pure layout merge is silent.
    let wouldKill = false;
    try {
      const specs = await window.nexus.orch.listMissionPanes(mission.id);
      const orch = specs.find((s) => s.role === 'orchestrator') ?? specs[0];
      wouldKill = hardReopenWouldKillAgents(orch?.adapterId);
    } catch {
      wouldKill = false;
    }

    if (wouldKill) {
      const ok = window.confirm(
        `Retomar "${mission.title}" exige encerrar o orquestrador Claude já em execução (login partilhado).\n\nOutros panes podem permanecer. Continuar?`,
      );
      if (!ok) {
        return { ok: false, error: 'Retoma cancelada.' };
      }
    }
  }
  return reopenMission(mission);
}
