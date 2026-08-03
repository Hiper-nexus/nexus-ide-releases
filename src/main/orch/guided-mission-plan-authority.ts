import type { Mission, Squad, SquadAgent } from "../../shared/orch-types";
import {
  classifyStandardMissionTopology,
  hasTeamReadOnlyFanoutDomain,
  type StandardMissionTopology,
} from "../../shared/mission-topology";
import { hasWavePackDomain } from "../../shared/mission-wave-pack";
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

export interface GuidedTeamFanoutReceiptAuthority {
  readonly primary: PlannedTaskRecord;
  readonly ordered: readonly PlannedTaskRecord[];
}

export interface GuidedWavePackReceiptAuthority {
  readonly primary: PlannedTaskRecord;
  readonly stories: readonly PlannedTaskRecord[];
  readonly qualityGate: PlannedTaskRecord | null;
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
  options: {
    readonly hasExistingPlan?: boolean;
    readonly existingTopology?: StandardMissionTopology;
    /**
     * Squad resolver used by the delivery-authority check. Callers that
     * resolve rosters through injected deps (the planner) must pass the same
     * resolver here so eligibility and sealing read one squad authority.
     */
    readonly resolveSquad?: (squadId: string) => Squad | null;
  } = {},
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
  // synthesized by the beginner flow AND for saved-team launch snapshots
  // (mission-runtime) with a delivery-shaped roster. Review/research-only
  // saved squads keep their orchestrator-authored plan: forcing
  // executor→reviewer would invalidate those rosters.
  if (
    !hasMainOwnedGuidedDeliveryAuthority(mission, options.resolveSquad) &&
    (
      (options.hasExistingPlan === true &&
        options.existingTopology !== "team-read-only-fanout") ||
      Boolean(mission.intentContract?.promotedPlan) ||
      (options.hasExistingPlan !== true &&
        classifyStandardMissionTopology(mission.intentContract?.goal ?? "") !==
          "team-read-only-fanout")
    )
  ) {
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

type GuidedRecoveredStage =
  | "advisory"
  | "reproduction"
  | "implementation"
  | "regression"
  | "independent-review"
  | "quality-gate";

function recoveredGuidedStage(
  kind: GuidedTaskKind,
  category: GuidedWorkerAgent["category"],
): GuidedRecoveredStage {
  if (kind === "isolated-advisory") {
    return category === "reviewer" ? "independent-review" : "advisory";
  }
  return kind;
}

export function assertRosterCompleteGuidedTeamFanoutReceipt(
  planned: readonly PlannedTaskRecord[],
  squad: Squad,
): GuidedTeamFanoutReceiptAuthority {
  try {
    const workers = squad.agents.filter(isGuidedWorkerAgent);
    if (planned.length !== workers.length || planned.length === 0) {
      legacyGuidedReceipt(
        "a rodada de equipe não possui exatamente uma tarefa por worker",
      );
    }
    const rosterHash = snapshotTaskPlanRoster(squad.agents).hash;
    const plannedByAgent = new Map(
      planned.map((entry) => [entry.agentRef, entry] as const),
    );
    if (
      plannedByAgent.size !== workers.length ||
      planned.some(
        (entry) =>
          entry.squadId !== squad.id || entry.rosterHash !== rosterHash,
      )
    ) {
      legacyGuidedReceipt(
        "a rodada de equipe diverge do squad/roster atualmente aprovado",
      );
    }

    for (const worker of workers) {
      const entry = plannedByAgent.get(worker.id);
      if (!entry || entry.agentCategory !== worker.category) {
        legacyGuidedReceipt(
          `a rodada de equipe não cobre a identidade ${worker.id}`,
        );
      }
      assertGuidedTeamFanoutEntry(entry, worker);
    }

    const ordered = workers.map((worker) => plannedByAgent.get(worker.id)!);
    return Object.freeze({
      primary: ordered[0]!,
      ordered: Object.freeze(ordered),
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

function assertGuidedTeamFanoutEntry(
  entry: PlannedTaskRecord,
  worker: GuidedWorkerAgent,
): void {
  const meta = assertSealedTaskSchedule(
    entry,
    decodeTaskScheduleDetail(entry.task.detail).meta,
  );
  const expectedKind =
    worker.category === "reviewer" ? "independent-review" : "advisory";
  if (
    meta.guidedTaskKind !== expectedKind ||
    meta.executionMode !== "read_only" ||
    meta.dependsOn.length !== 0 ||
    meta.parallelEligible !== true ||
    meta.ownership.files.length !== 0 ||
    meta.ownership.symbols.length !== 0 ||
    !hasTeamReadOnlyFanoutDomain(meta.ownership.domains)
  ) {
    legacyGuidedReceipt(
      `a tarefa ${entry.taskId} não é uma raiz paralela somente leitura`,
    );
  }
}

/**
 * Recovers a Wave Pack receipt: ≥2 story mutation roots (+ optional QA),
 * every task marked with the wave-pack domain.
 */
export function assertRosterCompleteGuidedWavePackReceipt(
  planned: readonly PlannedTaskRecord[],
  squad: Squad,
): GuidedWavePackReceiptAuthority {
  try {
    if (planned.length < 2) {
      legacyGuidedReceipt(
        "o Wave Pack precisa de pelo menos 2 tarefas seladas",
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
        "o Wave Pack diverge do squad/roster atualmente aprovado",
      );
    }

    const stories: PlannedTaskRecord[] = [];
    let qualityGate: PlannedTaskRecord | null = null;
    for (const entry of planned) {
      const meta = assertSealedTaskSchedule(
        entry,
        decodeTaskScheduleDetail(entry.task.detail).meta,
      );
      if (!hasWavePackDomain(meta.ownership.domains)) {
        legacyGuidedReceipt(
          `a tarefa ${entry.taskId} não carrega o marcador wave-pack`,
        );
      }
      if (meta.guidedTaskKind === "quality-gate") {
        if (qualityGate) {
          legacyGuidedReceipt("o Wave Pack tem mais de um quality-gate");
        }
        if (meta.executionMode !== "read_only") {
          legacyGuidedReceipt(
            `o quality-gate ${entry.taskId} deve ser read_only`,
          );
        }
        qualityGate = entry;
        continue;
      }
      if (
        meta.guidedTaskKind !== "implementation" ||
        meta.executionMode !== "isolated_worktree" ||
        meta.dependsOn.length !== 0 ||
        meta.parallelEligible !== true
      ) {
        legacyGuidedReceipt(
          `a tarefa ${entry.taskId} não é uma story raiz do Wave Pack`,
        );
      }
      stories.push(entry);
    }
    if (stories.length < 2) {
      legacyGuidedReceipt(
        "o Wave Pack precisa de pelo menos 2 stories de mutação",
      );
    }
    if (qualityGate) {
      const meta = assertSealedTaskSchedule(
        qualityGate,
        decodeTaskScheduleDetail(qualityGate.task.detail).meta,
      );
      const storyIds = new Set(stories.map((story) => story.taskId));
      if (
        meta.dependsOn.length !== stories.length ||
        meta.dependsOn.some((dep) => !storyIds.has(dep))
      ) {
        legacyGuidedReceipt(
          "o quality-gate do Wave Pack deve depender de todas as stories",
        );
      }
    }
    return Object.freeze({
      primary: stories[0]!,
      stories: Object.freeze(stories),
      qualityGate,
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

    type ScheduleRow = Readonly<{
      entry: PlannedTaskRecord;
      stage: GuidedRecoveredStage;
      dependsOn: readonly string[];
    }>;

    const rows: ScheduleRow[] = [];
    const byTaskId = new Map<string, ScheduleRow>();
    const dependents = new Map<string, string[]>();
    const singletons = new Map<GuidedRecoveredStage, string>();
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
      const stage = recoveredGuidedStage(kind, meta.agentCategory);
      // Fan-in is a quality-gate privilege. Every other stage keeps at most one
      // predecessor, so a receipt can never smuggle an arbitrary DAG past the
      // recovery contract.
      if (meta.dependsOn.length > 1 && stage !== "quality-gate") {
        legacyGuidedReceipt(
          `a tarefa ${entry.taskId} declara mais de uma dependência sem ser o quality gate`,
        );
      }
      if (
        stage === "implementation" ||
        stage === "quality-gate" ||
        stage === "reproduction" ||
        stage === "regression"
      ) {
        if (singletons.has(stage)) {
          legacyGuidedReceipt(`o receipt possui mais de um estágio ${stage}`);
        }
        singletons.set(stage, entry.taskId);
      }
      const row: ScheduleRow = Object.freeze({
        entry,
        stage,
        dependsOn: meta.dependsOn,
      });
      rows.push(row);
      byTaskId.set(entry.taskId, row);
      for (const dependency of meta.dependsOn) {
        dependents.set(dependency, [
          ...(dependents.get(dependency) ?? []),
          entry.taskId,
        ]);
      }
    }

    const implementationTaskId = singletons.get("implementation");
    const qualityGateTaskId = singletons.get("quality-gate");
    if (!implementationTaskId || !qualityGateTaskId) {
      legacyGuidedReceipt(
        "o receipt não contém executor e quality gate canônicos",
      );
    }
    const reproductionTaskId = singletons.get("reproduction") ?? null;
    assertClosedAcyclicPlanDependencies(
      rows.map((row) => ({ id: row.entry.taskId, dependsOn: row.dependsOn })),
    );

    const dependentsOf = (taskId: string): readonly string[] =>
      dependents.get(taskId) ?? [];
    const sameSet = (
      left: readonly string[],
      right: readonly string[],
    ): boolean => {
      const rightSet = new Set(right);
      return (
        new Set(left).size === left.length &&
        left.length === rightSet.size &&
        left.every((value) => rightSet.has(value))
      );
    };

    // Per-stage edge contract. Written as explicit invariants (not a chain
    // walk) so a bug graph, a serial-review graph and a parallel-review graph
    // are all recoverable from the same rules.
    for (const row of rows) {
      const taskId = row.entry.taskId;
      const consumers = dependentsOf(taskId);
      switch (row.stage) {
        case "advisory":
          if (row.dependsOn.length !== 0 || consumers.length !== 0) {
            legacyGuidedReceipt(
              `advisory ${taskId} deve ser raiz tip-only sem dependentes`,
            );
          }
          break;
        case "reproduction":
          if (
            row.dependsOn.length !== 0 ||
            !sameSet([...consumers], [implementationTaskId])
          ) {
            legacyGuidedReceipt(
              `reprodução ${taskId} deve ser raiz consumida apenas pela implementação`,
            );
          }
          break;
        case "implementation":
          if (
            !sameSet(
              [...row.dependsOn],
              reproductionTaskId ? [reproductionTaskId] : [],
            )
          ) {
            legacyGuidedReceipt(
              `implementação ${taskId} deve depender exatamente da reprodução selada (ou de nada)`,
            );
          }
          break;
        case "regression":
          if (!sameSet([...row.dependsOn], [implementationTaskId])) {
            legacyGuidedReceipt(
              `regressão ${taskId} deve depender exatamente da implementação`,
            );
          }
          break;
        case "independent-review": {
          const predecessor = row.dependsOn[0];
          const predecessorStage = predecessor
            ? byTaskId.get(predecessor)?.stage
            : undefined;
          if (
            row.dependsOn.length !== 1 ||
            (predecessorStage !== "implementation" &&
              predecessorStage !== "regression" &&
              predecessorStage !== "independent-review")
          ) {
            legacyGuidedReceipt(
              `revisão ${taskId} exige exatamente um predecessor de entrega`,
            );
          }
          break;
        }
        case "quality-gate":
          if (consumers.length !== 0) {
            legacyGuidedReceipt(`quality gate ${taskId} não pode ter dependentes`);
          }
          break;
        default:
          legacyGuidedReceipt(`estágio Guided desconhecido em ${taskId}`);
      }
    }

    // The gate joins the whole delivery frontier: every non-advisory task that
    // nothing else consumes. This single invariant covers the legacy serial
    // chain (frontier = last review) and concurrent reviews (frontier = all of
    // them) without letting an unconsumed stage escape validation.
    const frontier = rows
      .filter(
        (row) =>
          row.stage !== "advisory" &&
          row.entry.taskId !== qualityGateTaskId &&
          dependentsOf(row.entry.taskId).every(
            (consumer) => consumer === qualityGateTaskId,
          ),
      )
      .map((row) => row.entry.taskId);
    const qualityGateRow = byTaskId.get(qualityGateTaskId)!;
    if (
      frontier.length === 0 ||
      !sameSet([...qualityGateRow.dependsOn], frontier)
    ) {
      legacyGuidedReceipt(
        "o quality gate não fecha exatamente a fronteira de entrega selada",
      );
    }

    const stageRank: Record<GuidedRecoveredStage, number> = {
      advisory: 0,
      reproduction: 1,
      implementation: 2,
      regression: 3,
      "independent-review": 4,
      "quality-gate": 5,
    };
    const orderedRows = [...rows].sort(
      (left, right) =>
        stageRank[left.stage] - stageRank[right.stage] ||
        left.entry.taskId.localeCompare(right.entry.taskId),
    );

    return Object.freeze({
      implementation: byTaskId.get(implementationTaskId)!.entry,
      qualityGate: qualityGateRow.entry,
      ordered: Object.freeze(orderedRows.map((row) => row.entry)),
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
