import type { Mission, Squad } from "../../shared/orch-types";
import { partitionOwnershipIntoAreas } from "./repository-area-partition";
import type { MissionIntentContract } from "../../shared/mission-intent";
import { FEATURE_FLAG_IDS } from "../../shared/feature-flags";
import { getFeatureFlagRegistry } from "../feature-flags/feature-flag-registry";
import {
  classifyStandardMissionTopology,
  TEAM_READ_ONLY_FANOUT_DOMAIN,
  type StandardMissionTopology,
} from "../../shared/mission-topology";
import {
  decomposeGoalByRepositoryAreas,
  extractStoryOwnershipFiles,
  decomposeGuidedGoalIntoStories,
  planWavePackTasks,
  resolveMissionOrchestrationMode,
  resolveWavePackStories,
  topologyForOrchestrationMode,
  type ExtractedWavePackStory,
} from "../../shared/mission-wave-pack";
import { emitGuidedFanoutSerialized } from "./mission-event-emit";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  authReadyModelsForProvider,
  isCredentiallessOpenCodeModel,
} from "../adapters/model-auth-readiness";
import { listAdapterInfos } from "../adapters/adapter-registry";
import { hasAvailableAccount } from "../persistence/account-store";
import { listProviderSettings } from "../persistence/provider-config-store";
import { getOrchSettings } from "../persistence/settings-store";
import { OWNERSHIP_COVERAGE_DOMAIN } from "../runtime/worktree-contract";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import {
  assertExactRosterRoutes,
  assertGuidedPlanTaskDetailBudgets,
  assertRosterCompleteGuidedTeamFanoutReceipt,
  assertRosterCompleteGuidedV2Receipt,
  assertRosterCompleteGuidedWavePackReceipt,
  chooseCorrectiveQualityGate,
  choosePrimaryExecutor,
  guidedPlanEligibility,
  isGuidedWorkerAgent,
  taskIdFromPlan,
  type GuidedPlanTaskDetailInput,
} from "./guided-mission-plan-authority";
import {
  listRepositoryOwnershipClaims,
  repositoryOwnershipClaimsFromGitTree,
  resolveGuidedMutationOwnership,
} from "./guided-mission-ownership";
import {
  appendMissionDegradationNote,
  describeMissionDegradation,
  type MissionDegradation,
} from "./mission-degradation";
import { NEXUS_STORY_IMPLEMENTATION_SQUAD_ID } from "../../shared/builtin-squad-ids";
import { BUILTIN_SQUADS } from "./builtin-squads";
import {
  buildGuidedMissionTaskDetail,
  guidedAdvisoryDetail,
  guidedAdvisoryExecutionMode,
  guidedFanoutPlannerId,
  guidedIndependentReviewDetail,
  guidedQualityGateDetail,
  guidedRegressionDetail,
  guidedReproductionDetail,
  guidedTeamCoordinationDetail,
  guidedWarmupDetail,
  type GuidedWorkKindContractOptions,
} from "./guided-mission-prompt";
import {
  documentOwnershipFence,
  planGuidedWorkGraph,
} from "./guided-mission-work-graph";
import {
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
  GUIDED_MISSION_REGRESSION_TASK_ID,
  GUIDED_MISSION_REPRODUCTION_TASK_ID,
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
        | "lane-not-standard"
        | "automation-owned"
        | "squad-not-engine-generated"
        | "orchestration-livre";
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
  type MissionWithIntent = Mission & {
    intentContract: NonNullable<Mission["intentContract"]>;
  };
  const asMissionWithIntent = (value: Mission | null | undefined): MissionWithIntent => {
    if (!value?.intentContract) {
      throw new Error(
        "guided_plan_contract_missing: missão sumiu após rebind D1",
      );
    }
    return value as MissionWithIntent;
  };
  const loadedMission = suite.missions.get(missionId);
  if (!loadedMission?.intentContract) {
    throw new Error(
      "guided_plan_contract_missing: missão aprovada não encontrada",
    );
  }
  // Keep a mutable Mission view; after re-pin we re-read from the store so
  // ScopedMission coordinates stay consistent with the suite.
  let mission: MissionWithIntent = loadedMission as MissionWithIntent;
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
        "delivery, team-read-only-fanout e wave-pack; replaneje e reaprove a missão " +
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
  // D1: squad missing/stale/unbound → live default roster, never a silent wall.
  const planDegradations: MissionDegradation[] = [];
  /** Structured signal — never string-match degradation.what for control flow. */
  let squadAuthorityDegraded = false;
  const recordSquadDegradation = (degradation: MissionDegradation): void => {
    squadAuthorityDegraded = true;
    planDegradations.push(degradation);
  };

  const patchMission = (
    patch: {
      readonly squadId?: string;
      readonly description?: string;
      readonly intentContract?: Mission["intentContract"];
    },
  ): NonNullable<ReturnType<typeof suite.missions.get>> | null => {
    const current = suite.missions.get(missionId);
    if (!current) return null;
    const updater = (
      suite.missions as {
        update?: (
          id: string,
          next: Record<string, unknown>,
        ) => NonNullable<ReturnType<typeof suite.missions.get>> | null;
      }
    ).update;
    if (typeof updater === "function") {
      return updater.call(suite.missions, missionId, patch) ?? null;
    }
    // Test harnesses expose only get() — mutate the live object in place.
    if (patch.squadId !== undefined) {
      (current as { squadId?: string }).squadId = patch.squadId;
    }
    if (patch.description !== undefined) {
      (current as { description: string }).description = patch.description;
    }
    if (patch.intentContract !== undefined) {
      (current as { intentContract?: Mission["intentContract"] }).intentContract =
        patch.intentContract;
    }
    return current;
  };
  const resolveDefaultSquad = (): Squad | null => {
    return (
      deps.getSquad(NEXUS_STORY_IMPLEMENTATION_SQUAD_ID) ??
      BUILTIN_SQUADS.find(
        (entry) => entry.id === NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
      ) ??
      null
    );
  };
  let squad: Squad;
  if (!mission.squadId) {
    const fallback = resolveDefaultSquad();
    if (!fallback) {
      throw new Error(
        "guided_plan_squad_missing: missão sem squad e roster padrão indisponível",
      );
    }
    squad = fallback;
    patchMission({ squadId: fallback.id });
    recordSquadDegradation({
      what: "squad da missão",
      reducedTo: `${fallback.id} (roster padrão)`,
      why: "missão sem squad aprovado",
      recoverable: true,
    });
  } else {
    const found = deps.getSquad(mission.squadId);
    if (!found) {
      const fallback = resolveDefaultSquad();
      if (!fallback) {
        throw new Error(
          "guided_plan_squad_missing: squad aprovado indisponível e roster padrão ausente",
        );
      }
      squad = fallback;
      patchMission({ squadId: fallback.id });
      recordSquadDegradation({
        what: "squad da missão",
        reducedTo: `${fallback.id} (roster padrão)`,
        why: "squad aprovado indisponível no catálogo",
        recoverable: true,
      });
    } else {
      squad = found;
    }
  }
  let squadSnapshot = snapshotSquadAuthority(squad);
  const boundSquadRevision = mission.intentContract.squadRevisionHash;
  if (boundSquadRevision === undefined) {
    recordSquadDegradation({
      what: "vínculo de revisão do squad",
      reducedTo: "roster vivo atual",
      why: "intenção sem squadRevisionHash selado",
      recoverable: true,
    });
  } else if (boundSquadRevision !== squadSnapshot.hash) {
    recordSquadDegradation({
      what: "revisão do squad",
      reducedTo: "roster vivo atual",
      why: "o squad mudou depois da aprovação",
      recoverable: true,
    });
  }
  // Re-pin live squad revision so seal authority accepts the D1 roster
  // without inventing a second approval ceremony.
  if (
    mission.intentContract.squadRevisionHash !== squadSnapshot.hash ||
    mission.squadId !== squad.id
  ) {
    const pinned = patchMission({
      squadId: squad.id,
      intentContract: {
        ...mission.intentContract,
        squadRevisionHash: squadSnapshot.hash,
      },
    });
    if (pinned) {
      // Prefer a fresh store read so scope coordinates stay coherent.
      mission = asMissionWithIntent(suite.missions.get(missionId) ?? pinned);
      squadSnapshot = snapshotSquadAuthority(squad);
    } else {
      mission = asMissionWithIntent(suite.missions.get(missionId) ?? mission);
    }
  }
  const publishPlanDegradations = (): void => {
    if (planDegradations.length === 0) return;
    const current = suite.missions.get(missionId);
    if (!current) return;
    // One marker, all reasons — appendMissionVerdict alone would keep only the first.
    const reason = planDegradations
      .map((degradation) => describeMissionDegradation(degradation))
      .join(" | ");
    patchMission({
      description: appendMissionDegradationNote(
        current.description ?? "",
        reason,
      ),
    });
  };
  if (existing.length > 0) {
    const topology = existingTopology ?? "delivery";
    // Recovery derives authority from the immutable receipt, never from a
    // fresh interpretation of goal text. This prevents a classifier update
    // from invalidating a delivery that was already approved and sealed.
    const liveRosterHash = snapshotTaskPlanRoster(squad.agents).hash;
    const receiptMatchesLive = existing.every(
      (entry) =>
        entry.squadId === squad.id && entry.rosterHash === liveRosterHash,
    );
    // D1 only when THIS call already degraded for live squad drift
    // (missing/stale/unbound/re-pin). A corrupt receipt against a stable live
    // roster still falls through to assertRosterComplete* (legacy wall).
    if (!receiptMatchesLive && squadAuthorityDegraded) {
      const primary =
        existing.find(
          (entry) => entry.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
        ) ??
        existing.find((entry) => entry.agentCategory === "executor") ??
        existing[0]!;
      publishPlanDegradations();
      return Object.freeze({
        applicable: true,
        sealed: false,
        reason: "already-sealed" as const,
        topology,
        workerAgentRef: primary.agentRef,
        taskId: primary.taskId,
      });
    }
    if (topology === "delivery" || topology === "wave-pack") {
      deps.assertStandardSquadReadiness(squad);
    }
    // Never rewrite an immutable current receipt. Recovery may reuse only the
    // exact roster-complete Guided v2 graph; older valid receipts remain
    // blocked until the operator reapproves a fresh intent/plan.
    const recovered =
      topology === "team-read-only-fanout"
        ? assertRosterCompleteGuidedTeamFanoutReceipt(existing, squad)
        : topology === "wave-pack"
          ? assertRosterCompleteGuidedWavePackReceipt(existing, squad)
          : assertRosterCompleteGuidedV2Receipt(existing, squad);
    const primary =
      "implementation" in recovered
        ? recovered.implementation
        : recovered.primary;
    publishPlanDegradations();
    return Object.freeze({
      applicable: true,
      sealed: false,
      reason: "already-sealed",
      topology,
      workerAgentRef: primary.agentRef,
      taskId: primary.taskId,
    });
  }
  // prong (b) na ponta viva: o inventário do repositório, particionado em áreas
  // disjuntas, é o que permite um objetivo livre nascer com N raízes em vez de
  // 1. Falha de leitura nunca inventa leque — cai no comportamento anterior.
  // Leitura do inventário PREGUIÇOSA e memoizada: uma varredura por plano, e
  // NENHUMA quando o objetivo já declara os próprios alvos (aí nem áreas nem
  // baseOwnership derivado são necessários). Ambos os desperdícios — ler duas
  // vezes e ler à toa — foram pegos pela regressão.
  let inventoryCache: readonly string[] | null = null;
  const repositoryInventory = (): readonly string[] => {
    if (inventoryCache !== null) return inventoryCache;
    try {
      inventoryCache = deps.listRepositoryOwnership(suite.tasks.scope);
    } catch {
      inventoryCache = repositoryOwnershipClaimsFromGitTree([]);
      planDegradations.push({
        what: "inventário do projeto",
        reducedTo: "superfície greenfield padrão (escritor único)",
        why: "não consegui mapear o repositório ao vivo",
        recoverable: true,
      });
    }
    return inventoryCache;
  };
  const repositoryAreas = () => partitionOwnershipIntoAreas(repositoryInventory());
  const sealDecision = resolveGuidedSealTopology(mission, {
    // Só particiona quando o goal NÃO nomeia alvos — resolveGuidedSealTopology
    // dá prioridade aos arquivos citados, então áreas seriam trabalho jogado
    // fora nesse caso.
    lazyAreas: repositoryAreas,
  });
  const topology: StandardMissionTopology = sealDecision.topology;
  // P0-8 visibility: a decomposable NL goal kept single-writer by the narrow
  // destructive valve must surface — never a silent collapse to one executor.
  if (sealDecision.nlFanoutSuppressed === "destructive") {
    emitGuidedFanoutSerialized(suite.tasks.scope, missionId, {
      storyCount: sealDecision.nlFanoutStoryCount,
      reason: "destructive-goal safety valve (single-writer)",
    });
  }
  // New plans may use the fast classifier / Pack resolver as a proposal. Once
  // sealed, the task receipt above is the sole topology authority across
  // restarts.
  if (topology === "delivery" || topology === "wave-pack") {
    deps.assertStandardSquadReadiness(squad);
  }
  const adapters = deps.listLiveAdapters();
  let rosterWorkers = squad.agents.filter(isGuidedWorkerAgent);
  const taskPlanRosterHash = snapshotTaskPlanRoster(squad.agents).hash;
  if (rosterWorkers.length > 64) {
    const dropped = rosterWorkers.length - 64;
    rosterWorkers = rosterWorkers.slice(0, 64);
    planDegradations.push({
      what: "roster aprovado",
      reducedTo: "64 workers (teto do plano)",
      why: `${dropped} assento(s) ficaram de fora do selamento`,
      recoverable: true,
    });
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
    publishPlanDegradations();
    return Object.freeze({
      applicable: true,
      sealed: true,
      reason: "sealed",
      topology,
      workerAgentRef: primary.agentRef,
      taskId: primary.taskId,
    });
  }
  if (topology === "wave-pack") {
    publishPlanDegradations();
    return sealWavePackMissionPlan({
      mission,
      missionId,
      intentVersion,
      squad,
      rosterWorkers,
      suite,
      deps,
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
  // Work kind decides SHAPE (which stages exist and how they are wired); the
  // roster still decides bodies. `unknown` is deliberately the generic path.
  const workGraph = planGuidedWorkGraph({
    goal: mission.intentContract.goal,
    advisors: advisoryAgents,
    reviewers: independentReviewers,
    isReadOnlyCapable: (agent) =>
      guidedAdvisoryExecutionMode(agent) === "read_only",
  });
  const workKindContract: GuidedWorkKindContractOptions = {
    workKind: workGraph.workKind,
    reproductionInContractOnly: workGraph.reproductionInContractOnly,
    regressionInContractOnly: workGraph.regressionInContractOnly,
    // Design contract is resolved from the MAIN root and sealed into the task
    // detail: the isolated worktree is built from a commit and may not carry a
    // contract the bootstrap autopilot just materialized under `.context/`.
    workspaceRoot: suite.tasks.scope.rootRealPath,
  };
  const intentOwnership = resolveGuidedMutationOwnership(
    mission.intentContract,
  );
  // A filename-aware goal keeps the narrow intent surface. Natural goals do
  // not force a vibe coder to guess the repository layout: Main derives a
  // bounded, path-by-path inventory for the isolated worktree instead.
  let baseOwnership =
    intentOwnership.length > 0
      ? intentOwnership
      : resolveGuidedMutationOwnership(
          mission.intentContract,
          repositoryInventory(),
        );
  if (baseOwnership.length === 0) {
    baseOwnership = resolveGuidedMutationOwnership(
      mission.intentContract,
      repositoryOwnershipClaimsFromGitTree([]),
    );
    if (baseOwnership.length > 0) {
      planDegradations.push({
        what: "ownership do plano",
        reducedTo: "superfície greenfield padrão (escritor único)",
        why: "não consegui mapear áreas do projeto",
        recoverable: true,
      });
    }
  }
  if (baseOwnership.length === 0) {
    throw new Error(
      "guided_plan_ownership_missing: o inventário seguro do projeto está vazio",
    );
  }
  // A documentation mission must be mechanically unable to reach code — the
  // plan lane's write fence (PLAN_LANE_WRITABLE_PATHS) generalized.
  const ownershipFiles =
    workGraph.workKind === "doc"
      ? documentOwnershipFence(baseOwnership)
      : baseOwnership;
  // Provenance travels WITH the claim, because only the planner knows it.
  // Intent-derived paths are an assertion about this goal and stay exclusive.
  // Inventory-derived paths are the planner admitting it could not narrow the
  // goal: identical for every mission on the checkout, so enforcing them as
  // exclusive meant a second mission could never reserve a worktree here.
  // They stay the merge permit; they stop being a veto.
  const ownershipCoverageDomains: readonly string[] =
    intentOwnership.length > 0 ? [] : [OWNERSHIP_COVERAGE_DOMAIN];
  const advisoryTasks = workGraph.advisors.map((agent, index) => {
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
          ? [
              GUIDED_ISOLATED_ADVISORY_DOMAIN,
              "sequential-only",
              ...ownershipCoverageDomains,
            ]
          : [GUIDED_TASK_DOMAINS.advisory],
      },
      dependsOn: [],
    };
  });
  // Bug stages are read_only by construction: a defect repair is single-writer,
  // so proving the defect and proving the regression never open a second
  // mutation surface. planGuidedWorkGraph already refused any body that would
  // have to run in an isolated worktree.
  const reproductionTasks: GuidedPlanTaskDetailInput[] =
    workGraph.reproduction
      ? [
          {
            id: GUIDED_MISSION_REPRODUCTION_TASK_ID,
            title: `Reproduzir: ${mission.title}`.slice(0, 1_024),
            detail: guidedReproductionDetail(mission, workGraph.reproduction),
            agentRef: workGraph.reproduction.id,
            category: workGraph.reproduction.category as GuidedPlanTaskDetailInput["category"],
            executionMode: "read_only",
            ownership: {
              files: [],
              symbols: [],
              domains: [GUIDED_TASK_DOMAINS.reproduction],
            },
            dependsOn: [],
          },
        ]
      : [];
  const regressionTasks: GuidedPlanTaskDetailInput[] = workGraph.regression
    ? [
        {
          id: GUIDED_MISSION_REGRESSION_TASK_ID,
          title: `Provar a regressão: ${mission.title}`.slice(0, 1_024),
          detail: guidedRegressionDetail(mission, workGraph.regression),
          agentRef: workGraph.regression.id,
          category: workGraph.regression.category as GuidedPlanTaskDetailInput["category"],
          executionMode: "read_only",
          ownership: {
            files: [],
            symbols: [],
            domains: [GUIDED_TASK_DOMAINS.regression],
          },
          dependsOn: [GUIDED_MISSION_PLANNER_TASK_ID],
        },
      ]
    : [];
  // Independent reviews write nothing and read the SAME integrated HEAD, so
  // they are genuinely independent and run concurrently.
  //
  // "SAME integrated HEAD" is not an assumption of this planner — naming where
  // it is mechanized is part of the claim. It is enforced at the SEAL boundary,
  // not at dispatch: `assertReadOnlyLaneObservationCurrent`
  // (physical-handoff-git.ts, wired in tools-handoff.ts before any receipt
  // state exists) refuses any read_only handoff of a Guided advisory /
  // independent-review / quality-gate lane whose observed `worktreeHeadSha` is
  // not exactly the mission's latest `worktree_integrated` reference. And the
  // fence can never degrade to "no integration to compare against" for these
  // reviewers: `computeReadySet` only releases a task whose dependencies are
  // done AND merged, and `merged` is `dispatch.state === "completed"` — the
  // same transaction that writes the integration receipt. So a reviewer that
  // drifted is refused and re-dispatched onto the integrated tree; divergence
  // is fail-closed, never a silently inconsistent receipt.
  //
  // What is deliberately NOT a pin: the dispatch-time worktree re-anchor
  // (readOnlyWorktreeReanchorEligible, mission-scheduler-dispatch-transaction)
  // is per-reviewer and unserialized, and under a governed squad policy a
  // read_only lane gets no worktree at all — it runs in the operator's
  // checkout, confined read-only by the provider's own profile or by the Nexus
  // kernel sandbox. Both are convergence, so the seal fence is the authority.
  //
  // The exception is a reviewer whose CLI cannot hold a mechanically read-only
  // lane: it must run in an isolated worktree, which takes an exclusive
  // scheduler slot, so those stay chained (making them "parallel" would only
  // produce deferrals plus a receipt that lies about the shape).
  const reviewPivot =
    regressionTasks.length > 0
      ? GUIDED_MISSION_REGRESSION_TASK_ID
      : GUIDED_MISSION_PLANNER_TASK_ID;
  const orderedReviewers = [
    ...workGraph.reviewers.filter(
      (agent) => guidedAdvisoryExecutionMode(agent) === "read_only",
    ),
    ...workGraph.reviewers.filter(
      (agent) => guidedAdvisoryExecutionMode(agent) !== "read_only",
    ),
  ];
  const concurrentReviewCount = orderedReviewers.filter(
    (agent) => guidedAdvisoryExecutionMode(agent) === "read_only",
  ).length;
  const reviewIds = orderedReviewers.map((agent, index) =>
    guidedFanoutPlannerId("review", agent, index),
  );
  const independentReviewTasks = orderedReviewers.map((agent, index) => {
    const executionMode = guidedAdvisoryExecutionMode(agent);
    const isolated = executionMode === "isolated_worktree";
    return {
      id: reviewIds[index]!,
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
          ? [
              GUIDED_ISOLATED_ADVISORY_DOMAIN,
              "sequential-only",
              ...ownershipCoverageDomains,
            ]
          : [GUIDED_TASK_DOMAINS.independentReview],
      },
      dependsOn:
        index > concurrentReviewCount
          ? [reviewIds[index - 1]!]
          : [reviewPivot],
    };
  });
  // Warm-ups put reviewer/QA panes on screen in wave 1: each prepares its
  // checklist read-only while the executor implements. Roots with empty
  // ownership (parallel surface, no exclusive slot), never consumers, never
  // a second mutation surface. Kill-switch: feature.mission.warmupAdvisories.
  const warmupTargets = getFeatureFlagRegistry().isEnabled(
    FEATURE_FLAG_IDS.missionWarmupAdvisories,
  )
    ? [...independentReviewers, qualityGate]
    : [];
  const warmupTasks = warmupTargets.map((agent, index) => ({
    id: guidedFanoutPlannerId("warmup", agent, index),
    title: `Aquecer ${agent.agentName}: ${mission.title}`.slice(0, 1_024),
    detail: guidedWarmupDetail(mission, agent),
    agentRef: agent.id,
    category: "reviewer" as const,
    executionMode: "read_only" as const,
    ownership: {
      files: [],
      symbols: [],
      domains: [GUIDED_TASK_DOMAINS.warmup],
    },
    dependsOn: [],
  }));
  // Implementation does not wait on advisories — tip/discovery is parallel.
  // The gate joins the whole delivery frontier: every concurrent review plus
  // the tail of the sequential chain, or the last delivery stage when the
  // roster produced no independent reviewer at all.
  const concurrentReviewIds = reviewIds.slice(0, concurrentReviewCount);
  const sequentialTailId =
    reviewIds.length > concurrentReviewCount
      ? reviewIds[reviewIds.length - 1]!
      : null;
  const deliveryFrontier = [
    ...concurrentReviewIds,
    ...(sequentialTailId ? [sequentialTailId] : []),
  ];
  const qualityGateDependencies =
    deliveryFrontier.length > 0 ? deliveryFrontier : [reviewPivot];
  const guidedTasks: GuidedPlanTaskDetailInput[] = [
    ...advisoryTasks,
    ...reproductionTasks,
    ...warmupTasks,
    {
      id: GUIDED_MISSION_PLANNER_TASK_ID,
      title: `Entregar: ${mission.title}`.slice(0, 1_024),
      detail: buildGuidedMissionTaskDetail(mission, workKindContract),
      agentRef: worker.id,
      category: "executor",
      // FLIP DO PADRÃO (06/08): a entrega comum é UM escritor por construção —
      // não há com quem colidir, logo não há o que isolar. Nasce no caminho
      // simples: escreve no próprio checkout, sem provisionar worktree e sem
      // cerimônia de merge depois. O fan-out largo (wave-pack, N escritores
      // disjuntos) continua isolado, por escolha e não por padrão.
      // Ver docs/analysis/2026-08-06-refatoracao-execucao-simples.md.
      executionMode: "same_checkout",
      ownership: {
        files: [...ownershipFiles],
        symbols: [],
        domains: [
          GUIDED_TASK_DOMAINS.simpleImplementation,
          ...ownershipCoverageDomains,
        ],
      },
      dependsOn: reproductionTasks.map((task) => task.id),
    },
    ...regressionTasks,
    ...independentReviewTasks,
    {
      id: GUIDED_MISSION_QA_TASK_ID,
      title: `Validar e endurecer: ${mission.title}`.slice(0, 1_024),
      detail: guidedQualityGateDetail(mission, {
        readOnly: qualityGateReadOnly,
        ...workKindContract,
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
        domains: [
          GUIDED_TASK_DOMAINS.qualityGate,
          "sequential-only",
          ...(qualityGateReadOnly ? [] : ownershipCoverageDomains),
        ],
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
  publishPlanDegradations();
  return Object.freeze({
    applicable: true,
    sealed: true,
    reason: "sealed",
    topology,
    workerAgentRef: worker.id,
    taskId: taskIdFromPlan(plan),
  });
}

/**
 * Structured seal-topology decision. `nlFanoutStoryCount` records how many
 * disjoint stories an NL goal decomposed into (0 when not an NL fan-out path);
 * `nlFanoutSuppressed` names the narrow reason the fan-out was kept serial so
 * the caller can surface it — never silently collapse a decomposable plan.
 */
export interface GuidedSealTopologyDecision {
  readonly topology: StandardMissionTopology;
  readonly nlFanoutStoryCount: number;
  readonly nlFanoutSuppressed: null | "destructive";
}

/**
 * Canonical stories for a wave-pack seal: the structured contract stories
 * (Pack template / promoted BMAD) win; otherwise, for a plain NL guided goal
 * with no promoted plan, fall back to the P0-8 per-file decomposition. Both
 * `resolveGuidedSealTopology` and `sealWavePackMissionPlan` route through this
 * one resolver so the routing decision and the sealed unit count never diverge.
 */
function guidedWavePackStories(
  contract: MissionIntentContract,
): readonly ExtractedWavePackStory[] {
  const structured = resolveWavePackStories({
    wavePackStories: contract.wavePackStories,
    promotedPlanSummary: contract.promotedPlan?.summary,
  });
  if (structured.length >= 2) return structured;
  // Promoted-plan missions never fall back to NL text decomposition: their
  // authority is the physical plan handoff, not the raw goal.
  if (contract.promotedPlan) return structured;
  return decomposeGuidedGoalIntoStories({
    goal: contract.goal,
    acceptanceCriteria: contract.acceptanceCriteria,
  });
}

/**
 * P0-8: an NL guided goal whose plan decomposes into N disjoint stories must NOT
 * collapse to a single whole-repo executor. It routes onto the same wave-pack
 * machinery as a promoted/Pack plan. The ONLY thing that keeps such a goal
 * single-writer is the narrow destructive-goal safety valve (risk classified
 * `destructive` by `classifyGoalRisk`) — and that serialization is reported to
 * the caller so it is visible in mission state, never silent.
 */
export function resolveGuidedSealTopology(
  mission: Mission,
  options?: {
    /**
     * Áreas disjuntas do repositório vivo (prong b). Quando o objetivo NÃO cita
     * arquivos — o caso do dia a dia — quem conhece as frentes é o repositório,
     * não o texto do pedido. Ausente = comportamento anterior, intacto.
     */
    readonly lazyAreas?: () => readonly {
      readonly id: string;
      readonly files: readonly string[];
    }[];
  },
): GuidedSealTopologyDecision {
  const contract = mission.intentContract;
  const serialized = (
    topology: StandardMissionTopology,
  ): GuidedSealTopologyDecision => ({
    topology,
    nlFanoutStoryCount: 0,
    nlFanoutSuppressed: null,
  });
  if (!contract) return serialized("delivery");
  const stories = resolveWavePackStories({
    wavePackStories: contract.wavePackStories,
    promotedPlanSummary: contract.promotedPlan?.summary,
  });
  const forced = contract.orchestrationMode ?? null;
  // Without a promoted plan, keep the goal classifier (team fan-out / delivery)
  // unless the operator forced Pack (structured stories) or Livre.
  if (!contract.promotedPlan) {
    if (forced === "pack" && stories.length >= 2) {
      return serialized("wave-pack");
    }
    if (forced === "livre") {
      return serialized(
        topologyForOrchestrationMode(
          "livre",
          classifyStandardMissionTopology(contract.goal),
        ),
      );
    }
    // P0-8 NL fan-out: no promoted plan, no operator override. A goal that
    // names ≥2 disjoint files decomposes into that many parallel writers.
    if (forced === null) {
      // Primeiro o goal que CITA arquivos (P0-8); se ele não decompõe, tenta as
      // ÁREAS do repositório vivo (prong b) — nesta ordem, porque um alvo
      // declarado pelo operador é mais preciso que a forma do repo.
      const namedStories = decomposeGuidedGoalIntoStories({
        goal: contract.goal,
        acceptanceCriteria: contract.acceptanceCriteria,
      });
      // Se o objetivo declara QUALQUER alvo, o operador já estreitou a
      // superfície: não varremos o repositório nem inferimos áreas. Áreas são
      // só para o objetivo que não cita nada — o caso do dia a dia.
      const goalNamesFiles =
        extractStoryOwnershipFiles(contract.goal).length > 0;
      // Áreas só interessam quando o classificador cairia em `delivery` (um
      // escritor). Fan-out de time já abre raízes read-only por agente e não
      // tem o que particionar — varrer o repo ali seria trabalho jogado fora.
      const classifierWouldDeliver =
        classifyStandardMissionTopology(contract.goal) === "delivery";
      const nlStories =
        namedStories.length >= 2
          ? namedStories
          : goalNamesFiles || !classifierWouldDeliver
            ? namedStories
            : decomposeGoalByRepositoryAreas({
                goal: contract.goal,
                areas: options?.lazyAreas?.() ?? [],
              });
      if (nlStories.length >= 2) {
        // Narrow safety valve: a truly destructive goal stays single-writer,
        // and the suppression is reported so it surfaces in mission state.
        if (contract.risk === "destructive") {
          return {
            topology: "delivery",
            nlFanoutStoryCount: nlStories.length,
            nlFanoutSuppressed: "destructive",
          };
        }
        return {
          topology: "wave-pack",
          nlFanoutStoryCount: nlStories.length,
          nlFanoutSuppressed: null,
        };
      }
    }
    return serialized(classifyStandardMissionTopology(contract.goal));
  }
  const mode = resolveMissionOrchestrationMode({
    lane: contract.lane,
    risk: contract.risk,
    hasPromotedPlan: true,
    extractedStoryCount: stories.length,
    forcedMode: forced,
  });
  return serialized(topologyForOrchestrationMode(mode, "delivery"));
}

function sealWavePackMissionPlan(input: {
  readonly mission: Mission;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly squad: Squad;
  readonly rosterWorkers: ReadonlyArray<{
    readonly id: string;
    readonly agentName: string;
    readonly category: "executor" | "reviewer" | "scout" | "architect";
  }>;
  readonly suite: Pick<ProjectDomainStoreSuite, "missions" | "tasks">;
  readonly deps: GuidedMissionPlannerDeps;
}): GuidedMissionPlanResult {
  const { mission, missionId, intentVersion, squad, suite, deps } = input;
  const contract = mission.intentContract!;
  // Same resolver the topology decision used: structured stories win, else the
  // P0-8 NL per-file decomposition — so the sealed N units match the routing.
  const stories = guidedWavePackStories(contract);
  const allExecutors = input.rosterWorkers
    .filter((agent) => agent.category === "executor")
    .map((agent) =>
      Object.freeze({
        id: agent.id,
        agentName: agent.agentName,
        category: "executor" as const,
      }),
    );
  // Prefer implementation-shaped executors (Dev / Builder). Story Manager and
  // similar roster labels stay available only when no better match exists.
  const preferredExecutors = allExecutors.filter((agent) =>
    /\b(dev|impl|builder|coder|engineer)\b/i.test(
      `${agent.id} ${agent.agentName}`,
    ),
  );
  const executors =
    preferredExecutors.length > 0 ? preferredExecutors : allExecutors;
  const operatorChoice = deps.squadCliPolicy() === "operator-choice";
  const primaryExecutor = choosePrimaryExecutor(squad, operatorChoice);
  let qualityGate: {
    id: string;
    agentName: string;
    category: "reviewer";
  } | null = null;
  try {
    const gate = chooseCorrectiveQualityGate(
      squad,
      primaryExecutor,
      operatorChoice,
    );
    if (gate.category === "reviewer") {
      qualityGate = {
        id: gate.id,
        agentName: gate.agentName,
        category: "reviewer",
      };
    }
  } catch {
    qualityGate = null;
  }
  const intentOwnership = resolveGuidedMutationOwnership(contract);
  const baseOwnership =
    intentOwnership.length > 0
      ? intentOwnership
      : resolveGuidedMutationOwnership(
          contract,
          deps.listRepositoryOwnership(suite.tasks.scope),
        );
  if (baseOwnership.length === 0) {
    throw new Error(
      "wave_pack_ownership_missing: o inventário seguro do projeto está vazio",
    );
  }
  const ownershipCoverageDomains: readonly string[] =
    intentOwnership.length > 0 ? [] : [OWNERSHIP_COVERAGE_DOMAIN];
  const planned = planWavePackTasks({
    missionTitle: mission.title,
    goal: contract.goal,
    acceptanceCriteria: contract.acceptanceCriteria,
    stories,
    executors,
    qualityGate,
    maxWorkers: contract.budgets.maxWorkers,
    ownershipFiles: baseOwnership,
    ownershipCoverageDomains,
  });
  const packTasks: GuidedPlanTaskDetailInput[] = planned.map((task) => ({
    id: task.plannerId,
    title: task.title,
    detail: task.detail,
    agentRef: task.agentRef,
    category: task.category,
    executionMode: task.executionMode,
    ownership: {
      files: [...task.ownership.files],
      symbols: [...task.ownership.symbols],
      domains: [...task.ownership.domains],
    },
    dependsOn: [...task.dependsOn],
  }));
  assertGuidedPlanTaskDetailBudgets({
    missionId,
    intentVersion,
    tasks: packTasks,
  });
  const plan = sealMainOwnedMissionTaskPlan(
    { missionId, tasks: packTasks },
    suite.tasks.scope,
    suite,
    deps,
    mission.status === "pending" &&
      mission.intentState === "ready_to_start" &&
      typeof contract.approvedAt === "number"
      ? {
          kind: "approved-preflight",
          intentVersion,
          approvedAt: contract.approvedAt,
          approvalReviewSha256: contract.approvalReviewSha256,
        }
      : undefined,
  );
  const primary = plan.planned[0]!;
  return Object.freeze({
    applicable: true,
    sealed: true,
    reason: "sealed",
    topology: "wave-pack" as const,
    workerAgentRef: primary.agentRef,
    taskId: primary.taskId,
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
