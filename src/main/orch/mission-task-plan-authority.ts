import type { AgentCategory, Squad, SquadAgent } from "../../shared/orch-types";
import { hasCurrentDispatchAuthority } from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  assertCurrentMissionOrchestratorSession,
  type AgentGateContext,
} from "./gate";
import {
  emitPlannedTasksWithContract,
  type PlannerTaskInput,
} from "./mission-scheduler";
import { encodeTaskScheduleDetail } from "./mission-scheduler-meta";
import {
  assertClosedAcyclicPlanDependencies,
  supportsMechanicallyReadOnlyCli,
  type PlannedExecutionMode,
} from "./mission-scheduler-plan";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import { getSquad } from "./squad-store";
import { plannedTaskId, type ScopedTaskRecord } from "./task-store";
import { childMissionId } from "./tools-panes";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";

type WorkerCategory = Exclude<AgentCategory, "orchestrator">;

interface ParsedPlanTask extends PlannerTaskInput {
  readonly ownership: NonNullable<PlannerTaskInput["ownership"]>;
  readonly agentRef: string;
  readonly agentCategory: WorkerCategory;
  readonly executionMode: PlannedExecutionMode;
}

export interface MissionTaskPlanAuthorityDeps {
  readonly getSquad: (squadId: string) => Squad | null;
  readonly listMissionWorktrees: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => readonly unknown[];
}

export interface MissionTaskPlanResult {
  readonly missionId: string;
  readonly tasks: readonly ScopedTaskRecord[];
  readonly planned: readonly Readonly<{
    plannerId: string;
    taskId: string;
    dependsOn: readonly string[];
    ownership: NonNullable<PlannerTaskInput["ownership"]>;
    parallelEligible: boolean;
    agentRef: string;
    category: WorkerCategory;
    executionMode: PlannedExecutionMode;
  }>[];
}

const DEFAULT_DEPS: MissionTaskPlanAuthorityDeps = Object.freeze({
  // Keep the store lookup lazy. Several IPC shells replace squad-store with a
  // deliberately narrow test double and never exercise planning; touching the
  // export while this module is imported makes unrelated handlers fail during
  // collection instead of at the actual planning boundary.
  getSquad: (squadId: string) => getSquad(squadId),
  listMissionWorktrees: (scope: ProjectExecutionScope, missionId: string) =>
    requireWorktreeRuntimeRegistry().listMission(scope, missionId),
});

function stringItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function workerCategory(taskId: string, value: unknown): WorkerCategory {
  if (
    value !== "executor" &&
    value !== "reviewer" &&
    value !== "scout" &&
    value !== "architect"
  ) {
    throw new Error(`task ${taskId} requires a worker category`);
  }
  return value;
}

function executionMode(taskId: string, value: unknown): PlannedExecutionMode {
  if (value !== "isolated_worktree" && value !== "read_only") {
    throw new Error(
      `task ${taskId} requires executionMode isolated_worktree or read_only`,
    );
  }
  return value;
}

function resolveRosterAgent(
  taskId: string,
  agentRef: string,
  category: WorkerCategory,
  mode: PlannedExecutionMode,
  ownershipFiles: readonly string[],
  squad: Squad,
): SquadAgent {
  const matches = squad.agents.filter(
    (agent) => agent.id === agentRef || agent.agentName === agentRef,
  );
  if (matches.length !== 1) {
    throw new Error(
      `task ${taskId} agentRef is not an unambiguous squad member`,
    );
  }
  const assignedAgent = matches[0]!;
  if (assignedAgent.category === "orchestrator") {
    throw new Error(`task ${taskId} cannot be assigned to the orchestrator`);
  }
  if (assignedAgent.category !== category) {
    throw new Error(
      `task ${taskId} category does not match roster agent ${assignedAgent.id}`,
    );
  }
  if (assignedAgent.cli === "claude") {
    throw new Error(
      `task ${taskId} cannot use ${assignedAgent.id}: reserveClaude keeps the ` +
        "Claude OAuth session exclusive to the orchestrator; choose another roster worker",
    );
  }
  if (mode === "isolated_worktree" && ownershipFiles.length === 0) {
    throw new Error(
      `task ${taskId} isolated_worktree requires explicit ownership.files`,
    );
  }
  if (mode === "read_only" && category !== "scout" && category !== "reviewer") {
    throw new Error(`task ${taskId} read_only is restricted to scout/reviewer`);
  }
  if (
    mode === "read_only" &&
    !supportsMechanicallyReadOnlyCli(assignedAgent.cli)
  ) {
    throw new Error(
      `task ${taskId} read_only requires a mechanically confined CLI; ` +
        `${assignedAgent.cli} is not eligible`,
    );
  }
  return assignedAgent;
}

function parsePlanTask(
  raw: unknown,
  index: number,
  squad: Squad,
): ParsedPlanTask {
  if (!raw || typeof raw !== "object") {
    throw new Error(`invalid task at index ${index}`);
  }
  const row = raw as {
    id?: unknown;
    title?: unknown;
    detail?: unknown;
    ownership?: {
      files?: unknown;
      symbols?: unknown;
      domains?: unknown;
    };
    dependsOn?: unknown;
    agentRef?: unknown;
    category?: unknown;
    executionMode?: unknown;
  };
  const id =
    typeof row.id === "string" && row.id.trim().length > 0
      ? row.id.trim()
      : `task-${index + 1}`;
  const title =
    typeof row.title === "string" && row.title.trim().length > 0
      ? row.title.trim()
      : id;
  const ownership = {
    files: stringItems(row.ownership?.files),
    symbols: stringItems(row.ownership?.symbols),
    domains: stringItems(row.ownership?.domains),
  };
  const agentRef =
    typeof row.agentRef === "string" && row.agentRef.trim()
      ? row.agentRef.trim()
      : null;
  if (!agentRef) {
    throw new Error(`task ${id} requires agentRef from the saved squad`);
  }
  const category = workerCategory(id, row.category);
  const mode = executionMode(id, row.executionMode);
  const assignedAgent = resolveRosterAgent(
    id,
    agentRef,
    category,
    mode,
    ownership.files,
    squad,
  );
  return {
    id,
    title,
    detail: typeof row.detail === "string" ? row.detail : "",
    ownership,
    dependsOn: Array.isArray(row.dependsOn)
      ? row.dependsOn.filter(
          (dependency): dependency is string => typeof dependency === "string",
        )
      : undefined,
    agentRef: assignedAgent.id,
    agentCategory: category,
    executionMode: mode,
  };
}

/**
 * Main-owned authority for one immutable mission task plan.
 *
 * The LLM may propose raw rows, but this boundary resolves every row against
 * the saved roster, enforces execution confinement, closes the dependency
 * graph, and only then asks the scoped task store to seal the whole plan.
 */
export function planMissionTasks(
  args: Readonly<Record<string, unknown>>,
  ctx: AgentGateContext,
  suite: Pick<ProjectDomainStoreSuite, "missions" | "tasks">,
  deps: MissionTaskPlanAuthorityDeps = DEFAULT_DEPS,
): MissionTaskPlanResult {
  if (ctx.role !== "orchestrator") {
    throw new Error("only an orchestrator can plan mission tasks");
  }
  const requestedMissionId =
    typeof args.missionId === "string" && args.missionId.length > 0
      ? args.missionId
      : undefined;
  const missionId = childMissionId(ctx, requestedMissionId);
  if (!missionId) throw new Error("missionId is required for plan");
  if (deps.listMissionWorktrees(ctx.scope, missionId).length > 0) {
    throw new Error(
      "mission task plan is sealed after the first worktree allocation",
    );
  }
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (rawTasks.length === 0) throw new Error("tasks[] is required for plan");
  if (rawTasks.length > 64) throw new Error("at most 64 tasks per plan");

  const mission = suite.missions.get(missionId);
  if (mission) {
    assertCurrentMissionOrchestratorSession(ctx, mission);
  }
  if (!mission?.intentContract || !hasCurrentDispatchAuthority(mission)) {
    throw new Error("task plan requires a running approved mission");
  }
  if (!mission.squadId) {
    throw new Error("task plan requires mission bound to a saved squad");
  }
  const squad = deps.getSquad(mission.squadId);
  if (!squad) {
    throw new Error(
      "task plan squad snapshot is unavailable; reselect the squad",
    );
  }
  const squadSnapshot = snapshotSquadAuthority(squad);
  if (mission.intentContract.squadRevisionHash !== squadSnapshot.hash) {
    throw new Error(
      "task plan denied: saved squad changed after approval; reapprove the mission",
    );
  }

  const inputs = rawTasks.map((raw, index) => parsePlanTask(raw, index, squad));
  const requiredWorkerAgentRef =
    mission.intentContract.requiredWorkerAgentRef;
  if (requiredWorkerAgentRef) {
    if (inputs.length !== 1) {
      throw new Error(
        'scheduled mission requires a single task for its exact roster worker',
      );
    }
    if (inputs[0]?.agentRef !== requiredWorkerAgentRef) {
      throw new Error(
        `scheduled mission exact worker is ${requiredWorkerAgentRef}; ` +
          'the plan cannot substitute another roster member',
      );
    }
  }
  const planned = emitPlannedTasksWithContract(inputs);
  assertClosedAcyclicPlanDependencies(planned);
  const intentVersion = mission.intentContract.intentVersion;
  const assignments = new Map(inputs.map((input) => [input.id, input]));
  const idMap = new Map(
    planned.map(
      (task) =>
        [task.id, plannedTaskId(missionId, intentVersion, task.id)] as const,
    ),
  );
  const rows = planned.map((task) => {
    const storeId = idMap.get(task.id)!;
    const dependsOn = task.dependsOn
      .map((dependency) => idMap.get(dependency) ?? dependency)
      .filter((dependency) => dependency !== storeId);
    const assignment = assignments.get(task.id)!;
    return {
      plannerId: task.id,
      title: task.title,
      detail: encodeTaskScheduleDetail(task.detail, {
        dependsOn,
        ownership: task.ownership,
        merged: false,
        parallelEligible: task.parallelEligible,
        agentRef: assignment.agentRef,
        agentCategory: assignment.agentCategory,
        executionMode: assignment.executionMode,
      }),
      agentRef: assignment.agentRef,
      agentCategory: assignment.agentCategory,
    };
  });
  const created = suite.tasks.createPlanAtomically({
    missionId,
    intentVersion,
    squad: { id: squad.id, agents: squad.agents },
    rows,
  });
  return Object.freeze({
    missionId,
    tasks: created,
    planned: planned.map((task, index) => {
      const assignment = assignments.get(task.id)!;
      return Object.freeze({
        plannerId: task.id,
        taskId: created[index]!.id,
        dependsOn: task.dependsOn
          .map((dependency) => idMap.get(dependency) ?? dependency)
          .filter((dependency) => dependency !== created[index]!.id),
        ownership: task.ownership,
        parallelEligible: task.parallelEligible,
        agentRef: assignment.agentRef,
        category: assignment.agentCategory,
        executionMode: assignment.executionMode,
      });
    }),
  });
}
