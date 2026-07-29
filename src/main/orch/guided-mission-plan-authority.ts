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
import { getOrchSettings } from "../persistence/settings-store";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";

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
    if (!implementationTaskId || !qualityGateTaskId) {
      legacyGuidedReceipt(
        "o receipt não contém executor e quality gate canônicos",
      );
    }

    type ScheduleRow = Readonly<{
      entry: PlannedTaskRecord;
      kind: GuidedTaskKind;
      category: GuidedWorkerAgent["category"];
    }>;

    const implementationSchedule = schedules.get(implementationTaskId);
    const qualityGateSchedule = schedules.get(qualityGateTaskId);
    if (!implementationSchedule || !qualityGateSchedule) {
      legacyGuidedReceipt(
        "o receipt não permite recuperar executor e quality gate canônicos",
      );
    }

    const implementationNode = dependencyGraph.find(
      (entry) => entry.id === implementationTaskId,
    );
    const qualityGateNode = dependencyGraph.find(
      (entry) => entry.id === qualityGateTaskId,
    );
    if (
      !implementationNode ||
      implementationNode.dependsOn.length !== 0 ||
      !qualityGateNode ||
      qualityGateNode.dependsOn.length !== 1 ||
      dependentCounts.has(qualityGateTaskId)
    ) {
      legacyGuidedReceipt(
        "o receipt não preserva implementation raiz e quality-gate folha",
      );
    }

    const advisoryRoots: ScheduleRow[] = [];
    let reviewCount = 0;
    for (const entry of dependencyGraph) {
      const schedule = schedules.get(entry.id);
      if (!schedule) {
        legacyGuidedReceipt(
          `a tarefa ${entry.id} não possui schedule Guided recuperável`,
        );
      }
      const stage = recoveredGuidedStage(schedule.kind, schedule.category);
      if (stage === "advisory") {
        if (entry.dependsOn.length !== 0 || dependentCounts.has(entry.id)) {
          legacyGuidedReceipt(
            `advisory ${entry.id} deve ser raiz tip-only sem dependentes`,
          );
        }
        advisoryRoots.push(schedule);
      } else if (stage === "independent-review") {
        if (entry.dependsOn.length !== 1) {
          legacyGuidedReceipt(
            `revisão ${entry.id} exige exatamente uma dependência`,
          );
        }
        reviewCount += 1;
      } else if (stage !== "implementation" && stage !== "quality-gate") {
        legacyGuidedReceipt(`estágio Guided desconhecido em ${entry.id}`);
      }
    }

    const deliveryOrdered: ScheduleRow[] = [implementationSchedule];
    // `cursor` is narrowed to string inside the loop: the map lookup below is
    // what advances it, so the guard has to prove non-undefined first.
    let cursor: string = implementationTaskId;
    const seen = new Set<string>([implementationTaskId]);
    while (dependentByTaskId.has(cursor)) {
      const nextId: string = dependentByTaskId.get(cursor)!;
      if (seen.has(nextId)) {
        legacyGuidedReceipt("ciclo na cadeia de delivery Guided");
      }
      seen.add(nextId);
      const next = schedules.get(nextId);
      if (!next) {
        legacyGuidedReceipt(
          `a tarefa ${nextId} não possui schedule Guided recuperável`,
        );
      }
      deliveryOrdered.push(next);
      cursor = nextId;
      if (nextId === qualityGateTaskId) break;
    }
    if (
      deliveryOrdered[deliveryOrdered.length - 1]?.entry.taskId !==
      qualityGateTaskId
    ) {
      legacyGuidedReceipt(
        "a cadeia de delivery não termina no quality-gate",
      );
    }
    const deliveryStages = deliveryOrdered.map((schedule) =>
      recoveredGuidedStage(schedule.kind, schedule.category),
    );
    if (
      deliveryStages[0] !== "implementation" ||
      deliveryStages[deliveryStages.length - 1] !== "quality-gate" ||
      deliveryStages
        .slice(1, -1)
        .some((stage) => stage !== "independent-review")
    ) {
      legacyGuidedReceipt(
        "o receipt não preserva implementation → independent-review* → quality-gate",
      );
    }
    if (
      advisoryRoots.length + deliveryOrdered.length !== planned.length ||
      reviewCount !== deliveryStages.length - 2
    ) {
      legacyGuidedReceipt(
        "o receipt não forma o grafo Guided paralelo completo",
      );
    }

    const orderedSchedules = [
      ...advisoryRoots.sort((left, right) =>
        left.entry.taskId.localeCompare(right.entry.taskId),
      ),
      ...deliveryOrdered,
    ];

    return Object.freeze({
      implementation: implementationSchedule.entry,
      qualityGate: qualityGateSchedule.entry,
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

function canUseClaudeWorker(
  squad: Squad,
  operatorChoice = isOperatorChoicePolicy(
    getOrchSettings().squadCliPolicy,
  ),
): boolean {
  return (
    operatorChoice &&
    squad.agents.find((agent) => agent.category === "orchestrator")?.cli !==
      "claude"
  );
}

function orderedExecutorCandidates(
  squad: Squad,
  operatorChoice?: boolean,
): readonly SquadAgent[] {
  const claudeWorkerAvailable = canUseClaudeWorker(squad, operatorChoice);
  return squad.agents
    .map((agent, index) => ({ agent, index }))
    .filter(
      ({ agent }) =>
        agent.category === "executor" &&
        (agent.cli !== "claude" || claudeWorkerAvailable),
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
  operatorChoice?: boolean,
): readonly SquadAgent[] {
  const claudeWorkerAvailable = canUseClaudeWorker(squad, operatorChoice);
  return squad.agents
    .map((agent, index) => ({ agent, index }))
    .filter(
      ({ agent }) =>
        agent.category === "reviewer" &&
        (agent.cli !== "claude" || claudeWorkerAvailable) &&
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
  readonly orchestratorCliId?: string;
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
        orchestratorCliId: input.orchestratorCliId,
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

export function choosePrimaryExecutor(
  squad: Squad,
  operatorChoice?: boolean,
): SquadAgent {
  const candidates = orderedExecutorCandidates(squad, operatorChoice);
  if (candidates.length === 0) {
    throw new Error(
      "guided_plan_executor_missing: o squad aprovado precisa de um executor disponível",
    );
  }
  return candidates[0]!;
}

export function chooseCorrectiveQualityGate(
  squad: Squad,
  executor: SquadAgent,
  operatorChoice?: boolean,
): SquadAgent {
  const candidates = orderedQualityGateCandidates(
    squad,
    executor,
    operatorChoice,
  );
  if (candidates.length === 0) {
    throw new Error(
      "guided_plan_reviewer_missing: o squad aprovado precisa de um QA/reviewer independente do executor",
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
