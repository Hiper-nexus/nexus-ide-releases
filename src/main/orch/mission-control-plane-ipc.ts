/**
 * Coletor do snapshot do plano de controle (P1-0 · slice 1).
 *
 * Reúne as projeções que já existem — fila/ondas (mission-task-schedule,
 * 77a69fc7), dispatches (queue+ownership+lease) e panes vivos do registry —
 * e delega a fusão ao módulo puro compartilhado. Nenhum conteúdo selado do
 * plano cruza este módulo: a fila vem da mesma projeção read-only usada pelo
 * renderer, e lastError é saneado na fusão (redactMissionBlockDetail).
 */
import type { Mission, PaneSnapshot } from "../../shared/orch-types";
import {
  buildMissionControlSnapshot,
  type MissionControlSnapshot,
} from "../../shared/mission-control-plane";
import { missionTaskScheduleForRenderer } from "./mission-task-schedule-ipc";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";

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
