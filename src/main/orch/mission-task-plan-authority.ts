import type { AgentCategory, Squad, SquadAgent } from "../../shared/orch-types";
import {
  adapterCapabilityMatrixOf,
  type AdapterInfo,
} from "../../shared/adapter-types";
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
} from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  assertCurrentMissionOrchestratorSession,
  type AgentGateContext,
} from "./gate";
import {
  emitPlannedTasksWithContract,
  type PlannerTaskInput,
} from "./mission-scheduler";
import { ownershipLooksRepoWide, MAX_FREE_FORM_GREENFIELD_OVERLAP } from "./guided-mission-ownership";
import { encodeTaskScheduleDetail } from "./mission-scheduler-meta";
import {
  assertClosedAcyclicPlanDependencies,
  supportsMechanicallyReadOnlyCli,
  supportsMechanicallyWorkspaceWriteCli,
  type PlannedExecutionMode,
} from "./mission-scheduler-plan";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import { getSquad } from "./squad-store";
import {
  plannedTaskId,
  type ApprovedPreflightTaskPlanAuthority,
  type ScopedTaskRecord,
} from "./task-store";
import { childMissionId } from "./tools-panes";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { listAdapterInfos } from "../adapters/adapter-registry";
import { getOrchSettings } from "../persistence/settings-store";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import type { SquadCliPolicy } from "../../shared/settings-types";
import {
  classifyStandardMissionTopology,
  hasTeamReadOnlyFanoutDomain,
} from "../../shared/mission-topology";

type WorkerCategory = Exclude<AgentCategory, "orchestrator">;

interface ParsedPlanTask extends PlannerTaskInput {
  readonly ownership: NonNullable<PlannerTaskInput["ownership"]>;
  readonly agentRef: string;
  readonly agentCategory: WorkerCategory;
  readonly executionMode: PlannedExecutionMode;
}

export interface MissionTaskPlanAuthorityDeps {
  readonly getSquad: (squadId: string) => Squad | null;
  readonly getAdapterInfo: (adapterId: string) => AdapterInfo | null;
  readonly listMissionWorktrees: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => readonly unknown[];
  readonly squadCliPolicy: () => SquadCliPolicy;
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

export interface MainOwnedMissionTaskPlanInput {
  readonly missionId: string;
  readonly tasks: readonly unknown[];
}

/**
 * Exact approval snapshot that lets trusted Main seal a plan before dispatch.
 *
 * This is deliberately a separate, explicit capability from the ordinary
 * running-mission path. The MCP/orchestrator boundary never receives it, so a
 * worker cannot turn a merely approved mission into execution authority.
 */
export type MainOwnedApprovedPreflightAuthority =
  ApprovedPreflightTaskPlanAuthority;

const DEFAULT_DEPS: MissionTaskPlanAuthorityDeps = Object.freeze({
  // Keep the store lookup lazy. Several IPC shells replace squad-store with a
  // deliberately narrow test double and never exercise planning; touching the
  // export while this module is imported makes unrelated handlers fail during
  // collection instead of at the actual planning boundary.
  getSquad: (squadId: string) => getSquad(squadId),
  getAdapterInfo: (adapterId: string) =>
    listAdapterInfos().find((adapter) => adapter.id === adapterId) ?? null,
  listMissionWorktrees: (scope: ProjectExecutionScope, missionId: string) =>
    requireWorktreeRuntimeRegistry().listMission(scope, missionId),
  squadCliPolicy: () => getOrchSettings().squadCliPolicy,
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
  if (
    value !== "isolated_worktree" &&
    value !== "read_only" &&
    value !== "same_checkout"
  ) {
    throw new Error(
      `task ${taskId} requires executionMode isolated_worktree, read_only or same_checkout`,
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
  getAdapterInfo: MissionTaskPlanAuthorityDeps["getAdapterInfo"],
  operatorChoice = false,
  teamReadOnlyFanout = false,
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
    // reserveClaude protects the single Claude OAuth session from concurrent
    // Claude processes. In default autopilot the mission's one Claude process
    // may also own an isolated worktree when the orchestrator is NOT Claude.
    // Governed mode retains the narrower read-only advisor rule.
    const orchestratorCli = squad.agents.find(
      (agent) => agent.category === "orchestrator",
    )?.cli;
    if (
      orchestratorCli === "claude" ||
      (!operatorChoice && mode !== "read_only")
    ) {
      throw new Error(
        `task ${taskId} cannot use ${assignedAgent.id}: reserveClaude keeps the ` +
          "Claude OAuth session exclusive per mission; no modo Hardened Claude " +
          "só participa como advisor read_only quando o orquestrador não é Claude",
      );
    }
  }
  const adapterInfo = getAdapterInfo(assignedAgent.cli);
  const capabilities = adapterCapabilityMatrixOf(adapterInfo);
  if (
    !adapterInfo ||
    adapterInfo.kind !== "cli-pty" ||
    !capabilities.launchable ||
    !capabilities.promptInjectable ||
    !capabilities.statusObservable
  ) {
    throw new Error(
      `task ${taskId} cannot use ${assignedAgent.id}: CLI ${assignedAgent.cli} ` +
        "does not have a main-owned automatic launch/prompt/status route",
    );
  }
  if (mode === "isolated_worktree" && ownershipFiles.length === 0) {
    throw new Error(
      `task ${taskId} isolated_worktree requires explicit ownership.files`,
    );
  }
  if (
    mode === "isolated_worktree" &&
    !capabilities.governedWriter &&
    !operatorChoice
  ) {
    throw new Error(
      `task ${taskId} isolated_worktree requires a release-qualified governed writer`,
    );
  }
  if (
    mode === "isolated_worktree" &&
    !supportsMechanicallyWorkspaceWriteCli(assignedAgent.cli, operatorChoice)
  ) {
    throw new Error(
      `task ${taskId} governed writer is not release-enabled at the physical dispatch boundary`,
    );
  }
  if (
    mode === "read_only" &&
    !operatorChoice &&
    !capabilities.autonomousReadOnly
  ) {
    throw new Error(
      `task ${taskId} read_only requires a mechanically confined CLI; ` +
        `${assignedAgent.cli} is not eligible`,
    );
  }
  if (
    mode === "read_only" &&
    !capabilities.governedWriter &&
    category !== "reviewer" &&
    category !== "scout" &&
    !teamReadOnlyFanout
  ) {
    throw new Error(
      `task ${taskId} read_only-only CLI is restricted to reviewer/scout`,
    );
  }
  // Keep the id-level dispatch backstop in the plan seal too. A future
  // release may add an AdapterInfo qualification only together with the
  // physical spawn/claim/complete checks for that exact CLI. Advisory CLIs
  // (MCP-only, no native confinement) join read_only reviewer/scout tasks in
  // the advisory-unconfined tier; everything else requires the mechanically
  // confined lane.
  if (
    mode === "read_only" &&
    !operatorChoice &&
    !supportsMechanicallyReadOnlyCli(assignedAgent.cli)
  ) {
    throw new Error(
      `task ${taskId} read_only capability is not release-enabled at the physical dispatch boundary`,
    );
  }
  return assignedAgent;
}

function parsePlanTask(
  raw: unknown,
  index: number,
  squad: Squad,
  deps: Pick<
    MissionTaskPlanAuthorityDeps,
    "getAdapterInfo" | "squadCliPolicy"
  >,
  allowTeamReadOnlyFanout = false,
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
  const operatorChoice = isOperatorChoicePolicy(
    deps.squadCliPolicy(),
  );
  if (!operatorChoice && ownershipLooksRepoWide(ownership.files)) {
    throw new Error(
      `task ${id} ownership.files looks repo-wide; partition claims per task ` +
        `(at most ${MAX_FREE_FORM_GREENFIELD_OVERLAP} greenfield-catalog top-level paths)`,
    );
  }
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
    deps.getAdapterInfo,
    operatorChoice,
    allowTeamReadOnlyFanout &&
      hasTeamReadOnlyFanoutDomain(ownership.domains),
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
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];

  const mission = suite.missions.get(missionId);
  if (mission) {
    assertCurrentMissionOrchestratorSession(ctx, mission);
  }
  return sealMainOwnedMissionTaskPlan(
    {
      missionId,
      tasks: rawTasks,
    },
    ctx.scope,
    suite,
    deps,
  );
}

const TERMINAL_WORKTREE_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "abandoned",
  "integrated",
]);

/**
 * Seal immutability counts only worktrees that still hold an execution slot.
 *
 * Terminal records (failed/abandoned/integrated) belong to a prior plan
 * generation — routinely a blocked dispatch whose ownership was already
 * released with the dead-owner marker — and remain governed by
 * `WorktreeManager.create`'s own per-taskKey conflict and resurrection rules.
 * Counting them here made every reopen of a technically blocked mission die
 * with "sealed after the first worktree allocation", killing automatic
 * recovery. Records without a recognizable status stay fail-closed as live.
 */
export function hasLiveMissionWorktreeAllocation(
  records: readonly unknown[],
): boolean {
  return records.some((record) => {
    const status = (record as { readonly status?: unknown } | null)?.status;
    return !(
      typeof status === "string" && TERMINAL_WORKTREE_STATUSES.has(status)
    );
  });
}

/**
 * Trusted-main seal for an immutable task plan.
 *
 * Unlike the MCP entry point above, this boundary does not require an
 * orchestrator session: approval/bootstrap code runs before that physical
 * session exists. It still derives every authority-bearing field from the
 * current approved mission + exact saved squad, refuses any prior worktree,
 * and persists the plan atomically through ScopedTaskStore.
 *
 * Keep this export main-process-only. Renderer/CLI callers must enter through
 * their own authority boundary (`planMissionTasks` for MCP).
 */
export function sealMainOwnedMissionTaskPlan(
  input: MainOwnedMissionTaskPlanInput,
  scope: ProjectExecutionScope,
  suite: Pick<ProjectDomainStoreSuite, "missions" | "tasks">,
  deps: MissionTaskPlanAuthorityDeps = DEFAULT_DEPS,
  authority?: MainOwnedApprovedPreflightAuthority,
): MissionTaskPlanResult {
  const missionId = input.missionId;
  if (
    hasLiveMissionWorktreeAllocation(
      deps.listMissionWorktrees(scope, missionId),
    )
  ) {
    throw new Error(
      "mission task plan is sealed after the first worktree allocation",
    );
  }
  const rawTasks = [...input.tasks];
  if (rawTasks.length === 0) throw new Error("tasks[] is required for plan");
  if (rawTasks.length > 64) throw new Error("at most 64 tasks per plan");

  const mission = suite.missions.get(missionId);
  const contract = mission?.intentContract;
  const exactApprovedPreflight = Boolean(
    mission &&
      contract &&
      authority?.kind === "approved-preflight" &&
      mission.status === "pending" &&
      mission.intentState === "ready_to_start" &&
      mission.orchestratorSessionId === undefined &&
      hasCurrentApprovedDispatchContract(mission) &&
      mission.intentVersion === authority.intentVersion &&
      contract.intentVersion === authority.intentVersion &&
      contract.approvedAt === authority.approvedAt &&
      contract.approvalReviewSha256 === authority.approvalReviewSha256 &&
      contract.dispatchedAt === authority.dispatchedAt,
  );
  if (
    !mission?.intentContract ||
    (!hasCurrentDispatchAuthority(mission) && !exactApprovedPreflight)
  ) {
    throw new Error(
      "task plan requires a running approved mission or an exact main-owned approved preflight",
    );
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
  // Planner D1 re-pins live hash before seal. Residual mismatch is still a wall
  // (authority race between plan and seal).
  if (
    mission.intentContract.squadRevisionHash !== undefined &&
    mission.intentContract.squadRevisionHash !== squadSnapshot.hash
  ) {
    throw new Error(
      "task plan denied: saved squad changed after approval; reapprove the mission",
    );
  }

  const allowTeamReadOnlyFanout =
    classifyStandardMissionTopology(mission.intentContract.goal) ===
    "team-read-only-fanout";
  const inputs = rawTasks.map((raw, index) =>
    parsePlanTask(raw, index, squad, deps, allowTeamReadOnlyFanout),
  );
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
    ...(exactApprovedPreflight && authority
      ? { approvedPreflight: authority }
      : {}),
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
