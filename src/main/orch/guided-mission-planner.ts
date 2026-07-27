import type { Mission, Squad } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  authReadyModelsForProvider,
  isCredentiallessOpenCodeModel,
} from "../adapters/model-auth-readiness";
import { listAdapterInfos } from "../adapters/adapter-registry";
import { hasAvailableAccount } from "../persistence/account-store";
import { listProviderSettings } from "../persistence/provider-config-store";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import {
  assertExactRosterRoutes,
  assertGuidedPlanTaskDetailBudgets,
  assertRosterCompleteGuidedV2Receipt,
  chooseCorrectiveQualityGate,
  choosePrimaryExecutor,
  guidedPlanEligibility,
  isGuidedWorkerAgent,
  taskIdFromPlan,
  type GuidedPlanTaskDetailInput,
} from "./guided-mission-plan-authority";
import {
  addApprovedIntentOwnershipClaims,
  listRepositoryOwnershipClaims,
} from "./guided-mission-ownership";
import {
  buildGuidedMissionTaskDetail,
  guidedAdvisoryDetail,
  guidedAdvisoryExecutionMode,
  guidedFanoutPlannerId,
  guidedIndependentReviewDetail,
  guidedQualityGateDetail,
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
  repositoryOwnershipClaimsFromGitTree,
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
      workerAgentRef: string;
      taskId: string;
    }>
  | Readonly<{
      applicable: true;
      sealed: true;
      reason: "sealed";
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
  listLiveAdapters: productionLiveAdapters,
  listRepositoryOwnership: listRepositoryOwnershipClaims,
  assertStandardSquadReadiness: assertLiveGuidedSquadReadiness,
});

/**
 * Deterministic Guided Planner v2 for the beginner path.
 *
 * It seals a roster-complete, sequential delivery graph after approval and
 * before orchestrator bootstrap: non-mutating discovery/advisory identities,
 * exactly one mutation-owning executor, independent non-mutating reviewers,
 * then one corrective QA gate. Every approved non-orchestrator identity
 * receives a task. The live roster is revalidated before sealing, so only
 * identities backed by a mechanically qualified guided runtime enter this
 * graph. Read-only identities use native confinement; mutation owners use
 * disposable isolated worktrees. Worker materialization remains
 * scheduler-owned and cannot occur until the real kickoff acceptance receipt
 * exists.
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
  const ineligible = guidedPlanEligibility(mission);
  if (ineligible) {
    return Object.freeze({
      applicable: false,
      sealed: false,
      reason: ineligible,
    });
  }
  const intentVersion = mission.intentContract.intentVersion;
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
  // Recovery is an authority boundary too. Old app versions could persist an
  // engine-generated squad containing a direct/legacy CLI such as Aider. It
  // must not be allowed into a scheduler that waits for physical MCP receipts,
  // even when an older task-plan row already exists.
  deps.assertStandardSquadReadiness(squad);
  const existing = suite.tasks.listPlannedTasks(missionId, intentVersion);
  if (existing.length > 0) {
    // Never rewrite an immutable current receipt. Recovery may reuse only the
    // exact roster-complete Guided v2 graph; older valid receipts remain
    // blocked until the operator reapproves a fresh intent/plan.
    const recovered = assertRosterCompleteGuidedV2Receipt(existing, squad);
    return Object.freeze({
      applicable: true,
      sealed: false,
      reason: "already-sealed",
      workerAgentRef: recovered.implementation.agentRef,
      taskId: recovered.implementation.taskId,
    });
  }
  const adapters = deps.listLiveAdapters();
  const rosterWorkers = squad.agents.filter(isGuidedWorkerAgent);
  const taskPlanRosterHash = snapshotTaskPlanRoster(squad.agents).hash;
  if (rosterWorkers.length > 64) {
    throw new Error(
      "guided_plan_roster_too_large: o plano suporta no máximo 64 workers aprovados",
    );
  }
  const worker = choosePrimaryExecutor(squad);
  const qualityGate = chooseCorrectiveQualityGate(squad, worker);
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
  assertExactRosterRoutes({
    mission,
    workers: rosterWorkers,
    adapters,
    rosterHash: taskPlanRosterHash,
  });
  const ownershipFiles = addApprovedIntentOwnershipClaims(
    deps.listRepositoryOwnership(suite.tasks.scope),
    mission.intentContract,
  );
  if (ownershipFiles.length === 0) {
    throw new Error(
      "guided_plan_ownership_missing: nenhum caminho explícito pôde ser selado",
    );
  }
  const advisoryTasks = advisoryAgents.map((agent, index) => {
    const executionMode = guidedAdvisoryExecutionMode(agent);
    return {
      id: guidedFanoutPlannerId("advisory", agent, index),
      title: `Mapear com ${agent.agentName}: ${mission.title}`.slice(0, 1_024),
      detail: guidedAdvisoryDetail(mission, agent),
      agentRef: agent.id,
      category: agent.category,
      executionMode,
      ownership: {
        files: [...ownershipFiles],
        symbols: [],
        domains: [
          executionMode === "read_only"
            ? GUIDED_TASK_DOMAINS.advisory
            : GUIDED_ISOLATED_ADVISORY_DOMAIN,
          "sequential-only",
        ],
      },
      dependsOn:
        index > 0
          ? [
              guidedFanoutPlannerId(
                "advisory",
                advisoryAgents[index - 1]!,
                index - 1,
              ),
            ]
          : [],
    };
  });
  const independentReviewTasks = independentReviewers.map((agent, index) => {
    const executionMode = guidedAdvisoryExecutionMode(agent);
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
        files: [...ownershipFiles],
        symbols: [],
        domains: [
          executionMode === "read_only"
            ? GUIDED_TASK_DOMAINS.independentReview
            : GUIDED_ISOLATED_ADVISORY_DOMAIN,
          "sequential-only",
        ],
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
  const primaryDependencies =
    advisoryTasks.length > 0
      ? [advisoryTasks[advisoryTasks.length - 1]!.id]
      : [];
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
        domains: [GUIDED_TASK_DOMAINS.implementation, "sequential-only"],
      },
      dependsOn: primaryDependencies,
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
        files: [...ownershipFiles],
        symbols: [],
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
