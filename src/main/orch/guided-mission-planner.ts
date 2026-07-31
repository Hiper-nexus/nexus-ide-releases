import type { Mission, Squad } from "../../shared/orch-types";
import {
  classifyStandardMissionTopology,
  TEAM_READ_ONLY_FANOUT_DOMAIN,
  type StandardMissionTopology,
} from "../../shared/mission-topology";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  authReadyModelsForProvider,
  isCredentiallessOpenCodeModel,
} from "../adapters/model-auth-readiness";
import { listAdapterInfos } from "../adapters/adapter-registry";
import { hasAvailableAccount } from "../persistence/account-store";
import { listProviderSettings } from "../persistence/provider-config-store";
import { getOrchSettings } from "../persistence/settings-store";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import {
  assertExactRosterRoutes,
  assertGuidedPlanTaskDetailBudgets,
  assertRosterCompleteGuidedTeamFanoutReceipt,
  assertRosterCompleteGuidedV2Receipt,
  chooseCorrectiveQualityGate,
  choosePrimaryExecutor,
  guidedPlanEligibility,
  isGuidedWorkerAgent,
  taskIdFromPlan,
  type GuidedPlanTaskDetailInput,
} from "./guided-mission-plan-authority";
import {
  listRepositoryOwnershipClaims,
  resolveGuidedMutationOwnership,
} from "./guided-mission-ownership";
import {
  buildGuidedMissionTaskDetail,
  guidedAdvisoryDetail,
  guidedAdvisoryExecutionMode,
  guidedFanoutPlannerId,
  guidedIndependentReviewDetail,
  guidedQualityGateDetail,
  guidedTeamCoordinationDetail,
} from "./guided-mission-prompt";
import {
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
  GUIDED_TASK_DOMAINS,
} from "./guided-task-kind";
import {
  sealMainOwnedMissionTaskPlan,
  type MissionTaskPlanAuthorityDeps,
} from "./mission-task-plan-authority";
import { standardTopologyFromSealedTaskDetails } from "./guided-mission-topology-authority";
import type { LiveRosterAdapter } from "./mission-scheduler-plan";
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { assertLiveGuidedSquadReadiness } from "./squad-runtime-inventory";
import { getSquad } from "./squad-store";
import { snapshotTaskPlanRoster } from "./task-store";

export {
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
} from "./guided-task-kind";
export {
  addApprovedIntentOwnershipClaims,
  approvedIntentOwnershipClaims,
  GUIDED_GREENFIELD_OWNERSHIP,
  listRepositoryOwnershipClaims,
  ownershipLooksRepoWide,
  repositoryOwnershipClaimsFromGitTree,
  resolveGuidedMutationOwnership,
} from "./guided-mission-ownership";
export {
  buildGuidedMissionTaskDetail,
  buildGuidedPromotedPlanContext,
} from "./guided-mission-prompt";

export const GUIDED_ISOLATED_ADVISORY_DOMAIN =
  GUIDED_TASK_DOMAINS.isolatedAdvisory;

const EXPLICIT_QA_READ_ONLY =
  /\bqa\b[^.!?\n]{0,200}(?:somente\s+leitura|read[- ]only|n[aã]o\s+(?:deve\s+)?(?:editar|alterar|modificar|escrever)|must\s+not\s+(?:edit|modify|write))/i;

export function approvedIntentRequiresReadOnlyQualityGate(
  mission: Pick<Mission, "intentContract">,
): boolean {
  const contract = mission.intentContract;
  if (!contract) return false;
  return EXPLICIT_QA_READ_ONLY.test(
    [contract.goal, ...contract.acceptanceCriteria].join("\n"),
  );
}

export interface GuidedMissionPlannerDeps extends MissionTaskPlanAuthorityDeps {
  readonly listLiveAdapters: () => readonly LiveRosterAdapter[];
  readonly listRepositoryOwnership: (
    scope: ProjectExecutionScope,
  ) => readonly string[];
  readonly assertStandardSquadReadiness: (squad: Squad) => void;
}

export type GuidedMissionPlanResult =
  | Readonly<{
      applicable: false;
      sealed: false;
      reason:
        "lane-not-standard" | "automation-owned" | "squad-not-engine-generated";
    }>
  | Readonly<{
      applicable: true;
      sealed: false;
      reason: "already-sealed";
      topology: StandardMissionTopology;
      workerAgentRef: string;
      taskId: string;
    }>
  | Readonly<{
      applicable: true;
      sealed: true;
      reason: "sealed";
      topology: StandardMissionTopology;
      workerAgentRef: string;
      taskId: string;
    }>;

export function guidedLiveRosterAdapter(input: {
  readonly provider: {
    readonly adapterId: string;
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly authStrategy: string;
    readonly models: readonly string[];
    readonly defaultModel: string;
  };
  readonly accountAvailable: boolean;
}): LiveRosterAdapter {
  const authReadyModels = authReadyModelsForProvider(
    input.provider,
    input.provider.models,
  );
  const readyModels = input.accountAvailable
    ? authReadyModels
    : authReadyModels.filter((model) =>
        isCredentiallessOpenCodeModel(input.provider.adapterId, model),
      );
  return {
    id: input.provider.adapterId,
    installed:
      input.provider.enabled &&
      input.provider.installed &&
      readyModels.length > 0,
    models: {
      list: [...readyModels],
      // Preserve the exact provider default. If it is not auth-ready, route
      // sealing fails closed instead of silently substituting another model.
      default: input.provider.defaultModel,
    },
  };
}

function productionLiveAdapters(): readonly LiveRosterAdapter[] {
  return listProviderSettings()
    .filter((provider) => provider.adapterId !== "shell")
    .map((provider) =>
      guidedLiveRosterAdapter({
        provider,
        accountAvailable: hasAvailableAccount(provider.adapterId),
      }),
    );
}

const DEFAULT_DEPS: GuidedMissionPlannerDeps = Object.freeze({
  getSquad: (squadId: string) => getSquad(squadId),
  getAdapterInfo: (adapterId: string) =>
    listAdapterInfos().find((adapter) => adapter.id === adapterId) ?? null,
  listMissionWorktrees: (scope: ProjectExecutionScope, missionId: string) =>
    requireWorktreeRuntimeRegistry().listMission(scope, missionId),
  squadCliPolicy: () => getOrchSettings().squadCliPolicy,
  listLiveAdapters: productionLiveAdapters,
  listRepositoryOwnership: listRepositoryOwnershipClaims,
  assertStandardSquadReadiness: assertLiveGuidedSquadReadiness,
});

/**
 * Deterministic Guided Planner v2 for the beginner path.
 *
 * It seals a roster-complete delivery graph after approval and before
 * orchestrator bootstrap: non-mutating discovery/advisory identities (parallel
 * when read_only), exactly one mutation-owning executor with intent-scoped
 * ownership, independent reviewers after implementation, then one corrective
 * QA gate. Mutation ownership is a bounded, explicit projection of the
 * repository inventory plus any new paths named by the approved intent. This
 * lets ordinary goals such as "corrija este fluxo" start without requiring the
 * operator to guess filenames, while still excluding Git/Nexus authority
 * paths and root wildcards. Worker materialization remains scheduler-owned and
 * cannot occur until the real kickoff acceptance receipt exists.
 */
export function ensureGuidedMissionPlan(
  suite: Pick<ProjectDomainStoreSuite, "missions" | "tasks">,
  missionId: string,
  deps: GuidedMissionPlannerDeps = DEFAULT_DEPS,
): GuidedMissionPlanResult {
  const mission = suite.missions.get(missionId);
  if (!mission?.intentContract) {
    throw new Error(
      "guided_plan_contract_missing: missão aprovada não encontrada",
    );
  }
  const intentVersion = mission.intentContract.intentVersion;
  const existing = suite.tasks.listPlannedTasks(missionId, intentVersion);
  const existingTopology =
    existing.length > 0
      ? standardTopologyFromSealedTaskDetails(
          existing.map(
            (entry) => entry.task?.detail ?? entry.plannedDetail ?? "",
          ),
        )
      : undefined;
  if (existingTopology === "invalid") {
    throw new Error(
      "guided_plan_mixed_topology_blocked: o receipt selado mistura " +
        "delivery e team-read-only-fanout; replaneje e reaprove a missão " +
        "antes de iniciar qualquer provider",
    );
  }
  const ineligible = guidedPlanEligibility(mission, {
    hasExistingPlan: existing.length > 0,
    existingTopology,
    resolveSquad: deps.getSquad,
  });
  if (ineligible) {
    return Object.freeze({
      applicable: false,
      sealed: false,
      reason: ineligible,
    });
  }
  if (!mission.squadId) {
    throw new Error("guided_plan_squad_missing: missão sem squad aprovado");
  }
  const squad = deps.getSquad(mission.squadId);
  if (!squad) {
    throw new Error("guided_plan_squad_missing: squad aprovado indisponível");
  }
  const squadSnapshot = snapshotSquadAuthority(squad);
  if (mission.intentContract.squadRevisionHash !== squadSnapshot.hash) {
    throw new Error(
      "guided_plan_squad_stale: o squad mudou depois da aprovação",
    );
  }
  if (existing.length > 0) {
    const topology = existingTopology ?? "delivery";
    // Recovery derives authority from the immutable receipt, never from a
    // fresh interpretation of goal text. This prevents a classifier update
    // from invalidating a delivery that was already approved and sealed.
    if (topology === "delivery") deps.assertStandardSquadReadiness(squad);
    // Never rewrite an immutable current receipt. Recovery may reuse only the
    // exact roster-complete Guided v2 graph; older valid receipts remain
    // blocked until the operator reapproves a fresh intent/plan.
    const recovered =
      topology === "team-read-only-fanout"
        ? assertRosterCompleteGuidedTeamFanoutReceipt(existing, squad)
        : assertRosterCompleteGuidedV2Receipt(existing, squad);
    const primary =
      "primary" in recovered ? recovered.primary : recovered.implementation;
    return Object.freeze({
      applicable: true,
      sealed: false,
      reason: "already-sealed",
      topology,
      workerAgentRef: primary.agentRef,
      taskId: primary.taskId,
    });
  }
  const topology: StandardMissionTopology =
    mission.intentContract.promotedPlan
      ? "delivery"
      : classifyStandardMissionTopology(mission.intentContract.goal);
  // New plans may use the fast classifier as a proposal. Once sealed, the
  // task receipt above is the sole topology authority across restarts.
  if (topology === "delivery") deps.assertStandardSquadReadiness(squad);
  const adapters = deps.listLiveAdapters();
  const rosterWorkers = squad.agents.filter(isGuidedWorkerAgent);
  const taskPlanRosterHash = snapshotTaskPlanRoster(squad.agents).hash;
  if (rosterWorkers.length > 64) {
    throw new Error(
      "guided_plan_roster_too_large: o plano suporta no máximo 64 workers aprovados",
    );
  }
  if (
    topology === "team-read-only-fanout" &&
    rosterWorkers.length === 0
  ) {
    throw new Error(
      "guided_team_fanout_empty: squad aprovado não possui workers",
    );
  }
  assertExactRosterRoutes({
    mission,
    workers: rosterWorkers,
    adapters,
    rosterHash: taskPlanRosterHash,
    orchestratorCliId: squad.agents.find(
      (agent) => agent.category === "orchestrator",
    )?.cli,
  });
  if (topology === "team-read-only-fanout") {
    const coordinationTasks: GuidedPlanTaskDetailInput[] = rosterWorkers.map(
      (agent, index) => ({
        id: guidedFanoutPlannerId(
          agent.category === "reviewer" ? "review" : "advisory",
          agent,
          index,
        ),
        title: `Responder com ${agent.agentName}: ${mission.title}`.slice(
          0,
          1_024,
        ),
        detail: guidedTeamCoordinationDetail(mission, agent),
        agentRef: agent.id,
        category: agent.category,
        executionMode: "read_only",
        ownership: {
          files: [],
          symbols: [],
          domains: [
            agent.category === "reviewer"
              ? GUIDED_TASK_DOMAINS.independentReview
              : GUIDED_TASK_DOMAINS.advisory,
            TEAM_READ_ONLY_FANOUT_DOMAIN,
          ],
        },
        dependsOn: [],
      }),
    );
    assertGuidedPlanTaskDetailBudgets({
      missionId,
      intentVersion,
      tasks: coordinationTasks,
    });
    const plan = sealMainOwnedMissionTaskPlan(
      { missionId, tasks: coordinationTasks },
      suite.tasks.scope,
      suite,
      deps,
      mission.status === "pending" &&
        mission.intentState === "ready_to_start" &&
        typeof mission.intentContract.approvedAt === "number"
        ? {
            kind: "approved-preflight",
            intentVersion,
            approvedAt: mission.intentContract.approvedAt,
            approvalReviewSha256:
              mission.intentContract.approvalReviewSha256,
          }
        : undefined,
    );
    const primary = plan.planned[0]!;
    return Object.freeze({
      applicable: true,
      sealed: true,
      reason: "sealed",
      topology,
      workerAgentRef: primary.agentRef,
      taskId: primary.taskId,
    });
  }
  const operatorChoice =
    deps.squadCliPolicy() === "operator-choice";
  const worker = choosePrimaryExecutor(squad, operatorChoice);
  const qualityGate = chooseCorrectiveQualityGate(
    squad,
    worker,
    operatorChoice,
  );
  const qualityGateReadOnly =
    approvedIntentRequiresReadOnlyQualityGate(mission);
  const advisoryAgents = rosterWorkers.filter(
    (agent) =>
      agent.id !== worker.id &&
      (agent.category === "executor" ||
        agent.category === "scout" ||
        agent.category === "architect"),
  );
  const independentReviewers = rosterWorkers.filter(
    (agent) => agent.category === "reviewer" && agent.id !== qualityGate.id,
  );
  const intentOwnership = resolveGuidedMutationOwnership(
    mission.intentContract,
  );
  // A filename-aware goal keeps the narrow intent surface. Natural goals do
  // not force a vibe coder to guess the repository layout: Main derives a
  // bounded, path-by-path inventory for the isolated worktree instead.
  const ownershipFiles =
    intentOwnership.length > 0
      ? intentOwnership
      : resolveGuidedMutationOwnership(
          mission.intentContract,
          deps.listRepositoryOwnership(suite.tasks.scope),
        );
  if (ownershipFiles.length === 0) {
    throw new Error(
      "guided_plan_ownership_missing: o inventário seguro do projeto está vazio",
    );
  }
  const advisoryTasks = advisoryAgents.map((agent, index) => {
    const executionMode = guidedAdvisoryExecutionMode(agent);
    const isolated = executionMode === "isolated_worktree";
    return {
      id: guidedFanoutPlannerId("advisory", agent, index),
      title: `Mapear com ${agent.agentName}: ${mission.title}`.slice(0, 1_024),
      detail: guidedAdvisoryDetail(mission, agent),
      agentRef: agent.id,
      category: agent.category,
      executionMode,
      ownership: {
        // read_only advisors: empty files + kind domain → parallel-safe.
        // isolated advisors share mutation surface but take exclusive slot.
        files: isolated ? [...ownershipFiles] : [],
        symbols: [],
        domains: isolated
          ? [GUIDED_ISOLATED_ADVISORY_DOMAIN, "sequential-only"]
          : [GUIDED_TASK_DOMAINS.advisory],
      },
      dependsOn: [],
    };
  });
  const independentReviewTasks = independentReviewers.map((agent, index) => {
    const executionMode = guidedAdvisoryExecutionMode(agent);
    const isolated = executionMode === "isolated_worktree";
    return {
      id: guidedFanoutPlannerId("review", agent, index),
      title: `Revisar com ${agent.agentName}: ${mission.title}`.slice(0, 1_024),
      detail: guidedIndependentReviewDetail(mission, agent, {
        qualityGateReadOnly,
      }),
      agentRef: agent.id,
      category: "reviewer" as const,
      executionMode,
      ownership: {
        files: isolated ? [...ownershipFiles] : [],
        symbols: [],
        domains: isolated
          ? [GUIDED_ISOLATED_ADVISORY_DOMAIN, "sequential-only"]
          : [GUIDED_TASK_DOMAINS.independentReview],
      },
      dependsOn:
        index > 0
          ? [
              guidedFanoutPlannerId(
                "review",
                independentReviewers[index - 1]!,
                index - 1,
              ),
            ]
          : [GUIDED_MISSION_PLANNER_TASK_ID],
    };
  });
  // Implementation does not wait on advisories — tip/discovery is parallel.
  const qualityGateDependencies =
    independentReviewTasks.length > 0
      ? [independentReviewTasks[independentReviewTasks.length - 1]!.id]
      : [GUIDED_MISSION_PLANNER_TASK_ID];
  const guidedTasks: GuidedPlanTaskDetailInput[] = [
    ...advisoryTasks,
    {
      id: GUIDED_MISSION_PLANNER_TASK_ID,
      title: `Entregar: ${mission.title}`.slice(0, 1_024),
      detail: buildGuidedMissionTaskDetail(mission),
      agentRef: worker.id,
      category: "executor",
      executionMode: "isolated_worktree",
      ownership: {
        files: [...ownershipFiles],
        symbols: [],
        domains: [GUIDED_TASK_DOMAINS.implementation],
      },
      dependsOn: [],
    },
    ...independentReviewTasks,
    {
      id: GUIDED_MISSION_QA_TASK_ID,
      title: `Validar e endurecer: ${mission.title}`.slice(0, 1_024),
      detail: guidedQualityGateDetail(mission, {
        readOnly: qualityGateReadOnly,
      }),
      agentRef: qualityGate.id,
      category: "reviewer",
      executionMode: qualityGateReadOnly
        ? "read_only"
        : "isolated_worktree",
      ownership: {
        files: qualityGateReadOnly ? [] : [...ownershipFiles],
        symbols: [],
        // Gate is exclusive even when read_only/empty so unfinished tip
        // advisories cannot share a wave with the final QA pass.
        domains: [GUIDED_TASK_DOMAINS.qualityGate, "sequential-only"],
      },
      dependsOn: qualityGateDependencies,
    },
  ];
  assertGuidedPlanTaskDetailBudgets({
    missionId,
    intentVersion,
    tasks: guidedTasks,
  });
  const plan = sealMainOwnedMissionTaskPlan(
    {
      missionId,
      tasks: guidedTasks,
    },
    suite.tasks.scope,
    suite,
    deps,
    mission.status === "pending" &&
      mission.intentState === "ready_to_start" &&
      typeof mission.intentContract.approvedAt === "number"
      ? {
          kind: "approved-preflight",
          intentVersion,
          approvedAt: mission.intentContract.approvedAt,
          approvalReviewSha256:
            mission.intentContract.approvalReviewSha256,
        }
      : undefined,
  );
  return Object.freeze({
    applicable: true,
    sealed: true,
    reason: "sealed",
    topology,
    workerAgentRef: worker.id,
    taskId: taskIdFromPlan(plan),
  });
}

/** Production scope boundary injected into approval/bootstrap orchestration. */
export function ensureGuidedMissionPlanForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): GuidedMissionPlanResult {
  return ensureGuidedMissionPlan(
    getProjectDomainStores(scope),
    missionId,
    DEFAULT_DEPS,
  );
}
