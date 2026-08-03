/**
 * Shared promote plan → standard execution path used by MissionRail ▶ and
 * the clickable "Plano pronto" toast action.
 */
import type { Handoff, Mission } from '../../shared/orch-types';
import { classifyGoalRisk } from '../../shared/mission-intent';
import {
  countPromotableStories,
  recommendPromoteOrchestrationMode,
  shouldAskPromoteOrchestrationMode,
  type PromoteOrchestrationModeInput,
} from '../../shared/promote-orchestration-mode';
import { askPromoteOrchestrationMode } from '../state/orchestration-mode-store';
import { useOrchStore } from '../state/orch-store';
import { usePlanLaneMetricsStore } from '../state/plan-lane-metrics-store';
import { useToastStore } from '../state/toast-store';

export interface PromotePlanFlowResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  detail?: string;
}

export interface PromotePlanFlowOptions {
  /**
   * Skip the Pack/Guiado picker (caller already chose, or auto path).
   * Native Main review still runs.
   */
  readonly orchestrationMode?: PromoteOrchestrationModeInput;
  readonly wavePackTemplateId?: 'landing' | 'saas' | 'fix';
  readonly skipModePicker?: boolean;
}

/** In-flight guard — double toast/rail click must not promote twice. */
const promoting = new Set<string>();

function latestPlanSummaryForMission(
  missionId: string,
  handoffs: readonly Handoff[],
): string {
  for (let i = handoffs.length - 1; i >= 0; i -= 1) {
    const handoff = handoffs[i]!;
    if (handoff.missionId !== missionId) continue;
    if (handoff.status !== 'success') continue;
    const summary = handoff.summary?.trim();
    if (summary) return summary;
  }
  return '';
}

/**
 * Choose Pack/Guiado when the physical plan has ≥2 stories, then promote.
 * Native Main review remains the authority boundary — this is topology choice.
 */
export async function promotePlanMissionToExecution(
  mission: Mission,
  options: PromotePlanFlowOptions = {},
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
  promoting.add(mission.id);
  try {
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

    let orchestrationMode = options.orchestrationMode;
    let wavePackTemplateId = options.wavePackTemplateId;
    if (!orchestrationMode && !options.skipModePicker) {
      const summary = latestPlanSummaryForMission(
        latest.id,
        useOrchStore.getState().handoffs,
      );
      const storyCount = countPromotableStories(summary);
      if (shouldAskPromoteOrchestrationMode(storyCount)) {
        const risk = classifyGoalRisk(latest.intentContract?.goal ?? latest.description);
        const recommended = recommendPromoteOrchestrationMode({
          storyCount,
          risk,
        });
        const choice = await askPromoteOrchestrationMode({
          title: 'Como executar o plano?',
          body:
            storyCount >= 2
              ? `Encontrei ${storyCount} stories no plano de “${latest.title}”. ` +
                'Wave Pack abre panes em paralelo; Guiado serializa a entrega.'
              : `O plano de “${latest.title}” não tem stories BMAD suficientes. ` +
                'Escolha Guiado, ou Wave Pack com um template (Landing / SaaS / Fix).',
          storyCount,
          recommended,
          templateRequiredForPack: storyCount < 2,
        });
        if (!choice) {
          return { ok: false, cancelled: true };
        }
        orchestrationMode = choice.mode;
        wavePackTemplateId = choice.wavePackTemplateId;
      }
    }

    const updated = await window.nexus.orch.promotePlanLane({
      missionId: latest.id,
      ...(orchestrationMode ? { orchestrationMode } : {}),
      ...(wavePackTemplateId ? { wavePackTemplateId } : {}),
    });
    usePlanLaneMetricsStore.getState().notePlanPromoted();
    const modeBit =
      orchestrationMode === 'pack'
        ? 'Wave Pack'
        : orchestrationMode === 'guided'
          ? 'Guiado'
          : 'execução';
    const detail =
      updated.status === 'running'
        ? `${modeBit} iniciado; plano selado e nova sessão materializada.`
        : `Promoção registrada (${modeBit}); o Nexus está materializando a execução.`;
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
