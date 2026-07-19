/**
 * When a plan-lane mission receives a new handoff, nudge the operator to
 * promote — one-click toast action runs the same path as MissionRail ▶.
 */
import type { Handoff, Mission } from '../../shared/orch-types';
import { bumpPlanLaneMetric } from '../state/plan-lane-metrics-store';
import { useOrchStore } from '../state/orch-store';
import { useToastStore } from '../state/toast-store';
import { promotePlanMissionToExecution } from './plan-promote-flow';

export interface PlanHandoffReady {
  missionId: string;
  title: string;
  handoffId: string;
}

/**
 * Detect handoffs that appeared (by id) for missions still in lane=plan.
 * Only success|partial count as "design delivered".
 */
export function detectNewPlanHandoffs(
  prev: readonly Handoff[],
  next: readonly Handoff[],
  missions: readonly Mission[],
): PlanHandoffReady[] {
  const prevIds = new Set(prev.map((h) => h.id));
  const planMissions = new Map(
    missions
      .filter((m) => m.intentContract?.lane === 'plan')
      .map((m) => [m.id, m] as const),
  );
  const out: PlanHandoffReady[] = [];
  for (const h of next) {
    if (prevIds.has(h.id)) continue;
    if (!h.missionId) continue;
    if (h.status !== 'success' && h.status !== 'partial') continue;
    const mission = planMissions.get(h.missionId);
    if (!mission) continue;
    out.push({
      missionId: mission.id,
      title: mission.title?.trim() || mission.description?.slice(0, 48) || mission.id,
      handoffId: h.id,
    });
  }
  return out;
}

/** Toast with one-click promote + metric. */
export function notifyPlanHandoffsReady(
  ready: readonly PlanHandoffReady[],
): void {
  for (const item of ready) {
    bumpPlanLaneMetric('planHandoffReady');
    const missionId = item.missionId;
    useToastStore.getState().push('info', 'Plano pronto', {
      detail: `"${item.title}" — promover para código PREVC.`,
      ttlMs: 25_000,
      action: {
        label: 'Executar plano',
        onClick: async () => {
          const mission = useOrchStore
            .getState()
            .missions.find((m) => m.id === missionId);
          if (!mission) {
            useToastStore
              .getState()
              .push('warn', 'Plano', 'Missão já não está na lista.');
            return;
          }
          // Toast click is the confirm — skip second dialog.
          await promotePlanMissionToExecution(mission, { skipConfirm: true });
        },
      },
    });
  }
}
