/**
 * Read-only wave-schedule projection for the renderer.
 *
 * Main builds the items from durable authorities (sealed plan receipt, task
 * rows, dispatch states). Sealed detail/prompt content never leaves this
 * module: the detail of a receipt entry is decoded ONLY to lift the
 * dependency meta, and nothing else crosses the IPC boundary.
 */
import type { Mission } from "../../shared/orch-types";
import type {
  MissionTaskScheduleItem,
  MissionTaskScheduleStatus,
} from "../../shared/mission-task-schedule";
import { computeTaskWaveHints } from "../../shared/mission-task-schedule";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
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

const STAGE_LABELS: Record<string, string> = {
  orchestrator: "orquestração",
  executor: "implementação",
  reviewer: "revisão",
  qa: "qualidade",
  scout: "exploração",
  architect: "arquitetura",
};

export function missionTaskScheduleForRenderer(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
): MissionTaskScheduleItem[] {
  const missionId = mission.id;
  const intentVersion =
    mission.intentVersion ?? mission.intentContract?.intentVersion ?? 0;
  const taskRows = stores.tasks.list(missionId);
  const rowById = new Map(taskRows.map((row) => [row.id, row]));
  const dispatchStateByTask = new Map<string, TaskDispatchState>();
  for (const dispatch of stores.taskDispatches.list(missionId)) {
    if (dispatch.intentVersion !== intentVersion) continue;
    dispatchStateByTask.set(dispatch.taskId, dispatch.state);
  }

  let receipt: ReturnType<ProjectDomainStoreSuite["tasks"]["getPlanReceipt"]>;
  try {
    receipt = stores.tasks.getPlanReceipt(missionId, intentVersion);
  } catch {
    // Orphan/corrupt sealed plans degrade to the plain task view instead of
    // breaking the mission detail.
    receipt = null;
  }

  const items: MissionTaskScheduleItem[] = [];
  if (receipt) {
    const agentById = new Map(
      receipt.agents.map((agent) => [agent.id, agent]),
    );
    for (const entry of receipt.tasks) {
      const row = rowById.get(entry.taskId);
      const dispatchState = dispatchStateByTask.get(entry.taskId);
      const meta = decodeTaskScheduleDetail(entry.detail).meta;
      const agent = agentById.get(entry.agentRef);
      items.push({
        taskId: entry.taskId,
        title: entry.title,
        agentName: agent?.agentName ?? null,
        agentCategory: entry.agentCategory,
        stage: STAGE_LABELS[entry.agentCategory] ?? entry.agentCategory,
        status: dispatchState
          ? dispatchStatus(dispatchState)
          : taskRowStatus(row?.status ?? "pending"),
        dependsOn: meta?.dependsOn ?? [],
        waveHint: 1,
      });
    }
  } else {
    for (const row of taskRows) {
      const dispatchState = dispatchStateByTask.get(row.id);
      items.push({
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
      });
    }
  }

  const hints = computeTaskWaveHints(items);
  return items.map((item) => ({
    ...item,
    waveHint: hints.get(item.taskId) ?? 1,
  }));
}
