import { app } from "electron";
import type { Mission, Squad } from "../../shared/orch-types";
import {
  hasCurrentDispatchAuthority,
  missionIntentAuthoritySnapshot,
} from "../../shared/mission-intent";
import type { ProviderQuotaEntry } from "../../shared/quota-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  getAdapter,
  isBuiltinAdapter,
} from "../adapters/adapter-registry";
import {
  isCredentiallessOpenCodeModel,
  isProviderAuthReadyForModel,
} from "../adapters/model-auth-readiness";
import { warmKeychainOnlySubscriptionAuth } from "../adapters/subscription-auth";
import {
  hasAvailableAccount,
  listAccounts,
  pickAvailable,
} from "../persistence/account-store";
import { listProviderSettings } from "../persistence/provider-config-store";
import { getSessionState } from "../pty/pty-manager";
import { supportsEnforceableWorkspaceWriteNativeAuthority } from "../pty/autonomous-cli-policy";
import { getOrchSettings } from "../persistence/settings-store";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { quotaAvailabilityScore } from "../quota/quota-policy";
import { requireQuotaService } from "../quota/quota-service";
import { trustRealMissionCodexProjectPath } from "../real-mission-codex-trust";
import { ensureGuidedGitBaselineForWorktreeAsync } from "../runtime/guided-greenfield-baseline";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import { classifyOperationalFailure } from "../runtime/operational-failure-policy";
import {
  awaitMissionSchedulerAuthorityFence,
  missionSchedulerAdmission,
} from "./mission-scheduler-authority";
import { loadMissionSchedulerDependencyHandoffs } from "./mission-scheduler-dependency-context";
import { isMissionOrchestratorLiveForScheduler } from "./mission-kickoff";
import { taskRecordToSchedulerTask } from "./mission-scheduler-io";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import {
  assertSealedTaskSchedule,
  resolveSealedWorkerRoute,
  supportsAdvisoryParticipationCli,
  supportsMechanicallyReadOnlyCli,
  type LiveRosterAdapter,
} from "./mission-scheduler-plan";
import { MISSION_SCHEDULER_WORKER_LEASE_POLICY } from "./mission-scheduler-policy";
import type { SchedulerDispatchRequest } from "./mission-scheduler-runtime";
import { buildMissionSchedulerTaskPrompt } from "./mission-scheduler-task-prompt";
import { selectMissionSchedulerWorktreeDependencies } from "./mission-scheduler-worktree-dependencies";
import { countLiveMissionWorkerSlots } from "./mission-driver-io";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { getSquad } from "./squad-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { hashMissionIntentContract } from "./mission-pane-authority";
import { spawnPaneAndMaybePrompt } from "./tool-util";
import {
  projectMissionSchedulerWorkerSlots,
} from "./task-dispatch-worker-retirement";
import { taskDispatchQualityRepairReason } from "./task-dispatch-store";
import { TASK_DISPATCH_SESSION_EXIT_REASON } from "./task-dispatch-persistence";
import {
  hasBoundHandoffForExactDispatchWorker,
  type TaskDispatchExecutionMode,
  type TaskDispatchRecord,
} from "./task-dispatch-codec";
import type { PlannedTaskRecord } from "./task-store";
import { reserveWorkerSpawnSlot } from "./tools-panes";
import { requestMissionPaneClose } from "./pane-registry";
import { throwIfMissionSchedulerAborted } from "./mission-scheduler-abort";

export const MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX =
  "Falha durante o bootstrap do worker:";

// Mutex async por checkout ao redor de `git worktree add`: uma wave paralela
// despacha os workers concorrentemente e o Git falha com lock em vez de
// enfileirar — sem a serialização, creates irmãos derrubam uns aos outros.
const worktreeCreateChains = new Map<string, Promise<unknown>>();

export function runWorktreeCreateSerialized<T>(
  scope: Pick<ProjectExecutionScope, "projectId" | "checkoutId">,
  create: () => Promise<T>,
): Promise<T> {
  const key = `${scope.projectId}:${scope.checkoutId}`;
  const previous = worktreeCreateChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(create);
  worktreeCreateChains.set(key, next);
  return next.finally(() => {
    if (worktreeCreateChains.get(key) === next) {
      worktreeCreateChains.delete(key);
    }
  });
}

export class MissionSchedulerCapacityWaitError extends Error {
  constructor(message: string, cause?: unknown) {
    super(
      `capacity_wait: ${message}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "MissionSchedulerCapacityWaitError";
  }
}

export class MissionSchedulerRetryableDispatchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MissionSchedulerRetryableDispatchError";
  }
}

export class MissionSchedulerDispatchAuthorityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MissionSchedulerDispatchAuthorityError";
  }
}

export function isMissionSchedulerCapacityWait(error: unknown): boolean {
  if (error instanceof MissionSchedulerCapacityWaitError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bcapacity_wait:/iu.test(message) ||
    /\bmaxWorkers=\d+\s+já está reservado por dispatches duráveis\b/iu.test(
      message,
    )
  );
}

export function isMissionSchedulerRetryableDispatchError(
  error: unknown,
): boolean {
  return (
    isMissionSchedulerCapacityWait(error) ||
    error instanceof MissionSchedulerRetryableDispatchError ||
    classifyOperationalFailure(error) === "retryable"
  );
}

export function missionSchedulerBootstrapFailureDetail(error: unknown): string {
  const cause = (error instanceof Error ? error.message : String(error))
    .trim()
    .slice(0, 64_000);
  return `${MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX} ${
    cause || "causa indisponível"
  }`;
}

function missionSchedulerSessionExitFailureDetail(error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  const maskedByLifecycleFence =
    /^dispatch sem autoridade de efeito no estado blocked$/iu.test(
      cause.trim(),
    );
  return missionSchedulerBootstrapFailureDetail(
    maskedByLifecycleFence
      ? "agent session exited during boot before prompt acceptance"
      : error,
  );
}

type DispatchFailureSnapshot = Pick<
  TaskDispatchRecord,
  | "state"
  | "revision"
  | "paneId"
  | "sessionId"
  | "workerIncarnationId"
  | "lastError"
>;

interface MissionSchedulerDispatchFailureStore {
  get(taskId: string): DispatchFailureSnapshot | null;
  refineBootstrapSessionExitBlock(input: {
    readonly taskId: string;
    readonly missionId: string;
    readonly revision: number;
    readonly leaseToken: string;
    readonly paneId: string;
    readonly sessionId: string;
    readonly workerIncarnationId: string;
    readonly error: string;
  }): unknown;
  failSupersededBootstrap(input: {
    readonly taskId: string;
    readonly missionId: string;
    readonly leaseToken: string;
    readonly paneId: string;
    readonly sessionId: string;
    readonly workerIncarnationId: string;
    readonly error: string;
  }): unknown;
  fail(input: {
    readonly taskId: string;
    readonly revision: number;
    readonly leaseToken: string;
    readonly error: string;
  }): unknown;
}

const TERMINAL_DISPATCH_FAILURE_STATES = new Set([
  "completed",
  "blocked",
  "failed",
  "suspended",
  "superseded",
]);

/**
 * Persist the failure observed by the scheduler bootstrap catch. If the PTY
 * exit tap already won the race, the durable row is generic+blocked on legacy
 * state or superseded on the recoverable path. Only the exact bound physical
 * identity and original lease may refine or terminalize that attempt.
 * A later/execution exit has no active scheduler catch and retains the generic
 * lifecycle reason.
 */
export function persistMissionSchedulerDispatchFailure(input: {
  readonly store: MissionSchedulerDispatchFailureStore;
  readonly missionId: string;
  readonly taskId: string;
  readonly leaseToken: string | null;
  readonly paneId: string | null;
  readonly sessionId: string | null;
  readonly workerIncarnationId: string | null;
  readonly error: unknown;
}): "refined" | "failed" | "unchanged" {
  if (!input.leaseToken) return "unchanged";
  const current = input.store.get(input.taskId);
  if (!current) return "unchanged";
  const genericSessionExitWon =
    current.state === "blocked" &&
    current.lastError === TASK_DISPATCH_SESSION_EXIT_REASON;
  const detail = genericSessionExitWon
    ? missionSchedulerSessionExitFailureDetail(input.error)
    : missionSchedulerBootstrapFailureDetail(input.error);
  if (
    genericSessionExitWon &&
    input.paneId &&
    input.sessionId &&
    input.workerIncarnationId &&
    current.paneId === input.paneId &&
    current.sessionId === input.sessionId &&
    current.workerIncarnationId === input.workerIncarnationId
  ) {
    input.store.refineBootstrapSessionExitBlock({
      taskId: input.taskId,
      missionId: input.missionId,
      revision: current.revision,
      leaseToken: input.leaseToken,
      paneId: input.paneId,
      sessionId: input.sessionId,
      workerIncarnationId: input.workerIncarnationId,
      error: detail,
    });
    return "refined";
  }
  const recoverableSessionExitWon =
    current.state === "superseded" &&
    current.lastError === TASK_DISPATCH_SESSION_EXIT_REASON &&
    classifyOperationalFailure(input.error) === "terminal";
  if (
    recoverableSessionExitWon &&
    input.paneId &&
    input.sessionId &&
    input.workerIncarnationId &&
    current.paneId === input.paneId &&
    current.sessionId === input.sessionId &&
    current.workerIncarnationId === input.workerIncarnationId
  ) {
    input.store.failSupersededBootstrap({
      taskId: input.taskId,
      missionId: input.missionId,
      leaseToken: input.leaseToken,
      paneId: input.paneId,
      sessionId: input.sessionId,
      workerIncarnationId: input.workerIncarnationId,
      error: detail,
    });
    return "failed";
  }
  if (TERMINAL_DISPATCH_FAILURE_STATES.has(current.state)) {
    return "unchanged";
  }
  input.store.fail({
    taskId: input.taskId,
    revision: current.revision,
    leaseToken: input.leaseToken,
    error: detail,
  });
  return "failed";
}

export function missionAccountQuotaScores(
  adapterId: string,
  entries: readonly ProviderQuotaEntry[],
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const entry of entries) {
    if (entry.adapterId !== adapterId || !entry.accountId) continue;
    scores.set(entry.accountId, quotaAvailabilityScore(entry));
  }
  return scores;
}

async function resolveMissionSpawnAccountId(
  adapterId: string,
): Promise<string | undefined> {
  if (listAccounts(adapterId).length === 0) return undefined;
  let scores: ReadonlyMap<string, number> | undefined;
  try {
    const snapshot = await requireQuotaService().snapshot();
    const measured = missionAccountQuotaScores(adapterId, snapshot.entries);
    if (measured.size > 0) scores = measured;
  } catch {
    // Quota is an optimization signal. Cooldown/credential enforcement still
    // runs in account-store when the optional service is unavailable at boot.
  }
  const selected = pickAvailable(adapterId, null, Date.now(), scores);
  if (!selected) {
    throw new Error(
      `quota_unavailable: nenhuma conta ${adapterId} está apta para o worker`,
    );
  }
  return selected.id;
}

export function missionSchedulerRouteRequiresAccount(
  adapterId: string,
  model: string | undefined,
): boolean {
  return !isCredentiallessOpenCodeModel(adapterId, model);
}

/**
 * Re-anchor gate for the (re)bind of a read_only lane. The kickoff wave
 * claims every root task in one pass and each claim materializes the task
 * worktree at the HEAD of that moment; an advisor whose session is only
 * (re)bound after the executor integrated would otherwise validate the
 * stale claim-time tree and seal a receipt whose worktreeHeadSha predates
 * the integration it postdates — causal nonsense the completion chronology
 * invariant (chainHeadIsExact) rejects. Before such a worker session
 * starts, its worktree is fast-forwarded to the current integration HEAD.
 * Never eligible: a lane whose durable dispatch already binds physical
 * output (handoff/integration receipt — re-anchoring would rewrite the
 * tree a delivered receipt was sealed against), and any writable lane
 * (isolated_worktree), whose branch identity IS the delivery.
 */
export function readOnlyWorktreeReanchorEligible(input: {
  readonly executionMode: TaskDispatchExecutionMode;
  readonly dispatch: Pick<
    TaskDispatchRecord,
    "handoffId" | "handoffAcceptedAt" | "integrationReceipt" | "completedAt"
  > | null;
}): boolean {
  return (
    input.executionMode === "read_only" &&
    input.dispatch?.handoffId === undefined &&
    input.dispatch?.handoffAcceptedAt === undefined &&
    input.dispatch?.integrationReceipt === undefined &&
    input.dispatch?.completedAt === undefined
  );
}

/**
 * Keychain-only subscription providers (AGY) read as login-needed from the
 * warm status cache whenever no renderer/settings flow recently listed
 * providers — file probes also see an isolated E2E HOME, never the native
 * session. The scheduler's sealed-roster gate consumes that cache, so a live
 * operator session otherwise loops on roster_route_unavailable until the
 * pre-claim bound blocks the mission. Delegates to the shared warm helper
 * (main-loop-safe, memoized, authoritative) before building the roster.
 */
export async function warmMissionSchedulerRosterSubscriptionAuth(
  cliId: string,
): Promise<void> {
  await warmKeychainOnlySubscriptionAuth(cliId);
}

export function missionSchedulerLiveRosterAdapter(input: {
  readonly provider: {
    readonly adapterId: string;
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly authStrategy: string;
    readonly models: readonly string[];
    readonly defaultModel: string;
  };
  readonly requestedModel: string | undefined;
  readonly hasAvailableAccount: (adapterId: string) => boolean;
}): LiveRosterAdapter {
  const { provider, requestedModel } = input;
  const credentialless = isCredentiallessOpenCodeModel(
    provider.adapterId,
    requestedModel,
  );
  return Object.freeze({
    id: provider.adapterId,
    installed:
      provider.enabled &&
      provider.installed &&
      isProviderAuthReadyForModel(provider, requestedModel) &&
      (credentialless || input.hasAvailableAccount(provider.adapterId)),
    models: Object.freeze({
      list: provider.models,
      default: provider.defaultModel,
    }),
  });
}

export interface MissionSchedulerPreProviderAuthority {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly intentAuthority: string;
  readonly taskId: string;
  readonly planAuthority: string;
  readonly squadRevisionHash: string;
}

function intentAuthoritySnapshot(mission: Mission): string {
  return hashMissionIntentContract({
    id: mission.id,
    intentVersion: mission.intentVersion ?? 0,
    // Spend is a live runtime ledger, not approved intent. Tool use by one
    // sibling must not revoke another sibling's already-sealed bootstrap.
    intentContract: mission.intentContract
      ? missionIntentAuthoritySnapshot(mission.intentContract)
      : null,
    squadId: mission.squadId ?? null,
  });
}

function planAuthoritySnapshot(planned: PlannedTaskRecord): string {
  return hashMissionIntentContract({
    plannerId: planned.plannerId,
    taskId: planned.taskId,
    missionId: planned.missionId,
    intentVersion: planned.intentVersion,
    squadId: planned.squadId,
    rosterHash: planned.rosterHash,
    agentRef: planned.agentRef,
    agentCategory: planned.agentCategory,
    agent: planned.agent,
    plannedTitle: planned.plannedTitle,
    plannedDetail: planned.plannedDetail,
    taskTitle: planned.task.title,
    taskDetail: planned.task.detail,
  });
}

/**
 * Captures the exact approved intent, immutable task-plan receipt and current
 * squad revision used by a worker dispatch. PREVC is deliberately absent:
 * workers may run while Main prepares it, and `ensurePrevcMergeReady` remains
 * the mandatory promotion boundary.
 */
export function captureMissionSchedulerPreProviderAuthority(input: {
  readonly mission: Mission | null;
  readonly planned: PlannedTaskRecord | null;
  readonly squad: Squad | null;
}): MissionSchedulerPreProviderAuthority {
  const { mission, planned, squad } = input;
  if (!mission?.intentContract || !hasCurrentDispatchAuthority(mission)) {
    throw new Error(
      "scheduler dispatch requires current approved mission authority",
    );
  }
  if (!mission.squadId || !squad || squad.id !== mission.squadId) {
    throw new Error("scheduler dispatch squad is unavailable or changed");
  }
  const squadRevisionHash = snapshotSquadAuthority(squad).hash;
  if (mission.intentContract.squadRevisionHash !== squadRevisionHash) {
    throw new Error(
      "scheduler dispatch squad changed after mission approval",
    );
  }
  if (
    !planned ||
    planned.missionId !== mission.id ||
    planned.intentVersion !== mission.intentContract.intentVersion ||
    planned.squadId !== mission.squadId ||
    planned.taskId !== planned.task.id ||
    planned.task.title !== planned.plannedTitle ||
    planned.task.detail !== planned.plannedDetail
  ) {
    throw new Error(
      "scheduler dispatch task diverged from the sealed plan authority",
    );
  }
  return Object.freeze({
    missionId: mission.id,
    intentVersion: mission.intentContract.intentVersion,
    intentAuthority: intentAuthoritySnapshot(mission),
    taskId: planned.taskId,
    planAuthority: planAuthoritySnapshot(planned),
    squadRevisionHash,
  });
}

/** Revalidates intent, plan and squad after every asynchronous preparation. */
export function assertMissionSchedulerPreProviderAuthority(input: {
  readonly expected: MissionSchedulerPreProviderAuthority;
  readonly mission: Mission | null;
  readonly planned: PlannedTaskRecord | null;
  readonly squad: Squad | null;
}): void {
  const current = captureMissionSchedulerPreProviderAuthority(input);
  if (
    current.missionId !== input.expected.missionId ||
    current.intentVersion !== input.expected.intentVersion ||
    current.intentAuthority !== input.expected.intentAuthority
  ) {
    throw new Error(
      "scheduler dispatch intent authority changed before provider effect",
    );
  }
  if (
    current.taskId !== input.expected.taskId ||
    current.planAuthority !== input.expected.planAuthority
  ) {
    throw new Error(
      "scheduler dispatch plan authority changed before provider effect",
    );
  }
  if (current.squadRevisionHash !== input.expected.squadRevisionHash) {
    throw new Error(
      "scheduler dispatch squad authority changed before provider effect",
    );
  }
}
function schedulerDispatchAdmission(
  scope: ProjectExecutionScope,
  stores: ReturnType<typeof getProjectDomainStores>,
  mission: Mission,
) {
  const orchestratorPane =
    stores.missionPanes
      .list(mission.id)
      .find((pane) => pane.role === 'orchestrator') ?? null;
  return missionSchedulerAdmission({
    mission,
    hasCurrentKickoffReceipt:
      stores.missions.hasCurrentKickoffAcceptance(mission.id),
    orchestratorLive: isMissionOrchestratorLiveForScheduler(
      scope,
      mission,
      orchestratorPane,
    ),
  });
}


function hasExactBootstrapExitProof(
  dispatch: TaskDispatchRecord | null,
  input: {
    readonly paneId: string;
    readonly sessionId: string;
    readonly workerIncarnationId: string;
  },
): boolean {
  return Boolean(
    (dispatch?.state === "blocked" || dispatch?.state === "superseded") &&
      dispatch.lastError === TASK_DISPATCH_SESSION_EXIT_REASON &&
      dispatch.paneId === input.paneId &&
      dispatch.sessionId === input.sessionId &&
      dispatch.workerIncarnationId === input.workerIncarnationId,
  );
}

async function compensateRetryableBootstrapFailure(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly taskId: string;
  readonly stores: ReturnType<typeof getProjectDomainStores>;
  readonly leaseToken: string;
  readonly workerIncarnationId: string;
  readonly paneId: string | null;
  readonly sessionId: string | null;
  readonly error: unknown;
}): Promise<void> {
  const { paneId, sessionId, workerIncarnationId } = input;
  if (Boolean(paneId) !== Boolean(sessionId)) {
    throw new MissionSchedulerDispatchAuthorityError(
      "bootstrap retry encontrou identidade física parcial",
    );
  }
  // The exact worker's handoff may already be durably bound (AGY exits by
  // itself right after printing the block, so a bootstrap-phase abort/error
  // can race the ingest). Then there is nothing to compensate: the physical
  // work product exists and the normal handoff-consumption path owns the
  // dispatch. A requeue attempt would (correctly) be refused by the store —
  // never let that refusal terminalize a delivered handoff.
  if (
    hasBoundHandoffForExactDispatchWorker(
      input.stores.taskDispatches.get(input.taskId),
      { missionId: input.missionId, sessionId, workerIncarnationId },
    )
  ) {
    return;
  }
  if (paneId && sessionId) {
    const exactIdentity = { paneId, sessionId, workerIncarnationId };
    const alreadyExited = hasExactBootstrapExitProof(
      input.stores.taskDispatches.get(input.taskId),
      exactIdentity,
    );
    const closed =
      alreadyExited ||
      (await requestMissionPaneClose({
        scope: input.scope,
        missionId: input.missionId,
        paneId,
        sessionId,
        role: "worker",
        workerIncarnationId,
      }));
    const physicallyGone =
      closed ||
      hasExactBootstrapExitProof(
        input.stores.taskDispatches.get(input.taskId),
        exactIdentity,
      ) ||
      getSessionState(sessionId) === null ||
      getSessionState(sessionId) === "exited";
    if (!physicallyGone) {
      throw new MissionSchedulerDispatchAuthorityError(
        "bootstrap retry não comprovou o encerramento físico do worker",
      );
    }
    const missionPaneRows = input.stores.missionPanes
      .list(input.missionId)
      .filter((row) => row.paneId === paneId);
    const exactPane = input.stores.missionPanes.findByPaneId(paneId);
    if (
      missionPaneRows.length > 1 ||
      (missionPaneRows.length === 1 &&
        (!exactPane ||
          exactPane.role !== "worker" ||
          exactPane.workerIncarnationId !== workerIncarnationId))
    ) {
      throw new MissionSchedulerDispatchAuthorityError(
        "bootstrap retry encontrou autoridade ambígua no pane persistido",
      );
    }
    if (exactPane) input.stores.missionPanes.remove(exactPane.id);
  }
  input.stores.taskDispatches.requeueTechnicalBootstrapFailure({
    taskId: input.taskId,
    missionId: input.missionId,
    leaseToken: input.leaseToken,
    workerIncarnationId,
    ...(paneId ? { paneId } : {}),
    ...(sessionId ? { sessionId } : {}),
    error: missionSchedulerBootstrapFailureDetail(input.error),
  });
}

export async function dispatchMissionSchedulerTask(
  scope: ProjectExecutionScope,
  missionId: string,
  request: SchedulerDispatchRequest,
  signal?: AbortSignal,
): Promise<void> {
  throwIfMissionSchedulerAborted(signal);
  const { taskId } = request;
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission?.intentContract) {
    throw new Error("scheduler dispatch requires an approved mission contract");
  }
  const initialAdmission = schedulerDispatchAdmission(scope, stores, mission);
  if (!initialAdmission.ok) {
    throw new MissionSchedulerDispatchAuthorityError(
      `mission-admission:${initialAdmission.code}`,
    );
  }
  const planned = stores.tasks.getPlannedTask(taskId);
  if (
    !planned ||
    planned.missionId !== missionId ||
    planned.intentVersion !== mission.intentContract.intentVersion
  ) {
    throw new Error(
      `task ${taskId} não pertence ao plano selado da intenção atual`,
    );
  }
  const task = planned.task;
  const qualityRepairReason = taskDispatchQualityRepairReason(
    stores.taskDispatches.get(taskId),
  );
  const decoded = decodeTaskScheduleDetail(task.detail);
  const meta = assertSealedTaskSchedule(planned, decoded.meta);
  const mapped = taskRecordToSchedulerTask(task);
  if (
    JSON.stringify(request.ownership) !== JSON.stringify(meta.ownership) ||
    JSON.stringify(request.dependsOn) !== JSON.stringify(meta.dependsOn)
  ) {
    throw new Error(`scheduler request ${taskId} divergiu do plano selado`);
  }
  // Reroute durável dentro do roster selado: se o coordenador re-vinculou o
  // dispatch a um agente alternativo (CLI original esgotou spawn físico), o
  // dispatch inteiro — rota, claim, prompt, pane — usa esse agente. O plano
  // selado permanece imutável; o claim re-valida a diretiva contra o mesmo
  // roster/hash na transação SQLite.
  const rerouteDirective = (() => {
    const currentDispatch = stores.taskDispatches.get(taskId);
    return currentDispatch?.state === "superseded" &&
      currentDispatch.intentVersion === mission.intentContract.intentVersion
      ? currentDispatch.providerReroute
      : undefined;
  })();
  const effectiveAgent = (() => {
    if (!rerouteDirective) return planned.agent;
    if (rerouteDirective.fromAgentRef !== planned.agentRef) {
      throw new Error(
        "diretiva de reroute divergiu do agentRef selado do plano",
      );
    }
    const receipt = stores.tasks.getPlanReceipt(
      missionId,
      mission.intentContract.intentVersion,
    );
    const candidate = receipt?.agents.find(
      (agent) => agent.id === rerouteDirective.toAgentRef,
    );
    if (!candidate || candidate.category !== planned.agentCategory) {
      throw new Error(
        "agente alternativo do reroute não existe no roster selado com a categoria da task",
      );
    }
    return candidate;
  })();
  const effectiveAgentRef = rerouteDirective?.toAgentRef ?? planned.agentRef;
  const squad = mission.squadId ? getSquad(mission.squadId) : null;
  const dispatchAuthority = captureMissionSchedulerPreProviderAuthority({
    mission,
    planned,
    squad,
  });
  const assertCurrentDispatchAuthority = (): void => {
    const currentMission = stores.missions.get(missionId);
    if (!currentMission) {
      throw new MissionSchedulerDispatchAuthorityError(
        'mission-admission:authority-missing',
      );
    }
    const admission = schedulerDispatchAdmission(
      scope,
      stores,
      currentMission,
    );
    if (!admission.ok) {
      throw new MissionSchedulerDispatchAuthorityError(
        `mission-admission:${admission.code}`,
      );
    }
    const currentPlanned = stores.tasks.getPlannedTask(taskId);
    assertMissionSchedulerPreProviderAuthority({
      expected: dispatchAuthority,
      mission: currentMission,
      planned: currentPlanned,
      squad: currentMission.squadId
        ? getSquad(currentMission.squadId)
        : null,
    });
  };
  assertCurrentDispatchAuthority();
  const dependencyHandoffs = loadMissionSchedulerDependencyHandoffs({
    missionId,
    dependsOn: mapped.dependsOn,
    stores,
  });
  const worktreeDependencies =
    selectMissionSchedulerWorktreeDependencies({
      missionId,
      dependsOn: mapped.dependsOn,
      getDispatch: (dependencyTaskId) =>
        stores.taskDispatches.get(dependencyTaskId),
    });
  const executionMode = meta.executionMode;
  const taskText = `${task.title}\n${decoded.body}`;
  await warmMissionSchedulerRosterSubscriptionAuth(effectiveAgent.cli);
  const adapters = listProviderSettings()
    .filter((provider) => provider.adapterId !== "shell")
    .map((provider) => {
      const requestedModel =
        provider.adapterId === effectiveAgent.cli
          ? (effectiveAgent.model ?? provider.defaultModel)
          : provider.defaultModel;
      return missionSchedulerLiveRosterAdapter({
        provider,
        requestedModel,
        hasAvailableAccount,
      });
    });
  const orchestratorCliId =
    squad?.agents.find((agent) => agent.category === "orchestrator")?.cli;
  const sealedRoute = resolveSealedWorkerRoute({
    taskText,
    agent: effectiveAgent,
    adapters,
    rosterHash: planned.rosterHash,
    orchestratorCliId,
  });
  const operatorChoice = isOperatorChoicePolicy(
    getOrchSettings().squadCliPolicy,
  );
  const useTaskWorktree =
    executionMode === "isolated_worktree" ||
    (operatorChoice && executionMode === "read_only");
  if (executionMode === "isolated_worktree") {
    const liveAdapter = getAdapter(sealedRoute.routeContract.adapterId);
    // Governed: require Codex-class native workspace-write. Operator-choice:
    // any live cli-pty is enough because the worker runs in its own worktree
    // and only Main can integrate a validated candidate.
    const writeEligible =
      liveAdapter?.kind === "cli-pty" &&
      (operatorChoice ||
        (isBuiltinAdapter(liveAdapter.id) &&
          supportsEnforceableWorkspaceWriteNativeAuthority(liveAdapter)));
    if (!liveAdapter || !writeEligible) {
      throw new Error(
        `workspace_write_unsupported: ${sealedRoute.routeContract.adapterId} ` +
          (operatorChoice
            ? "não possui uma rota cli-pty ativa para o worktree da tarefa"
            : "não possui sandbox nativo builtin qualificado para o dispatch selado"),
      );
    }
  }
  const accountId = await awaitMissionSchedulerAuthorityFence({
    assertCurrentAuthority: assertCurrentDispatchAuthority,
    prepare: () =>
      missionSchedulerRouteRequiresAccount(
        sealedRoute.routeContract.adapterId,
        sealedRoute.routeContract.model,
      )
        ? resolveMissionSpawnAccountId(sealedRoute.decision.adapterId)
        : Promise.resolve(undefined),
  });
  throwIfMissionSchedulerAborted(signal);
  if (executionMode === "read_only" && !operatorChoice) {
    const adapterId = sealedRoute.decision.adapterId;
    // Two ways to earn a read_only lane, both enforced outside the prompt:
    // the provider's own verified profile (codex argv, grok Seatbelt), or the
    // Nexus-owned kernel sandbox that mounts the execution scope read-only for
    // an advisory CLI (see advisory-process-sandbox). The Nexus boundary is
    // macOS-only today, so elsewhere an advisory CLI still has no barrier.
    const providerConfined = supportsMechanicallyReadOnlyCli(adapterId);
    const nexusConfined =
      process.platform === "darwin" &&
      supportsAdvisoryParticipationCli(adapterId);
    if (!providerConfined && !nexusConfined) {
      throw new Error(
        `read_only_unsupported: ${adapterId} não oferece ` +
          "uma barreira mecânica de escrita verificada; " +
          "replaneje com uma CLI que suporte sandbox read-only verificado",
      );
    }
  }
  const workerId = effectiveAgent.agentName;
  const plannedAllowedTools = effectiveAgent.allowedTools ?? [];
  const dispatches = stores.taskDispatches.list(missionId);
  const workerSlotProjection = projectMissionSchedulerWorkerSlots(
    missionId,
    stores.missionPanes.list(missionId),
    dispatches,
  );
  throwIfMissionSchedulerAborted(signal);
  const reservation = reserveWorkerSpawnSlot({
    scope,
    missionId,
    contract: mission.intentContract,
    // Scheduler-bound workers are counted by active durable dispatch, while
    // manual/ambiguous panes retain the existing live-pane fail-safe.
    currentWorkerCount:
      countLiveMissionWorkerSlots(
        scope,
        missionId,
        workerSlotProjection.unmanagedRows,
      ).live + workerSlotProjection.activeDispatchCount,
    allowedTools: plannedAllowedTools,
  });
  if (!reservation.ok) {
    if (reservation.code === "budget_exhausted") {
      throw new MissionSchedulerCapacityWaitError(reservation.error);
    }
    throw new Error(reservation.error);
  }

  let worktreeCreated = false;
  let dispatchLeaseToken: string | null = null;
  let dispatchRevision: number | null = null;
  let dispatchWorkerIncarnationId: string | null = null;
  let boundPaneId: string | null = null;
  let boundSessionId: string | null = null;
  try {
    throwIfMissionSchedulerAborted(signal);
    assertCurrentDispatchAuthority();
    if (useTaskWorktree) {
      // Every WorktreeManager reservation needs a real, clean base. Existing
      // operator bytes are checkpointed before the first claim so a local Git
      // precondition never consumes a durable dispatch attempt.
      await ensureGuidedGitBaselineForWorktreeAsync(scope);
    }
    const claim = stores.taskDispatches.claim({
      missionId,
      taskId,
      intentVersion: mission.intentContract.intentVersion,
      workerId,
      leaseOwner: "main-orchestration-coordinator",
      leaseMs: MISSION_SCHEDULER_WORKER_LEASE_POLICY.claimLeaseMs,
      maxWorkers: mission.intentContract.budgets.maxWorkers,
      ownership: mapped.ownership,
      executionMode,
      agentRef: effectiveAgentRef,
      agentCategory: meta.agentCategory,
      rosterHash: planned.rosterHash,
      routeContract: sealedRoute.routeContract,
    });
    dispatchLeaseToken = claim.leaseToken;
    dispatchRevision = claim.revision;
    dispatchWorkerIncarnationId = claim.workerIncarnationId;
    const worktree =
      useTaskWorktree
        ? await runWorktreeCreateSerialized(scope, () =>
            requireWorktreeRuntimeRegistry().create({
              scope,
              missionId,
              taskId,
              workerId,
              ownership: mapped.ownership,
              dependsOn: worktreeDependencies,
            }),
          )
        : null;
    throwIfMissionSchedulerAborted(signal);
    worktreeCreated = worktree !== null;
    if (
      worktree &&
      readOnlyWorktreeReanchorEligible({ executionMode, dispatch: claim })
    ) {
      // Re-anchor BEFORE this worker session starts: the advisor must
      // observe (and seal a receipt against) the tree that contains every
      // integration completed since the claim-time base was frozen.
      //
      // Convergence, not authority — and deliberately so. This call is not
      // serialized against sibling re-anchors, and when `useTaskWorktree` is
      // false (governed policy + read_only) there is no worktree to re-anchor
      // at all: `executionRoot` is the operator checkout, which the lane can
      // only read (provider read-only profile or the Nexus kernel sandbox).
      // What guarantees that concurrent read_only lanes seal the same tree is
      // `assertReadOnlyLaneObservationCurrent` at the handoff boundary, which
      // refuses any receipt whose `worktreeHeadSha` is not exactly the
      // mission's latest `worktree_integrated` reference. A lane that drifted
      // is refused and requeued; nothing inconsistent is ever persisted.
      requireWorktreeRuntimeRegistry().reanchorReadyWorktreeToIntegrationHead(
        scope,
        missionId,
        taskId,
      );
    }
    const executionRoot = worktree?.worktreePath ?? scope.rootRealPath;
    if (worktree?.worktreePath) {
      try {
        trustRealMissionCodexProjectPath(
          app.getPath("userData"),
          worktree.worktreePath,
        );
      } catch {
        // Exact Codex project trust is best-effort for the release gate only.
      }
    }
    const routeReservation = stores.missions.reserveRouteDecision(
      missionId,
      taskText,
      sealedRoute.decision,
    );
    const routedDispatch = stores.taskDispatches.attachRoute({
      taskId,
      revision: dispatchRevision,
      leaseToken: dispatchLeaseToken,
      routeReservationId: routeReservation.id,
      ...sealedRoute.routeContract,
    });
    dispatchRevision = routedDispatch.revision;
    const spawningDispatch = stores.taskDispatches.markSpawning({
      taskId,
      revision: dispatchRevision,
      leaseToken: dispatchLeaseToken,
    });
    dispatchRevision = spawningDispatch.revision;
    stores.missions.consumeRouteReservation(
      {
        reservationId: routeReservation.id,
        missionId,
        ...sealedRoute.routeContract,
      },
      `dispatch:${claim.id}`,
    );
    const assertCurrentSpawnAuthority = (): void => {
      assertCurrentDispatchAuthority();
      const current = stores.taskDispatches.assertLifecycleAuthority({
        taskId,
        missionId,
        intentVersion: mission.intentContract!.intentVersion,
        expectedStates: ["spawning", "running"],
      });
      if (
        current.workerIncarnationId !== claim.workerIncarnationId ||
        current.workerId !== workerId ||
        current.agentRef !== effectiveAgentRef
      ) {
        throw new Error(
          "scheduler spawn authority diverged from the sealed worker incarnation",
        );
      }
    };
    throwIfMissionSchedulerAborted(signal);
    assertCurrentSpawnAuthority();
    await spawnPaneAndMaybePrompt(
      {
        adapterId: sealedRoute.routeContract.adapterId,
        accountId,
        model: sealedRoute.routeContract.model,
        effort: sealedRoute.routeContract.effort,
        cwd: executionRoot,
        executionScope: Object.freeze({
          ...scope,
          rootRealPath: executionRoot,
        }),
        scope,
        missionId,
        agentName: effectiveAgent.agentName,
        workerIncarnationId: claim.workerIncarnationId,
        agentCategory: meta.agentCategory,
        role: "worker",
        executionMode,
        title: task.title,
        prompt: buildMissionSchedulerTaskPrompt(
          { ...mapped, title: task.title, detail: decoded.body },
          {
            agentName: effectiveAgent.agentName,
            category: meta.agentCategory,
            executionMode,
            qualityRepairReason,
          },
          dependencyHandoffs,
        ),
        allowedTools: [...(reservation.allowedTools ?? plannedAllowedTools)],
        allowedSkills:
          effectiveAgent.allowedSkills === null ||
          effectiveAgent.allowedSkills === undefined
            ? null
            : [...effectiveAgent.allowedSkills],
        readOnly: executionMode === "read_only",
      },
      {
        invocation: {
          ...(signal ? { signal } : {}),
          assertCurrentAuthority: assertCurrentSpawnAuthority,
        },
        onPaneCreated: (paneId, sessionId) => {
          if (!dispatchLeaseToken || dispatchRevision === null) return;
          const bound = stores.taskDispatches.bindSpawn({
            taskId,
            revision: dispatchRevision,
            leaseToken: dispatchLeaseToken,
            workerIncarnationId: claim.workerIncarnationId,
            paneId,
            sessionId,
          });
          dispatchRevision = bound.revision;
          boundPaneId = paneId;
          boundSessionId = sessionId;
        },
        ...(dependencyHandoffs.length > 0
          ? {
              onPromptAccepted: (
                paneId: string,
                sessionId: string,
                acceptedPrompt: string,
              ) => {
                if (!dispatchLeaseToken || dispatchRevision === null) {
                  throw new Error(
                    "dependency consumption prompt accepted without dispatch authority",
                  );
                }
                const current = stores.taskDispatches.get(taskId);
                if (
                  !current ||
                  current.paneId !== paneId ||
                  current.sessionId !== sessionId ||
                  current.workerIncarnationId !== claim.workerIncarnationId
                ) {
                  throw new Error(
                    "dependency consumption prompt diverged from the bound worker",
                  );
                }
                stores.taskDispatches.recordDependencyPromptConsumption({
                  taskId,
                  revision: dispatchRevision,
                  leaseToken: dispatchLeaseToken,
                  sessionId,
                  workerIncarnationId: claim.workerIncarnationId,
                  acceptedPrompt,
                  dependencies: dependencyHandoffs.map((dependency) => ({
                    taskId: dependency.taskId,
                    handoffId: dependency.handoffId,
                    summary: dependency.summary,
                    summarySha256: dependency.summarySha256,
                  })),
                });
              },
            }
          : {}),
      },
    );
    throwIfMissionSchedulerAborted(signal);
  } catch (error) {
    if (signal?.aborted) {
      if (dispatchLeaseToken && dispatchWorkerIncarnationId) {
        try {
          await compensateRetryableBootstrapFailure({
            scope,
            missionId,
            taskId,
            stores,
            leaseToken: dispatchLeaseToken,
            workerIncarnationId: dispatchWorkerIncarnationId,
            paneId: boundPaneId,
            sessionId: boundSessionId,
            error: signal.reason ?? error,
          });
        } catch (recoveryError) {
          throw new MissionSchedulerDispatchAuthorityError(
            "dispatch abortado não pôde provar o encerramento físico exato",
            recoveryError,
          );
        }
      }
      throwIfMissionSchedulerAborted(signal);
    }
    if (isMissionSchedulerCapacityWait(error)) {
      throw error instanceof MissionSchedulerCapacityWaitError
        ? error
        : new MissionSchedulerCapacityWaitError(
            error instanceof Error ? error.message : String(error),
            error,
          );
    }
    const disposition = classifyOperationalFailure(error);
    // AGY exits by itself right after printing its handoff block, so a fast
    // advisory can surface a bootstrap-phase error (e.g. the acceptance watch
    // observing the physical exit) AFTER the handoff was durably bound to this
    // exact worker incarnation. That binding is the bootstrap's intended
    // physical outcome — a strictly stronger proof than any spawn-phase
    // signal — and every downstream consumer (read-only completion, worker
    // retirement) already handles a naturally exited session. Terminalizing
    // here would strand a delivered handoff and fail the mission.
    if (dispatchWorkerIncarnationId && boundSessionId) {
      if (
        hasBoundHandoffForExactDispatchWorker(
          stores.taskDispatches.get(taskId),
          {
            missionId,
            sessionId: boundSessionId,
            workerIncarnationId: dispatchWorkerIncarnationId,
          },
        )
      ) {
        return;
      }
    }
    if (
      disposition === "retryable" &&
      dispatchLeaseToken &&
      dispatchWorkerIncarnationId
    ) {
      try {
        await compensateRetryableBootstrapFailure({
          scope,
          missionId,
          taskId,
          stores,
          leaseToken: dispatchLeaseToken,
          workerIncarnationId: dispatchWorkerIncarnationId,
          paneId: boundPaneId,
          sessionId: boundSessionId,
          error,
        });
        throw new MissionSchedulerRetryableDispatchError(
          missionSchedulerBootstrapFailureDetail(error),
          error,
        );
      } catch (recoveryError) {
        if (recoveryError instanceof MissionSchedulerRetryableDispatchError) {
          throw recoveryError;
        }
        error = new MissionSchedulerDispatchAuthorityError(
          "falha técnica transitória não pôde ser compensada com autoridade exata",
          recoveryError,
        );
      }
    } else if (disposition === "retryable" && !dispatchLeaseToken) {
      throw new MissionSchedulerRetryableDispatchError(
        missionSchedulerBootstrapFailureDetail(error),
        error,
      );
    }
    const failureDetail = missionSchedulerBootstrapFailureDetail(error);
    let persistedFailure: ReturnType<
      typeof persistMissionSchedulerDispatchFailure
    > = "unchanged";
    try {
      persistedFailure = persistMissionSchedulerDispatchFailure({
        store: stores.taskDispatches,
        missionId,
        taskId,
        leaseToken: dispatchLeaseToken,
        paneId: boundPaneId,
        sessionId: boundSessionId,
        workerIncarnationId: dispatchWorkerIncarnationId,
        error,
      });
    } catch (dispatchError) {
      console.error(
        "[mission-scheduler] failed to persist dispatch failure:",
        dispatchError,
      );
    }
    // Never poison a reusable worktree while the durable dispatch still owns
    // an open retry lane. Only a persisted terminal transition may terminalize
    // the corresponding worktree.
    if (worktreeCreated && persistedFailure !== "unchanged") {
      try {
        requireWorktreeRuntimeRegistry().markFailed(
          scope,
          missionId,
          taskId,
          failureDetail,
        );
      } catch (markError) {
        console.error(
          "[mission-scheduler] failed to mark dispatch failure:",
          markError,
        );
      }
    }
    throw error;
  } finally {
    reservation.release();
  }
}
