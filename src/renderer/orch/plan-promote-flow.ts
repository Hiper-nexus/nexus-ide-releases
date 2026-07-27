/**
 * Shared promote plan → standard PREVC path used by MissionRail ▶ and
 * the clickable "Plano pronto" toast action.
 */
import type { Mission } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { usePlanLaneMetricsStore } from '../state/plan-lane-metrics-store';
import { useToastStore } from '../state/toast-store';

export interface PromotePlanFlowResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  detail?: string;
}

/** In-flight guard — double toast/rail click must not promote twice. */
const promoting = new Set<string>();

/**
 * Confirm (optional), promote lane, notify orchestrator, metrics + toast.
 */
export async function promotePlanMissionToExecution(
  mission: Mission,
): Promise<PromotePlanFlowResult> {
  if (mission.intentContract?.lane !== 'plan') {
    return { ok: false, error: 'Missão não está em lane plan.' };
  }
  if (mission.status === 'done' || mission.status === 'failed') {
    return { ok: false, error: 'Missão terminal — não pode promover.' };
  }
  if (promoting.has(mission.id)) {
    return { ok: false, error: 'Promoção já em curso para esta missão.' };
  }
  // Lock before IPC so toast + rail cannot interleave two promotes. The main
  // process owns the single native review; the renderer must not add a second
  // cosmetic confirm in front of that exact authority boundary.
  promoting.add(mission.id);
  try {
    // Re-read immediately before native review — another surface may already
    // have promoted the mission.
    const latest =
      useOrchStore.getState().missions.find((m) => m.id === mission.id) ??
      mission;
    if (latest.intentContract?.lane !== 'plan') {
      return {
        ok: false,
        error: 'Esta missão já saiu do plan mode.',
      };
    }
    if (latest.status === 'done' || latest.status === 'failed') {
      return { ok: false, error: 'Missão terminal — não pode promover.' };
    }
    const updated = await window.nexus.orch.promotePlanLane({
      missionId: latest.id,
    });
    usePlanLaneMetricsStore.getState().notePlanPromoted();
    const detail =
      updated.status === 'running'
        ? 'PREVC ativo; plano selado e nova sessão de execução iniciada.'
        : 'Promoção registrada; o Nexus está materializando a execução.';
    useToastStore.getState().push('success', 'Plano → código', detail);
    return { ok: true, detail };
  } catch (cause) {
    const error =
      cause instanceof Error ? cause.message : 'Falha ao promover o plano.';
    useToastStore.getState().push('error', 'Promover plano', error);
    return { ok: false, error };
  } finally {
    promoting.delete(mission.id);
  }
}
