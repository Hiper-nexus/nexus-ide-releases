/**
 * When a plan-lane mission receives a new handoff, nudge the operator to
 * promote — one-click toast action runs the same path as MissionRail ▶.
 */
import type { Handoff, Mission } from '../../shared/orch-types';
import { usePlanLaneMetricsStore } from '../state/plan-lane-metrics-store';
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
  // Seed / rehydrate: empty prev means full snapshot — never treat as "new".
  if (prev.length === 0 && next.length > 0) return [];
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

/** Toast with one-click promote + metric (deduped by handoff id). */
export function notifyPlanHandoffsReady(
  ready: readonly PlanHandoffReady[],
): void {
  const metrics = usePlanLaneMetricsStore.getState();
  for (const item of ready) {
    // First-time handoff id only — survives reload (no toast storm).
    if (!metrics.notePlanHandoffReady(item.handoffId)) continue;
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
          if (mission.intentContract?.lane !== 'plan') {
            useToastStore
              .getState()
              .push('info', 'Plano', 'Esta missão já saiu do plan mode.');
            return;
          }
          // Toast click is the confirm — skip second dialog.
          await promotePlanMissionToExecution(mission, { skipConfirm: true });
        },
      },
    });
  }
}
