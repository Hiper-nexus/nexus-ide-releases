import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import type { WebContents } from "electron";
import { z } from "zod";
import {
  missionEngineCommandSchema,
  type MissionEngineCommand,
  type MissionResult,
} from "../../shared/mission-engine-contract";
import { GUIDED_PLAN_BLOCK_MARKER } from "../../shared/guided-mission-plan";
import { parseClarifyAnswerArtifact } from "../../shared/clarify";
import {
  compactMissionContext,
  missionCompactHasProgress,
  renderMissionCompact,
} from "../../shared/mission-context-compact";
import { buildIntentDispatchKickoffPrompt } from "../../shared/mission-dispatch-kickoff";
import type { StandardMissionTopology } from "../../shared/mission-topology";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { isUiMissionText } from "../../shared/mission-work-kind";
import { getOrchSettings } from "../persistence/settings-store";
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  missionIntentAuthoritySnapshot,
  missionBlockPatch,
  type MissionAttachmentSnapshot,
  type MissionOrchestratorRuntimeSnapshot,
} from "../../shared/mission-intent";
import type {
  Mission,
  MissionIntentContract,
  MissionOrchestratorBootstrapResult,
  MissionOrchestratorPane,
  MissionPaneAuthoritySeal,
  MissionPaneSpec,
  MissionPatch,
  PaneSnapshot,
  Squad,
  SquadAgent,
  MissionIntentState,
  MissionStatus,
} from "../../shared/orch-types";
import { isMissionRuntimeSquadId } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from '../../shared/pet-studio';
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import {
  revalidateSealedAttachmentSnapshots,
  snapshotDroppedAttachmentPaths,
  validateDroppedAttachmentPaths,
  workspaceRootAuthorityFromScope,
} from "../persistence/dropped-files";
import {
  getAgentSessionInfo,
  getSessionState,
  type OwnedAgentSessionInfo,
} from "../pty/pty-manager";
import {
  getAcpDriverSemanticStatus,
  getAcpDriverSession,
} from "../acp/acp-harness-driver";
import {
  getAgentSemanticStatus,
  getAgentSemanticStatusBySession,
} from "./agent-status";
import { releaseSession } from "./gate";
import type {
  RebindOrchestratorAuthorityInput,
  RecordMissionPaneInput,
} from "./mission-pane-store";
import {
  hasPendingMissionKickoffFlight,
  submitMissionKickoffFromMain,
  type MissionKickoffResult,
} from "./mission-kickoff";
import {
  assertSafePtyPrompt,
  deliverAgentPrompt,
} from "./tool-util";
import {
  emitBootstrapProgress,
  emitMissionEvent,
} from "./mission-event-emit";
import { emitMissionIntentEvent } from "./mission-intent-events";
import type { BootstrapProgressStep } from "../../shared/mission-intent-projection";
import {
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  requestMissionPaneClose,
  requestPaneClose,
  spawnMainOwnedMissionPaneAsync,
  type MissionPaneCloseRequest,
  type PaneRuntimeAuthority,
  type PaneSpawnOptions,
} from "./pane-registry";
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
  type ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import {
  MissionLifecycleLockBusyError,
  withMissionLifecycleLock,
} from "./mission-lifecycle-lock";
import { suppressIntentionalMissionOrchestratorExit } from "./mission-orchestrator-exit-lifecycle";
import {
  fastLaneBootstrap,
  fastLaneOrchestratorPaneSummary,
  missionFastLaneEnabled,
  resumeFastLaneMission,
} from "./mission-fast-lane";
import { getSquad } from "./squad-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import {
  canonicalMissionOrchestratorRuntime,
  resolveProductionMissionOrchestratorRuntime,
  sameMissionOrchestratorRuntime,
  type ResolvedMissionOrchestratorRuntime,
} from "./mission-orchestrator-runtime";
import {
  ensureGuidedMissionPlanForScope,
  type GuidedMissionPlanResult,
} from "./guided-mission-planner";
import { warmSquadRuntimeSubscriptionAuth } from "./squad-runtime-inventory";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";
import { warnGuidedDeliveryDriverInactive } from "./guided-driver-visibility";
import { ensureGuidedMissionPrevcForScope } from "./guided-mission-prevc";
import { prepareOpportunisticPrevcContext } from "./prevc-merge-preparation";
import { assertPromotedPlanSnapshot } from "./plan-promotion-authority";
import { ensurePlanLaneGitBaseline } from "../runtime/guided-greenfield-baseline";
import { commitPromotedPlanToGit } from "./promoted-plan-git-authority";
import {
  classifyOperationalFailure,
  terminalOperationalFailureReason,
} from "../runtime/operational-failure-policy";
import { hasRetiredRosterRouteMarker } from "../../shared/retired-adapter-policy";
import {
  formatRecoveryAttemptBlock,
  hasAutomaticTechnicalRecovery,
  hasTerminalOperationalFailureMarker,
  replaceRecoveryAttemptBlock,
  stripRecoveryAttemptBlock,
  TERMINAL_OPERATIONAL_FAILURE_MARKER,
} from "../../shared/mission-recovery-policy";
import {
  appendMissionDegradationNote,
  describeMissionDegradation,
  LEGITIMATE_MISSION_BLOCKS,
  type MissionDegradation,
} from './mission-degradation';
import {
  emitMissionDegradation,
  emitMissionDegradationNudge,
} from './mission-event-emit';
import { evaluateMissionAdmission } from "./mission-engine-admission";
import {
  MainMissionEngine,
  type MissionBlockInput,
  type MissionStartInput,
  type MissionVerifiedCompletionInput,
} from "./mission-engine";
import { createMissionEnginePreparationPorts } from "./mission-engine-preparation";
import type { ScopedMissionStore } from "./mission-store";
import {
  configureMissionEngineForScope,
  MissionEngineRegistry,
} from "./mission-engine-registry";
import {
  taskDispatchBlockDetailFromDescription,
  taskDispatchTechnicalResumeDescription,
} from "./task-dispatch-persistence";
import {
  resolveMissionAgentLiveState,
  type MissionAgentTaskFallback,
  type ProjectMissionSnapshotView,
} from "./mission-snapshot";
import type {
  TaskDispatchRecord,
  TaskDispatchState,
} from "./task-dispatch-store";

export {
  preferredMissionOrchestratorAdapterId,
  type ResolvedMissionOrchestratorRuntime,
} from "./mission-orchestrator-runtime";
import {
  hashMissionIntentAuthority,
  resolveMissionPaneAuthoritySeal,
  sameMissionPaneApprovalSeal,
  sameMissionPaneAuthoritySeal,
} from "./mission-pane-authority";

const BOOTSTRAP_BLOCK_MARKER = "<!-- nexus:orchestrator-bootstrap-blocked -->";
const BOOTSTRAP_TERMINATION_PENDING_MARKER =
  "<!-- nexus:orchestrator-termination-pending -->";
const PLAN_PROMOTION_BLOCK_MARKER =
  "<!-- nexus:plan-promotion-restart-blocked -->";
const PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER =
  "<!-- nexus:plan-promotion-teardown-blocked -->";
const BOOTSTRAP_CTA = "Retomar missão";
const BOOTSTRAP_AUTO_RETRY_CTA = "Recuperação automática";

const SEALED_APPROVAL_REVIEW_SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** Main-owned session inventory shared by PTY and ACP mission transports. */
function runtimeAgentSessionInfo(
  sessionId: string,
): OwnedAgentSessionInfo | null {
  return getAgentSessionInfo(sessionId) ?? getAcpDriverSession(sessionId)?.agent ?? null;
}

function runtimeSessionState(
  sessionId: string,
): ReturnType<typeof getSessionState> {
  return getSessionState(sessionId) ??
    (getAcpDriverSession(sessionId) ? "idle" : null);
}

function bootstrapFlightKey(
  scope: Readonly<ProjectExecutionScope>,
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

function bootstrapMissionSnapshot(mission: Mission): string {
  return JSON.stringify({
    id: mission.id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    squadId: mission.squadId ?? null,
    orchestratorSessionId: mission.orchestratorSessionId ?? null,
    intentState: mission.intentState ?? null,
    intentVersion: mission.intentVersion ?? 0,
    intentContract: mission.intentContract
      ? missionIntentAuthoritySnapshot(mission.intentContract)
      : null,
  });
}

function missionMatchesExpectedAuthoritySeal(
  mission: Mission,
  expected?: MissionPaneAuthoritySeal,
): boolean {
  if (!expected) return true;
  return Boolean(
    mission.intentVersion === expected.intentVersion &&
      mission.intentContract &&
      hashMissionIntentAuthority(mission.intentContract) ===
        expected.intentContractHash &&
      mission.intentContract.squadRevisionHash ===
        expected.squadRevisionHash,
  );
}

function bootstrapMissionApprovalSnapshot(mission: Mission): string {
  return JSON.stringify({
    id: mission.id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    squadId: mission.squadId ?? null,
    intentState: mission.intentState ?? null,
    intentVersion: mission.intentVersion ?? 0,
    intentContract: mission.intentContract
      ? missionIntentAuthoritySnapshot(mission.intentContract)
      : null,
  });
}

function sameAttachmentSnapshots(
  expected: readonly MissionAttachmentSnapshot[] | undefined,
  actual: readonly MissionAttachmentSnapshot[] | undefined,
): boolean {
  const left = expected ?? [];
  const right = actual ?? [];
  return (
    left.length === right.length &&
    left.every((snapshot, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        snapshot.path === candidate.path &&
        snapshot.sourcePath === candidate.sourcePath &&
        snapshot.sealId === candidate.sealId &&
        snapshot.sha256 === candidate.sha256 &&
        snapshot.size === candidate.size &&
        snapshot.device === candidate.device &&
        snapshot.inode === candidate.inode
      );
    })
  );
}

export const missionOrchestratorBootstrapRequestSchema = z
  .object({
    missionId: z.string().min(1).max(128),
  })
  .strict();

export interface MissionOrchestratorBootstrapDeps {
  /**
   * Effective bootstrap policy. Tests and isolated runtimes inject this so
   * proving Autopilot/Hardened never mutates the operator's settings file.
   */
  squadCliPolicy?(): "operator-choice" | "governed";
  getMission(scope: ProjectExecutionScope, missionId: string): Mission | null;
  updateMission(
    scope: ProjectExecutionScope,
    missionId: string,
    patch: MissionPatch,
  ): Mission | null;
  transitionMissionLifecycle(
    scope: ProjectExecutionScope,
    missionId: string,
    expectation: {
      readonly updatedAt: number;
      readonly intentVersion: number;
    },
    patch: {
      readonly status: Mission["status"];
      readonly intentState: NonNullable<Mission["intentState"]>;
      readonly description?: string;
    },
  ): Mission | null;
  /** Main-only atomic CAS for squad identity and its approved revision hash. */
  rebindMissionSquadAuthority(
    scope: ProjectExecutionScope,
    missionId: string,
    expected: Mission,
    squadId: string,
    contract: MissionIntentContract,
  ): Mission | null;
  setOrchestratorSession(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string | null,
  ): Mission | null;
  clearOrchestratorSessionIfMatches(
    scope: ProjectExecutionScope,
    missionId: string,
    expectedSessionId: string,
  ): Mission | null;
  retireOrchestratorSessionForReplacement(
    scope: ProjectExecutionScope,
    missionId: string,
    expectedSessionId: string,
    expectedAuthoritySeal?: MissionPaneAuthoritySeal,
  ): Mission | null;
  hasCurrentKickoffAcceptance(
    scope: ProjectExecutionScope,
    missionId: string,
  ): boolean;
  /** Aceite de kickoff em voo — recibo a caminho, não ausência de recibo. */
  hasPendingKickoffFlight(missionId: string): boolean;
  listMissionPanes(
    scope: ProjectExecutionScope,
    missionId: string,
  ): MissionPaneSpec[];
  recordMissionPane(
    scope: ProjectExecutionScope,
    input: RecordMissionPaneInput,
  ): MissionPaneSpec;
  rebindMissionPaneAuthority?(
    scope: ProjectExecutionScope,
    input: RebindOrchestratorAuthorityInput,
  ): MissionPaneSpec;
  removeMissionPane(scope: ProjectExecutionScope, paneRowId: string): boolean;
  getSquad(squadId: string): Squad | null;
  resolveRuntime(
    squad: Squad,
    orchestrator: SquadAgent,
  ): ResolvedMissionOrchestratorRuntime;
  spawnMainOwnedPane(
    input: PaneSpawnOptions & {
      missionId: string;
      role: "orchestrator";
    },
  ): ReturnType<typeof spawnMainOwnedMissionPaneAsync>;
  closePane(paneId: string): boolean | Promise<boolean>;
  suppressIntentionalExit(input: {
    readonly scope: ProjectExecutionScope;
    readonly missionId: string;
    readonly orchestratorSessionId: string;
    readonly authoritySeal?: MissionPaneAuthoritySeal;
  }): () => void;
  /** Trusted physical inventory used to distinguish a dead row from a live orphan. */
  listRuntimePanes(): PaneSnapshot[];
  getSessionState: typeof getSessionState;
  getAgentSessionInfo(sessionId: string): OwnedAgentSessionInfo | null;
  getRuntimeAuthority(sessionId: string): PaneRuntimeAuthority | null;
  submitKickoff(
    scope: Readonly<ProjectExecutionScope>,
    input: { missionId: string; sessionId: string; prompt: string },
  ): Promise<MissionKickoffResult>;
  emitDispatched(mission: Mission): void;
  /**
   * Operator-visible bootstrap progress (telemetry only — never awaited,
   * never a gate). Absent in fakes; the service must not depend on it.
   */
  emitProgress?(
    scope: ProjectExecutionScope,
    missionId: string,
    step: BootstrapProgressStep,
    detail?: string,
  ): void;
  validateAttachmentPaths(
    paths: readonly string[] | undefined,
  ): string[] | undefined;
  snapshotAttachmentPaths(
    paths: readonly string[] | undefined,
  ): MissionAttachmentSnapshot[] | undefined;
  revalidatePetStudioAttachmentSnapshots?(
    scope: ProjectExecutionScope,
    snapshots: readonly MissionAttachmentSnapshot[] | undefined,
  ): MissionAttachmentSnapshot[] | undefined;
  /** Main-owned planning preflight; runs before every external bootstrap effect. */
  ensureMissionPlan?(scope: ProjectExecutionScope, missionId: string): unknown;
  /**
   * Async warm of the keychain-only subscription cache (AGY). The sync
   * squad-readiness gate inside `ensureMissionPlan` reads only that warm
   * cache, so a cold cache reads a live operator session as login-needed and
   * blocks the bootstrap. Awaited immediately before `ensureMissionPlan`.
   */
  warmSubscriptionAuth?(): Promise<void>;
  /** Proves the Git baseline/source for plan and promoted-plan journeys. */
  ensurePlanGitBaseline?(
    scope: ProjectExecutionScope,
    missionId: string,
  ): unknown;
  /** Warm standard-lane context in parallel; never freezes or delays launch. */
  prepareOpportunisticPrevc?(
    scope: ProjectExecutionScope,
    missionId: string,
  ): unknown | Promise<unknown>;
  /**
   * Main-owned guided PREVC freeze, started in parallel and never awaited by
   * bootstrap. It is the only production call that persists
   * `mission_contracts` for a standard-lane guided mission: without it the
   * fence in guided-prevc-mcp-fence.ts blocks nexus_route_task,
   * nexus_mission_spawn_pane and nexus_workflow_prepare_execution forever,
   * because ensurePrevcMergeReady only runs once a dispatch already reached
   * merge — which itself requires a worker that this fence would never let
   * spawn. ensureGuidedMissionPrevc refuses to (re)freeze once any worker
   * pane/dispatch has materialized, so calling this repeatedly is safe.
   */
  ensureMissionPrevc?(
    scope: ProjectExecutionScope,
    missionId: string,
  ): unknown | Promise<unknown>;
  /**
   * Driver mode in force. Guided delivery completion is driver-owned, so a
   * guided mission starting under a non-active driver must be surfaced.
   */
  missionDriverMode?(): "shadow" | "active";
  /**
   * Loud once-per-mission warning that guided delivery completion requires
   * the mission driver enabled. Advisory: never blocks the bootstrap.
   */
  warnDriverInactive?(
    scope: ProjectExecutionScope,
    missionId: string,
  ): void;
}

export interface MissionOrchestratorBootstrapRecoveryDeps {
  listScopes(): readonly ProjectExecutionScope[];
  listBootstrapCandidates(scope: ProjectExecutionScope): readonly Mission[];
  bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult>;
  /**
   * Recover a durable technical block through the same main-owned path used by
   * the rail. Optional for narrow tests/embedders; production always supplies
   * it.
   */
  resumeBlocked?(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult>;
  /**
   * Persist a terminal operator-facing stop when recoverable retries are
   * exhausted for the current approved revision. Optional in narrow tests.
   */
  exhaustTechnicalRecovery?(
    scope: ProjectExecutionScope,
    missionId: string,
    attempts: number,
  ): void;
  /**
   * Persist (or clear, with null) the durable "tentativa N de 8" block so the
   * operator sees attempts counting instead of an eternal spinner. Optional
   * in narrow tests; never a gate.
   */
  persistRecoveryAttempt?(
    scope: ProjectExecutionScope,
    missionId: string,
    outcome: { readonly attempt: number; readonly reason: string } | null,
  ): void;
  now?(): number;
  warn?(message: string, error: unknown): void;
}

export const MISSION_ORCHESTRATOR_BOOTSTRAP_RECONCILE_MS = 5_000;
const TECHNICAL_RECOVERY_BASE_DELAY_MS = 5_000;
const TECHNICAL_RECOVERY_MAX_DELAY_MS = 60_000;
/** Hard cap for recoverable technical retries on one approved revision. */
export const TECHNICAL_RECOVERY_MAX_ATTEMPTS = 8;
/**
 * A hung resume must consume an attempt instead of hanging the lane forever
 * (H9). The physical singleflight + authority fence stay authoritative; this
 * only stops the coordinator from waiting on a flight that never answers.
 */
export const RECOVERY_ATTEMPT_TIMEOUT_MS = 120_000;
/** Automatic recovery gives up the lock wait (not the mission) after this. */
export const RECOVERY_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
/** A hung keychain warm cannot hold the boot; the gate fails closed later. */
const SUBSCRIPTION_AUTH_WARM_TIMEOUT_MS = 10_000;

class RecoveryAttemptTimeoutError extends Error {
  constructor(missionId: string, timeoutMs: number) {
    super(
      `a retomada automática de ${missionId} não respondeu em ${timeoutMs}ms`,
    );
    this.name = "RecoveryAttemptTimeoutError";
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function recoveryAttemptReason(resultOrError: unknown): string {
  if (
    resultOrError &&
    typeof resultOrError === "object" &&
    "error" in resultOrError
  ) {
    const error = (resultOrError as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error.trim();
  }
  if (resultOrError instanceof Error && resultOrError.message.trim()) {
    return resultOrError.message.trim();
  }
  return "falha sem detalhe registrado";
}

interface TechnicalRecoveryState {
  readonly attempts: number;
  readonly nextAttemptAt: number;
  /** Snapshot used only to distinguish a settled incident from a later loss. */
  readonly observedBlockedUpdatedAt: number;
  /**
   * Active retries deliberately ignore mission.updatedAt: re-arm + re-block
   * writes are part of the same incident. Once settled, a different timestamp
   * proves a later durable block and opens a fresh recovery lane.
   */
  readonly settled: boolean;
  /**
   * Terminal preflight or attempt exhaustion: the approved revision itself is
   * closed. Ignore later updatedAt churn (block notes, exhaust writes) until
   * intentVersion/approvedAt mint a new revisionKey.
   */
  readonly revisionClosed: boolean;
}

type KickoffSessionRetirementResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly result: MissionOrchestratorBootstrapResult;
    };

function technicalRecoveryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 8));
  return Math.min(
    TECHNICAL_RECOVERY_MAX_DELAY_MS,
    TECHNICAL_RECOVERY_BASE_DELAY_MS * 2 ** exponent,
  );
}

function isRetryableBootstrapResult(
  result: MissionOrchestratorBootstrapResult,
): boolean {
  if (result.ok) return result.kickoff.accepted === false;
  if (hasTerminalOperationalFailureMarker(result.error)) return false;
  // Permanent preflight drifts (squad stale, mixed topology, missing roster)
  // classify as terminal even when the durable marker has not been written yet.
  if (classifyOperationalFailure(result.error) === "terminal") return false;
  return (
    result.reason === "not_authorized" ||
    result.reason === "preflight_failed" ||
    result.reason === "spawn_failed" ||
    result.reason === "materialization_failed" ||
    result.reason === "provider_exited"
  );
}
function hasSealedPendingMissionStart(mission: Mission): boolean {
  const reviewSha256 = mission.intentContract?.approvalReviewSha256;
  return (
    mission.status === "pending" &&
    mission.intentState === "ready_to_start" &&
    hasCurrentApprovedDispatchContract(mission) &&
    typeof mission.intentContract?.dispatchedAt === "number" &&
    mission.intentContract.dispatchedAt > 0 &&
    typeof reviewSha256 === "string" &&
    SEALED_APPROVAL_REVIEW_SHA256_PATTERN.test(reviewSha256)
  );
}


export function needsMissionOrchestratorBootstrapRecovery(
  mission: Pick<Mission, "orchestratorSessionId">,
  panes: readonly Pick<MissionPaneSpec, "role">[],
  hasCurrentKickoffAcceptance: boolean,
): boolean {
  const hasPersistedOrchestrator = panes.some(

    (pane) => pane.role === "orchestrator",
  );
  return (
    !mission.orchestratorSessionId ||
    !hasPersistedOrchestrator ||
    !hasCurrentKickoffAcceptance
  );
}
export function sealMissionStartReview(
  missions: Pick<ScopedMissionStore, "get" | "transitionLifecycle">,
  input: MissionStartInput,
): Mission {
  const current = missions.get(input.missionId);
  const reviewSha256 = current?.intentContract?.approvalReviewSha256;
  const approved = current
    ? hasCurrentApprovedDispatchContract(current)
    : false;
  const lifecycleOk = Boolean(
    current &&
      ((current.status === 'pending' &&
        current.intentState === 'ready_to_start') ||
        (current.status === 'running' &&
          (current.intentState === 'dispatched' ||
            current.intentState === 'executing'))),
  );
  const hashOk = reviewSha256 === input.reviewSha256;
  if (!current || !approved || !hashOk || !lifecycleOk) {
    const reasons: string[] = [];
    if (!current) reasons.push('mission-missing');
    else {
      if (!approved) {
        reasons.push(
          `approval-missing(intentVersion=${current.intentVersion ?? 'null'},contractIntentVersion=${current.intentContract?.intentVersion ?? 'null'},approvedAt=${current.intentContract?.approvedAt ?? 'null'},goalEmpty=${!(current.intentContract?.goal?.trim())})`,
        );
      }
      if (!hashOk) {
        reasons.push(
          `hash-mismatch(persisted=${reviewSha256 ?? 'null'},input=${input.reviewSha256})`,
        );
      }
      if (!lifecycleOk) {
        reasons.push(
          `lifecycle(${current.status}/${current.intentState ?? 'null'})`,
        );
      }
    }
    console.error('[mission-start-seal] review fence rejected', {
      missionId: input.missionId,
      reasons,
      status: current?.status ?? null,
      intentState: current?.intentState ?? null,
      intentVersion: current?.intentVersion ?? null,
      contractIntentVersion: current?.intentContract?.intentVersion ?? null,
      approvedAt: current?.intentContract?.approvedAt ?? null,
      persistedReviewSha256: reviewSha256 ?? null,
      inputReviewSha256: input.reviewSha256,
      dispatchedAt: current?.intentContract?.dispatchedAt ?? null,
    });
    throw new Error(
      `mission start review fence changed before seal (${reasons.join('; ')})`,
    );
  }
  const dispatchedAt =
    typeof current.intentContract?.dispatchedAt === 'number' &&
    current.intentContract.dispatchedAt > 0
      ? current.intentContract.dispatchedAt
      : Date.now();
  const sealed = missions.transitionLifecycle(
    current.id,
    {
      updatedAt: current.updatedAt,
      intentVersion: current.intentVersion ?? 0,
    },
    {
      status: current.status,
      intentState: current.intentState!,
      intentContract: {
        ...current.intentContract!,
        dispatchedAt,
      },
    },
  );
  if (
    !sealed ||
    sealed.intentContract?.approvalReviewSha256 !== input.reviewSha256 ||
    sealed.intentContract.dispatchedAt !== dispatchedAt
  ) {
    throw new Error('mission start seal CAS changed before bootstrap');
  }
  return sealed;
}

function sameScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath &&
    left.workspaceRootDevice === right.workspaceRootDevice &&
    left.workspaceRootInode === right.workspaceRootInode
  );
}

function chooseOrchestrator(squad: Squad): SquadAgent | null {
  return (
    squad.agents.find((agent) => agent.category === "orchestrator") ?? null
  );
}

/** Bounded printable value for mismatch diagnostics (ids/models/paths only). */
function mismatchValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.slice(0, 96) || "''";
  return String(value);
}

/**
 * Every failing check of the exact-authority seal, by name and with both
 * sides' values. The seal compares ~20 fields across four sources (live agent
 * session, persisted pane row, approved runtime snapshot, runtime authority);
 * a boolean-only verdict made real field drifts (model alias, null-vs-undefined
 * accountId/effort, confinement flags) undiagnosable in the field — the
 * operator only ever saw "did not retain exact mission authority" with no
 * cause. Never weakens the check: callers still fail on any entry.
 */
export function runtimeAuthorityMismatches(
  scope: ProjectExecutionScope,
  mission: Mission,
  pane: MissionPaneSpec,
  agent: OwnedAgentSessionInfo | null,
  authority: PaneRuntimeAuthority | null,
  approvedRuntime: MissionOrchestratorRuntimeSnapshot,
): string[] {
  if (!mission.orchestratorSessionId)
    return ["mission.orchestratorSessionId ausente"];
  if (!agent) return ["agent session info ausente"];
  if (!authority) return ["runtime authority ausente"];
  // Canonical authority, not representation: "unspecified" arrives as
  // undefined from the durable pane row but as null from the PTY session
  // (pty-manager coalesces undefined→null). Both grant the same thing, so the
  // seal must not fail on the spelling — architect-designed squads omit the
  // field entirely and hit exactly this (field: agent.allowedSkills×pane).
  // An explicit [] stays distinct: it blocks everything.
  const sameCapabilities = (
    rawLeft: readonly string[] | null | undefined,
    rawRight: readonly string[] | null | undefined,
  ) => {
    const left = rawLeft ?? null;
    const right = rawRight ?? null;
    return (
      left === right ||
      (Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => value === right[index]))
    );
  };
  const mismatches: string[] = [];
  const check = (name: string, left: unknown, right: unknown) => {
    if (left !== right) {
      mismatches.push(
        `${name}[${mismatchValue(left)} != ${mismatchValue(right)}]`,
      );
    }
  };
  check(
    "agent.sessionId×mission",
    agent.sessionId,
    mission.orchestratorSessionId,
  );
  check("agent.paneId×pane", agent.paneId, pane.paneId);
  check("agent.adapterId×pane", agent.adapterId, pane.adapterId);
  // Compare the REQUESTED model (0.19.27 fix): providers normalize the
  // model alias in agent.model; the seal validates what was requested and
  // approved, never the provider's normalized spelling.
  check("agent.requestedModel×pane", agent.requestedModel, pane.model);
  check("agent.accountId×pane", agent.accountId, pane.accountId);
  check("agent.effort×pane", agent.effort, pane.effort);
  // Canonical path only: symlink / trailing-slash / realpath spelling must not
  // tear down a healthy Maestro PTY (field: agent.cwd×pane false-negative).
  check(
    "agent.cwd×pane",
    agent.cwd === undefined ? undefined : path.resolve(agent.cwd),
    pane.cwd === undefined ? undefined : path.resolve(pane.cwd),
  );
  check("agent.missionId", agent.missionId, mission.id);
  check("agent.role", agent.role, "orchestrator");
  check("agent.readOnly×pane", agent.readOnly, pane.readOnly === true);
  check("pane.adapterId×runtime", pane.adapterId, approvedRuntime.adapterId);
  check("pane.model×runtime", pane.model, approvedRuntime.model);
  check("pane.accountId×runtime", pane.accountId, approvedRuntime.accountId);
  check("pane.effort×runtime", pane.effort, approvedRuntime.effort);
  check(
    "pane.readOnly×runtime",
    pane.readOnly === true,
    approvedRuntime.readOnly,
  );
  check("agent.readOnly×runtime", agent.readOnly, approvedRuntime.readOnly);
  check(
    "agent.nativeReadOnly×runtime",
    agent.nativeReadOnly,
    approvedRuntime.nativeReadOnly,
  );
  if (!sameMissionPaneAuthoritySeal(agent.authoritySeal, pane.authoritySeal)) {
    mismatches.push("agent.authoritySeal×pane");
  }
  if (!sameCapabilities(agent.allowedTools, pane.allowedTools)) {
    mismatches.push("agent.allowedTools×pane");
  }
  if (!sameCapabilities(agent.allowedSkills, pane.allowedSkills)) {
    mismatches.push("agent.allowedSkills×pane");
  }
  if (!sameScope(agent.scope, scope)) mismatches.push("agent.scope");
  check("authority.sessionId×agent", authority.sessionId, agent.sessionId);
  check("authority.paneId×pane", authority.paneId, pane.paneId);
  check("authority.kind", authority.kind, "cli-agent");
  check("authority.missionId", authority.missionId, mission.id);
  check("authority.role", authority.role, "orchestrator");
  if (!authority.scope || !sameScope(authority.scope, scope)) {
    mismatches.push("authority.scope");
  }
  return mismatches;
}

type RetirementPhysicalIdentity =
  | { readonly ok: true; readonly paneId: string }
  | { readonly ok: false; readonly detail: string };

function resolveRetirementPhysicalIdentity(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly sessionId: string;
  readonly pane?: MissionPaneSpec;
  readonly expectedAuthoritySeal?: MissionPaneAuthoritySeal;
  readonly agent: OwnedAgentSessionInfo | null;
  readonly authority: PaneRuntimeAuthority | null;
}): RetirementPhysicalIdentity {
  const { scope, missionId, sessionId, pane, agent, authority } = input;
  const paneId = pane?.paneId ?? agent?.paneId;
  const mismatches: string[] = [];
  if (!paneId) mismatches.push("paneId ausente");
  if (pane) {
    if (pane.missionId !== missionId) mismatches.push("pane.missionId");
    if (pane.role !== "orchestrator") mismatches.push("pane.role");
    if (pane.scope && !sameScope(pane.scope, scope)) {
      mismatches.push("pane.scope");
    }
  }
  if (!agent) {
    mismatches.push("agent ausente");
  } else {
    if (agent.sessionId !== sessionId) mismatches.push("agent.sessionId");
    if (agent.paneId !== paneId) mismatches.push("agent.paneId");
    if (agent.missionId !== missionId) mismatches.push("agent.missionId");
    if (agent.role !== "orchestrator") mismatches.push("agent.role");
    if (!sameScope(agent.scope, scope)) mismatches.push("agent.scope");
    const trustedSeal = pane
      ? pane.authoritySeal
      : input.expectedAuthoritySeal;
    if (
      trustedSeal &&
      !sameMissionPaneAuthoritySeal(agent.authoritySeal, trustedSeal)
    ) {
      mismatches.push("agent.authoritySeal");
    }
  }
  if (!authority) {
    mismatches.push("runtime authority ausente");
  } else {
    if (authority.sessionId !== sessionId) {
      mismatches.push("authority.sessionId");
    }
    if (authority.paneId !== paneId) mismatches.push("authority.paneId");
    if (authority.kind !== "cli-agent") mismatches.push("authority.kind");
    if (authority.missionId !== missionId) {
      mismatches.push("authority.missionId");
    }
    if (authority.role !== "orchestrator") mismatches.push("authority.role");
    if (!authority.scope || !sameScope(authority.scope, scope)) {
      mismatches.push("authority.scope");
    }
  }
  return paneId && mismatches.length === 0
    ? { ok: true, paneId }
    : {
        ok: false,
        detail: mismatches.slice(0, 8).join("; ") || "identidade ausente",
      };
}

function paneResult(
  pane: MissionPaneSpec,
  sessionId: string,
): MissionOrchestratorPane {
  if (!pane.paneId || !pane.cwd || !pane.agentName) {
    throw new Error("persisted orchestrator pane identity is incomplete");
  }
  return {
    paneId: pane.paneId,
    sessionId,
    adapterId: pane.adapterId,
    model: pane.model,
    accountId: pane.accountId,
    effort: pane.effort,
    cwd: pane.cwd,
    title: pane.title,
    agentName: pane.agentName,
    role: "orchestrator",
  };
}

function failureDetail(reason: string, cause?: unknown): string {
  const suffix =
    cause instanceof Error && cause.message.trim()
      ? ` ${cause.message.trim()}`
      : "";
  const detail = `${reason}${suffix}`.slice(0, 4_096);
  if (hasTerminalOperationalFailureMarker(detail)) return detail;
  const disposition = classifyOperationalFailure(cause ?? detail);
  const detailDisposition = classifyOperationalFailure(detail);
  return (
    disposition === 'terminal' || detailDisposition === 'terminal'
      ? terminalOperationalFailureReason(detail)
      : detail
  ).slice(0, 4_096);
}

function namedMissionFailureCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.match(/\b([a-z][a-z_]{6,50}):/i)?.[1] ??
    message.match(
      /\b((?:guided_plan|guided_prevc)_[a-z_]+|squad_runtime_unavailable)\b/i,
    )?.[1] ??
    null
  );
}

/** Capacity/ceremony gaps keep a live bootstrap; corrupt authority does not. */
function isDegradableBootstrapFailure(error: unknown): boolean {
  const code = namedMissionFailureCode(error);
  if (!code || LEGITIMATE_MISSION_BLOCKS.has(code)) return false;
  return (
    code.startsWith('guided_plan_') ||
    code.startsWith('guided_prevc_') ||
    code === 'squad_runtime_unavailable'
  );
}

const productionDeps: MissionOrchestratorBootstrapDeps = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  updateMission: (scope, missionId, patch) =>
    getProjectDomainStores(scope).missions.update(missionId, patch),
  transitionMissionLifecycle: (scope, missionId, expectation, patch) =>
    getProjectDomainStores(scope).missions.transitionLifecycle(
      missionId,
      expectation,
      patch,
    ),
  rebindMissionSquadAuthority: (
    scope,
    missionId,
    expected,
    squadId,
    contract,
  ) =>
    getProjectDomainStores(scope).missions.rebindMissionSquadAuthority(
      missionId,
      expected,
      squadId,
      contract,
    ),
  setOrchestratorSession: (scope, missionId, sessionId) =>
    getProjectDomainStores(scope).missions.setOrchestratorSession(
      missionId,
      sessionId,
    ),
  clearOrchestratorSessionIfMatches: (scope, missionId, expectedSessionId) =>
    getProjectDomainStores(scope).missions.clearOrchestratorSessionIfMatches(
      missionId,
      expectedSessionId,
    ),
  retireOrchestratorSessionForReplacement: (
    scope,
    missionId,
    expectedSessionId,
    expectedAuthoritySeal,
  ) =>
    getProjectDomainStores(
      scope,
    ).missions.retireOrchestratorSessionForReplacement(
      missionId,
      expectedSessionId,
      expectedAuthoritySeal,
    ),
  hasCurrentKickoffAcceptance: (scope, missionId) =>
    getProjectDomainStores(scope).missions.hasCurrentKickoffAcceptance(
      missionId,
    ),
  hasPendingKickoffFlight: (missionId) =>
    hasPendingMissionKickoffFlight(missionId),
  listMissionPanes: (scope, missionId) =>
    getProjectDomainStores(scope).missionPanes.list(missionId),
  recordMissionPane: (scope, input) =>
    getProjectDomainStores(scope).missionPanes.record(input),
  rebindMissionPaneAuthority: (scope, input) =>
    getProjectDomainStores(scope).missionPanes.rebindOrchestratorAuthority(
      input,
    ),
  removeMissionPane: (scope, paneRowId) =>
    getProjectDomainStores(scope).missionPanes.remove(paneRowId),
  getSquad: (squadId) => getSquad(squadId),
  resolveRuntime: (squad, orchestrator) =>
    resolveProductionMissionOrchestratorRuntime(squad, orchestrator),
  spawnMainOwnedPane: (input) => spawnMainOwnedMissionPaneAsync(input),
  closePane: (paneId) => requestPaneClose(paneId),
  suppressIntentionalExit: (input) =>
    suppressIntentionalMissionOrchestratorExit(input),
  listRuntimePanes: () => listPaneSnapshots(),
  getSessionState: (sessionId) => runtimeSessionState(sessionId),
  getAgentSessionInfo: (sessionId) => runtimeAgentSessionInfo(sessionId),
  getRuntimeAuthority: (sessionId) =>
    getPaneRuntimeAuthorityBySession(sessionId),
  submitKickoff: (scope, input) => submitMissionKickoffFromMain(scope, input),
  emitDispatched: (mission) => {
    emitMissionIntentEvent({
      name: 'task_dispatched',
      missionId: mission.id,
      squadId: mission.squadId,
      intentState: mission.intentState,
      intentVersion: mission.intentVersion,
      reason: 'main_orchestrator_bootstrap',
    });
  },
  emitProgress: (scope, missionId, step, detail) =>
    emitBootstrapProgress(scope, missionId, step, detail),
  validateAttachmentPaths: (paths) => validateDroppedAttachmentPaths(paths),
  snapshotAttachmentPaths: (paths) => snapshotDroppedAttachmentPaths(paths),
  revalidatePetStudioAttachmentSnapshots: (scope, snapshots) =>
    snapshots
      ? revalidateSealedAttachmentSnapshots(snapshots, {
          workspaceRootAuthority: workspaceRootAuthorityFromScope(scope),
          checkoutId: scope.checkoutId,
        })
      : undefined,
  ensurePlanGitBaseline: (scope, missionId) => {
    const mission = getProjectDomainStores(scope).missions.get(missionId);
    if (mission?.intentContract?.lane === 'plan') {
      ensurePlanLaneGitBaseline(scope);
    } else if (mission?.intentContract?.promotedPlan) {
      commitPromotedPlanToGit(
        scope,
        assertPromotedPlanSnapshot(mission.intentContract.promotedPlan),
      );
    }
  },
  ensureMissionPlan: (scope, missionId) =>
    ensureGuidedMissionPlanForScope(scope, missionId),
  warmSubscriptionAuth: () => warmSquadRuntimeSubscriptionAuth(),
  prepareOpportunisticPrevc: (scope, missionId) =>
    prepareOpportunisticPrevcContext(scope, missionId),
  ensureMissionPrevc: (scope, missionId) =>
    ensureGuidedMissionPrevcForScope(scope, missionId),
  missionDriverMode: () =>
    getOrchSettings().missionDriverActiveMode === true ? 'active' : 'shadow',
  warnDriverInactive: (scope, missionId) =>
    warnGuidedDeliveryDriverInactive(scope, missionId),
};

/**
 * The only initial-orchestrator materializer. The public input is scope +
 * mission id; provider, account, model, cwd, roster and grants are derived
 * from trusted main stores immediately before each external effect.
 */
export class MissionOrchestratorBootstrapService {
  readonly #deps: MissionOrchestratorBootstrapDeps;
  readonly #flights = new Map<
    string,
    Promise<MissionOrchestratorBootstrapResult>
  >();
  readonly #authorizedSnapshots = new Map<string, string>();
  readonly #authorizedApprovalSnapshots = new Map<string, string>();

  constructor(deps: MissionOrchestratorBootstrapDeps = productionDeps) {
    this.#deps = deps;
  }

  bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult> {
    const key = bootstrapFlightKey(scope, missionId);
    const existing = this.#flights.get(key);
    if (existing) return existing;
    const flight = this.#bootstrap(scope, missionId)
      .catch((error) =>
        this.#failure(
          scope,
          missionId,
          'materialization_failed',
          failureDetail(
            'O bootstrap main-owned falhou inesperadamente.',
            error,
          ),
        ),
      )
      .finally(() => {
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
        this.#authorizedSnapshots.delete(key);
        this.#authorizedApprovalSnapshots.delete(key);
      });
    this.#flights.set(key, flight);
    return flight;
  }

  async #bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult> {
    let initial = this.#deps.getMission(scope, missionId);
    const approvedStart =
      initial !== null &&
      hasCurrentApprovedDispatchContract(initial) &&
      ((initial.status === 'pending' &&
        initial.intentState === 'ready_to_start') ||
        hasCurrentDispatchAuthority(initial));
    if (!initial || !approvedStart) {
      return this.#failure(
        scope,
        missionId,
        'not_authorized',
        'O bootstrap exige a revisão aprovada vigente em ready_to_start ou uma execução já admitida.',
      );
    }
    this.#authorizedSnapshots.set(
      bootstrapFlightKey(scope, missionId),
      bootstrapMissionSnapshot(initial),
    );
    this.#authorizedApprovalSnapshots.set(
      bootstrapFlightKey(scope, missionId),
      bootstrapMissionApprovalSnapshot(initial),
    );
    this.#emitProgress(scope, missionId, 'authority_checked');
    // Worker authority never depends on PREVC preparation. Main prepares only
    // project context in parallel; freeze and review happen after handoff at
    // the promotion boundary so their seal cannot invalidate live workers.
    const guidedPrevcFrozen = false;
    let standardTopology: StandardMissionTopology = 'delivery';
    // The sync squad-readiness gate inside ensureMissionPlan reads only the
    // warm subscription cache; warm the keychain-only providers (AGY) first
    // so a live operator session is not read as login-needed. Recovery and
    // resume paths reach this bootstrap without any renderer IPC, so the
    // IPC-level warm alone is not sufficient here. Conditional await: when no
    // warm is configured the bootstrap must keep its synchronous
    // run-up-to-spawn so concurrent same-tick retries singleflight.
    this.#emitProgress(scope, missionId, 'subscription_auth');
    const subscriptionAuthWarm = this.#deps.warmSubscriptionAuth?.();
    if (subscriptionAuthWarm) {
      try {
        await raceWithTimeout(
          subscriptionAuthWarm,
          SUBSCRIPTION_AUTH_WARM_TIMEOUT_MS,
          () =>
            new Error(
              'warm de autenticação da assinatura excedeu 10s; seguindo sem warm',
            ),
        );
      } catch (warmError) {
        // A hung keychain cannot hold the boot. Continue without warm; if
        // auth is genuinely missing the squad-readiness gate fails closed
        // with a cause instead of silently logging in nobody.
        console.warn(
          `[mission-bootstrap] subscription warm skipped for ${missionId}:`,
          warmError,
        );
      }
    }
    const autopilot = isOperatorChoicePolicy(
      this.#deps.squadCliPolicy?.() ?? getOrchSettings().squadCliPolicy,
    );
    try {
      const requiresPrePlanGitBaseline =
        initial.intentContract?.lane === 'plan' ||
        Boolean(initial.intentContract?.promotedPlan);
      if (requiresPrePlanGitBaseline) {
        this.#deps.ensurePlanGitBaseline?.(scope, missionId);
      }
      const planResult = this.#deps.ensureMissionPlan?.(scope, missionId);
      if (
        planResult &&
        typeof planResult === 'object' &&
        'applicable' in planResult &&
        planResult.applicable === true &&
        'topology' in planResult &&
        (planResult.topology === 'team-read-only-fanout' ||
          planResult.topology === 'wave-pack')
      ) {
        standardTopology = planResult.topology;
      }
      if (
        !requiresPrePlanGitBaseline &&
        standardTopology !== 'team-read-only-fanout' &&
        standardTopology !== 'wave-pack'
      ) {
        this.#deps.ensurePlanGitBaseline?.(scope, missionId);
      }
    } catch (error) {
      const detail = failureDetail(
        'O plano main-owned não pôde ser selado antes de iniciar qualquer provider.',
        error,
      );
      if (!isDegradableBootstrapFailure(error) && !autopilot) {
        return this.#failure(scope, missionId, 'preflight_failed', detail);
      }
      if (isDegradableBootstrapFailure(error)) {
        this.#surfaceDegradation(scope, missionId, {
          what: 'preflight do plano',
          reducedTo: 'bootstrap reconciliável com escritor único',
          why: detail,
          recoverable: true,
          path: 'bootstrap.reconcile',
        });
      }
      console.warn(
        `[mission-bootstrap] plan seal degraded for ${missionId}:`,
        error,
      );
    }
    const replanned = this.#deps.getMission(scope, missionId);
    if (replanned) {
      // Planner D1 may re-pin a live fallback squad or append a degradation
      // note. Continue with that exact store snapshot, not the pre-plan view.
      initial = replanned;
      const key = bootstrapFlightKey(scope, missionId);
      this.#authorizedSnapshots.set(key, bootstrapMissionSnapshot(initial));
      this.#authorizedApprovalSnapshots.set(
        key,
        bootstrapMissionApprovalSnapshot(initial),
      );
    }
    this.#emitProgress(scope, missionId, 'plan_baseline');
    const guidedPrevcRequired = missionRequiresGuidedPrevc(
      initial,
      standardTopology,
    );
    // Guided delivery completion is driver-owned: with the driver disabled the
    // mission executes and then silently never flips to done. Surface that at
    // mission start instead of letting it die quietly at the finish line.
    if (
      guidedPrevcRequired &&
      (this.#deps.missionDriverMode?.() ?? 'active') !== 'active'
    ) {
      this.#deps.warnDriverInactive?.(scope, missionId);
    }

    const squad = initial.squadId ? this.#deps.getSquad(initial.squadId) : null;
    const orchestrator = squad ? chooseOrchestrator(squad) : null;
    if (!squad || !orchestrator) {
      return this.#failure(
        scope,
        missionId,
        'squad_missing',
        'O squad salvo ou seu orquestrador não está disponível.',
        undefined,
        'user',
      );
    }
    // D1: a mutable/catalog squad is a lower-capacity authority snapshot, not
    // a reason to wall a running mission. The planner already re-pins the
    // current roster; the bootstrap records the reduction and the recovery
    // supervisor will re-enter if the live identity disappears.
    if (!isMissionRuntimeSquadId(squad.id)) {
      this.#surfaceDegradation(scope, missionId, {
        what: 'identidade do squad',
        reducedTo: 'roster vivo do catálogo, reconciliado por inatividade',
        why: 'o squad aprovado ainda é mutável e não possui snapshot mission-runtime',
        recoverable: true,
        path: 'bootstrap.reconcile',
      });
      console.warn(
        `[mission-bootstrap] squad ${squad.id} is catalog-live; ` +
          `continuing with D1 reconciliation for ${missionId}`,
      );
    }
    let squadSnapshot = snapshotSquadAuthority(squad);
    if (initial.intentContract?.squadRevisionHash !== squadSnapshot.hash) {
      this.#surfaceDegradation(scope, missionId, {
        what: 'revisão do squad',
        reducedTo: 'roster vivo atual',
        why: 'o squad mudou depois da aprovação',
        recoverable: true,
        path: 'bootstrap.reconcile',
      });
      console.warn(
        `[mission-bootstrap] squadRevisionHash drift for ` +
          `${missionId}; continuing with live squad`,
      );
      // Re-pin the live roster into the main-owned mission contract before
      // computing the pane seal. The downgrade changes capacity, not the
      // operator's intent; leaving the old hash here would turn the same
      // recoverable catalog churn into a materialization wall.
      if (initial.intentContract) {
        const rebound = this.#deps.rebindMissionSquadAuthority(
          scope,
          missionId,
          initial,
          squad.id,
          {
            ...initial.intentContract,
            squadRevisionHash: squadSnapshot.hash,
          },
        );
        if (rebound) {
          initial = rebound;
          squadSnapshot = snapshotSquadAuthority(squad);
          const key = bootstrapFlightKey(scope, missionId);
          this.#authorizedSnapshots.set(key, bootstrapMissionSnapshot(initial));
          this.#authorizedApprovalSnapshots.set(
            key,
            bootstrapMissionApprovalSnapshot(initial),
          );
        }
      }
    }
    this.#emitProgress(scope, missionId, 'squad_sealed');
    // Only production call that persists mission_contracts for a guided
    // mission. It MUST fire before the authority seal is computed below:
    // freezing rotates the PREVC seal (contextRevision/contractHash), and a
    // seal captured before the freeze no longer matches the spawn fence,
    // which re-resolves the now-frozen contract ("stale mission pane
    // authority"). Never awaited: a slow/blocked Doctor bootstrap must not
    // delay or fail the Maestro's own spawn — but its synchronous prefix
    // (the actual freezeContract persistence) runs inline at this call, so
    // resolveMissionPaneAuthoritySeal already sees the frozen contract.
    // ensureGuidedMissionPrevc is idempotent and refuses to (re)freeze once
    // a worker has materialized; when the context is not ready (greenfield)
    // nothing freezes and both sides keep the intent-hash fallback seal.
    // Fast path / Pack / fan-out: never freeze PREVC on the spawn critical path
    // (docs/design/orch-fast-path.md). Only Guided-required missions pay this.
    // Do not emit prevc_freeze when skipping — vacancy UI would lie.
    if (guidedPrevcRequired) {
      this.#emitProgress(scope, missionId, 'prevc_freeze');
      try {
        void Promise.resolve(
          this.#deps.ensureMissionPrevc?.(scope, missionId),
        ).catch((error) => {
          console.warn(
            `[mission-bootstrap] PREVC freeze deferred for ${missionId}:`,
            error,
          );
        });
      } catch (error) {
        console.warn(
          `[mission-bootstrap] PREVC freeze deferred for ${missionId}:`,
          error,
        );
      }
    }
    const authoritySeal =
      resolveMissionPaneAuthoritySeal(scope, initial, squad) ?? undefined;
    if (!authoritySeal) {
      if (!autopilot) {
        return this.#failure(
          scope,
          missionId,
          "preflight_failed",
          "A revisão aprovada não pôde ser selada para o pane. Replaneje e aprove novamente.",
          undefined,
          "user",
        );
      }
      // Libre: spawn Maestro without a full seal rather than re-open approval.
      console.warn(
        `[mission-bootstrap] Autopilot: authority seal unavailable for ` +
          `${missionId}; continuing without seal`,
      );
    }

    let approvedRuntime = initial.intentContract?.orchestratorRuntime;
    let resolvedRuntime: MissionOrchestratorRuntimeSnapshot;
    try {
      resolvedRuntime = canonicalMissionOrchestratorRuntime(
        this.#deps.resolveRuntime(squad, orchestrator),
      );
    } catch (error) {
      return this.#failure(
        scope,
        missionId,
        'preflight_failed',
        failureDetail('O preflight do runtime do orquestrador falhou.', error),
        undefined,
        'user',
      );
    }
    if (!approvedRuntime) {
      // D1: older approvals without a runtime snapshot use the exact live
      // runtime resolved by Main, and the downgrade remains visible.
      this.#surfaceDegradation(scope, missionId, {
        what: 'snapshot do runtime',
        reducedTo: 'runtime vivo resolvido pelo Main',
        why: 'a aprovação não carregava provider/model/account pinados',
        recoverable: true,
        path: 'bootstrap.reconcile',
      });
      console.warn(
        `[mission-bootstrap] missing orchestratorRuntime for ` +
          `${missionId}; using live resolved runtime`,
      );
      approvedRuntime = resolvedRuntime;
    }
    if (!sameMissionOrchestratorRuntime(approvedRuntime, resolvedRuntime)) {
      if (resolvedRuntime.nativeReadOnly === false) {
        return this.#failure(
          scope,
          missionId,
          'preflight_failed',
          'O runtime resolvido não oferece confinamento nativo seguro para o orquestrador.',
          undefined,
          'user',
        );
      }
      this.#surfaceDegradation(scope, missionId, {
        what: 'runtime do orquestrador',
        reducedTo: 'runtime vivo seguro, com reentrada por inatividade',
        why: 'provider, modelo, conta, esforço ou confinamento mudaram desde a aprovação',
        recoverable: true,
        path: 'bootstrap.reconcile',
      });
      console.warn(
        `[mission-bootstrap] runtime drift after approval for ` +
          `${missionId}; using safe live runtime and recovery network`,
      );
      approvedRuntime = resolvedRuntime;
    }
    // External effects consume the persisted approval, never a mutable
    // settings object. On Autopilot we still honor the approved snapshot so
    // the operator's review remains the authority of record.
    const runtime = approvedRuntime;
    this.#emitProgress(scope, missionId, 'runtime_checked');
    let isPrevcPreparationStarted = false;
    const preparePrevcInBackground = (): void => {
      if (!guidedPrevcRequired) return;
      if ((initial.intentContract?.lane ?? 'standard') !== 'standard') return;
      if (isPrevcPreparationStarted) return;
      isPrevcPreparationStarted = true;
      try {
        void Promise.resolve(
          this.#deps.prepareOpportunisticPrevc?.(scope, missionId),
        ).catch((error) => {
          console.warn(
            `[mission-bootstrap] PREVC context preparation deferred for ${missionId}:`,
            error,
          );
        });
      } catch (error) {
        console.warn(
          `[mission-bootstrap] PREVC context preparation deferred for ${missionId}:`,
          error,
        );
      }
      // O freeze Main-owned roda antes do cômputo do authority seal (ver
      // acima, antes de resolveMissionPaneAuthoritySeal) — aqui ele já é
      // idempotentemente no-op.
    };

    let activeOrchestratorSessionId = initial.orchestratorSessionId;
    let persistedOrchestrator = this.#deps
      .listMissionPanes(scope, missionId)
      .find((pane) => pane.role === "orchestrator");
    if (
      persistedOrchestrator &&
      !sameMissionPaneAuthoritySeal(
        persistedOrchestrator.authoritySeal,
        authoritySeal,
      )
    ) {
      if (
        authoritySeal &&
        persistedOrchestrator.paneId &&
        persistedOrchestrator.authoritySeal &&
        sameMissionPaneApprovalSeal(
          persistedOrchestrator.authoritySeal,
          authoritySeal,
        ) &&
        this.#deps.rebindMissionPaneAuthority
      ) {
        try {
          persistedOrchestrator = this.#deps.rebindMissionPaneAuthority(scope, {
            missionId,
            paneId: persistedOrchestrator.paneId,
            expectedAuthoritySeal: persistedOrchestrator.authoritySeal,
            authoritySeal,
          });
        } catch (error) {
          return this.#failure(
            scope,
            missionId,
            "preflight_failed",
            failureDetail(
              "O reseal do orquestrador após freeze/refreeze falhou.",
              error,
            ),
          );
        }
      } else if (!persistedOrchestrator.authoritySeal) {
        // Pre-seal releases persisted orchestrator rows without revision
        // authority. A currently approved contract is enough to retire that
        // legacy physical identity; it is not a reason to make the operator
        // replan the same intent forever.
        const retired = activeOrchestratorSessionId
          ? await this.#retireUnacceptedKickoffSession(
              scope,
              missionId,
              persistedOrchestrator,
              activeOrchestratorSessionId,
              authoritySeal,
            )
          : await this.#retireUnboundPersistedOrchestrator(
              scope,
              missionId,
              persistedOrchestrator,
              authoritySeal,
            );
        if (!retired.ok) return retired.result;
        activeOrchestratorSessionId = undefined;
        persistedOrchestrator = undefined;
      } else {
        return this.#failure(
          scope,
          missionId,
          "preflight_failed",
          "O pane persistido pertence a outra revisão de intenção, contexto, " +
            "contrato ou squad. Replaneje e aprove antes de retomar.",
          undefined,
          "user",
        );
      }
    }

    // A mission-session binding without its pane row is a torn transaction.
    // It must be physically retired (or proven already dead) before minting a
    // replacement, otherwise every reconciler pass either loops or duplicates
    // a still-running provider.
    if (activeOrchestratorSessionId && !persistedOrchestrator) {
      const retired = await this.#retireUnacceptedKickoffSession(
        scope,
        missionId,
        undefined,
        activeOrchestratorSessionId,
        authoritySeal,
      );
      if (!retired.ok) return retired.result;
      activeOrchestratorSessionId = undefined;
    }
    if (!activeOrchestratorSessionId && persistedOrchestrator) {
      const retired = await this.#retireUnboundPersistedOrchestrator(
        scope,
        missionId,
        persistedOrchestrator,
        authoritySeal,
      );
      if (!retired.ok) return retired.result;
      persistedOrchestrator = undefined;
    }
    this.#emitProgress(scope, missionId, "drift_retired");

    if (activeOrchestratorSessionId && persistedOrchestrator) {
      const sessionId = activeOrchestratorSessionId;
      const sessionState = this.#deps.getSessionState(sessionId);
      const agent = this.#deps.getAgentSessionInfo(sessionId);
      const authority = this.#deps.getRuntimeAuthority(sessionId);
      const mismatches =
        sessionState === null
          ? []
          : runtimeAuthorityMismatches(
              scope,
              initial,
              persistedOrchestrator,
              agent,
              authority,
              runtime,
            );
      const hasExactLiveRuntime = Boolean(
        sessionState !== null && mismatches.length === 0,
      );
      if (sessionState === null) {
        const retired = await this.#retireUnacceptedKickoffSession(
          scope,
          missionId,
          persistedOrchestrator,
          sessionId,
          authoritySeal,
        );
        if (!retired.ok) return retired.result;
        activeOrchestratorSessionId = undefined;
        persistedOrchestrator = undefined;
      } else if (!hasExactLiveRuntime) {
        return this.#failure(
          scope,
          missionId,
          "preflight_failed",
          failureDetail(
            "A autoridade física do orquestrador persistido divergiu do contrato aprovado.",
            new Error(mismatches.slice(0, 8).join("; ")),
          ),
        );
      }
    }

    if (activeOrchestratorSessionId && persistedOrchestrator) {
      const sessionId = activeOrchestratorSessionId;
      preparePrevcInBackground();
      if (this.#deps.hasCurrentKickoffAcceptance(scope, missionId)) {
        const admitted = this.#commitStartAdmission(
          scope,
          missionId,
          sessionId,
          persistedOrchestrator,
          runtime,
        );
        if (!admitted.ok) return admitted.result;
        return {
          ok: true,
          missionId,
          pane: paneResult(persistedOrchestrator, sessionId),
          kickoff: { accepted: true },
          reused: true,
        };
      }
      // Recibo a caminho ≠ recibo ausente. O aceite leva de segundos a minutos
      // e o reconciliador re-entra a cada 5s; não interrompa um voo legítimo.
      if (this.#deps.hasPendingKickoffFlight(missionId)) {
        return {
          ok: true,
          missionId,
          pane: paneResult(persistedOrchestrator, sessionId),
          kickoff: { accepted: true },
          reused: true,
        };
      }
      // A sessão viva sem voo nem receipt não tem um estado que possa ser
      // retomado com segurança. Prove a saída física exata, remova somente sua
      // identidade durável e siga pelo spawn fresco na mesma singleflight.
      const retired = await this.#retireUnacceptedKickoffSession(
        scope,
        missionId,
        persistedOrchestrator,
        sessionId,
        authoritySeal,
      );
      if (!retired.ok) return retired.result;
      activeOrchestratorSessionId = undefined;
      persistedOrchestrator = undefined;
    }

    let attachmentPaths: string[] | undefined;
    let attachmentSnapshots: MissionAttachmentSnapshot[] | undefined;
    const initialContract = initial.intentContract;
    try {
      if (!initialContract) {
        throw new Error("mission attachment contract is unavailable");
      }
      if (initial.squadId === PET_STUDIO_SQUAD_ID) {
        if (!this.#deps.revalidatePetStudioAttachmentSnapshots) {
          throw new Error("Pet Studio attachment validation is unavailable");
        }
        attachmentSnapshots =
          this.#deps.revalidatePetStudioAttachmentSnapshots(
            scope,
            initialContract.attachmentSnapshots,
          );
        if (
          attachmentSnapshots?.length !== 1 ||
          initialContract.attachmentPaths?.length !== 1 ||
          initialContract.attachmentPaths[0] !==
            attachmentSnapshots[0]?.path
        ) {
          throw new Error("Pet Studio sealed attachment identity is invalid");
        }
        attachmentPaths = attachmentSnapshots.map((snapshot) => snapshot.path);
      } else {
        attachmentPaths = this.#deps.validateAttachmentPaths(
          initialContract.attachmentPaths,
        );
        attachmentSnapshots =
          this.#deps.snapshotAttachmentPaths(attachmentPaths);
      }
      if (
        !sameAttachmentSnapshots(
          initialContract.attachmentSnapshots,
          attachmentSnapshots,
        )
      ) {
        throw new Error(
          "o conteúdo dos anexos mudou desde a aprovação; nova aprovação é obrigatória",
        );
      }
    } catch (error) {
      return this.#failure(
        scope,
        missionId,
        "preflight_failed",
        failureDetail("A validação dos anexos da missão falhou.", error),
        undefined,
        "user",
      );
    }
    this.#emitProgress(scope, missionId, "attachments_verified");

    const title = `${squad.name} · orq`;
    preparePrevcInBackground();
    const spawn = await this.#deps.spawnMainOwnedPane({
      adapterId: runtime.adapterId,
      model: runtime.model,
      accountId: runtime.accountId,
      effort: runtime.effort,
      cwd: scope.rootRealPath,
      title,
      missionId,
      agentName: orchestrator.agentName,
      allowedTools: orchestrator.allowedTools,
      allowedSkills: orchestrator.allowedSkills,
      role: "orchestrator",
      scope,
      executionScope: scope,
      // MCP remains delegation-capable. Native Bash/Edit/git is independently
      // denied by the provider confinement selected above.
      readOnly: runtime.readOnly,
      nativeReadOnly: runtime.nativeReadOnly,
      authoritySeal,
    });
    if (!spawn.ok || !spawn.paneId || !spawn.sessionId) {
      return this.#failure(
        scope,
        missionId,
        "spawn_failed",
        `O provider do orquestrador não iniciou. ${
          spawn.error ?? "Falha física sem detalhe."
        }`,
      );
    }
    this.#emitProgress(scope, missionId, "pane_spawned");

    let paneRow: MissionPaneSpec | null = null;
    let sessionBound = false;
    try {
      paneRow = this.#deps.recordMissionPane(scope, {
        missionId,
        paneId: spawn.paneId,
        adapterId: runtime.adapterId,
        model: runtime.model,
        accountId: runtime.accountId,
        effort: runtime.effort,
        cwd: scope.rootRealPath,
        title,
        agentName: orchestrator.agentName,
        role: "orchestrator",
        allowedTools: orchestrator.allowedTools,
        allowedSkills: orchestrator.allowedSkills,
        readOnly: runtime.readOnly,
        executionScope: scope,
        authoritySeal,
      });
      const bound = this.#deps.setOrchestratorSession(
        scope,
        missionId,
        spawn.sessionId,
      );
      if (!bound) throw new Error("mission disappeared during bootstrap");
      sessionBound = true;
      const current = this.#deps.getMission(scope, missionId);
      const agent = this.#deps.getAgentSessionInfo(spawn.sessionId);
      const authority = this.#deps.getRuntimeAuthority(spawn.sessionId);
      if (!current) {
        throw new Error("mission disappeared before authority seal");
      }
      const mismatches = runtimeAuthorityMismatches(
        scope,
        current,
        paneRow,
        agent,
        authority,
        runtime,
      );
      if (mismatches.length > 0) {
        const detail =
          "spawned PTY did not retain exact mission authority — divergências: " +
          mismatches.slice(0, 8).join("; ");
        // Autopilot: first pane already exists — log and continue rather than
        // tearing down the mission over cosmetic authority-field drift.
        if (autopilot) {
          console.warn(`[mission-bootstrap] Autopilot: ${detail}`);
        } else {
          throw new Error(detail);
        }
      }


      const compactMemory = compactMissionContext({ mission: current });
      const prompt = buildIntentDispatchKickoffPrompt({
        squad,
        missionId,
        missionTitle: current.title,
        goal: current.intentContract!.goal,
        acceptanceCriteria: current.intentContract!.acceptanceCriteria,
        risk: current.intentContract!.risk,
        maxWorkers: current.intentContract!.budgets.maxWorkers,
        lane: current.intentContract!.lane ?? "standard",
        contextPaths: current.intentContract!.contextPaths,
        attachmentPaths,
        compactMemoryMarkdown: missionCompactHasProgress(compactMemory)
          ? renderMissionCompact(compactMemory)
          : null,
        promotedPlan: current.intentContract!.promotedPlan
          ? assertPromotedPlanSnapshot(current.intentContract!.promotedPlan)
          : undefined,
        guidedPrevcRequired,
        guidedPrevcFrozen,
        standardTopology,
        // The prompt must state the policy actually in force; otherwise the
        // Maestro substitutes Codex for the operator's chosen executor.
        operatorChoice: autopilot,
        uiMissionObjective: isUiMissionText(
          [
            current.intentContract!.goal,
            ...current.intentContract!.acceptanceCriteria,
          ].join("\n"),
        ),
      });
      this.#emitProgress(scope, missionId, "kickoff_submitted");
      const kickoffAttempt = await this.#deps.submitKickoff(scope, {
        missionId,
        sessionId: spawn.sessionId,
        prompt,
      });
      if (!kickoffAttempt.accepted) {
        const failure = this.#failure(
          scope,
          missionId,
          'materialization_failed',
          `kickoff-${kickoffAttempt.reason}: ${kickoffAttempt.detail}`,
          bootstrapMissionSnapshot(
            this.#deps.getMission(scope, missionId) ?? current,
          ),
        );
        return kickoffAttempt.retryScheduled
          ? {
              ...failure,
              cta: BOOTSTRAP_AUTO_RETRY_CTA,
              retryScheduled: true,
            }
          : failure;
      }
      this.#emitProgress(scope, missionId, "kickoff_accepted");
      const admitted = this.#commitStartAdmission(
        scope,
        missionId,
        spawn.sessionId,
        paneRow,
        runtime,
      );
      if (!admitted.ok) return admitted.result;
      return {
        ok: true,
        missionId,
        pane: paneResult(paneRow, spawn.sessionId),
        kickoff: kickoffAttempt,
      };
    } catch (error) {
      const detail = failureDetail(
        "O bootstrap não pôde selar a autoridade da sessão.",
        error,
      );
      const currentBeforeTeardown = this.#deps.getMission(scope, missionId);
      const failure = this.#failure(
        scope,
        missionId,
        "materialization_failed",
        detail,
        currentBeforeTeardown
          ? bootstrapMissionSnapshot(currentBeforeTeardown)
          : undefined,
      );

      // Revoke durable mission authority before waiting for the physical
      // process. The binding remains the source of truth until closePane
      // returns an affirmative exit proof.
      let physicallyClosed = false;
      try {
        physicallyClosed = await this.#deps.closePane(spawn.paneId);
      } catch {
        physicallyClosed = false;
      }
      if (physicallyClosed) {
        const current = this.#deps.getMission(scope, missionId);
        if (
          sessionBound &&
          current?.orchestratorSessionId === spawn.sessionId
        ) {
          this.#deps.setOrchestratorSession(scope, missionId, null);
        }
        if (paneRow) this.#deps.removeMissionPane(scope, paneRow.id);
      } else {
        this.#markTerminationPending(scope, missionId, spawn.sessionId, detail);
      }
      return failure;
    }
  }

  async #retireUnacceptedKickoffSession(
    scope: ProjectExecutionScope,
    missionId: string,
    pane: MissionPaneSpec | undefined,
    sessionId: string,
    expectedAuthoritySeal?: MissionPaneAuthoritySeal,
  ): Promise<KickoffSessionRetirementResult> {
    const detail =
      "A sessão existe sem receipt durável nem kickoff em voo. O Nexus precisa " +
      "encerrar esse processo antes de iniciar uma sessão fresca.";
    const releaseExitSuppression = this.#deps.suppressIntentionalExit({
      scope,
      missionId,
      orchestratorSessionId: sessionId,
      authoritySeal: expectedAuthoritySeal,
    });
    try {
      if (this.#deps.getSessionState(sessionId) === null) {
        if (pane?.paneId) {
          // Best-effort registry/UI cleanup. The absent PTY state is already
          // the proof that no process can race the fresh spawn. Keep the exact
          // exit lease through durable binding cleanup so the reconciler
          // cannot manufacture a pre-dispatch block in between.
          await this.#closePaneWithExitProof(pane.paneId);
        }
        return this.#clearRetiredKickoffIdentity(
          scope,
          missionId,
          pane,
          sessionId,
          expectedAuthoritySeal,
        );
      }
      const physical = resolveRetirementPhysicalIdentity({
        scope,
        missionId,
        sessionId,
        pane,
        expectedAuthoritySeal,
        agent: this.#deps.getAgentSessionInfo(sessionId),
        authority: this.#deps.getRuntimeAuthority(sessionId),
      });
      if (!physical.ok) {
        return {
          ok: false,
          result: this.#failure(
            scope,
            missionId,
            "preflight_failed",
            terminalOperationalFailureReason(
              "A sessão antiga continua viva, mas sua identidade física divergiu " +
                `da missão aprovada (${physical.detail}).`,
            ),
          ),
        };
      }
      const physicallyClosed = await this.#closePaneWithExitProof(
        physical.paneId,
      );
      if (!physicallyClosed) {
        const result = this.#failure(
          scope,
          missionId,
          "materialization_failed",
          detail,
        );
        this.#markTerminationPending(scope, missionId, sessionId, detail);
        return { ok: false, result };
      }
      return this.#clearRetiredKickoffIdentity(
        scope,
        missionId,
        pane,
        sessionId,
        expectedAuthoritySeal,
      );
    } finally {
      releaseExitSuppression();
    }
  }

  async #retireUnboundPersistedOrchestrator(
    scope: ProjectExecutionScope,
    missionId: string,
    pane: MissionPaneSpec,
    expectedAuthoritySeal?: MissionPaneAuthoritySeal,
  ): Promise<KickoffSessionRetirementResult> {
    const paneId = pane.paneId;
    if (!paneId) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          "preflight_failed",
          terminalOperationalFailureReason(
            "O registro legado do orquestrador não possui identidade física.",
          ),
        ),
      };
    }
    const matches = this.#deps
      .listRuntimePanes()
      .filter((candidate) => candidate.paneId === paneId);
    if (matches.length > 1) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          "preflight_failed",
          terminalOperationalFailureReason(
            "Mais de um pane físico reivindica a identidade do orquestrador legado.",
          ),
        ),
      };
    }
    const runtimePane = matches[0];
    const sessionId = runtimePane?.sessionId ?? null;
    if (runtimePane && !this.#isExactRuntimePane(scope, missionId, runtimePane)) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          "preflight_failed",
          terminalOperationalFailureReason(
            "O pane físico legado pertence a outra missão, função ou workspace.",
          ),
        ),
      };
    }
    if (sessionId && this.#deps.getSessionState(sessionId) !== null) {
      const physical = resolveRetirementPhysicalIdentity({
        scope,
        missionId,
        sessionId,
        pane,
        expectedAuthoritySeal,
        agent: this.#deps.getAgentSessionInfo(sessionId),
        authority: this.#deps.getRuntimeAuthority(sessionId),
      });
      if (!physical.ok) {
        return {
          ok: false,
          result: this.#failure(
            scope,
            missionId,
            "preflight_failed",
            terminalOperationalFailureReason(
              "A sessão física do pane legado divergiu da missão aprovada " +
                `(${physical.detail}).`,
            ),
          ),
        };
      }
      if (!(await this.#closePaneWithExitProof(physical.paneId))) {
        return {
          ok: false,
          result: this.#failure(
            scope,
            missionId,
            "materialization_failed",
            "O pane legado continua vivo; o Nexus tentará o teardown novamente.",
          ),
        };
      }
    } else if (runtimePane) {
      // No live PTY remains. Ask the registry to drop its presentation entry,
      // but do not let an already-dead pane hold mission execution hostage.
      await this.#closePaneWithExitProof(paneId);
    }
    return this.#removeRetiredPaneIdentity(scope, missionId, pane);
  }

  #isExactRuntimePane(
    scope: ProjectExecutionScope,
    missionId: string,
    pane: PaneSnapshot,
  ): boolean {
    return (
      pane.missionId === missionId &&
      pane.role === "orchestrator" &&
      Boolean(pane.scope && sameScope(pane.scope, scope))
    );
  }

  async #closePaneWithExitProof(paneId: string): Promise<boolean> {
    try {
      return await this.#deps.closePane(paneId);
    } catch {
      return false;
    }
  }

  #clearRetiredKickoffIdentity(
    scope: ProjectExecutionScope,
    missionId: string,
    pane: MissionPaneSpec | undefined,
    sessionId: string,
    expectedAuthoritySeal?: MissionPaneAuthoritySeal,
  ): KickoffSessionRetirementResult {
    const current = this.#deps.getMission(scope, missionId);
    if (!current || current.orchestratorSessionId !== sessionId) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          "not_authorized",
          "A autoridade do orquestrador mudou durante o teardown físico.",
        ),
      };
    }
    const cleared = this.#deps.retireOrchestratorSessionForReplacement(
      scope,
      missionId,
      sessionId,
      expectedAuthoritySeal,
    );
    if (!cleared) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          "materialization_failed",
          "A missão desapareceu após o teardown físico do orquestrador.",
        ),
      };
    }
    this.#authorizedSnapshots.set(
      bootstrapFlightKey(scope, missionId),
      bootstrapMissionSnapshot(cleared),
    );
    const paneRetirement: KickoffSessionRetirementResult = pane
      ? this.#removeRetiredPaneIdentity(
          scope,
          missionId,
          pane,
          bootstrapMissionSnapshot(cleared),
        )
      : { ok: true };
    if (!paneRetirement.ok) return paneRetirement;
    if (
      cleared.status === "running" &&
      hasCurrentDispatchAuthority(cleared) &&
      missionMatchesExpectedAuthoritySeal(
        cleared,
        expectedAuthoritySeal,
      ) &&
      bootstrapMissionApprovalSnapshot(cleared) ===
        this.#authorizedApprovalSnapshots.get(
          bootstrapFlightKey(scope, missionId),
        )
    ) {
      return { ok: true };
    }
    const retryScheduled = hasAutomaticTechnicalRecovery(cleared);
    return {
      ok: false,
      result: {
        ok: false,
        missionId,
        reason: retryScheduled ? "provider_exited" : "not_authorized",
        error:
          "A sessão antiga encerrou, mas a missão mudou antes do respawn. " +
          (retryScheduled
            ? "A recuperação automática continuará com o contrato vigente."
            : "O Nexus preservou o novo estado da missão."),
        cta: retryScheduled ? BOOTSTRAP_AUTO_RETRY_CTA : BOOTSTRAP_CTA,
        ...(retryScheduled ? { retryScheduled: true } : {}),
      },
    };
  }

  #removeRetiredPaneIdentity(
    scope: ProjectExecutionScope,
    missionId: string,
    pane: MissionPaneSpec,
    expectedCurrentSnapshot?: string,
  ): KickoffSessionRetirementResult {
    const durable = this.#deps
      .listMissionPanes(scope, missionId)
      .find((candidate) => candidate.id === pane.id);
    if (
      durable &&
      (durable.missionId !== missionId ||
        durable.paneId !== pane.paneId ||
        durable.role !== "orchestrator")
    ) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          "preflight_failed",
          terminalOperationalFailureReason(
            "A identidade durável do pane mudou durante o teardown.",
          ),
          expectedCurrentSnapshot,
        ),
      };
    }
    if (!durable) return { ok: true };
    const removed = this.#deps.removeMissionPane(scope, pane.id);
    const stillPersisted =
      !removed &&
      this.#deps
        .listMissionPanes(scope, missionId)
        .some((candidate) => candidate.id === pane.id);
    if (stillPersisted) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          "materialization_failed",
          "O processo antigo encerrou, mas o registro do pane não pôde ser removido.",
          expectedCurrentSnapshot,
        ),
      };
    }
    return { ok: true };
  }

  #markTerminationPending(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string,
    detail: string,
  ): void {
    const current = this.#deps.getMission(scope, missionId);
    if (
      !current ||
      current.orchestratorSessionId !== sessionId ||
      current.status === "done" ||
      current.status === "failed"
    ) {
      return;
    }
    const note =
      `${BOOTSTRAP_TERMINATION_PENDING_MARKER}\n` +
      `## Encerramento físico pendente\n${detail} O Nexus preservou o vínculo ` +
      `do pane até obter prova de saída. CTA: ${BOOTSTRAP_CTA}.`;
    const description = current.description.includes(
      BOOTSTRAP_TERMINATION_PENDING_MARKER,
    )
      ? current.description
      : [current.description.trim(), note]
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 65_536);
    this.#deps.transitionMissionLifecycle(
      scope,
      missionId,
      {
        updatedAt: current.updatedAt,
        intentVersion: current.intentVersion ?? 0,
      },
      {
        status: 'blocked',
        intentState: 'blocked_technical',
        description,
      },
    );
  }

  /**
   * D1 lower tier for bootstrap capacity gaps. It keeps the exact running
   * mission/intent authority and relies on the recovery coordinator's nudge /
   * inactivity cadence to re-enter; it never turns a transient gap into a
   * blocked mission.
   */
  #commitStartAdmission(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string,
    pane: MissionPaneSpec,
    runtime: MissionOrchestratorRuntimeSnapshot,
  ):
    | { readonly ok: true; readonly mission: Mission }
    | {
        readonly ok: false;
        readonly result: MissionOrchestratorBootstrapResult;
      } {
    let current = this.#deps.getMission(scope, missionId);
    const sessionState = this.#deps.getSessionState(sessionId);
    const live =
      sessionState === 'spawning' ||
      sessionState === 'busy' ||
      sessionState === 'idle';
    const mismatches = current
      ? runtimeAuthorityMismatches(
          scope,
          current,
          pane,
          this.#deps.getAgentSessionInfo(sessionId),
          this.#deps.getRuntimeAuthority(sessionId),
          runtime,
        )
      : ['mission ausente'];
    const admission = evaluateMissionAdmission({
      hasDispatchAuthority: Boolean(
        current && hasCurrentApprovedDispatchContract(current),
      ),
      hasCurrentKickoffReceipt:
        this.#deps.hasCurrentKickoffAcceptance(scope, missionId),
      orchestratorLive: live && mismatches.length === 0,
    });
    if (!current || !admission.ok) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          'materialization_failed',
          `mission-start-admission:${admission.ok ? 'authority-missing' : admission.code}`,
          current ? bootstrapMissionSnapshot(current) : undefined,
        ),
      };
    }

    let promoted = false;
    if (
      current.status === 'pending' &&
      current.intentState === 'ready_to_start'
    ) {
      const dispatched = this.#deps.transitionMissionLifecycle(
        scope,
        missionId,
        {
          updatedAt: current.updatedAt,
          intentVersion: current.intentVersion ?? 0,
        },
        { status: 'running', intentState: 'dispatched' },
      );
      if (!dispatched) {
        return {
          ok: false,
          result: this.#failure(
            scope,
            missionId,
            'materialization_failed',
            'mission-start-admission:authority-missing — lifecycle CAS changed before dispatch',
            bootstrapMissionSnapshot(current),
          ),
        };
      }
      current = dispatched;
      promoted = true;
    }
    if (
      current.status === 'running' &&
      current.intentState === 'dispatched'
    ) {
      const executing = this.#deps.transitionMissionLifecycle(
        scope,
        missionId,
        {
          updatedAt: current.updatedAt,
          intentVersion: current.intentVersion ?? 0,
        },
        { status: 'running', intentState: 'executing' },
      );
      if (!executing) {
        return {
          ok: false,
          result: this.#failure(
            scope,
            missionId,
            'materialization_failed',
            'mission-start-admission:authority-missing — lifecycle CAS changed before execution',
            bootstrapMissionSnapshot(current),
          ),
        };
      }
      current = executing;
      promoted = true;
    }

    const finalSessionState = this.#deps.getSessionState(sessionId);
    const finalAdmission = evaluateMissionAdmission({
      hasDispatchAuthority: hasCurrentDispatchAuthority(current),
      hasCurrentKickoffReceipt:
        this.#deps.hasCurrentKickoffAcceptance(scope, missionId),
      orchestratorLive:
        (finalSessionState === 'spawning' ||
          finalSessionState === 'busy' ||
          finalSessionState === 'idle') &&
        runtimeAuthorityMismatches(
          scope,
          current,
          pane,
          this.#deps.getAgentSessionInfo(sessionId),
          this.#deps.getRuntimeAuthority(sessionId),
          runtime,
        ).length === 0,
    });
    if (!finalAdmission.ok) {
      return {
        ok: false,
        result: this.#failure(
          scope,
          missionId,
          'materialization_failed',
          `mission-start-admission:${finalAdmission.code}`,
          bootstrapMissionSnapshot(current),
        ),
      };
    }
    if (promoted) this.#deps.emitDispatched(current);
    return { ok: true, mission: current };
  }

  #surfaceDegradation(
    scope: ProjectExecutionScope,
    missionId: string,
    degradation: MissionDegradation,
  ): void {
    try {
      const current = this.#deps.getMission(scope, missionId);
      if (
        !current ||
        current.status !== 'running' ||
        !hasCurrentDispatchAuthority(current)
      ) {
        return;
      }
      const description = appendMissionDegradationNote(
        current.description ?? '',
        describeMissionDegradation(degradation),
      );
      const updated = this.#deps.updateMission(scope, missionId, {
        description,
      });
      const effective = updated ?? current;
      const key = bootstrapFlightKey(scope, missionId);
      this.#authorizedSnapshots.set(key, bootstrapMissionSnapshot(effective));
      this.#authorizedApprovalSnapshots.set(
        key,
        bootstrapMissionApprovalSnapshot(effective),
      );
      const intentVersion =
        effective.intentContract?.intentVersion ?? effective.intentVersion;
      emitMissionDegradation(scope, missionId, degradation, intentVersion);
      emitMissionDegradationNudge(scope, missionId, degradation, intentVersion);
    } catch (error) {
      // Observability is best effort. The physical authority and recovery
      // supervisor remain the safety net when the card/journal cannot write.
      console.warn(
        `[mission-bootstrap] degradation surface failed for ${missionId}:`,
        error,
      );
    }
  }

  /**
   * Telemetry only: never awaited, never a gate, never allowed to fail the
   * bootstrap — a broken journal must keep the card static, not the mission.
   */
  #emitProgress(
    scope: ProjectExecutionScope,
    missionId: string,
    step: BootstrapProgressStep,
    detail?: string,
  ): void {
    try {
      this.#deps.emitProgress?.(scope, missionId, step, detail);
    } catch (error) {
      console.warn(
        `[mission-bootstrap] bootstrap progress emission failed for ${missionId}/${step}:`,
        error,
      );
    }
  }

  #failure(
    scope: ProjectExecutionScope,
    missionId: string,
    reason: Extract<
      MissionOrchestratorBootstrapResult,
      { ok: false }
    >["reason"],
    detail: string,
    expectedCurrentSnapshot?: string,
    blockKind: "technical" | "user" = "technical",
  ): Extract<MissionOrchestratorBootstrapResult, { ok: false }> {
    const current = this.#deps.getMission(scope, missionId);
    const key = bootstrapFlightKey(scope, missionId);
    const authorizedSnapshot = this.#authorizedSnapshots.get(key);
    const authorizedApprovalSnapshot =
      this.#authorizedApprovalSnapshots.get(key);
    const exactSnapshot = expectedCurrentSnapshot ?? authorizedSnapshot;
    const effectiveBlockKind =
      blockKind === "technical" &&
      hasTerminalOperationalFailureMarker(detail)
        ? "user"
        : blockKind;
    let retryScheduled = false;
    if (
      reason !== "not_authorized" &&
      exactSnapshot !== undefined &&
      authorizedApprovalSnapshot !== undefined &&
      current &&
      bootstrapMissionSnapshot(current) === exactSnapshot &&
      bootstrapMissionApprovalSnapshot(current) ===
        authorizedApprovalSnapshot &&
      current.status !== "done" &&
      current.status !== "failed"
    ) {
      const nextCta =
        effectiveBlockKind === "technical"
          ? BOOTSTRAP_AUTO_RETRY_CTA
          : BOOTSTRAP_CTA;
      const note =
        `${BOOTSTRAP_BLOCK_MARKER}\n## Orquestrador não iniciado\n${detail} ` +
        `CTA: ${nextCta}.`;
      const description = current.description.includes(BOOTSTRAP_BLOCK_MARKER)
        ? current.description
        : [current.description.trim(), note]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 65_536);
      const blocked = this.#deps.transitionMissionLifecycle(
        scope,
        missionId,
        {
          updatedAt: current.updatedAt,
          intentVersion: current.intentVersion ?? 0,
        },
        {
          status: 'blocked',
          intentState:
            effectiveBlockKind === 'technical'
              ? 'blocked_technical'
              : 'blocked_user',
          description,
        },
      );
      retryScheduled = blocked
        ? hasAutomaticTechnicalRecovery(blocked)
        : false;
    }
    return {
      ok: false,
      missionId,
      reason,
      error: detail,
      cta: retryScheduled ? BOOTSTRAP_AUTO_RETRY_CTA : BOOTSTRAP_CTA,
      ...(retryScheduled ? { retryScheduled: true } : {}),
    };
  }
}

/**
 * Restart/event recovery for the durable approval → initial-orchestrator edge.
 *
 * Calls are coalesced into one promise. The bootstrap service remains the
 * authority for per-mission singleflight, live-session reuse and fail-closed
 * blocking, so recovery cannot create a second PTY. The coordinator cadence
 * provides the bounded follow-up pass for a scope discovered mid-flight.
 */
export class MissionOrchestratorBootstrapRecovery {
  readonly #deps: MissionOrchestratorBootstrapRecoveryDeps;
  readonly #technicalRecoveryByRevision = new Map<
    string,
    TechnicalRecoveryState
  >();
  #flight: Promise<void> | null = null;

  constructor(deps: MissionOrchestratorBootstrapRecoveryDeps) {
    this.#deps = deps;
  }

  reconcile(): Promise<void> {
    if (this.#flight) return this.#flight;
    const flight = this.#pass()
      .catch((error) => {
        this.#warn(
          "[mission-orchestrator-bootstrap] recovery pass failed:",
          error,
        );
      })
      .finally(() => {
        if (this.#flight === flight) this.#flight = null;
      });
    this.#flight = flight;
    return flight;
  }

  waitForIdle(): Promise<void> {
    return this.#flight ?? Promise.resolve();
  }

  async #pass(): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const scope of this.#deps.listScopes()) {
      let missions: readonly Mission[];
      try {
        missions = this.#deps.listBootstrapCandidates(scope);
      } catch (error) {
        this.#warn(
          `[mission-orchestrator-bootstrap] could not list scope ${scope.projectId}:`,
          error,
        );
        continue;
      }
      for (const mission of missions) {
        if (mission.status === "blocked") {
          if (
            !hasAutomaticTechnicalRecovery(mission) ||
            !this.#deps.resumeBlocked
          ) {
            continue;
          }
          // Technical failures keep a bounded-backoff recovery lane. They do
          // not become a permanent user block after one unlucky provider boot,
          // and they also cannot create a five-second respawn storm.
          const revisionKey = [
            bootstrapFlightKey(scope, mission.id),
            mission.intentVersion ?? mission.intentContract?.intentVersion ?? 0,
            mission.intentContract?.approvedAt ?? 0,
          ].join("\0");
          const now = this.#deps.now?.() ?? Date.now();
          const previous =
            this.#technicalRecoveryByRevision.get(revisionKey);
          const recovery =
            previous &&
            (previous.revisionClosed ||
              !previous.settled ||
              previous.observedBlockedUpdatedAt === mission.updatedAt)
              ? previous
              : undefined;
          if (recovery && recovery.nextAttemptAt > now) continue;
          const attempt = (recovery?.attempts ?? 0) + 1;
          pending.push(
            raceWithTimeout(
              this.#deps.resumeBlocked(scope, mission.id),
              RECOVERY_ATTEMPT_TIMEOUT_MS,
              () =>
                new RecoveryAttemptTimeoutError(
                  mission.id,
                  RECOVERY_ATTEMPT_TIMEOUT_MS,
                ),
            ).then(
              (result) => {
                if (result.ok && result.kickoff.accepted) {
                  // Keep only this exact blocked incident closed in case the
                  // next coordinator pass briefly observes its stale snapshot.
                  // A later transition (even in the same revision) has a new
                  // updatedAt and therefore receives a fresh recovery lane.
                  this.#technicalRecoveryByRevision.set(revisionKey, {
                    attempts: attempt,
                    nextAttemptAt: Number.POSITIVE_INFINITY,
                    observedBlockedUpdatedAt: mission.updatedAt,
                    settled: true,
                    revisionClosed: false,
                  });
                  this.#persistRecoveryAttempt(scope, mission.id, null);
                  return;
                }
                if (!isRetryableBootstrapResult(result)) {
                  this.#technicalRecoveryByRevision.set(revisionKey, {
                    attempts: attempt,
                    nextAttemptAt: Number.POSITIVE_INFINITY,
                    observedBlockedUpdatedAt: mission.updatedAt,
                    settled: true,
                    revisionClosed: true,
                  });
                  this.#persistRecoveryAttempt(scope, mission.id, {
                    attempt,
                    reason: recoveryAttemptReason(result),
                  });
                  this.#warn(
                    `[mission-orchestrator-bootstrap] automatic recovery needs a ` +
                      `new approved revision for ${mission.id}:`,
                    result,
                  );
                  return;
                }
                if (attempt >= TECHNICAL_RECOVERY_MAX_ATTEMPTS) {
                  this.#technicalRecoveryByRevision.set(revisionKey, {
                    attempts: attempt,
                    nextAttemptAt: Number.POSITIVE_INFINITY,
                    observedBlockedUpdatedAt: mission.updatedAt,
                    settled: true,
                    revisionClosed: true,
                  });
                  this.#persistRecoveryAttempt(scope, mission.id, {
                    attempt,
                    reason: recoveryAttemptReason(result),
                  });
                  try {
                    this.#deps.exhaustTechnicalRecovery?.(
                      scope,
                      mission.id,
                      attempt,
                    );
                  } catch (exhaustError) {
                    this.#warn(
                      `[mission-orchestrator-bootstrap] could not persist ` +
                        `exhausted recovery for ${mission.id}:`,
                      exhaustError,
                    );
                  }
                  this.#warn(
                    `[mission-orchestrator-bootstrap] technical recovery exhausted ` +
                      `after ${attempt} attempts for ${mission.id}; ` +
                      `operator action required:`,
                    result,
                  );
                  return;
                }
                this.#technicalRecoveryByRevision.set(revisionKey, {
                  attempts: attempt,
                  nextAttemptAt:
                    now + technicalRecoveryDelayMs(attempt),
                  observedBlockedUpdatedAt:
                    recovery?.observedBlockedUpdatedAt ?? mission.updatedAt,
                  settled: false,
                  revisionClosed: false,
                });
                this.#warn(
                  `[mission-orchestrator-bootstrap] technical recovery attempt ${attempt} ` +
                    `did not start ${mission.id}; retry remains scheduled:`,
                  result,
                );
                this.#persistRecoveryAttempt(scope, mission.id, {
                  attempt,
                  reason: recoveryAttemptReason(result),
                });
              },
              (error) => {
                if (attempt >= TECHNICAL_RECOVERY_MAX_ATTEMPTS) {
                  this.#technicalRecoveryByRevision.set(revisionKey, {
                    attempts: attempt,
                    nextAttemptAt: Number.POSITIVE_INFINITY,
                    observedBlockedUpdatedAt: mission.updatedAt,
                    settled: true,
                    revisionClosed: true,
                  });
                  this.#persistRecoveryAttempt(scope, mission.id, {
                    attempt,
                    reason: recoveryAttemptReason(error),
                  });
                  try {
                    this.#deps.exhaustTechnicalRecovery?.(
                      scope,
                      mission.id,
                      attempt,
                    );
                  } catch (exhaustError) {
                    this.#warn(
                      `[mission-orchestrator-bootstrap] could not persist ` +
                        `exhausted recovery for ${mission.id}:`,
                      exhaustError,
                    );
                  }
                  this.#warn(
                    `[mission-orchestrator-bootstrap] technical recovery exhausted ` +
                      `after ${attempt} attempts for ${mission.id}; ` +
                      `operator action required:`,
                    error,
                  );
                  return;
                }
                this.#technicalRecoveryByRevision.set(revisionKey, {
                  attempts: attempt,
                  nextAttemptAt:
                    now + technicalRecoveryDelayMs(attempt),
                  observedBlockedUpdatedAt:
                    recovery?.observedBlockedUpdatedAt ?? mission.updatedAt,
                  settled: false,
                  revisionClosed: false,
                });
                this.#warn(
                  `[mission-orchestrator-bootstrap] technical recovery attempt ${attempt} ` +
                    `failed for ${mission.id}; retry remains scheduled:`,
                  error,
                );
                this.#persistRecoveryAttempt(scope, mission.id, {
                  attempt,
                  reason: recoveryAttemptReason(error),
                });
              },
            ),
          );
          continue;
        }
        if (
          !hasSealedPendingMissionStart(mission) &&
          (mission.status !== "running" ||
            !hasCurrentDispatchAuthority(mission))
        ) {
          continue;
        }
        pending.push(
          this.#deps.bootstrap(scope, mission.id).then(
            () => undefined,
            (error) => {
              this.#warn(
                `[mission-orchestrator-bootstrap] recovery failed for ${mission.id}:`,
                error,
              );
            },
          ),
        );
      }
    }
    await Promise.all(pending);
  }

  #warn(message: string, error: unknown): void {
    (this.#deps.warn ?? console.warn)(message, error);
  }

  /** Telemetry-grade persistence: a broken store keeps the lane moving. */
  #persistRecoveryAttempt(
    scope: ProjectExecutionScope,
    missionId: string,
    outcome: { readonly attempt: number; readonly reason: string } | null,
  ): void {
    try {
      this.#deps.persistRecoveryAttempt?.(scope, missionId, outcome);
    } catch (error) {
      this.#warn(
        `[mission-orchestrator-bootstrap] could not persist recovery attempt ` +
          `for ${missionId}:`,
        error,
      );
    }
  }
}

const productionService = new MissionOrchestratorBootstrapService();
const missionEngineBootstrapResults = new Map<
  string,
  MissionOrchestratorBootstrapResult
>();

type MissionDirectCommand = Extract<
  MissionEngineCommand,
  { readonly kind: "direct" }
>;

export interface MissionDirectDeliveryDeps {
  readonly getRuntimeAgentSessionInfo: (
    sessionId: string,
  ) => OwnedAgentSessionInfo | null;
  readonly getAcpDriverSession: typeof getAcpDriverSession;
  readonly getAcpDriverSemanticStatus: typeof getAcpDriverSemanticStatus;
  readonly getPaneRuntimeAuthorityBySession:
    typeof getPaneRuntimeAuthorityBySession;
  readonly getSquad: typeof getSquad;
  readonly deliverAgentPrompt: typeof deliverAgentPrompt;
  readonly emitMissionEvent: typeof emitMissionEvent;
}

const productionMissionDirectDeliveryDeps: MissionDirectDeliveryDeps = {
  getRuntimeAgentSessionInfo: runtimeAgentSessionInfo,
  getAcpDriverSession,
  getAcpDriverSemanticStatus,
  getPaneRuntimeAuthorityBySession,
  getSquad,
  deliverAgentPrompt,
  emitMissionEvent,
};

interface MissionDirectAuthority {
  readonly mission: Mission;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly authorityFingerprint: string;
}

function missionDirectAuthority(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  command: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps,
): MissionDirectAuthority {
  const mission = stores.missions.get(command.missionId);
  if (!mission || mission.id !== command.missionId) {
    throw new Error("mission direct requires a current mission");
  }
  if (!hasCurrentDispatchAuthority(mission)) {
    throw new Error("mission direct requires live current dispatch authority");
  }
  if (!stores.missions.hasCurrentKickoffAcceptance(mission.id)) {
    throw new Error("mission direct requires the current kickoff receipt");
  }
  const sessionId = mission.orchestratorSessionId;
  if (!sessionId) {
    throw new Error("mission direct requires a live orchestrator session");
  }
  const agent = deps.getRuntimeAgentSessionInfo(sessionId);
  if (!agent) {
    throw new Error("mission direct orchestrator session is not live");
  }
  const pane =
    stores.missionPanes
      .list(mission.id)
      .find(
        (candidate) =>
          candidate.role === "orchestrator" &&
          candidate.paneId === agent.paneId,
      ) ?? null;
  const approvedRuntime = mission.intentContract?.orchestratorRuntime;
  if (!pane || !approvedRuntime) {
    throw new Error("mission direct orchestrator authority is incomplete");
  }
  const mismatches = runtimeAuthorityMismatches(
    scope,
    mission,
    pane,
    agent,
    deps.getPaneRuntimeAuthorityBySession(sessionId),
    approvedRuntime,
  );
  if (mismatches.length > 0) {
    throw new Error(
      `mission direct orchestrator authority mismatch: ${mismatches[0]}`,
    );
  }

  let squadRevisionHash = mission.intentContract?.squadRevisionHash ?? null;
  if (command.targetAgentId !== null) {
    const currentSquad = mission.squadId
      ? deps.getSquad(mission.squadId)
      : null;
    if (!currentSquad || !squadRevisionHash) {
      throw new Error("mission direct target requires sealed squad authority");
    }
    const currentSquadSnapshot = snapshotSquadAuthority(currentSquad);
    if (currentSquadSnapshot.hash !== squadRevisionHash) {
      throw new Error("mission direct target squad authority is stale");
    }
    if (
      !currentSquadSnapshot.agents.some(
        (candidate) => candidate.id === command.targetAgentId,
      )
    ) {
      throw new Error("mission direct target agent is not in the sealed squad");
    }
    squadRevisionHash = currentSquadSnapshot.hash;
  }

  const authorityFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        scope: {
          installationId: scope.installationId,
          projectId: scope.projectId,
          checkoutId: scope.checkoutId,
          rootRealPath: scope.rootRealPath,
        },
        missionId: mission.id,
        intentVersion: mission.intentVersion ?? 0,
        sessionId,
        paneId: pane.paneId,
        adapterId: pane.adapterId,
        squadRevisionHash,
        targetAgentId: command.targetAgentId,
        text: command.text,
      }),
    )
    .digest("hex");
  return {
    mission,
    sessionId,
    adapterId: pane.adapterId,
    authorityFingerprint,
  };
}

function missionDirectPrompt(command: MissionDirectCommand): string {
  const payload = {
    kind: "operator_direction" as const,
    targetAgentId: command.targetAgentId,
    text: command.text,
  };
  const targetRule =
    command.targetAgentId === null
      ? "Apply this direction to your current mission."
      : `Route this direction to exactly squad agent ${JSON.stringify(command.targetAgentId)} and retain orchestration authority.`;
  return assertSafePtyPrompt(
    [
      "Nexus operator direction accepted by the main process.",
      targetRule,
      "Exact direction envelope:",
      JSON.stringify(payload),
    ].join("\n"),
  );
}

/**
 * Main-owned canonical direct path. Renderer input selects neither a session
 * nor a transport: both are rederived from the current sealed mission. The
 * method resolves only after PTY acceptance proof (or the ACP turn boundary),
 * revalidates that exact authority, then emits the bounded conversation event.
 */
export async function deliverMissionDirectInstruction(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  rawCommand: MissionDirectCommand,
  deps: MissionDirectDeliveryDeps = productionMissionDirectDeliveryDeps,
): Promise<void> {
  assertSafePtyPrompt(rawCommand.text);
  const parsed = missionEngineCommandSchema.parse(rawCommand);
  if (parsed.kind !== "direct") {
    throw new Error("mission direct received a non-direct command");
  }
  const command = parsed;
  assertSafePtyPrompt(command.text);
  const initial = missionDirectAuthority(scope, stores, command, deps);
  const prompt = missionDirectPrompt(command);
  const acpSession = deps.getAcpDriverSession(initial.sessionId);
  if (acpSession) {
    const status = deps.getAcpDriverSemanticStatus(initial.sessionId);
    if (status !== "idle" && status !== "completed") {
      throw new Error("mission direct ACP orchestrator is not ready");
    }
    // `promptLiveSession` emits turn_started and flips semantic status to
    // working synchronously, before its promise follows the provider's full
    // turn. That transition is the ACP acceptance receipt.
    const turn = acpSession.prompt(prompt);
    if (deps.getAcpDriverSemanticStatus(initial.sessionId) !== "working") {
      void turn.catch(() => undefined);
      throw new Error("mission direct ACP turn was not accepted");
    }
    void turn.catch((error) => {
      console.warn("[mission-direct] ACP turn ended after acceptance:", error);
    });
  } else {
    const accepted = await deps.deliverAgentPrompt(
      initial.sessionId,
      prompt,
      undefined,
      { adapterId: initial.adapterId },
    );
    if (!accepted) {
      throw new Error("mission direct delivery was not accepted");
    }
  }

  const current = missionDirectAuthority(scope, stores, command, deps);
  if (
    current.sessionId !== initial.sessionId ||
    current.authorityFingerprint !== initial.authorityFingerprint
  ) {
    throw new Error("mission direct authority changed during delivery");
  }
  const payload = {
    kind: "operator_direction" as const,
    targetAgentId: command.targetAgentId,
    text: command.text,
  };
  deps.emitMissionEvent(scope, {
    missionId: command.missionId,
    runId: "operator-direction",
    type: "custom",
    origin: "main",
    idempotencyKey: `operator_direction:${initial.authorityFingerprint}`,
    payload,
  });
}

function projectMissionEngineSnapshotView(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  missionId: string,
): ProjectMissionSnapshotView {
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error('mission not found');
  const missionPanes = stores.missionPanes.list(missionId);
  const orchestratorPane =
    missionPanes.find((pane) => pane.role === 'orchestrator') ?? null;
  const sessionId = mission.orchestratorSessionId;
  const sessionState = sessionId ? runtimeSessionState(sessionId) : null;
  const approvedRuntime = mission.intentContract?.orchestratorRuntime;
  const orchestratorLive = Boolean(
    sessionId &&
      orchestratorPane &&
      approvedRuntime &&
      (sessionState === 'spawning' ||
        sessionState === 'busy' ||
        sessionState === 'idle') &&
      runtimeAuthorityMismatches(
        scope,
        mission,
        orchestratorPane,
        runtimeAgentSessionInfo(sessionId),
        getPaneRuntimeAuthorityBySession(sessionId),
        approvedRuntime,
      ).length === 0,
  );
  const squad = mission.squadId ? getSquad(mission.squadId) : null;
  const roster = (squad?.agents ?? []).map((agent) => ({
    ...agent,
    allowedTools: agent.allowedTools ? [...agent.allowedTools] : agent.allowedTools,
    allowedSkills: agent.allowedSkills
      ? [...agent.allowedSkills]
      : agent.allowedSkills,
  }));
  const rosterById = new Map(roster.map((agent) => [agent.id, agent] as const));
  const rosterByName = new Map(
    roster.map((agent) => [agent.agentName, agent] as const),
  );
  const taskAgentById = new Map(
    stores.tasks
      .listPlannedTasks(mission.id, mission.intentVersion ?? 0)
      .map((planned) => [planned.taskId, planned.agentRef] as const),
  );
  const tasks = stores.tasks.list(mission.id).map((task) => {
    const agentId = taskAgentById.get(task.id);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      ...(agentId ? { agentId } : {}),
      dependsOn: [] as string[],
      evidence: [] as Array<{ id: string; path?: string }>,
    };
  });
  const taskFallbackByAgent = new Map<string, MissionAgentTaskFallback>();
  for (const agent of roster) {
    const agentTasks = tasks.filter((task) => task.agentId === agent.id);
    if (agentTasks.some((task) => task.status === 'running')) {
      taskFallbackByAgent.set(agent.id, 'working');
    } else if (agentTasks.some((task) => task.status === 'failed')) {
      taskFallbackByAgent.set(agent.id, 'failed');
    } else if (
      agentTasks.length > 0 &&
      agentTasks.every((task) => task.status === 'done')
    ) {
      taskFallbackByAgent.set(agent.id, 'done');
    } else {
      taskFallbackByAgent.set(agent.id, 'queued');
    }
  }
  const livePaneSnapshots = listPaneSnapshots();
  const sessionByPaneId = new Map<string, string>();
  for (const snapshot of livePaneSnapshots) {
    if (snapshot.sessionId) {
      sessionByPaneId.set(snapshot.paneId, snapshot.sessionId);
    }
  }
  if (
    orchestratorPane?.paneId &&
    mission.orchestratorSessionId &&
    !sessionByPaneId.has(orchestratorPane.paneId)
  ) {
    sessionByPaneId.set(
      orchestratorPane.paneId,
      mission.orchestratorSessionId,
    );
  }
  const dispatches = stores.taskDispatches.list(missionId);
  for (const dispatch of dispatches) {
    if (dispatch.paneId && dispatch.sessionId && !sessionByPaneId.has(dispatch.paneId)) {
      sessionByPaneId.set(dispatch.paneId, dispatch.sessionId);
    }
  }
  const currentUnitByAgent = new Map<string, string>();
  for (const task of tasks) {
    if (task.status === 'running' && task.agentId) {
      currentUnitByAgent.set(task.agentId, task.id);
    }
  }
  for (const dispatch of dispatches) {
    if (
      !dispatch.agentRef ||
      currentUnitByAgent.has(dispatch.agentRef) ||
      !['running', 'spawning', 'routed'].includes(dispatch.state)
    ) {
      continue;
    }
    currentUnitByAgent.set(dispatch.agentRef, dispatch.taskId);
  }

  const panes: ProjectMissionSnapshotView['panes'] = [];
  const claimedAgentIds = new Set<string>();
  for (const pane of missionPanes) {
    if (!pane.paneId) continue;
    let agentId: string | undefined;
    if (pane.agentName && rosterByName.has(pane.agentName)) {
      agentId = rosterByName.get(pane.agentName)!.id;
    } else if (pane.role === 'orchestrator') {
      agentId = roster.find((agent) => agent.category === 'orchestrator')?.id;
    } else {
      const dispatch = dispatches.find(
        (candidate) =>
          candidate.paneId === pane.paneId ||
          (pane.workerIncarnationId !== undefined &&
            candidate.workerIncarnationId === pane.workerIncarnationId),
      );
      if (dispatch?.agentRef && rosterById.has(dispatch.agentRef)) {
        agentId = dispatch.agentRef;
      }
    }
    if (!agentId || claimedAgentIds.has(agentId)) continue;
    claimedAgentIds.add(agentId);

    const paneSessionId = sessionByPaneId.get(pane.paneId) ?? null;
    const liveSessionState = paneSessionId
      ? runtimeSessionState(paneSessionId)
      : null;
    const semantic =
      getAgentSemanticStatus(pane.paneId)?.status ??
      (paneSessionId
        ? getAgentSemanticStatusBySession(paneSessionId)?.status
        : null) ??
      (paneSessionId ? getAcpDriverSemanticStatus(paneSessionId) : null);
    const state = resolveMissionAgentLiveState({
      semantic,
      sessionState:
        liveSessionState === 'spawning' ||
        liveSessionState === 'busy' ||
        liveSessionState === 'idle'
          ? liveSessionState
          : null,
      taskState: taskFallbackByAgent.get(agentId) ?? 'queued',
    });
    const currentUnitId = currentUnitByAgent.get(agentId);
    panes.push({
      paneId: pane.paneId,
      agentId,
      state,
      ...(currentUnitId ? { currentUnitId } : {}),
    });
  }

  return {
    mission: {
      id: mission.id,
      title: mission.title,
      objective:
        mission.intentContract?.goal.trim() ||
        mission.description.trim() ||
        mission.title,
      workspaceLabel: `${scope.projectId}/${scope.checkoutId}`,
      status: mission.status,
      version: mission.intentVersion ?? 0,
      updatedAt: mission.updatedAt,
      ...(mission.result ? { result: mission.result } : {}),
    },
    hasDispatchAuthority: hasCurrentDispatchAuthority(mission),
    hasCurrentKickoffReceipt:
      stores.missions.hasCurrentKickoffAcceptance(mission.id),
    orchestratorLive,
    tasks,
    handoffs: [],
    panes,
    roster,
  };
}

interface MissionEngineLifecyclePatch {
  readonly status: MissionStatus;
  readonly intentState: MissionIntentState;
  readonly description?: string;
  readonly learnings?: string;
  readonly result?: MissionResult;
}

function transitionMissionEngineLifecycle(
  stores: ProjectDomainStoreSuite,
  input: Pick<
    MissionBlockInput,
    | "missionId"
    | "expectedStatus"
    | "expectedIntentState"
    | "expectedUpdatedAt"
    | "expectedIntentVersion"
  >,
  patch: MissionEngineLifecyclePatch,
): void {
  const current = stores.missions.get(input.missionId);
  if (
    !current ||
    current.status !== input.expectedStatus ||
    current.intentState !== input.expectedIntentState ||
    current.updatedAt !== input.expectedUpdatedAt ||
    (current.intentVersion ?? 0) !== input.expectedIntentVersion
  ) {
    throw new Error("mission engine lifecycle fence changed");
  }
  const updated = stores.missions.transitionLifecycle(
    input.missionId,
    {
      updatedAt: input.expectedUpdatedAt,
      intentVersion: input.expectedIntentVersion,
    },
    patch,
  );
  if (!updated) {
    throw new Error("mission engine lifecycle CAS changed");
  }
}

const productionMissionEngines = new MissionEngineRegistry((scope, stores) =>
  new MainMissionEngine(scope, {
    ...createMissionEnginePreparationPorts({
      scope,
      missions: stores.missions,
    }),
    readReviewFence: async (missionId) => {
      const mission = stores.missions.get(missionId);
      if (mission?.squadId === PET_STUDIO_SQUAD_ID) {
        const saved = getSquad(PET_STUDIO_SQUAD_ID);
        if (!saved || !isDeepStrictEqual(saved, PET_STUDIO_SQUAD)) {
          throw new Error('saved Pet Studio squad authority changed');
        }
      }
      const reviewSha256 =
        mission?.intentContract?.approvalReviewSha256;
      if (!reviewSha256) return null;
      return {
        missionId,
        reviewSha256,
        ...(mission.squadId === PET_STUDIO_SQUAD_ID
          ? {
              profile: { kind: "pet-studio" as const },
              attachments:
                mission.intentContract?.attachmentSnapshots?.map(
                  (snapshot) => ({ ...snapshot }),
                ) ?? [],
            }
          : {}),
      };
    },
    revalidatePetStudioAttachments: (snapshots) =>
      revalidateSealedAttachmentSnapshots(snapshots, {
        workspaceRootAuthority: workspaceRootAuthorityFromScope(scope),
        checkoutId: scope.checkoutId,
      }),
    seal: async (input) => {
      sealMissionStartReview(stores.missions, input);
    },
    bootstrap: async (missionId) => {
      // Via Rápida (padrão): terminais interativos direto no workspace, sem o
      // pipeline cerimonial. O motor antigo fica atrás de
      // NEXUS_CEREMONIAL_MISSIONS=1 até a remoção definitiva.
      if (missionFastLaneEnabled()) {
        await fastLaneBootstrap(scope, missionId);
        return;
      }
      const result = await productionService.bootstrap(scope, missionId);
      missionEngineBootstrapResults.set(
        bootstrapFlightKey(scope, missionId),
        result,
      );
      // Auto-recovery is already scheduled for this mission. Throwing here
      // makes MissionEngine.start fail closed and the renderer discard the
      // exact prepared mission while recovery is still running.
      if (result.ok) {
        if (
          !result.kickoff.accepted &&
          !result.kickoff.retryScheduled
        ) {
          throw new Error(
            `mission-start-admission:kickoff-receipt-missing (${result.kickoff.reason})`,
          );
        }
        return;
      }
      if (result.retryScheduled) return;
      throw new Error(result.error);
    },
    retryKickoff: async (command) => {
      if (missionFastLaneEnabled()) {
        await resumeFastLaneMission(scope, command.missionId);
        return;
      }
      const result = await resumeBlockedMissionBootstrapForScope(
        scope,
        command.missionId,
      );
      missionEngineBootstrapResults.set(
        bootstrapFlightKey(scope, command.missionId),
        result,
      );
      if (result.ok) {
        if (
          !result.kickoff.accepted &&
          !result.kickoff.retryScheduled
        ) {
          throw new Error(
            `mission-start-admission:kickoff-receipt-missing (${result.kickoff.reason})`,
          );
        }
        return;
      }
      if (result.retryScheduled) return;
      throw new Error(result.error);
    },
    resume: async (command) => {
      const mission = stores.missions.get(command.missionId);
      if (!mission) throw new Error("mission not found");
      if (
        mission.status === "running" &&
        mission.intentState === "executing"
      ) {
        return;
      }
      if (
        mission.status !== "blocked" ||
        mission.intentState !== "blocked_technical"
      ) {
        throw new Error("mission engine resume requires a technical block");
      }
      const detail = taskDispatchBlockDetailFromDescription(
        mission.description,
      );
      if (!detail) {
        throw new Error("mission engine resume requires an exact dispatch block");
      }
      transitionMissionEngineLifecycle(
        stores,
        {
          missionId: mission.id,
          expectedStatus: mission.status,
          expectedIntentState: mission.intentState,
          expectedUpdatedAt: mission.updatedAt,
          expectedIntentVersion: mission.intentVersion ?? 0,
        },
        {
          status: "running",
          intentState: "executing",
          description: taskDispatchTechnicalResumeDescription(
            mission.description,
            detail,
          ),
        },
      );
    },
    stop: async (command) => {
      // Native confirmation + lifecycle lock + physical teardown belong to
      // the renderer IPC authority boundary. This port is deliberately
      // post-authority only: it can validate an idempotent completed close,
      // but can never terminate a live process without that boundary.
      const mission = stores.missions.get(command.missionId);
      if (!mission) throw new Error("mission not found");
      if (
        (mission.status !== "blocked" && mission.status !== "failed") ||
        mission.orchestratorSessionId !== undefined
      ) {
        throw new Error(
          "mission engine stop requires completed operator runtime teardown",
        );
      }
    },
    direct: async (command) => {
      await deliverMissionDirectInstruction(scope, stores, command);
    },
    answerQuestion: async (command) => {
      const question = stores.handoffs.get(command.questionId);
      if (
        !question ||
        question.missionId !== command.missionId ||
        question.deliveryState !== "consumed"
      ) {
        throw new Error(
          "mission engine answer requires the consumed current question",
        );
      }
      const answers = stores.handoffs
        .list({ missionId: command.missionId, includeDelivered: true })
        .filter((handoff) => {
          if (handoff.authorityOrigin !== "operator-confirmed") return false;
          return handoff.artifacts.some((artifact) => {
            const parsed = parseClarifyAnswerArtifact(artifact);
            return parsed?.questionId === command.questionId;
          });
        });
      if (answers.length !== 1) {
        throw new Error(
          "mission engine answer requires one operator-confirmed response",
        );
      }
      const answer = answers[0]!.artifacts
        .map((artifact) => parseClarifyAnswerArtifact(artifact))
        .find((artifact) => artifact?.questionId === command.questionId);
      const matchesCommand =
        answer?.answer.kind === "chip"
          ? answer.answer.chipId === command.optionId
          : answer?.answer.kind === "freeform" &&
            answer.answer.value === command.text;
      if (!matchesCommand) {
        throw new Error("mission engine answer diverges from durable response");
      }
      const mission = stores.missions.get(command.missionId);
      if (!mission) throw new Error("mission not found");
      if (
        mission.status === "running" &&
        mission.intentState === "executing"
      ) {
        return;
      }
      if (
        mission.status !== "blocked" ||
        mission.intentState !== "blocked_user"
      ) {
        throw new Error("mission engine answer requires a user block");
      }
      transitionMissionEngineLifecycle(
        stores,
        {
          missionId: mission.id,
          expectedStatus: mission.status,
          expectedIntentState: mission.intentState,
          expectedUpdatedAt: mission.updatedAt,
          expectedIntentVersion: mission.intentVersion ?? 0,
        },
        { status: "running", intentState: "executing" },
      );
    },
    blockUser: (input) =>
      transitionMissionEngineLifecycle(stores, input, {
        status: "blocked",
        intentState: "blocked_user",
        description: input.description,
      }),
    blockTechnical: (input) =>
      transitionMissionEngineLifecycle(stores, input, {
        status: "blocked",
        intentState: "blocked_technical",
        description: input.description,
      }),
    resumeTechnical: (input) =>
      transitionMissionEngineLifecycle(stores, input, {
        status: "running",
        intentState: "executing",
        description: input.description,
      }),
    completeVerified: (input: MissionVerifiedCompletionInput) =>
      transitionMissionEngineLifecycle(stores, input, {
        status: "done",
        intentState: "done",
        learnings: input.learnings,
        result: input.result,
      }),
    readSnapshotView: async (missionId) =>
      projectMissionEngineSnapshotView(scope, stores, missionId),
    listSnapshotViews: async () =>
      stores.missions
        .list()
        .map((mission) =>
          projectMissionEngineSnapshotView(scope, stores, mission.id),
        ),
  }),
);
configureMissionEngineForScope((scope) =>
  productionMissionEngines.forScope(scope, getProjectDomainStores(scope)),
);

function blockMissionEngineStartFailure(
  scope: ProjectExecutionScope,
  missionId: string,
  expectedIntentVersion: number,
  expectedReviewSha256: string | undefined,
  error: unknown,
): MissionOrchestratorBootstrapResult {
  const stores = getProjectDomainStores(scope);
  const current = stores.missions.get(missionId);
  const detail = failureDetail('MissionEngine.start falhou.', error);
  let retryScheduled = false;
  if (
    current &&
    current.status !== 'done' &&
    current.status !== 'failed' &&
    (current.intentVersion ?? 0) === expectedIntentVersion &&
    current.intentContract?.approvalReviewSha256 === expectedReviewSha256
  ) {
    const note =
      `${BOOTSTRAP_BLOCK_MARKER}\n## Orquestrador não iniciado\n${detail} ` +
      `CTA: ${BOOTSTRAP_AUTO_RETRY_CTA}.`;
    const description = current.description.includes(BOOTSTRAP_BLOCK_MARKER)
      ? current.description
      : [current.description.trim(), note]
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 65_536);
    const blocked = stores.missions.transitionLifecycle(
      missionId,
      {
        updatedAt: current.updatedAt,
        intentVersion: expectedIntentVersion,
      },
      {
        status: 'blocked',
        intentState: 'blocked_technical',
        description,
      },
    );
    retryScheduled = Boolean(blocked && hasAutomaticTechnicalRecovery(blocked));
  }
  return {
    ok: false,
    missionId,
    reason: 'materialization_failed',
    error: detail,
    cta: retryScheduled ? BOOTSTRAP_AUTO_RETRY_CTA : BOOTSTRAP_CTA,
    ...(retryScheduled ? { retryScheduled: true } : {}),
  };
}
const productionScopes = new Map<string, ProjectExecutionScope>();
const productionRecovery = new MissionOrchestratorBootstrapRecovery({
  listScopes: () => [...productionScopes.values()],
  listBootstrapCandidates: (scope) => {
    const stores = getProjectDomainStores(scope);
    const running = stores.missions.list("running").filter((mission) => {
      // A complete durable binding already has its own lifecycle/rebind
      // supervision. Recovery owns the missing or torn approval→bootstrap
      // edge only; a half-binding is sent through the service so it blocks
      // with a CTA instead of spawning blindly.
      return needsMissionOrchestratorBootstrapRecovery(
        mission,
        stores.missionPanes.list(mission.id),
        stores.missions.hasCurrentKickoffAcceptance(mission.id),
      );
    });
    const pendingStarts = stores.missions
      .list("pending")
      .filter(hasSealedPendingMissionStart);
    const technicallyBlocked = stores.missions
      .list("blocked")
      .filter(hasAutomaticTechnicalRecovery);
    return [...running, ...pendingStarts, ...technicallyBlocked];
  },
  bootstrap: (scope, missionId) =>
    bootstrapMissionOrchestratorForScope(scope, missionId),
  resumeBlocked: (scope, missionId) =>
    resumeAutomaticallyBlockedMissionBootstrapForScope(scope, missionId),
  exhaustTechnicalRecovery: (scope, missionId, attempts) => {
    const stores = getProjectDomainStores(scope);
    const current = stores.missions.get(missionId);
    if (!current || !hasAutomaticTechnicalRecovery(current)) return;
    const detail = terminalOperationalFailureReason(
      `Recuperação automática esgotou ${attempts} tentativas sem iniciar o ` +
        `orquestrador. A falha não cedeu com retry; revise o plano e aprove ` +
        `novamente, ou use ${BOOTSTRAP_CTA}.`,
    );
    const note =
      `${BOOTSTRAP_BLOCK_MARKER}\n## Orquestrador não iniciado\n${detail} ` +
      `CTA: ${BOOTSTRAP_CTA}.`;
    const description = current.description.includes(BOOTSTRAP_BLOCK_MARKER)
      ? current.description.includes(TERMINAL_OPERATIONAL_FAILURE_MARKER)
        ? current.description
        : `${current.description}\n${detail}`.slice(0, 65_536)
      : [current.description.trim(), note]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 65_536);
    stores.missions.update(missionId, {
      ...missionBlockPatch("user"),
      description,
    });
  },
  persistRecoveryAttempt: (scope, missionId, outcome) => {
    const stores = getProjectDomainStores(scope);
    const current = stores.missions.get(missionId);
    if (
      !current ||
      current.status === "done" ||
      current.status === "failed"
    ) {
      return;
    }
    const description = outcome
      ? replaceRecoveryAttemptBlock(
          current.description,
          formatRecoveryAttemptBlock(
            outcome.attempt,
            TECHNICAL_RECOVERY_MAX_ATTEMPTS,
            outcome.reason,
            new Date().toISOString(),
          ),
        )
      : stripRecoveryAttemptBlock(current.description);
    if (description === current.description) return;
    stores.missions.update(missionId, {
      description: description.slice(0, 65_536),
    });
  },
});
let disposeProductionScopeListener: (() => void) | null = null;

function productionScopeKey(scope: Readonly<ProjectExecutionScope>): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
  ].join("\0");
}

/** Main-process boundary used by approval and recovery, sharing one engine start. */
export function bootstrapMissionOrchestratorForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  expectedReviewSha256?: string,
): Promise<MissionOrchestratorBootstrapResult> {
  return withMissionLifecycleLock(scope, missionId, async () => {
    const stores = getProjectDomainStores(scope);
    const initial = stores.missions.get(missionId);
    if (!initial) {
      return {
        ok: false,
        missionId,
        reason: 'not_authorized',
        error: 'MissionEngine.start exige uma missão existente.',
        cta: BOOTSTRAP_CTA,
      };
    }
    const intentVersion = initial.intentVersion ?? 0;
    const reviewSha256 =
      expectedReviewSha256 ??
      initial.intentContract?.approvalReviewSha256;
    if (!reviewSha256) {
      return blockMissionEngineStartFailure(
        scope,
        missionId,
        intentVersion,
        undefined,
        new Error('review fence is absent'),
      );
    }

    const key = bootstrapFlightKey(scope, missionId);
    missionEngineBootstrapResults.delete(key);
    try {
      await productionMissionEngines
        .forScope(scope, stores)
        .start(scope, { missionId, reviewSha256 });
    } catch (error) {
      const bootstrapResult = missionEngineBootstrapResults.get(key);
      if (bootstrapResult) return bootstrapResult;
      return blockMissionEngineStartFailure(
        scope,
        missionId,
        intentVersion,
        reviewSha256,
        error,
      );
    }
    return (
      missionEngineBootstrapResults.get(key) ??
      blockMissionEngineStartFailure(
        scope,
        missionId,
        intentVersion,
        reviewSha256,
        new Error('MissionEngine.start completed without bootstrap receipt'),
      )
    );
  });
}

export interface PlanPromotionRestartDeps {
  getMission(scope: ProjectExecutionScope, missionId: string): Mission | null;
  updateMission(
    scope: ProjectExecutionScope,
    missionId: string,
    patch: MissionPatch,
  ): Mission | null;
  setOrchestratorSession(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string | null,
  ): Mission | null;
  listMissionPanes(
    scope: ProjectExecutionScope,
    missionId: string,
  ): MissionPaneSpec[];
  removeMissionPane(scope: ProjectExecutionScope, paneRowId: string): boolean;
  getSessionState(sessionId: string): ReturnType<typeof getSessionState>;
  getAgentSessionInfo(sessionId: string): OwnedAgentSessionInfo | null;
  revokeSessionAuthority(sessionId: string): void;
  closePane(input: MissionPaneCloseRequest): boolean | Promise<boolean>;
  ensureMissionPlan(
    scope: ProjectExecutionScope,
    missionId: string,
  ): GuidedMissionPlanResult;
  bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult>;
}

export type PlanPromotionTeardownResult =
  | Readonly<{ ok: true; missionId: string }>
  | Readonly<{
      ok: false;
      missionId: string;
      error: string;
      cta: string;
    }>;

const productionPlanPromotionRestartDeps: PlanPromotionRestartDeps = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  updateMission: (scope, missionId, patch) =>
    getProjectDomainStores(scope).missions.update(missionId, patch),
  setOrchestratorSession: (scope, missionId, sessionId) =>
    getProjectDomainStores(scope).missions.setOrchestratorSession(
      missionId,
      sessionId,
    ),
  listMissionPanes: (scope, missionId) =>
    getProjectDomainStores(scope).missionPanes.list(missionId),
  removeMissionPane: (scope, paneRowId) =>
    getProjectDomainStores(scope).missionPanes.remove(paneRowId),
  getSessionState,
  getAgentSessionInfo,
  revokeSessionAuthority: releaseSession,
  closePane: requestMissionPaneClose,
  ensureMissionPlan: ensureGuidedMissionPlanForScope,
  bootstrap: bootstrapMissionOrchestratorForScope,
};

const productionPlanPromotionRestartWithinLifecycleLockDeps:
  PlanPromotionRestartDeps = {
    ...productionPlanPromotionRestartDeps,
    bootstrap: (scope, missionId) =>
      productionService.bootstrap(scope, missionId),
  };

function planPromotionTeardownFailure(
  scope: ProjectExecutionScope,
  missionId: string,
  detail: string,
  deps: PlanPromotionRestartDeps,
): PlanPromotionTeardownResult {
  const current = deps.getMission(scope, missionId);
  if (current && current.status !== "done" && current.status !== "failed") {
    const note =
      `${PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER}\n` +
      `## Sessão de plano preservada\n${detail} Nenhuma autoridade de código ` +
      `foi criada. Feche o processo órfão ou tente “Executar plano” novamente.`;
    deps.updateMission(scope, missionId, {
      ...missionBlockPatch("technical"),
      description: current.description.includes(
        PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER,
      )
        ? current.description
        : [current.description.trim(), note]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 65_536),
    });
  }
  return Object.freeze({
    ok: false,
    missionId,
    error: detail,
    cta: "Executar plano novamente",
  });
}

/**
 * Close plan-v1 before writing any standard-lane bytes.
 *
 * This order makes a crash fail safe: until physical exit succeeds the
 * durable mission remains plan-v1; after it succeeds, a crash can at worst
 * leave a plan mission with no pane, which ordinary bootstrap recovery can
 * recreate. There is never a durable code-v2 contract pointing at a v1 PTY.
 */
export async function stopMissionOrchestratorBeforePlanPromotionForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  expectedIntentVersion: number,
  deps: PlanPromotionRestartDeps = productionPlanPromotionRestartDeps,
): Promise<PlanPromotionTeardownResult> {
  const plan = deps.getMission(scope, missionId);
  if (
    !plan?.intentContract ||
    plan.intentContract.lane !== "plan" ||
    plan.intentVersion !== expectedIntentVersion ||
    plan.intentContract.intentVersion !== expectedIntentVersion ||
    plan.status === "done" ||
    plan.status === "failed"
  ) {
    return Object.freeze({
      ok: false,
      missionId,
      error: "O plano mudou antes do encerramento da sessão.",
      cta: "Revisar plano",
    });
  }

  const priorSessionId = plan.orchestratorSessionId;
  if (priorSessionId) deps.revokeSessionAuthority(priorSessionId);

  const priorPanes = deps.listMissionPanes(scope, missionId);
  const orchestratorPanes = priorPanes.filter(
    (pane) => pane.role === "orchestrator",
  );
  if (
    orchestratorPanes.length > 1 ||
    priorPanes.some((pane) => pane.role !== "orchestrator")
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "O runtime de plano contém panes incompatíveis com a promoção segura.",
      deps,
    );
  }

  const priorAgent = priorSessionId
    ? deps.getAgentSessionInfo(priorSessionId)
    : null;
  const paneIds = new Set(
    priorPanes
      .map((pane) => pane.paneId)
      .filter(
        (paneId): paneId is string =>
          typeof paneId === "string" && paneId.length > 0,
      ),
  );
  if (priorAgent?.paneId) paneIds.add(priorAgent.paneId);
  if (
    priorSessionId &&
    deps.getSessionState(priorSessionId) !== null &&
    paneIds.size === 0
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "A sessão de plano está viva, mas seu pane físico não foi identificado.",
      deps,
    );
  }
  for (const paneId of paneIds) {
    if (
      !(await deps.closePane({
        paneId,
        missionId,
        scope,
      }))
    ) {
      return planPromotionTeardownFailure(
        scope,
        missionId,
        "O Nexus não obteve prova de encerramento físico do pane de plano.",
        deps,
      );
    }
  }
  if (
    priorSessionId &&
    deps.getSessionState(priorSessionId) !== null
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "A sessão de plano continuou viva após a solicitação de encerramento.",
      deps,
    );
  }

  const current = deps.getMission(scope, missionId);
  if (
    !current?.intentContract ||
    current.intentContract.lane !== "plan" ||
    current.intentVersion !== expectedIntentVersion ||
    current.intentContract.intentVersion !== expectedIntentVersion ||
    current.orchestratorSessionId !== priorSessionId ||
    current.status === "done" ||
    current.status === "failed"
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "O plano mudou durante o encerramento físico da sessão.",
      deps,
    );
  }
  const remainingPanes = deps.listMissionPanes(scope, missionId);
  const priorPaneRows = new Set(priorPanes.map((pane) => pane.id));
  if (remainingPanes.some((pane) => !priorPaneRows.has(pane.id))) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "Um novo pane apareceu durante o encerramento da sessão de plano.",
      deps,
    );
  }

  if (priorSessionId) {
    const cleared = deps.setOrchestratorSession(scope, missionId, null);
    if (!cleared) {
      return planPromotionTeardownFailure(
        scope,
        missionId,
        "O vínculo durável da sessão de plano não pôde ser removido.",
        deps,
      );
    }
  }
  for (const pane of remainingPanes) {
    if (
      !deps.removeMissionPane(scope, pane.id) &&
      deps
        .listMissionPanes(scope, missionId)
        .some((candidate) => candidate.id === pane.id)
    ) {
      return planPromotionTeardownFailure(
        scope,
        missionId,
        "O vínculo durável do pane de plano não pôde ser removido.",
        deps,
      );
    }
  }
  const detached = deps.getMission(scope, missionId);
  if (
    !detached?.intentContract ||
    detached.intentContract.lane !== "plan" ||
    detached.intentVersion !== expectedIntentVersion ||
    detached.intentContract.intentVersion !== expectedIntentVersion ||
    detached.orchestratorSessionId !== undefined ||
    deps.listMissionPanes(scope, missionId).length > 0
  ) {
    return planPromotionTeardownFailure(
      scope,
      missionId,
      "O vínculo de plano mudou antes da prova durável de encerramento.",
      deps,
    );
  }
  if (detached.description.includes(PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER)) {
    const cleaned = deps.updateMission(scope, missionId, {
      description: detached.description
        .split(PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER)[0]!
        .trim(),
    });
    if (!cleaned) {
      return planPromotionTeardownFailure(
        scope,
        missionId,
        "O aviso da tentativa anterior não pôde ser limpo com segurança.",
        deps,
      );
    }
  }
  return Object.freeze({ ok: true, missionId });
}

function planPromotionRestartFailure(
  scope: ProjectExecutionScope,
  missionId: string,
  detail: string,
  deps: PlanPromotionRestartDeps,
): MissionOrchestratorBootstrapResult {
  const current = deps.getMission(scope, missionId);
  if (current && current.status !== "done" && current.status !== "failed") {
    const blockedContract = current.intentContract
      ? {
          ...current.intentContract,
          approvedAt: current.intentContract.approvedAt ?? Date.now(),
          // A failed runtime transition has no executable v2 authority.
          // Keeping this timestamp would let the generic pane-rearm path
          // bypass the dedicated physical teardown retry.
          dispatchedAt: undefined,
        }
      : undefined;
    const note =
      `${PLAN_PROMOTION_BLOCK_MARKER}\n` +
      `## Promoção não reiniciada\n${detail} A sessão de plano não recebeu ` +
      `autoridade de código. CTA: ${BOOTSTRAP_CTA}.`;
    const description = current.description.includes(
      PLAN_PROMOTION_BLOCK_MARKER,
    )
      ? current.description
      : [current.description.trim(), note]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 65_536);
    deps.updateMission(scope, missionId, {
      ...missionBlockPatch("technical"),
      ...(blockedContract ? { intentContract: blockedContract } : {}),
      description,
    });
  }
  return {
    ok: false,
    missionId,
    reason: "materialization_failed",
    error: detail,
    cta: BOOTSTRAP_CTA,
  };
}

/**
 * Exact plan-v1 → code-v2 runtime transition.
 *
 * The caller has already revoked and physically closed plan-v1 before writing
 * the durable standard-v2 contract. This boundary refuses any reappearing
 * session/pane, dispatches v2, seals its guided plan and lets the ordinary
 * bootstrap create a fresh pane + kickoff. Reusing or renderer-injecting into
 * the v1 PTY is deliberately impossible.
 */
export async function restartMissionOrchestratorAfterPlanPromotionForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  expectedIntentVersion: number,
  deps: PlanPromotionRestartDeps = productionPlanPromotionRestartDeps,
): Promise<MissionOrchestratorBootstrapResult> {
  const promoted = deps.getMission(scope, missionId);
  if (
    !promoted?.intentContract ||
    promoted.intentContract.lane !== "standard" ||
    promoted.intentVersion !== expectedIntentVersion ||
    promoted.intentContract.intentVersion !== expectedIntentVersion ||
    promoted.intentState !== "ready_to_start" ||
    promoted.status !== "pending"
  ) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: "A revisão promovida mudou antes de reiniciar o orquestrador.",
      cta: BOOTSTRAP_CTA,
    };
  }

  if (
    promoted.orchestratorSessionId !== undefined ||
    deps.listMissionPanes(scope, missionId).length > 0
  ) {
    return planPromotionRestartFailure(
      scope,
      missionId,
      "Uma sessão ou pane apareceu depois do encerramento seguro do plano.",
      deps,
    );
  }

  const current = deps.getMission(scope, missionId);
  if (
    !current?.intentContract ||
    current.intentContract.lane !== "standard" ||
    current.intentVersion !== expectedIntentVersion ||
    current.intentContract.intentVersion !== expectedIntentVersion ||
    current.intentState !== "ready_to_start" ||
    current.status !== "pending" ||
    current.orchestratorSessionId !== undefined ||
    deps.listMissionPanes(scope, missionId).length > 0
  ) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: "A missão mudou antes de despachar a revisão promovida.",
      cta: BOOTSTRAP_CTA,
    };
  }

  const armedContract = {
    ...current.intentContract,
    approvedAt: current.intentContract.approvedAt ?? Date.now(),
    dispatchedAt: Date.now(),
  };
  const armed = deps.updateMission(scope, missionId, {
    status: "running",
    intentState: "dispatched",
    intentContract: armedContract,
  });
  if (
    !armed ||
    armed.intentVersion !== expectedIntentVersion ||
    !hasCurrentDispatchAuthority(armed)
  ) {
    return planPromotionRestartFailure(
      scope,
      missionId,
      "A autoridade da revisão promovida não pôde ser despachada.",
      deps,
    );
  }

  try {
    const plan = deps.ensureMissionPlan(scope, missionId);
    if (
      !plan.applicable ||
      (plan.reason !== "sealed" && plan.reason !== "already-sealed")
    ) {
      throw new Error(
        `guided_plan_receipt_missing: a promoção não produziu o grafo Guided v2 (${plan.reason})`,
      );
    }
  } catch (error) {
    return planPromotionRestartFailure(
      scope,
      missionId,
      `O plano guiado da revisão promovida não pôde ser selado. ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 4_096),
      deps,
    );
  }
  return deps.bootstrap(scope, missionId);
}

/**
 * Whether — and how — a bootstrap-blocked mission may be re-armed for another
 * bootstrap attempt. Pure so the exact recovery precondition is testable: only
 * a mission the BOOTSTRAP failure itself blocked (marker in description,
 * blocked/blocked_technical, approved dispatch authority intact) qualifies.
 * Field wedge this exits: bootstrap failure → blocked_technical with zero
 * panes → wizard retry hits "invalid transition", rail reopen finds no pane
 * composition, removal preserves the mission — no recovery path at all.
 */
export function blockedBootstrapResumePatch(mission: Mission):
  | {
      ok: true;
      patch: {
        status: "running";
        intentState: "executing";
        description: string;
      };
    }
  | {
      ok: false;
      error: string;
    } {
  // Qualquer missão bloqueada com contrato aprovado vigente é resumível pelo
  // bootstrap: os re-bloqueios do próprio ciclo (kickoff sem recibo,
  // provider_exited) NÃO anexam o marker, e exigi-lo aqui devolvia a missão
  // ao restore de panes — que recria a identidade morta que o bootstrap
  // recusa (beco circular). O bootstrap revalida squad/contrato/runtime de
  // qualquer forma.
  //
  // Field trap (28/07): exigir também que o intentState fosse blocked_* fechava
  // um segundo beco. Um bloqueio pode gravar status=blocked deixando o
  // intentState anterior (ex.: `dispatched`), e esse par inconsistente era
  // recusado pelos DOIS lados — o início pedia `running`, a retomada pedia
  // `blocked_*` — prendendo a missão para sempre:
  //   failed to start: ... (status=blocked/dispatched — missão precisa estar running)
  //   retomada recusada: Só uma missão bloqueada pode ser retomada por aqui.
  // `status === "blocked"` já é o sinal de autoridade; o par desalinhado é
  // exatamente o que este patch cura, ao gravar running/executing junto.
  if (mission.status !== "blocked") {
    return {
      ok: false,
      error: "Só uma missão bloqueada pode ser retomada por aqui.",
    };
  }
  if (mission.intentState === "done") {
    return {
      ok: false,
      error: "Esta missão já foi concluída; abra uma nova para continuar.",
    };
  }
  // The approved contract must still be current; everything else (squad hash,
  // runtime, seal) is re-validated by the bootstrap itself after re-arm.
  if (!hasCurrentApprovedDispatchContract(mission)) {
    return {
      ok: false,
      error:
        "A aprovação da missão não está mais vigente. Revise a intenção e aprove novamente.",
    };
  }
  const description = mission.description
    .split(BOOTSTRAP_BLOCK_MARKER)[0]!
    .split(GUIDED_PLAN_BLOCK_MARKER)[0]!
    .split(PLAN_PROMOTION_BLOCK_MARKER)[0]!
    .split(PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER)[0]!
    .trim();
  // begin_execution is the state machine's sanctioned exit from
  // blocked_technical; canDispatchWorkers excludes blocked states, so the
  // bootstrap would refuse a re-armed mission that kept the blocked intent.
  return {
    ok: true,
    patch: { status: "running", intentState: "executing", description },
  };
}

export function blockedPlanPromotionResumePatch(mission: Mission):
  | {
      ok: true;
      intentVersion: number;
      patch: MissionPatch;
    }
  | {
      ok: false;
      error: string;
    } {
  const contract = mission.intentContract;
  const intentVersion = mission.intentVersion;
  if (
    !mission.description.includes(PLAN_PROMOTION_BLOCK_MARKER) ||
    mission.status !== 'blocked' ||
    mission.intentState !== 'blocked_technical' ||
    contract?.lane !== 'standard' ||
    intentVersion === undefined ||
    contract.intentVersion !== intentVersion
  ) {
    return {
      ok: false,
      error:
        'A revisão promovida não conserva o contrato necessário para tentar o reinício.',
    };
  }
  return {
    ok: true,
    intentVersion,
    patch: {
      status: 'pending',
      intentState: 'ready_to_start',
      description: mission.description
        .split(PLAN_PROMOTION_BLOCK_MARKER)[0]!
        .trim(),
      intentContract: {
        ...contract,
        dispatchedAt: undefined,
      },
    },
  };
}

/**
 * Re-arm (only) a blocked mission that still has persisted pane composition:
 * pane respawn resolves the current authority seal from the LIVE mission, and
 * createMissionPaneAuthoritySeal is null while status != running — so panes
 * must never respawn before the mission is re-armed. Uses the state machine's
 * sanctioned exits (user_resume / begin_execution → executing). Pure for
 * testability; the IPC boundary applies the patch and the renderer then
 * restores the composition.
 */
export function blockedMissionRearmPatch(mission: Mission):
  | {
      ok: true;
      patch: {
        status: "running";
        intentState: "executing";
        description: string;
      };
    }
  | {
      ok: false;
      error: string;
    } {
  if (
    mission.description.includes(PLAN_PROMOTION_BLOCK_MARKER) ||
    mission.description.includes(PLAN_PROMOTION_TEARDOWN_BLOCK_MARKER)
  ) {
    return {
      ok: false,
      error:
        "A promoção exige encerrar fisicamente a sessão de plano; use Retomar missão.",
    };
  }
  // Same shape that wedged `blockedBootstrapResumePatch`: demanding the
  // intentState ALSO be blocked_* refused the inconsistent pair
  // `blocked` + `dispatched`, which a raw dispatch block used to produce. The
  // producer is fixed, but leaving the condition here keeps a loaded trap for
  // whoever rewires this channel — it currently has no production caller.
  // `status === 'blocked'` is the authority; a finished mission stays out.
  if (mission.status !== "blocked" || mission.intentState === "done") {
    return {
      ok: false,
      error: "Só uma missão bloqueada pode ser re-armada para retomada.",
    };
  }
  if (!hasCurrentApprovedDispatchContract(mission)) {
    return {
      ok: false,
      error:
        "A aprovação da missão não está mais vigente. Revise a intenção e aprove novamente.",
    };
  }
  const description = mission.description
    .split(BOOTSTRAP_BLOCK_MARKER)[0]!
    .trim();
  return {
    ok: true,
    patch: { status: "running", intentState: "executing", description },
  };
}

/** Main boundary: re-arm a blocked mission before the renderer restores panes. */
export function rearmBlockedMissionForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withMissionLifecycleLock(scope, missionId, () =>
    rearmBlockedMissionWithinLifecycleLock(scope, missionId),
  );
}

function rearmBlockedMissionWithinLifecycleLock(
  scope: ProjectExecutionScope,
  missionId: string,
): { ok: true } | { ok: false; error: string } {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) {
    return { ok: false, error: "Missão não encontrada neste workspace." };
  }
  const rearm = blockedMissionRearmPatch(mission);
  if (!rearm.ok) return rearm;
  const updated = stores.missions.update(missionId, rearm.patch);
  if (!updated) {
    return {
      ok: false,
      error: "A missão mudou durante a retomada. Tente novamente.",
    };
  }
  return { ok: true };
}


const DEAD_GRAPH_DISPATCH_STATES = new Set<TaskDispatchState>([
  "superseded",
  "blocked",
  "failed",
]);

interface DeadGraphPaneTarget {
  readonly paneId: string;
  readonly role: "orchestrator" | "worker";
  readonly sessionId?: string;
  readonly workerIncarnationId?: string;
  readonly observedInRuntime: boolean;
}

export interface DeadGraphReapprovalDeps {
  getMission(scope: ProjectExecutionScope, missionId: string): Mission | null;
  listMissionPanes(
    scope: ProjectExecutionScope,
    missionId: string,
  ): MissionPaneSpec[];
  removeMissionPane(scope: ProjectExecutionScope, paneRowId: string): boolean;
  listTaskDispatches(
    scope: ProjectExecutionScope,
    missionId: string,
  ): TaskDispatchRecord[];
  listRuntimePanes(): readonly PaneSnapshot[];
  getSessionState: typeof getSessionState;
  revokeSessionAuthority(sessionId: string): void;
  closePane(input: MissionPaneCloseRequest): boolean | Promise<boolean>;
  publishReapprovalRevision(
    scope: ProjectExecutionScope,
    missionId: string,
    expected: Mission,
  ): Mission;
}

const productionDeadGraphReapprovalDeps: DeadGraphReapprovalDeps = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  listMissionPanes: (scope, missionId) =>
    getProjectDomainStores(scope).missionPanes.list(missionId),
  removeMissionPane: (scope, paneRowId) =>
    getProjectDomainStores(scope).missionPanes.remove(paneRowId),
  listTaskDispatches: (scope, missionId) =>
    getProjectDomainStores(scope).taskDispatches.list(missionId),
  listRuntimePanes: listPaneSnapshots,
  getSessionState,
  revokeSessionAuthority: releaseSession,
  closePane: requestMissionPaneClose,
  publishReapprovalRevision: (scope, missionId, expected) =>
    getProjectDomainStores(scope).missions.publishDeadGraphReapprovalRevision(
      missionId,
      expected,
    ),
};

function deadGraphResumeFailure(
  missionId: string,
  detail: string,
  options: { readonly terminal?: boolean } = {},
): MissionOrchestratorBootstrapResult {
  // Structural identity conflicts never yield to retrying the same approved
  // revision: mark them terminal so the recovery lane settles instead of
  // burning all 8 attempts on a deterministic failure (H10).
  const error = options.terminal
    ? terminalOperationalFailureReason(detail)
    : detail;
  return Object.freeze({
    ok: false,
    missionId,
    reason: "not_authorized",
    error: error.slice(0, 4_096),
    cta: BOOTSTRAP_CTA,
  });
}

function sameDeadGraphMissionFence(
  expected: Mission,
  current: Mission | null,
): boolean {
  return Boolean(
    current &&
      current.updatedAt === expected.updatedAt &&
      current.orchestratorSessionId === expected.orchestratorSessionId &&
      bootstrapMissionSnapshot(current) === bootstrapMissionSnapshot(expected),
  );
}

/**
 * Convert a blocked, already-invalidated task graph into a fresh revision that
 * requires native approval. Returns null only for bootstrap-only blocks (no
 * terminal dispatch in the current revision), which retain the ordinary
 * resume/rebootstrap path.
 */
export async function prepareDeadGraphReapprovalForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  deps: DeadGraphReapprovalDeps = productionDeadGraphReapprovalDeps,
): Promise<MissionOrchestratorBootstrapResult | null> {
  const mission = deps.getMission(scope, missionId);
  if (!mission) {
    return deadGraphResumeFailure(
      missionId,
      "Missão não encontrada neste workspace.",
    );
  }
  const currentVersion = mission.intentVersion ?? 0;
  const currentDispatches = deps
    .listTaskDispatches(scope, missionId)
    .filter((dispatch) => dispatch.intentVersion === currentVersion);
  const invalidated = currentDispatches.filter(
      (dispatch) =>
        DEAD_GRAPH_DISPATCH_STATES.has(dispatch.state),
    );
  const retiredRouteInvalidated = hasRetiredRosterRouteMarker(
    mission.description,
  );
  if (invalidated.length === 0 && !retiredRouteInvalidated) return null;
  if (
    currentDispatches.some(
      (dispatch) =>
        dispatch.state !== "completed" &&
        !DEAD_GRAPH_DISPATCH_STATES.has(dispatch.state),
    )
  ) {
    return deadGraphResumeFailure(
      missionId,
      "Há um dispatch atual não terminal; a revisão permaneceu bloqueada sem encerrar processos ativos.",
    );
  }

  const resume = blockedBootstrapResumePatch(mission);
  if (!resume.ok) {
    return deadGraphResumeFailure(missionId, resume.error);
  }

  const persistedPanes = deps.listMissionPanes(scope, missionId);
  const runtimePanes = deps
    .listRuntimePanes()
    .filter((pane) => pane.missionId === missionId);
  if (
    runtimePanes.some(
      (pane) => !pane.scope || !sameScope(pane.scope, scope),
    )
  ) {
    return deadGraphResumeFailure(
      missionId,
      "O runtime antigo não conserva a identidade exata deste workspace; a missão permaneceu bloqueada.",
    );
  }

  const targets = new Map<string, DeadGraphPaneTarget>();
  const addTarget = (target: DeadGraphPaneTarget): boolean => {
    const existing = targets.get(target.paneId);
    if (!existing) {
      targets.set(target.paneId, target);
      return true;
    }
    if (
      existing.role !== target.role ||
      (existing.sessionId !== undefined &&
        target.sessionId !== undefined &&
        existing.sessionId !== target.sessionId) ||
      (existing.workerIncarnationId !== undefined &&
        target.workerIncarnationId !== undefined &&
        existing.workerIncarnationId !== target.workerIncarnationId)
    ) {
      return false;
    }
    targets.set(target.paneId, {
      paneId: target.paneId,
      role: target.role,
      sessionId: existing.sessionId ?? target.sessionId,
      workerIncarnationId:
        existing.workerIncarnationId ?? target.workerIncarnationId,
      observedInRuntime:
        existing.observedInRuntime || target.observedInRuntime,
    });
    return true;
  };

  for (const pane of persistedPanes) {
    if (!pane.paneId) continue;
    const matchingDispatches =
      pane.role === "worker"
        ? invalidated.filter(
            (dispatch) =>
              dispatch.paneId === pane.paneId ||
              (pane.workerIncarnationId !== undefined &&
                dispatch.workerIncarnationId === pane.workerIncarnationId),
          )
        : [];
    if (matchingDispatches.length > 1) {
      return deadGraphResumeFailure(
        missionId,
        "Mais de um dispatch reivindica o mesmo pane antigo; a missão permaneceu bloqueada.",
        { terminal: true },
      );
    }
    const dispatch = matchingDispatches[0];
    const observed = runtimePanes.find(
      (candidate) => candidate.paneId === pane.paneId,
    );
    const sessionId =
      pane.role === "orchestrator"
        ? mission.orchestratorSessionId
        : dispatch?.sessionId;
    if (
      observed &&
      sessionId !== undefined &&
      observed.sessionId !== sessionId
    ) {
      return deadGraphResumeFailure(
        missionId,
        "A sessão física do pane antigo divergiu do vínculo durável; a missão permaneceu bloqueada.",
        { terminal: true },
      );
    }
    if (
      !addTarget({
        paneId: pane.paneId,
        role: pane.role,
        sessionId: sessionId ?? observed?.sessionId ?? undefined,
        workerIncarnationId:
          pane.workerIncarnationId ?? dispatch?.workerIncarnationId,
        observedInRuntime: observed !== undefined,
      })
    ) {
      return deadGraphResumeFailure(
        missionId,
        "As identidades do pane antigo são ambíguas; a missão permaneceu bloqueada.",
        { terminal: true },
      );
    }
  }

  for (const dispatch of invalidated) {
    const bySession = dispatch.sessionId
      ? runtimePanes.filter(
          (candidate) => candidate.sessionId === dispatch.sessionId,
        )
      : [];
    const byPane = dispatch.paneId
      ? runtimePanes.filter(
          (candidate) => candidate.paneId === dispatch.paneId,
        )
      : [];
    const observed = [...new Set([...bySession, ...byPane])];
    if (observed.length > 1) {
      return deadGraphResumeFailure(
        missionId,
        "O worker antigo possui mais de uma identidade física; a missão permaneceu bloqueada.",
        { terminal: true },
      );
    }
    const runtime = observed[0];
    if (
      runtime &&
      ((dispatch.paneId !== undefined &&
        runtime.paneId !== dispatch.paneId) ||
        (dispatch.sessionId !== undefined &&
          runtime.sessionId !== dispatch.sessionId))
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O worker físico divergiu do dispatch terminal; a missão permaneceu bloqueada.",
        { terminal: true },
      );
    }
    const paneId = dispatch.paneId ?? runtime?.paneId;
    const sessionId = dispatch.sessionId ?? runtime?.sessionId ?? undefined;
    if (!paneId) {
      if (sessionId && deps.getSessionState(sessionId) !== null) {
        return deadGraphResumeFailure(
          missionId,
          "Há uma sessão antiga viva sem pane identificável; a missão permaneceu bloqueada.",
        );
      }
      continue;
    }
    if (
      !addTarget({
        paneId,
        role: "worker",
        sessionId,
        workerIncarnationId: dispatch.workerIncarnationId,
        observedInRuntime: runtime !== undefined,
      })
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O dispatch terminal conflita com a identidade do pane antigo; a missão permaneceu bloqueada.",
      );
    }
  }

  if (mission.orchestratorSessionId) {
    const observed = runtimePanes.filter(
      (pane) => pane.sessionId === mission.orchestratorSessionId,
    );
    if (observed.length > 1) {
      return deadGraphResumeFailure(
        missionId,
        "A sessão do orquestrador antigo está vinculada a múltiplos panes.",
        { terminal: true },
      );
    }
    if (
      observed[0] &&
      !addTarget({
        paneId: observed[0].paneId,
        role: "orchestrator",
        sessionId: mission.orchestratorSessionId,
        observedInRuntime: true,
      })
    ) {
      return deadGraphResumeFailure(
        missionId,
        "A identidade do orquestrador antigo é ambígua; a missão permaneceu bloqueada.",
        { terminal: true },
      );
    }
  }

  for (const runtime of runtimePanes) {
    if (
      (runtime.role !== "orchestrator" && runtime.role !== "worker") ||
      !addTarget({
        paneId: runtime.paneId,
        role: runtime.role,
        sessionId: runtime.sessionId ?? undefined,
        workerIncarnationId: runtime.workerIncarnationId,
        observedInRuntime: true,
      })
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O inventário físico antigo não possui autoridade exata para encerramento.",
        { terminal: true },
      );
    }
  }

  const knownSessions = new Set(
    [...targets.values()]
      .map((target) => target.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  try {
    for (const sessionId of knownSessions) {
      deps.revokeSessionAuthority(sessionId);
    }
  } catch {
    return deadGraphResumeFailure(
      missionId,
      "A autoridade de uma sessão antiga não pôde ser revogada; a missão permaneceu bloqueada.",
    );
  }

  for (const target of targets.values()) {
    if (!target.observedInRuntime) {
      if (
        target.sessionId &&
        deps.getSessionState(target.sessionId) !== null
      ) {
        return deadGraphResumeFailure(
          missionId,
          "A sessão antiga continua viva sem um pane físico verificável; a missão permaneceu bloqueada.",
        );
      }
      continue;
    }
    let closed = false;
    try {
      closed = await deps.closePane({
        paneId: target.paneId,
        missionId,
        scope,
        sessionId: target.sessionId,
        role: target.role,
        workerIncarnationId: target.workerIncarnationId,
      });
    } catch {
      closed = false;
    }
    if (
      !closed ||
      (target.sessionId &&
        deps.getSessionState(target.sessionId) !== null)
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O Nexus não obteve prova de encerramento físico de todos os panes e sessões antigos; a missão permaneceu bloqueada.",
      );
    }
  }

  for (const dispatch of invalidated) {
    if (
      dispatch.sessionId &&
      deps.getSessionState(dispatch.sessionId) !== null
    ) {
      return deadGraphResumeFailure(
        missionId,
        "Um worker antigo permaneceu vivo após o teardown; a missão permaneceu bloqueada.",
      );
    }
  }
  const runtimeAfterClose = deps
    .listRuntimePanes()
    .filter((pane) => pane.missionId === missionId);
  if (
    runtimeAfterClose.some((pane) => {
      const target = targets.get(pane.paneId);
      return (
        !target ||
        !pane.scope ||
        !sameScope(pane.scope, scope) ||
        pane.role !== target.role ||
        (target.sessionId !== undefined &&
          pane.sessionId !== target.sessionId) ||
        (pane.sessionId !== null &&
          deps.getSessionState(pane.sessionId) !== null)
      );
    })
  ) {
    return deadGraphResumeFailure(
      missionId,
      "O inventário físico mudou durante o teardown; a missão permaneceu bloqueada.",
    );
  }

  if (!sameDeadGraphMissionFence(mission, deps.getMission(scope, missionId))) {
    return deadGraphResumeFailure(
      missionId,
      "A missão mudou durante o teardown físico; a revisão nova não foi publicada.",
    );
  }
  const originalPaneRows = new Set(persistedPanes.map((pane) => pane.id));
  const panesBeforeCommit = deps.listMissionPanes(scope, missionId);
  if (panesBeforeCommit.some((pane) => !originalPaneRows.has(pane.id))) {
    return deadGraphResumeFailure(
      missionId,
      "Um novo pane apareceu durante o teardown; a revisão nova não foi publicada.",
    );
  }
  for (const pane of panesBeforeCommit) {
    let removed = false;
    try {
      removed = deps.removeMissionPane(scope, pane.id);
    } catch {
      removed = false;
    }
    if (
      !removed &&
      deps
        .listMissionPanes(scope, missionId)
        .some((candidate) => candidate.id === pane.id)
    ) {
      return deadGraphResumeFailure(
        missionId,
        "O vínculo durável de um pane antigo não pôde ser removido; a missão permaneceu bloqueada.",
      );
    }
  }
  if (deps.listMissionPanes(scope, missionId).length > 0) {
    return deadGraphResumeFailure(
      missionId,
      "O teardown durável dos panes antigos ficou incompleto; a missão permaneceu bloqueada.",
    );
  }

  let reapproval: Mission;
  try {
    reapproval = deps.publishReapprovalRevision(scope, missionId, mission);
  } catch (error) {
    return deadGraphResumeFailure(
      missionId,
      failureDetail(
        "A missão mudou antes do CAS da nova revisão; ela permaneceu bloqueada.",
        error,
      ),
    );
  }
  return Object.freeze({
    ok: false,
    missionId,
    reason: "review_required",
    intentVersion: reapproval.intentVersion,
    error:
      "A execução anterior foi encerrada. Revise a nova versão e aprove novamente antes de iniciar.",
    cta: "Revisar e aprovar",
  });
}

/**
 * Re-arm a bootstrap-blocked mission and retry the orchestrator bootstrap.
 * The bootstrap re-validates every authority (squad hash, contract, runtime)
 * and re-blocks with an actionable marker if the retry fails again.
 */
export function resumeBlockedMissionBootstrapForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<MissionOrchestratorBootstrapResult> {
  return withMissionLifecycleLock(scope, missionId, () =>
    resumeBlockedMissionBootstrapWithinLifecycleLock(scope, missionId),
  );
}

export interface AutomaticMissionBootstrapResumeDeps {
  readonly getMission: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => Mission | null;
  readonly resumeWithinLifecycleLock: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => Promise<MissionOrchestratorBootstrapResult>;
}

/**
 * Automatic recovery must re-authorize after waiting for the lifecycle lock.
 * A coordinator snapshot may say blocked_technical while an operator's Parar
 * wins the lock first and demotes it to blocked_user.
 */
export function resumeAutomaticallyBlockedMissionBootstrapForScope(
  scope: ProjectExecutionScope,
  missionId: string,
  deps: AutomaticMissionBootstrapResumeDeps = {
    getMission: (currentScope, currentMissionId) =>
      getProjectDomainStores(currentScope).missions.get(currentMissionId),
    resumeWithinLifecycleLock:
      resumeBlockedMissionBootstrapWithinLifecycleLock,
  },
): Promise<MissionOrchestratorBootstrapResult> {
  return withMissionLifecycleLock(
    scope,
    missionId,
    () => {
      const current = deps.getMission(scope, missionId);
      if (!current || !hasAutomaticTechnicalRecovery(current)) {
        return {
          ok: false as const,
          missionId,
          reason: "not_authorized" as const,
          error:
            "A recuperação automática foi cancelada porque a missão agora " +
            "aguarda uma decisão do operador ou perdeu a aprovação vigente.",
          cta: BOOTSTRAP_CTA,
        };
      }
      return deps.resumeWithinLifecycleLock(scope, missionId);
    },
    { acquireTimeoutMs: RECOVERY_LOCK_ACQUIRE_TIMEOUT_MS },
  ).catch((error): MissionOrchestratorBootstrapResult => {
    if (error instanceof MissionLifecycleLockBusyError) {
      // Another lifecycle transition holds the mission right now. This is
      // contention, not failure: the bounded backoff retries it, and the
      // attempt ceiling keeps even perpetual contention from looping forever.
      return {
        ok: false,
        missionId,
        reason: "preflight_failed",
        error:
          "recovery_lock_busy: outra transição do ciclo de vida da missão " +
          "segura o lock; a recuperação tenta novamente no próximo backoff.",
        cta: BOOTSTRAP_CTA,
      };
    }
    throw error;
  });
}

async function resumeBlockedMissionBootstrapWithinLifecycleLock(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<MissionOrchestratorBootstrapResult> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: "Missão não encontrada neste workspace.",
      cta: BOOTSTRAP_CTA,
    };
  }
  const deadGraphReapproval = await prepareDeadGraphReapprovalForScope(
    scope,
    missionId,
  );
  if (deadGraphReapproval) return deadGraphReapproval;
  // The marker is a substring of operator-authored description text, so it can
  // outlive the promotion it described. When the specialized patch refuses,
  // returning here left the mission wedged on "A revisão promovida não
  // conserva o contrato necessário" with no other exit — the generic resume
  // right below was never reached. Fall through instead: it is strictly more
  // restrictive (the bootstrap revalidates squad, contract and runtime), so
  // this removes the dead end without widening any authority.
  const promotionResume = mission.description.includes(
    PLAN_PROMOTION_BLOCK_MARKER,
  )
    ? blockedPlanPromotionResumePatch(mission)
    : null;
  if (promotionResume?.ok) {
    const reset = stores.missions.update(missionId, promotionResume.patch);
    if (!reset) {
      return {
        ok: false,
        missionId,
        reason: 'not_authorized',
        error:
          'A missão mudou durante a retomada da promoção. Tente novamente.',
        cta: BOOTSTRAP_CTA,
      };
    }
    return restartMissionOrchestratorAfterPlanPromotionForScope(
      scope,
      missionId,
      promotionResume.intentVersion,
      productionPlanPromotionRestartWithinLifecycleLockDeps,
    );
  }
  const resume = blockedBootstrapResumePatch(mission);
  if (!resume.ok) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: resume.error,
      cta: BOOTSTRAP_CTA,
    };
  }
  // Preserve every durable identity through re-arm. The bootstrap owns the
  // only safe replacement path: it inventories the exact physical pane,
  // proves/awaits process exit, then CAS-removes the row before spawning.
  // Deleting a row here when orch_session_id was null turned a torn binding
  // with a live provider into an invisible duplicate process.
  const updated = stores.missions.update(missionId, resume.patch);
  if (!updated) {
    return {
      ok: false,
      missionId,
      reason: "not_authorized",
      error: "A missão mudou durante a retomada. Tente novamente.",
      cta: BOOTSTRAP_CTA,
    };
  }
  return productionService.bootstrap(scope, missionId);
}

/** Starts durable-scope discovery before the coordinator's first pass. */
export function prepareMissionOrchestratorBootstrapRecovery(): void {
  // Via Rápida: a recuperação cerimonial NÃO pode disputar missões com o
  // motor novo — foi exatamente essa varredura que re-kickoffava por cima de
  // uma equipe viva e travava tudo em kickoff-timeout. Retomada é explícita
  // (Retomar/retry) e vai para resumeFastLaneMission.
  if (missionFastLaneEnabled()) return;
  if (disposeProductionScopeListener) return;
  disposeProductionScopeListener = requireProjectDomainStoreRegistry().onScope(
    (scope) => {
      productionScopes.set(productionScopeKey(scope), scope);
      // onScope runs after the durable suite is registered. Starting the
      // singleflight here closes restart recovery even before the renderer
      // reopens, while the coordinator supplies the periodic safety net.
      void productionRecovery.reconcile();
    },
  );
}

export function reconcileMissionOrchestratorBootstrap(): Promise<void> {
  if (missionFastLaneEnabled()) return Promise.resolve();
  return productionRecovery.reconcile();
}

export async function shutdownMissionOrchestratorBootstrapRecovery(): Promise<void> {
  disposeProductionScopeListener?.();
  disposeProductionScopeListener = null;
  productionScopes.clear();
  await productionRecovery.waitForIdle();
}


/** Renderer boundary for retrying a bootstrap-blocked mission. */
export async function resumeBlockedMissionBootstrapFromRenderer(
  owner: WebContents,
  raw: unknown,
): Promise<MissionOrchestratorBootstrapResult> {
  const input = missionOrchestratorBootstrapRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  if (missionFastLaneEnabled()) {
    try {
      await resumeFastLaneMission(scope, input.missionId);
      const pane = fastLaneOrchestratorPaneSummary(scope, input.missionId);
      if (pane) {
        return {
          ok: true,
          missionId: input.missionId,
          pane,
          kickoff: { accepted: true },
          reused: true,
        };
      }
      return {
        ok: false,
        missionId: input.missionId,
        reason: "spawn_failed",
        error: "a retomada não conseguiu religar a coordenação",
        cta: BOOTSTRAP_CTA,
      };
    } catch (error) {
      return {
        ok: false,
        missionId: input.missionId,
        reason: "materialization_failed",
        error:
          error instanceof Error ? error.message : "retomada da Via Rápida falhou",
        cta: BOOTSTRAP_CTA,
      };
    }
  }
  return resumeBlockedMissionBootstrapForScope(scope, input.missionId);
}
