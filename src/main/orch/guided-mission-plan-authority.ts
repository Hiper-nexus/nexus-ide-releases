import type { Mission, Squad, SquadAgent } from "../../shared/orch-types";
import { hasMainOwnedGuidedDeliveryAuthority } from "./guided-mission-authority";
import {
  GUIDED_MISSION_PLANNER_TASK_ID,
  type GuidedTaskKind,
} from "./guided-task-kind";
import {
  assertClosedAcyclicPlanDependencies,
  assertSealedTaskSchedule,
  resolveSealedWorkerRoute,
  type LiveRosterAdapter,
} from "./mission-scheduler-plan";
import {
  decodeTaskScheduleDetail,
  encodeTaskScheduleDetail,
} from "./mission-scheduler-meta";
import type { MissionTaskPlanResult } from "./mission-task-plan-authority";
import {
  emitPlannedTasksWithContract,
  type PlannerTaskInput,
} from "./mission-scheduler";
import { assertGuidedSealedTaskDetailBudget } from "./guided-mission-prompt";
import {
  plannedTaskId,
  snapshotTaskPlanRoster,
  type PlannedTaskRecord,
} from "./task-store";

export type GuidedWorkerAgent = SquadAgent & {
  readonly category: "executor" | "reviewer" | "scout" | "architect";
};

export interface GuidedPlanTaskDetailInput extends PlannerTaskInput {
  readonly detail: string;
  readonly ownership: NonNullable<PlannerTaskInput["ownership"]>;
  readonly agentRef: string;
  readonly category: GuidedWorkerAgent["category"];
  readonly executionMode: "isolated_worktree" | "read_only";
}

export interface GuidedV2ReceiptAuthority {
  readonly implementation: PlannedTaskRecord;
  readonly qualityGate: PlannedTaskRecord;
  readonly ordered: readonly PlannedTaskRecord[];
}

export function isGuidedWorkerAgent(
  agent: SquadAgent,
): agent is GuidedWorkerAgent {
  return agent.category !== "orchestrator";
}

/**
 * Preflight the exact encoded detail shape that the task-plan authority will
 * persist. Guided tasks always carry explicit ownership, so the generic
 * scheduler projection is deterministic here.
 */
export function assertGuidedPlanTaskDetailBudgets(input: {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly tasks: readonly GuidedPlanTaskDetailInput[];
}): void {
  const assignments = new Map(input.tasks.map((task) => [task.id, task]));
  const planned = emitPlannedTasksWithContract(input.tasks);
  const taskIds = new Map(
    planned.map(
      (task) =>
        [
          task.id,
          plannedTaskId(input.missionId, input.intentVersion, task.id),
        ] as const,
    ),
  );
  for (const task of planned) {
    const assignment = assignments.get(task.id);
    if (!assignment) {
      throw new Error(
        `guided_plan_task_detail_invalid: assignment ausente para ${task.id}`,
      );
    }
    const encodedDetail = encodeTaskScheduleDetail(task.detail, {
      dependsOn: task.dependsOn.map(
        (dependency) => taskIds.get(dependency) ?? dependency,
      ),
      ownership: task.ownership,
      merged: false,
      parallelEligible: task.parallelEligible,
      agentRef: assignment.agentRef,
      agentCategory: assignment.category,
      executionMode: assignment.executionMode,
    });
    assertGuidedSealedTaskDetailBudget(task.id, encodedDetail);
  }
}

export function guidedPlanEligibility(
  mission: Mission,
):
  | "lane-not-standard"
  | "automation-owned"
  | "squad-not-engine-generated"
  | null {
  if ((mission.intentContract?.lane ?? "standard") !== "standard") {
    return "lane-not-standard";
  }
  // Cron/release automation has a separately issued exact-worker contract.
  // Guided Planner owns human-submitted typed/voice/imported missions only.
  if (
    mission.intentContract?.source === "automation" ||
    mission.intentContract?.requiredWorkerAgentRef
  ) {
    return "automation-owned";
  }
  // Guided Planner v2 is the deterministic completion contract for squads
  // synthesized by the beginner flow. Saved/manual specialty squads keep
  // their established orchestrator-authored plan: forcing executor→reviewer
  // would invalidate legitimate rosters such as review/research-only squads.
  if (!hasMainOwnedGuidedDeliveryAuthority(mission)) {
    return "squad-not-engine-generated";
  }
  return null;
}

function legacyGuidedReceipt(detail: string, cause?: unknown): never {
  throw new Error(
    `guided_plan_legacy_receipt_blocked: ${detail}; ` +
      "reaprove a missão para selar um plano roster-complete v2",
    cause === undefined ? undefined : { cause },
  );
}

function recoveredGuidedStage(
  kind: GuidedTaskKind,
  category: GuidedWorkerAgent["category"],
): "advisory" | "implementation" | "independent-review" | "quality-gate" {
  if (kind === "isolated-advisory") {
    return category === "reviewer" ? "independent-review" : "advisory";
  }
  return kind;
}

export function assertRosterCompleteGuidedV2Receipt(
  planned: readonly PlannedTaskRecord[],
  squad: Squad,
): GuidedV2ReceiptAuthority {
  try {
    const workers = squad.agents.filter(isGuidedWorkerAgent);
    if (planned.length !== workers.length || planned.length < 2) {
      legacyGuidedReceipt(
        "o receipt não possui exatamente uma tarefa para cada worker aprovado",
      );
    }
    const rosterHash = snapshotTaskPlanRoster(squad.agents).hash;
    if (
      planned.some(
        (entry) =>
          entry.squadId !== squad.id || entry.rosterHash !== rosterHash,
      )
    ) {
      legacyGuidedReceipt(
        "o receipt não pertence ao squad/roster atualmente aprovado",
      );
    }
    const expectedAgentRefs = new Set(workers.map((agent) => agent.id));
    const actualAgentRefs = new Set(planned.map((entry) => entry.agentRef));
    if (
      actualAgentRefs.size !== planned.length ||
      actualAgentRefs.size !== expectedAgentRefs.size ||
      [...expectedAgentRefs].some((agentRef) => !actualAgentRefs.has(agentRef))
    ) {
      legacyGuidedReceipt(
        "o receipt não cobre o roster aprovado sem duplicação",
      );
    }

    let implementationCount = 0;
    let qualityGateCount = 0;
    let implementationTaskId: string | null = null;
    let qualityGateTaskId: string | null = null;
    const dependencyGraph: Array<{
      id: string;
      dependsOn: readonly string[];
    }> = [];
    const dependentCounts = new Map<string, number>();
    const dependentByTaskId = new Map<string, string>();
    const schedules = new Map<
      string,
      Readonly<{
        entry: PlannedTaskRecord;
        kind: GuidedTaskKind;
        category: GuidedWorkerAgent["category"];
      }>
    >();
    for (const entry of planned) {
      const meta = assertSealedTaskSchedule(
        entry,
        decodeTaskScheduleDetail(entry.task.detail).meta,
      );
      const kind = meta.guidedTaskKind;
      if (!kind) {
        legacyGuidedReceipt(
          `a tarefa ${entry.taskId} não possui domínio Guided v2 exato`,
        );
      }
      if (kind === "implementation") {
        implementationCount += 1;
        implementationTaskId = entry.taskId;
      } else if (kind === "quality-gate") {
        qualityGateCount += 1;
        qualityGateTaskId = entry.taskId;
      }
      if (meta.dependsOn.length > 1) {
        legacyGuidedReceipt(
          `a tarefa ${entry.taskId} não pertence ao encadeamento v2`,
        );
      }
      for (const dependency of meta.dependsOn) {
        dependentCounts.set(
          dependency,
          (dependentCounts.get(dependency) ?? 0) + 1,
        );
        dependentByTaskId.set(dependency, entry.taskId);
      }
      schedules.set(
        entry.taskId,
        Object.freeze({
          entry,
          kind,
          category: meta.agentCategory,
        }),
      );
      dependencyGraph.push({
        id: entry.taskId,
        dependsOn: meta.dependsOn,
      });
    }
    if (implementationCount !== 1 || qualityGateCount !== 1) {
      legacyGuidedReceipt(
        "o receipt não contém executor e quality gate canônicos",
      );
    }
    assertClosedAcyclicPlanDependencies(dependencyGraph);
    const roots = dependencyGraph.filter(
      (entry) => entry.dependsOn.length === 0,
    );
    if (
      roots.length !== 1 ||
      !implementationTaskId ||
      !qualityGateTaskId ||
      dependentCounts.has(qualityGateTaskId) ||
      [...dependentCounts.values()].some((count) => count !== 1) ||
      dependencyGraph.reduce(
        (count, entry) => count + entry.dependsOn.length,
        0,
      ) !==
        dependencyGraph.length - 1
    ) {
      legacyGuidedReceipt(
        "o receipt não preserva o encadeamento sequencial v2",
      );
    }

    const orderedSchedules: Array<
      Readonly<{
        entry: PlannedTaskRecord;
        kind: GuidedTaskKind;
        category: GuidedWorkerAgent["category"];
      }>
    > = [];
    let cursor: string | undefined = roots[0]!.id;
    while (cursor) {
      const schedule = schedules.get(cursor);
      if (!schedule) {
        legacyGuidedReceipt(
          `a tarefa ${cursor} não possui schedule Guided recuperável`,
        );
      }
      orderedSchedules.push(schedule);
      cursor = dependentByTaskId.get(cursor);
    }
    if (orderedSchedules.length !== planned.length) {
      legacyGuidedReceipt(
        "o receipt não forma uma única cadeia Guided completa",
      );
    }

    const implementationIndex = orderedSchedules.findIndex(
      (schedule) => schedule.kind === "implementation",
    );
    const qualityGateIndex = orderedSchedules.findIndex(
      (schedule) => schedule.kind === "quality-gate",
    );
    const stages = orderedSchedules.map((schedule) =>
      recoveredGuidedStage(schedule.kind, schedule.category),
    );
    if (
      implementationIndex < 0 ||
      qualityGateIndex !== orderedSchedules.length - 1 ||
      stages
        .slice(0, implementationIndex)
        .some((stage) => stage !== "advisory") ||
      stages[implementationIndex] !== "implementation" ||
      stages
        .slice(implementationIndex + 1, qualityGateIndex)
        .some((stage) => stage !== "independent-review") ||
      stages[qualityGateIndex] !== "quality-gate"
    ) {
      legacyGuidedReceipt(
        "o receipt não preserva advisory → implementation → independent-review → quality-gate",
      );
    }

    const implementation = schedules.get(implementationTaskId)?.entry;
    const qualityGate = schedules.get(qualityGateTaskId)?.entry;
    if (!implementation || !qualityGate) {
      legacyGuidedReceipt(
        "o receipt não permite recuperar executor e quality gate canônicos",
      );
    }
    return Object.freeze({
      implementation,
      qualityGate,
      ordered: Object.freeze(
        orderedSchedules.map((schedule) => schedule.entry),
      ),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("guided_plan_legacy_receipt_blocked:")
    ) {
      throw error;
    }
    legacyGuidedReceipt(
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

function generalistRank(agent: SquadAgent): number {
  const identity = `${agent.id} ${agent.agentName}`.toLocaleLowerCase("en-US");
  return /\b(generalist|generalista|implementador|builder|dev|coder|fixer)\b/.test(
    identity,
  )
    ? 0
    : 1;
}

function orderedExecutorCandidates(squad: Squad): readonly SquadAgent[] {
  return squad.agents
    .map((agent, index) => ({ agent, index }))
    .filter(
      ({ agent }) => agent.category === "executor" && agent.cli !== "claude",
    )
    .sort(
      (left, right) =>
        generalistRank(left.agent) - generalistRank(right.agent) ||
        left.index - right.index ||
        left.agent.id.localeCompare(right.agent.id),
    )
    .map(({ agent }) => agent);
}

function qualityGateRank(agent: SquadAgent): number {
  const identity = `${agent.id} ${agent.agentName}`.toLocaleLowerCase("en-US");
  // "e2e" describes a test domain, not necessarily the QA role. Ranking it
  // together with explicit QA identities made an `e2e-reviewer` tie with an
  // `e2e-qa`, so roster order could incorrectly assign the reviewer as the
  // final no-change quality gate.
  if (/\b(qa|quality|teste|test|validation|validação)\b/u.test(identity)) {
    return 0;
  }
  if (/\b(review|reviewer|revisor|security|segurança)\b/u.test(identity)) {
    return 1;
  }
  return 2;
}

function orderedQualityGateCandidates(
  squad: Squad,
  executor: SquadAgent,
): readonly SquadAgent[] {
  return squad.agents
    .map((agent, index) => ({ agent, index }))
    .filter(
      ({ agent }) =>
        agent.category === "reviewer" &&
        agent.cli !== "claude" &&
        agent.id !== executor.id,
    )
    .sort(
      (left, right) =>
        qualityGateRank(left.agent) - qualityGateRank(right.agent) ||
        Number(left.agent.cli === executor.cli) -
          Number(right.agent.cli === executor.cli) ||
        left.index - right.index ||
        left.agent.id.localeCompare(right.agent.id),
    )
    .map(({ agent }) => agent);
}

export function assertExactRosterRoutes(input: {
  readonly mission: Mission;
  readonly workers: readonly SquadAgent[];
  readonly adapters: readonly LiveRosterAdapter[];
  readonly rosterHash: string;
}): void {
  const taskText = [
    input.mission.title,
    input.mission.intentContract?.goal ?? input.mission.description,
  ].join("\n");
  const failures: string[] = [];
  for (const worker of input.workers) {
    try {
      resolveSealedWorkerRoute({
        taskText,
        agent: worker,
        adapters: input.adapters,
        rosterHash: input.rosterHash,
      });
    } catch (error) {
      failures.push(
        `${worker.id}/${worker.cli}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      "guided_plan_roster_route_unavailable: o roster aprovado não pode ser " +
        `executado por identidade sem substituição; ${failures.join(" | ")}`,
    );
  }
}

export function choosePrimaryExecutor(squad: Squad): SquadAgent {
  const candidates = orderedExecutorCandidates(squad);
  if (candidates.length === 0) {
    throw new Error(
      "guided_plan_executor_missing: o squad aprovado precisa de um executor não-Claude",
    );
  }
  return candidates[0]!;
}

export function chooseCorrectiveQualityGate(
  squad: Squad,
  executor: SquadAgent,
): SquadAgent {
  const candidates = orderedQualityGateCandidates(squad, executor);
  if (candidates.length === 0) {
    throw new Error(
      "guided_plan_reviewer_missing: o squad aprovado precisa de um QA/reviewer não-Claude independente do executor",
    );
  }
  return candidates[0]!;
}

export function taskIdFromPlan(plan: MissionTaskPlanResult): string {
  const task = plan.planned.find(
    (candidate) => candidate.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
  );
  if (!task) {
    throw new Error("guided_plan_receipt_invalid: tarefa canônica ausente");
  }
  return task.taskId;
}
