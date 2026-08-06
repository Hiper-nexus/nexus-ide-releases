import type { Mission } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { appendMissionVerdict } from "../../shared/mission-block-cause";
import {
  ContextReadinessError,
  type ContextWorkflowService,
  type MissionContractDraft,
} from "../context/context-workflow-service";
import {
  runContextBootstrapAutopilot,
  type ContextBootstrapAutopilotResult,
} from "../context/context-bootstrap-autopilot";
import type {
  GuidedGitBaselineResult,
} from "../runtime/guided-greenfield-baseline";
import { ensureGuidedGitBaselineBeforeContext } from "../runtime/guided-greenfield-baseline";
import type { GuidedGreenfieldApprovedIntent } from "../runtime/guided-greenfield-brief";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import type { WorkflowStage } from "../context/contract-compiler";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { bindFreezeDraftToApprovedIntent } from "./mission-freeze-authority";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";
import { standardTopologyFromSealedTaskDetails } from "./guided-mission-topology-authority";
import {
  hasGuidedTaskDomain,
  parseGuidedTaskKind,
} from "./guided-task-kind";
import {
  assertWavePackStoryFilesDisjoint,
  hasWavePackDisjointFilesDomain,
} from "../../shared/mission-wave-pack";
import {
  describeMissionDegradation,
  type MissionDegradation,
} from "./mission-degradation";

export function ownershipRequiresGuidedPrevc(
  domains: readonly string[],
): boolean {
  return hasGuidedTaskDomain(domains);
}

type GuidedPrevcWorkflowPort = Pick<
  ContextWorkflowService,
  | "advance"
  | "compileMissionSnapshot"
  | "freezeContract"
  | "getMissionWorkflow"
>;

export interface GuidedMissionPrevcResult {
  readonly required: boolean;
  readonly frozen: boolean;
  readonly stage: WorkflowStage | null;
  readonly readyForWorkerDispatch: boolean;
  /**
   * D1: when PREVC cannot freeze but a smaller working path exists, Main
   * continues without a PREVC seal. Callers must surface `degradationReason`
   * — silent skip is forbidden.
   */
  readonly degraded?: boolean;
  readonly degradationReason?: string;
}

export interface GuidedMissionPrevcDeps {
  getMission(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Mission | null;
  listPlannedTaskDetails(
    scope: ProjectExecutionScope,
    missionId: string,
    intentVersion: number,
  ): readonly string[];
  hasMaterializedWorkerAuthority(
    scope: ProjectExecutionScope,
    missionId: string,
  ): boolean;
  ensureGreenfieldBaseline(
    scope: ProjectExecutionScope,
    approvedIntent: GuidedGreenfieldApprovedIntent,
  ): GuidedGitBaselineResult | null;
  workflowForScope(scope: ProjectExecutionScope): GuidedPrevcWorkflowPort;
}

export interface GuidedMissionPrevcBootstrapDeps {
  ensurePrevc(
    scope: ProjectExecutionScope,
    missionId: string,
  ): GuidedMissionPrevcResult;
  bootstrapContext(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<
    Pick<
      ContextBootstrapAutopilotResult,
      "readiness" | "blockingError" | "autopilotHint"
    >
  >;
  /**
   * D1: persist a visible [NEXUS_DEGRADED] note on the mission card when PREVC
   * cannot freeze. Optional in unit tests; production always supplies it.
   */
  surfaceDegradation?(
    scope: ProjectExecutionScope,
    missionId: string,
    reason: string,
  ): void;
}

/** Persist D1 PREVC degrade onto the mission description (operator-visible). */
export function surfaceGuidedPrevcDegradation(
  scope: ProjectExecutionScope,
  missionId: string,
  reason: string,
): void {
  try {
    const stores = getProjectDomainStores(scope);
    const mission = stores.missions.get(missionId);
    if (!mission) return;
    const degradation: MissionDegradation = {
      what: "selo PREVC",
      reducedTo: "caminho simples sem mission_contracts",
      why: reason,
      recoverable: true,
    };
    const description = appendMissionVerdict(
      mission.description ?? "",
      "<!-- nexus:mission-degradation -->",
      "[NEXUS_DEGRADED]",
      describeMissionDegradation(degradation),
    );
    stores.missions.update(missionId, { description });
  } catch (error) {
    console.warn(
      `[guided-prevc] failed to surface D1 degradation for ${missionId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

const PRODUCTION_DEPS: GuidedMissionPrevcDeps = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  listPlannedTaskDetails: (scope, missionId, intentVersion) =>
    getProjectDomainStores(scope)
      .tasks.listPlannedTasks(missionId, intentVersion)
      .map((planned) => planned.task.detail),
  hasMaterializedWorkerAuthority: (scope, missionId) => {
    const stores = getProjectDomainStores(scope);
    return (
      stores.taskDispatches.list(missionId).length > 0 ||
      stores.missionPanes
        .list(missionId)
        .some((pane) => pane.role === "worker")
    );
  },
  ensureGreenfieldBaseline: (scope, approvedIntent) =>
    ensureGuidedGitBaselineBeforeContext(scope, { approvedIntent }),
  workflowForScope: (scope) => getContextWorkflowService(scope),
};

const PRODUCTION_BOOTSTRAP_DEPS: GuidedMissionPrevcBootstrapDeps = {
  surfaceDegradation: surfaceGuidedPrevcDegradation,
  ensurePrevc: (scope, missionId) =>
    ensureGuidedMissionPrevc(scope, missionId, PRODUCTION_DEPS),
  bootstrapContext: (scope, missionId) =>
    runContextBootstrapAutopilot({
      scope,
      missionId,
      author: {
        id: "nexus-guided-preflight",
        sessionId: `main:${missionId}:context`,
        provider: "nexus-main",
      },
      autoReview: true,
      autoCommit: true,
    }),
};

export function taskDetailsRequireGuidedPrevc(
  taskDetails: readonly string[],
): boolean {
  return taskDetails.some((detail) => {
    const meta = decodeTaskScheduleDetail(detail).meta;
    return Boolean(
      meta && ownershipRequiresGuidedPrevc(meta.ownership.domains),
    );
  });
}

/**
 * Fail-closed disjointness gate for a fanned-out plan: any two sealed stories
 * that declare a real disjoint file footprint (`wave-pack-disjoint-files`) must
 * not share a file. This runs for every mission — including the wave-pack
 * topology that skips the rest of guided PREVC — so a decomposition that would
 * put two writers on the same file is rejected before any worktree is claimed.
 */
export function assertSealedWavePackStoriesDisjoint(
  taskDetails: readonly string[],
): void {
  const stories: {
    readonly plannerId: string;
    readonly ownership: { readonly files: readonly string[] };
  }[] = [];
  taskDetails.forEach((detail, index) => {
    const meta = decodeTaskScheduleDetail(detail).meta;
    if (!meta || !hasWavePackDisjointFilesDomain(meta.ownership.domains)) {
      return;
    }
    stories.push({
      plannerId: `sealed-story-${index + 1}`,
      ownership: { files: meta.ownership.files },
    });
  });
  if (stories.length >= 2) assertWavePackStoryFilesDisjoint(stories);
}

function assertGuidedPrevcTaskDetailsV2(
  taskDetails: readonly string[],
): void {
  if (taskDetails.length === 0) {
    throw new Error(
      "guided_plan_receipt_missing: missão guiada sem plano selado",
    );
  }
  for (const [index, detail] of taskDetails.entries()) {
    const meta = decodeTaskScheduleDetail(detail).meta;
    try {
      if (
        !meta?.agentRef ||
        !parseGuidedTaskKind({
          agentCategory: meta.agentCategory,
          executionMode: meta.executionMode,
          domains: meta.ownership.domains,
          label: `receipt ${index + 1}`,
        })
      ) {
        throw new Error("metadata Guided ausente");
      }
    } catch (error) {
      throw new Error(
        "guided_plan_legacy_receipt_blocked: metadata de execução PREVC v2 ausente ou inválida",
        { cause: error },
      );
    }
  }
}

export function frozenWorkflowMatchesApprovedIntent(
  mission: Mission,
  workflow: ReturnType<GuidedPrevcWorkflowPort["getMissionWorkflow"]>,
): boolean {
  const approved = mission.intentContract;
  const frozen = workflow.contract?.contract;
  return Boolean(
    approved &&
      frozen &&
      frozen.missionId === mission.id &&
      frozen.goal === approved.goal.trim() &&
      frozen.acceptanceCriteria.length ===
        approved.acceptanceCriteria.length &&
      frozen.acceptanceCriteria.every(
        (criterion, index) =>
          criterion.statement === approved.acceptanceCriteria[index]?.trim(),
      ),
  );
}

/** Exact PREVC draft derived only from the operator-approved intent. */
export function mainOwnedMissionContractDraft(
  mission: Mission,
): MissionContractDraft {
  const approved = mission.intentContract;
  if (!approved) {
    throw new Error(
      "guided_prevc_contract_missing: missão sem intenção aprovada",
    );
  }
  return bindFreezeDraftToApprovedIntent(mission, {
    missionId: mission.id,
    goal: approved.goal.trim(),
    acceptanceCriteria: approved.acceptanceCriteria.map(
      (statement, index) => ({
        id: `criterion-${String(index + 1).padStart(4, "0")}`,
        statement: statement.trim(),
        requiredSensorIds: [],
        invariantRefs: [],
        requiredArtifactIds: [],
      }),
    ),
    nonGoals: [],
    impactedDomains: [],
    impactedSymbols: [],
    requestedSensors: [],
    requiredArtifacts: [],
    riskHints: [],
  });
}

function advanceDeterministicPlanning(
  service: GuidedPrevcWorkflowPort,
  missionId: string,
): ReturnType<GuidedPrevcWorkflowPort["getMissionWorkflow"]> {
  let current = service.getMissionWorkflow(missionId);
  if (current.workflow?.stage !== "planning") return current;
  const index = current.workflow.route.indexOf("planning");
  const next = current.workflow.route[index + 1];
  if (!next) {
    throw new Error(
      "guided_prevc_invalid_route: planning não possui próxima etapa",
    );
  }
  service.advance(missionId, next);
  current = service.getMissionWorkflow(missionId);
  return current;
}

/**
 * Main-owned guided preflight. It freezes PREVC before every worker. When the
 * only blocker is missing versioned context, this synchronous core creates the
 * safe greenfield baseline and reports pending. The async bootstrap boundary
 * below then runs the bounded Main-owned Doctor and retries the physical
 * freeze; no provider or scheduler may inherit that obligation from a prompt.
 */
export function ensureGuidedMissionPrevc(
  scope: ProjectExecutionScope,
  missionId: string,
  deps: GuidedMissionPrevcDeps = PRODUCTION_DEPS,
): GuidedMissionPrevcResult {
  const mission = deps.getMission(scope, missionId);
  if (!mission?.intentContract) {
    throw new Error(
      "guided_prevc_contract_missing: missão aprovada não encontrada",
    );
  }
  const taskDetails = deps.listPlannedTaskDetails(
    scope,
    missionId,
    mission.intentContract.intentVersion,
  );
  // Disjoint fan-out is proven before any topology decision or provider work:
  // two writers may never share a file. No-op for shared-inventory plans.
  assertSealedWavePackStoriesDisjoint(taskDetails);
  const topology = standardTopologyFromSealedTaskDetails(taskDetails);
  if (topology === "invalid") {
    throw new Error(
      "guided_prevc_contract_stale: o receipt selado mistura delivery e " +
        "team-read-only-fanout ou wave-pack; replaneje e reaprove a missão",
    );
  }
  if (!missionRequiresGuidedPrevc(mission, topology)) {
    return Object.freeze({
      required: false,
      frozen: false,
      stage: null,
      readyForWorkerDispatch: false,
    });
  }
  // Receipt validity remains a separate fail-closed gate. These bytes can
  // block recovery, but can never opt this mission out of PREVC.
  assertGuidedPrevcTaskDetailsV2(taskDetails);

  const service = deps.workflowForScope(scope);
  let current = service.getMissionWorkflow(missionId);
  if (current.contract || current.workflow) {
    if (
      !current.contract ||
      !current.workflow ||
      !frozenWorkflowMatchesApprovedIntent(mission, current)
    ) {
      throw new Error(
        "guided_prevc_contract_stale: o workflow congelado não corresponde à intenção aprovada",
      );
    }
    // Also proves that contextRevision is still current before any provider.
    service.compileMissionSnapshot(missionId);
  } else {
    if (deps.hasMaterializedWorkerAuthority(scope, missionId)) {
      throw new Error(
        "guided_prevc_late_freeze_blocked: pane/claim já materializado; " +
          "encerre a revisão antiga e reabra a missão antes de congelar PREVC",
      );
    }
    try {
      service.freezeContract(mainOwnedMissionContractDraft(mission), {
        id: "nexus-guided-preflight",
        sessionId: `main:${missionId}`,
        provider: "nexus-main",
      });
    } catch (error) {
      if (!(error instanceof ContextReadinessError)) throw error;
      deps.ensureGreenfieldBaseline(scope, {
        goal: mission.intentContract.goal,
        acceptanceCriteria: mission.intentContract.acceptanceCriteria,
      });
      return Object.freeze({
        required: true,
        frozen: false,
        stage: null,
        readyForWorkerDispatch: false,
      });
    }
    current = service.getMissionWorkflow(missionId);
  }

  current = advanceDeterministicPlanning(service, missionId);
  if (!current.contract || !current.workflow) {
    throw new Error(
      "guided_prevc_freeze_failed: contrato/workflow não persistiu",
    );
  }
  return Object.freeze({
    required: true,
    frozen: true,
    stage: current.workflow.stage,
    readyForWorkerDispatch: current.workflow.stage === "execution",
  });
}

/**
 * Async bootstrap boundary for a Guided mission.
 *
 * A missing context may require the bounded Doctor pipeline, but that work is
 * still Main-owned. The initial orchestrator and scheduler never receive a
 * merely prompt-level obligation to create `mission_contracts`: Main prepares
 * context, retries the physical freeze and proves the durable rows first.
 */
export async function ensureGuidedMissionPrevcAtBootstrapBoundary(
  scope: ProjectExecutionScope,
  missionId: string,
  deps: GuidedMissionPrevcBootstrapDeps = PRODUCTION_BOOTSTRAP_DEPS,
): Promise<GuidedMissionPrevcResult> {
  const initial = deps.ensurePrevc(scope, missionId);
  if (!initial.required || initial.frozen) return initial;

  const prepared = await deps.bootstrapContext(scope, missionId);
  if (!prepared.readiness.ready) {
    const blockers = prepared.readiness.blockers
      .map((blocker) => blocker.code)
      .slice(0, 16)
      .join(", ");
    const detail = [
      prepared.blockingError,
      blockers ? `blockers=${blockers}` : null,
      prepared.autopilotHint,
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("; ")
      .slice(0, 2_048);
    // D1: context bootstrap failure is a capacity gap, not false authority.
    // Continue on the simple path without a PREVC seal — never a silent wall.
    const reason =
      "contexto não congelado; entrega segue sem selo de PREVC" +
      (detail ? ` (${detail})` : "");
    console.warn(
      `[guided-prevc] D1 degrade mission=${missionId}: ${reason}`,
    );
    deps.surfaceDegradation?.(scope, missionId, reason);
    return Object.freeze({
      required: false,
      frozen: false,
      stage: null,
      readyForWorkerDispatch: true,
      degraded: true,
      degradationReason: reason,
    });
  }

  const frozen = deps.ensurePrevc(scope, missionId);
  if (frozen.required && !frozen.frozen) {
    const reason =
      "contexto pronto, mas mission_contracts não persistiu; " +
      "entrega segue sem selo de PREVC";
    console.warn(
      `[guided-prevc] D1 degrade mission=${missionId}: ${reason}`,
    );
    deps.surfaceDegradation?.(scope, missionId, reason);
    return Object.freeze({
      required: false,
      frozen: false,
      stage: null,
      readyForWorkerDispatch: true,
      degraded: true,
      degradationReason: reason,
    });
  }
  return frozen;
}

export function ensureGuidedMissionPrevcForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<GuidedMissionPrevcResult> {
  return ensureGuidedMissionPrevcAtBootstrapBoundary(
    scope,
    missionId,
    PRODUCTION_BOOTSTRAP_DEPS,
  );
}

export function assertGuidedPrevcExecutionReady(input: {
  readonly required: boolean;
  readonly missionId: string;
  readonly approvedGoal?: string;
  readonly approvedAcceptanceCriteria?: readonly string[];
  readonly workflow: ReturnType<
    GuidedPrevcWorkflowPort["getMissionWorkflow"]
  >;
}): void {
  if (!input.required) return;
  if (!input.workflow.contract || !input.workflow.workflow) {
    throw new Error(
      `guided_prevc_required: ${input.missionId} não possui contrato PREVC congelado`,
    );
  }
  const contract = input.workflow.contract.contract;
  if (
    contract.missionId !== input.missionId ||
    (input.approvedGoal !== undefined &&
      contract.goal !== input.approvedGoal.trim()) ||
    (input.approvedAcceptanceCriteria !== undefined &&
      (contract.acceptanceCriteria.length !==
        input.approvedAcceptanceCriteria.length ||
        contract.acceptanceCriteria.some(
          (criterion, index) =>
            criterion.statement !==
            input.approvedAcceptanceCriteria?.[index]?.trim(),
        )))
  ) {
    throw new Error(
      `guided_prevc_contract_stale: ${input.missionId} divergiu da intenção aprovada`,
    );
  }
  if (input.workflow.workflow.stage !== "execution") {
    throw new Error(
      `guided_prevc_not_at_execution: ${input.missionId} está em ${input.workflow.workflow.stage}`,
    );
  }
}
