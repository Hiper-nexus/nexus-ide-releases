/**
 * Coletor do snapshot do plano de controle (P1-0 · slice 1).
 *
 * Reúne as projeções vivas — tasks simples da missão, dispatches legados e
 * panes vivos do registry — e delega a fusão ao módulo puro compartilhado.
 * A projeção de plano selado/ondas morreu com o motor cerimonial: a fila
 * agora nasce das linhas simples de task (Via Rápida não sela plano).
 */
import type { Mission, PaneSnapshot } from "../../shared/orch-types";
import {
  buildMissionControlSnapshot,
  type MissionControlSnapshot,
} from "../../shared/mission-control-plane";
import type {
  MissionTaskScheduleItem,
  MissionTaskScheduleStatus,
} from "../../shared/mission-task-schedule";
import { computeTaskWaveHints } from "../../shared/mission-task-schedule";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import type { TaskDispatchState } from "./task-dispatch-codec";

const ACTIVE_DISPATCH_STATES: ReadonlySet<TaskDispatchState> = new Set([
  "claimed",
  "routed",
  "spawning",
  "running",
  "handoff_ready",
  "merging",
]);

function dispatchStatus(
  state: TaskDispatchState,
): MissionTaskScheduleStatus {
  if (ACTIVE_DISPATCH_STATES.has(state)) return "running";
  if (state === "completed") return "done";
  if (state === "blocked" || state === "suspended") return "blocked";
  return "failed"; // failed | superseded
}

function taskRowStatus(status: string): MissionTaskScheduleStatus {
  if (status === "running") return "running";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  return "pending";
}

function missionTaskScheduleForRenderer(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
): MissionTaskScheduleItem[] {
  const missionId = mission.id;
  const intentVersion =
    mission.intentVersion ?? mission.intentContract?.intentVersion ?? 0;
  const dispatchStateByTask = new Map<string, TaskDispatchState>();
  for (const dispatch of stores.taskDispatches.list(missionId)) {
    if (dispatch.intentVersion !== intentVersion) continue;
    dispatchStateByTask.set(dispatch.taskId, dispatch.state);
  }
  const items: MissionTaskScheduleItem[] = stores.tasks
    .list(missionId)
    .map((row) => {
      const dispatchState = dispatchStateByTask.get(row.id);
      return {
        taskId: row.id,
        title: row.title,
        agentName: null,
        agentCategory: null,
        stage: null,
        status: dispatchState
          ? dispatchStatus(dispatchState)
          : taskRowStatus(row.status),
        dependsOn: [],
        waveHint: 1,
      };
    });
  const hints = computeTaskWaveHints(items);
  return items.map((item) => ({
    ...item,
    waveHint: hints.get(item.taskId) ?? 1,
  }));
}

export function missionControlPlaneSnapshot(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
  panes: readonly PaneSnapshot[],
  generatedAt: number,
): MissionControlSnapshot {
  const intentVersion =
    mission.intentVersion ?? mission.intentContract?.intentVersion ?? 0;
  const dispatches = stores.taskDispatches
    .list(mission.id)
    .filter((dispatch) => dispatch.intentVersion === intentVersion);
  return buildMissionControlSnapshot({
    missionId: mission.id,
    generatedAt,
    mission: {
      title: mission.title,
      status: mission.status,
      intentState: mission.intentState ?? null,
      description: mission.description ?? "",
    },
    panes: panes.filter((pane) => pane.missionId === mission.id),
    schedule: missionTaskScheduleForRenderer(stores, mission),
    dispatches: dispatches.map((dispatch) => ({
      taskId: dispatch.taskId,
      state: dispatch.state,
      attempt: dispatch.attempt,
      workerId: dispatch.workerId,
      leaseOwner: dispatch.leaseOwner,
      leaseExpiresAt: dispatch.leaseExpiresAt,
      ...(dispatch.paneId ? { paneId: dispatch.paneId } : {}),
      ...(dispatch.sessionId ? { sessionId: dispatch.sessionId } : {}),
      ...(typeof dispatch.lastHeartbeatAt === "number"
        ? { lastHeartbeatAt: dispatch.lastHeartbeatAt }
        : {}),
      ...(dispatch.lastError ? { lastError: dispatch.lastError } : {}),
      ...(dispatch.agentCategory
        ? { agentCategory: dispatch.agentCategory }
        : {}),
      ownership: dispatch.ownership,
    })),
  });
}
