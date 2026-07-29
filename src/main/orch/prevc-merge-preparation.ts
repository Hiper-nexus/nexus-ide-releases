import type { Mission } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  runContextBootstrapAutopilot,
  type ContextBootstrapAutopilotResult,
} from "../context/context-bootstrap-autopilot";
import {
  applicableContextSensors,
  loadContextConfiguration,
} from "../context/context-doctor";
import { ingestProjectContext } from "../context/context-ingestor";
import {
  type ContextWorkflowService,
  type WorkflowIdentity,
} from "../context/context-workflow-service";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { drivePrevcAutopilot } from "./prevc-autopilot-coordinator";
import { getProjectDomainStores } from "./project-domain-store-registry";
import {
  frozenWorkflowMatchesApprovedIntent,
  mainOwnedMissionContractDraft,
} from "./guided-mission-prevc";
import {
  classifyOperationalFailure,
  type OperationalFailureDisposition,
} from "../runtime/operational-failure-policy";

type PrevcMergeWorkflowPort = Pick<
  ContextWorkflowService,
  | "freezeContract"
  | "getMissionWorkflow"
  | "inspectReadiness"
  | "inspectCurrentPreExecutionReviewGate"
  | "refreezeContract"
>;

type BootstrapResult = Pick<
  ContextBootstrapAutopilotResult,
  "readiness" | "blockingError" | "autopilotHint"
>;

export interface PrevcMergePreparationDependencies {
  readonly getMission: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => Mission | null;
  readonly workflowForScope: (
    scope: ProjectExecutionScope,
  ) => PrevcMergeWorkflowPort;
  readonly bootstrapContext: (
    scope: ProjectExecutionScope,
    missionId: string,
    signal?: AbortSignal,
  ) => Promise<BootstrapResult>;
  readonly prepareExecution: (input: {
    readonly scope: ProjectExecutionScope;
    readonly missionId: string;
    readonly assertCurrentAuthority: () => void;
    readonly signal?: AbortSignal;
  }) => Promise<unknown>;
  readonly inspectRequirements?: (
    scope: ProjectExecutionScope,
  ) => {
    readonly sensorIds: ReadonlySet<string>;
    readonly invariantRefs: ReadonlySet<string>;
  };
  readonly getPreExecutionPlanBinding?: (
    scope: ProjectExecutionScope,
    missionId: string,
    intentVersion: number,
  ) => {
    readonly intentVersion: number;
    readonly planHash: string;
  } | null;
}

const PRODUCTION_DEPS: PrevcMergePreparationDependencies = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  workflowForScope: (scope) => getContextWorkflowService(scope),
  bootstrapContext: (scope, missionId, signal) =>
    runContextBootstrapAutopilot({
      scope,
      missionId,
      author: {
        id: "nexus-prevc-merge-preparation",
        sessionId: `main:${missionId}:context`,
        provider: "nexus-main",
      },
      autoReview: true,
      autoCommit: true,
      ...(signal ? { signal } : {}),
    }),
  prepareExecution: (input) =>
    drivePrevcAutopilot({
      scope: input.scope,
      missionId: input.missionId,
      allowExecutionExit: false,
      assertCurrentAuthority: input.assertCurrentAuthority,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  getPreExecutionPlanBinding: (scope, missionId, intentVersion) => {
    const receipt = getProjectDomainStores(scope).tasks.getPlanReceipt(
      missionId,
      intentVersion,
    );
    return receipt
      ? Object.freeze({
          intentVersion: receipt.intentVersion,
          planHash: receipt.planHash,
        })
      : null;
  },
  inspectRequirements: (scope) => {
    const config = loadContextConfiguration(scope);
    return Object.freeze({
      sensorIds: new Set(
        applicableContextSensors(scope, config.sensors).map(
          (sensor) => sensor.id,
        ),
      ),
      invariantRefs: new Set(
        ingestProjectContext(scope).facts
          .filter((fact) => fact.category === "invariant")
          .map((fact) => fact.id),
      ),
    });
  },
};

const opportunisticContextFlights = new Map<
  string,
  Promise<{
    readonly prepared: boolean;
    readonly ready: boolean;
    readonly reason?: string;
  }>
>();

const TERMINAL_PREVC_FAILURE_CODES = Object.freeze([
  "prevc_merge_contract_missing",
  "prevc_merge_requires_standard_lane",
  "prevc_merge_workflow_corrupt",
  "prevc_merge_contract_stale",
  "prevc_merge_freeze_failed",
  "prevc_merge_stage_invalid",
]);

const PENDING_PREVC_FAILURE_CODES = Object.freeze([
  "prevc_merge_context_pending",
  "prevc_merge_not_ready",
  // A missing project sensor/invariant may be supplied by the candidate or by
  // context bootstrap. It is not proof of terminal mission authority loss.
  "prevc_merge_requirements_pending",
  // Current production advances repairable pre-execution findings as durable
  // guidance. Keep legacy/restart projections non-terminal as well.
  "prevc_merge_review_blocked",
]);

/**
 * PREVC is opportunistic while workers run, but the promotion boundary must
 * distinguish capacity waits from durable authority/configuration failures.
 * Retrying a corrupt or stale frozen workflow forever leaves the mission
 * visually alive while it can never merge.
 */
export function classifyPrevcMergeFailure(
  error: unknown,
): OperationalFailureDisposition {
  const message =
    error instanceof Error
      ? error.message
      : (() => {
          try {
            return String(error);
          } catch {
            return "";
          }
        })();
  if (
    TERMINAL_PREVC_FAILURE_CODES.some((code) => message.includes(code))
  ) {
    return "terminal";
  }
  if (PENDING_PREVC_FAILURE_CODES.some((code) => message.includes(code))) {
    return "retryable";
  }
  return classifyOperationalFailure(error);
}

function scopeMissionKey(
  scope: ProjectExecutionScope,
  missionId: string,
): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    missionId,
  ].join("\0");
}

/**
 * Starts only project-context preparation. It intentionally does not freeze a
 * contract: freezing rotates the PREVC authority seal and would invalidate
 * workers that are already running. Final promotion calls
 * `ensurePrevcMergeReady` after their handoffs are durable.
 */
export function prepareOpportunisticPrevcContext(
  scope: ProjectExecutionScope,
  missionId: string,
  dependencies: PrevcMergePreparationDependencies = PRODUCTION_DEPS,
): Promise<{
  readonly prepared: boolean;
  readonly ready: boolean;
  readonly reason?: string;
}> {
  const key = scopeMissionKey(scope, missionId);
  const existing = opportunisticContextFlights.get(key);
  if (existing) return existing;
  const flight = (async () => {
    const mission = dependencies.getMission(scope, missionId);
    if (
      !mission?.intentContract ||
      (mission.intentContract.lane ?? "standard") !== "standard"
    ) {
      return Object.freeze({
        prepared: false,
        ready: false,
        reason: "not a dispatched standard mission",
      });
    }
    const service = dependencies.workflowForScope(scope);
    const workflow = service.getMissionWorkflow(missionId);
    if (workflow.contract && workflow.workflow) {
      return Object.freeze({ prepared: false, ready: true });
    }
    const readiness = service.inspectReadiness();
    if (readiness.ready && readiness.contextRevision) {
      return Object.freeze({ prepared: false, ready: true });
    }
    const result = await dependencies.bootstrapContext(scope, missionId);
    return Object.freeze({
      prepared: true,
      ready: result.readiness.ready && Boolean(result.readiness.contextRevision),
      ...(!result.readiness.ready
        ? { reason: pendingContextMessage(result) }
        : {}),
    });
  })().finally(() => {
    if (opportunisticContextFlights.get(key) === flight) {
      opportunisticContextFlights.delete(key);
    }
  });
  opportunisticContextFlights.set(key, flight);
  return flight;
}

function mergePreparationIdentity(missionId: string): WorkflowIdentity {
  return Object.freeze({
    id: "nexus-prevc-merge-preparation",
    sessionId: `main:${missionId}:merge`,
    provider: "nexus-main",
  });
}

function pendingContextMessage(result: BootstrapResult): string {
  const blockers = result.readiness.blockers
    .map((blocker) => blocker.code)
    .slice(0, 16)
    .join(", ");
  const detail = [
    blockers || null,
    result.blockingError,
    result.autopilotHint,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("; ")
    .slice(0, 2_048);
  return `prevc_merge_context_pending${detail ? `: ${detail}` : ""}`;
}

/**
 * Completes opportunistic PREVC at the promotion boundary.
 *
 * Workers are allowed to start while project context is being prepared. Before
 * MergeQueue snapshots its integration base, Main makes context authoritative,
 * freezes the exact approved intent, and advances planning/reviews to
 * `execution`. The merge validator can therefore stay fail-closed without
 * turning temporary context preparation into a terminal task failure.
 */
export async function ensurePrevcMergeReady(
  scope: ProjectExecutionScope,
  missionId: string,
  options: {
    readonly signal?: AbortSignal;
    readonly assertCurrentAuthority?: () => void;
  } = {},
  dependencies: PrevcMergePreparationDependencies = PRODUCTION_DEPS,
): Promise<{
  readonly stage: "execution";
  readonly frozenNow: boolean;
  readonly refrozen: boolean;
}> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error("PREVC merge preparation was aborted");
  }
  if (opportunisticContextFlights.has(scopeMissionKey(scope, missionId))) {
    throw new Error(
      "prevc_merge_context_pending: background PREVC preparation is still running",
    );
  }
  return ensurePrevcMergeReadyCore(
    scope,
    missionId,
    options,
    dependencies,
  );
}

async function ensurePrevcMergeReadyCore(
  scope: ProjectExecutionScope,
  missionId: string,
  options: {
    readonly signal?: AbortSignal;
    readonly assertCurrentAuthority?: () => void;
  },
  dependencies: PrevcMergePreparationDependencies,
): Promise<{
  readonly stage: "execution";
  readonly frozenNow: boolean;
  readonly refrozen: boolean;
}> {
  const assertCurrentAuthority =
    options.assertCurrentAuthority ?? (() => undefined);
  assertCurrentAuthority();
  const mission = dependencies.getMission(scope, missionId);
  if (!mission?.intentContract) {
    throw new Error("prevc_merge_contract_missing: approved mission not found");
  }
  if ((mission.intentContract.lane ?? "standard") !== "standard") {
    throw new Error("prevc_merge_requires_standard_lane");
  }

  const service = dependencies.workflowForScope(scope);
  let readiness = service.inspectReadiness();
  if (!readiness.ready || !readiness.contextRevision) {
    const prepared = await dependencies.bootstrapContext(
      scope,
      missionId,
      options.signal,
    );
    assertCurrentAuthority();
    if (!prepared.readiness.ready || !prepared.readiness.contextRevision) {
      throw new Error(pendingContextMessage(prepared));
    }
    readiness = prepared.readiness;
  }

  assertCurrentAuthority();
  let current = service.getMissionWorkflow(missionId);
  if (Boolean(current.contract) !== Boolean(current.workflow)) {
    throw new Error("prevc_merge_workflow_corrupt: partial frozen workflow");
  }
  if (
    current.contract &&
    current.workflow &&
    !frozenWorkflowMatchesApprovedIntent(mission, current)
  ) {
    throw new Error(
      "prevc_merge_contract_stale: frozen workflow does not match the currently approved intent",
    );
  }

  let frozenNow = false;
  let refrozen = false;
  const identity = mergePreparationIdentity(missionId);
  if (!current.contract && !current.workflow) {
    service.freezeContract(mainOwnedMissionContractDraft(mission), identity);
    frozenNow = true;
    current = service.getMissionWorkflow(missionId);
  } else if (
    current.contract!.contract.contextRevision !== readiness.contextRevision
  ) {
    service.refreezeContract(missionId, identity);
    refrozen = true;
    current = service.getMissionWorkflow(missionId);
  }

  if (!current.contract || !current.workflow) {
    throw new Error("prevc_merge_freeze_failed: workflow was not persisted");
  }
  if (!frozenWorkflowMatchesApprovedIntent(mission, current)) {
    throw new Error(
      "prevc_merge_contract_stale: frozen workflow does not match the currently approved intent",
    );
  }
  const available =
    dependencies.inspectRequirements?.(scope) ??
    PRODUCTION_DEPS.inspectRequirements!(scope);
  const missingSensors = current.contract.contract.requiredSensors.filter(
    (sensorId) => !available.sensorIds.has(sensorId),
  );
  const missingInvariants =
    current.contract.contract.businessInvariantRefs.filter(
      (invariantRef) => !available.invariantRefs.has(invariantRef),
    );
  if (missingSensors.length > 0 || missingInvariants.length > 0) {
    throw new Error(
      "prevc_merge_requirements_pending: " +
        [
          missingSensors.length > 0
            ? `sensors=${missingSensors.slice(0, 16).join(",")}`
            : null,
          missingInvariants.length > 0
            ? `invariants=${missingInvariants.slice(0, 16).join(",")}`
            : null,
        ]
          .filter(Boolean)
          .join("; "),
    );
  }
  if (
    current.workflow.stage !== "execution" &&
    !["planning", "review-primary", "review-secondary"].includes(
      current.workflow.stage,
    )
  ) {
    throw new Error(
      `prevc_merge_stage_invalid: expected pre-execution stage, got ${current.workflow.stage}`,
    );
  }
  if (current.workflow.stage !== "execution") {
    await dependencies.prepareExecution({
      scope,
      missionId,
      assertCurrentAuthority,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertCurrentAuthority();
    current = service.getMissionWorkflow(missionId);
  }
  if (current.workflow?.stage !== "execution") {
    if (
      current.workflow &&
      ["review-primary", "review-secondary"].includes(
        current.workflow.stage,
      )
    ) {
      const planBinding = (
        dependencies.getPreExecutionPlanBinding ??
        PRODUCTION_DEPS.getPreExecutionPlanBinding!
      )(
        scope,
        missionId,
        mission.intentContract.intentVersion,
      );
      if (!planBinding) {
        throw new Error(
          "prevc_merge_not_ready: current sealed task plan is missing",
        );
      }
      const gate = service.inspectCurrentPreExecutionReviewGate(
        missionId,
        planBinding,
      );
      if (
        gate.reportCount > 0 &&
        gate.reason !== "review-quorum-missing"
      ) {
        throw new Error(
          "prevc_merge_review_blocked: " +
            `${gate.reason}; evidence=${gate.evidenceIds.join(",")}`,
        );
      }
    }
    throw new Error(
      `prevc_merge_not_ready: workflow ended at ${current.workflow?.stage ?? "missing"}`,
    );
  }
  return Object.freeze({
    stage: "execution",
    frozenNow,
    refrozen,
  });
}
