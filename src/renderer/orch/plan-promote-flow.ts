/**
 * Shared promote plan → standard PREVC path used by MissionRail ▶ and
 * the clickable "Plano pronto" toast action.
 */
import type { Mission } from '../../shared/orch-types';
import { askConfirm } from '../state/confirm-store';
import { bumpPlanLaneMetric } from '../state/plan-lane-metrics-store';
import { useToastStore } from '../state/toast-store';
import { ensureOrchestratorAfterPlanPromote } from './plan-promote-notify';

export interface PromotePlanFlowResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  detail?: string;
}

/**
 * Confirm (optional), promote lane, notify orchestrator, metrics + toast.
 */
export async function promotePlanMissionToExecution(
  mission: Mission,
  options?: {
    /** Skip the confirm dialog (toast CTA already is an explicit click). */
    skipConfirm?: boolean;
  },
): Promise<PromotePlanFlowResult> {
  if (mission.intentContract?.lane !== 'plan') {
    return { ok: false, error: 'Missão não está em lane plan.' };
  }
  if (mission.status === 'done' || mission.status === 'failed') {
    return { ok: false, error: 'Missão terminal — não pode promover.' };
  }
  if (!options?.skipConfirm) {
    const ok = await askConfirm({
      title: 'Executar o plano?',
      body:
        'A missão sai do modo design (só plan.md) e passa a permitir worktrees, ' +
        'código e shell sob o PREVC. O plan.md permanece no workspace.',
      confirmLabel: 'Executar plano',
    });
    if (!ok) return { ok: false, cancelled: true };
  }
  try {
    const updated = await window.nexus.orch.promotePlanLane({
      missionId: mission.id,
    });
    const goal =
      updated.intentContract?.goal?.trim() ||
      mission.intentContract?.goal?.trim() ||
      mission.description ||
      '';
    bumpPlanLaneMetric('planPromoted');
    const result = await ensureOrchestratorAfterPlanPromote({
      mission: updated,
      goal,
    });
    const detail =
      result === 'injected'
        ? 'PREVC ativo; orquestrador focado e notificado.'
        : result === 'reopened'
          ? 'PREVC ativo; panes reabertos e orquestrador notificado.'
          : 'PREVC ativo. Sem pane vivo — reabra a missão se precisar do kickoff.';
    useToastStore.getState().push('success', 'Plano → código', detail);
    return { ok: true, detail };
  } catch (cause) {
    const error =
      cause instanceof Error ? cause.message : 'Falha ao promover o plano.';
    useToastStore.getState().push('error', 'Promover plano', error);
    return { ok: false, error };
  }
}
