import { app } from "electron";
import type { Mission } from "../../shared/orch-types";
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
import { getContextWorkflowService } from "../context/context-workflow-registry";
import {
  hasAvailableAccount,
  listAccounts,
  pickAvailable,
} from "../persistence/account-store";
import { listProviderSettings } from "../persistence/provider-config-store";
import { supportsEnforceableWorkspaceWriteNativeAuthority } from "../pty/autonomous-cli-policy";
import { quotaAvailabilityScore } from "../quota/quota-policy";
import { requireQuotaService } from "../quota/quota-service";
import { trustRealMissionCodexProjectPath } from "../real-mission-codex-trust";
import { ensureGuidedGitBaseline } from "../runtime/guided-greenfield-baseline";
import { requireWorktreeRuntimeRegistry } from "../runtime/worktree-runtime-registry";
import { assertGuidedPrevcExecutionReady } from "./guided-mission-prevc";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";
import { isGuidedDeliveryTaskKind } from "./guided-task-kind";
import {
  awaitMissionSchedulerAuthorityFence,
  missionSchedulerHasKickoffAuthority,
} from "./mission-scheduler-authority";
import { loadMissionSchedulerDependencyHandoffs } from "./mission-scheduler-dependency-context";
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
import { spawnPaneAndMaybePrompt } from "./tool-util";
import {
  projectMissionSchedulerWorkerSlots,
} from "./task-dispatch-worker-retirement";
import { TASK_DISPATCH_SESSION_EXIT_REASON } from "./task-dispatch-persistence";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import { reserveWorkerSpawnSlot } from "./tools-panes";

export const MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX =
  "Falha durante o bootstrap do worker:";

export function missionSchedulerBootstrapFailureDetail(error: unknown): string {
  const cause = (error instanceof Error ? error.message : String(error))
    .trim()
    .slice(0, 64_000);
  return `${MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX} ${
    cause || "causa indisponível"
  }`;
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
 * exit tap already won the race, the durable row is generic+blocked; only the
 * exact bound physical identity and original lease may refine that metadata.
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
  const detail = missionSchedulerBootstrapFailureDetail(input.error);
  if (
    current.state === "blocked" &&
    current.lastError === TASK_DISPATCH_SESSION_EXIT_REASON &&
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

/**
 * Last mission-level gate before scheduler provider discovery. Keeping this
 * boundary ahead of route/account/claim/worktree work makes task metadata
 * incapable of suppressing PREVC.
 */
export function assertMissionSchedulerPreProviderAuthority(input: {
  readonly mission: Pick<Mission, "id" | "intentContract" | "squadId">;
  readonly workflow: Parameters<
    typeof assertGuidedPrevcExecutionReady
  >[0]["workflow"];
}): void {
  const contract = input.mission.intentContract;
  if (!contract) {
    throw new Error(
      "scheduler dispatch requires an approved mission contract",
    );
  }
  assertGuidedPrevcExecutionReady({
    required: missionRequiresGuidedPrevc(input.mission),
    missionId: input.mission.id,
    approvedGoal: contract.goal,
    approvedAcceptanceCriteria: contract.acceptanceCriteria,
    workflow: input.workflow,
  });
}

export async function dispatchMissionSchedulerTask(
  scope: ProjectExecutionScope,
  missionId: string,
  request: SchedulerDispatchRequest,
): Promise<void> {
  const { taskId } = request;
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission?.intentContract) {
    throw new Error("scheduler dispatch requires an approved mission contract");
  }
  if (!missionSchedulerHasKickoffAuthority(stores.missions, missionId)) {
    throw new Error(
      "kickoff_not_accepted: o scheduler exige recibo durável idle→busy " +
        "da sessão orquestradora atual",
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
  const decoded = decodeTaskScheduleDetail(task.detail);
  const meta = assertSealedTaskSchedule(planned, decoded.meta);
  const mapped = taskRecordToSchedulerTask(task);
  if (
    JSON.stringify(request.ownership) !== JSON.stringify(meta.ownership) ||
    JSON.stringify(request.dependsOn) !== JSON.stringify(meta.dependsOn)
  ) {
    throw new Error(`scheduler request ${taskId} divergiu do plano selado`);
  }
  const workflow = getContextWorkflowService(scope);
  const assertCurrentPrevcAuthority = (): void => {
    const currentWorkflow = workflow.getMissionWorkflow(missionId);
    assertMissionSchedulerPreProviderAuthority({
      mission,
      workflow: currentWorkflow,
    });
    // Saved/manual specialty squads retain their legacy optional PREVC path.
    // A guided task never reaches provider discovery, account resolution,
    // claim or worktree materialization without the stronger assertion above.
    if (currentWorkflow.contract) {
      workflow.assertMutationAllowed(
        missionId,
        "nexus_mission_spawn_pane",
        {},
      );
    }
  };
  assertCurrentPrevcAuthority();
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
  const adapters = listProviderSettings()
    .filter((provider) => provider.adapterId !== "shell")
    .map((provider) => {
      const requestedModel =
        provider.adapterId === planned.agent.cli
          ? (planned.agent.model ?? provider.defaultModel)
          : provider.defaultModel;
      return missionSchedulerLiveRosterAdapter({
        provider,
        requestedModel,
        hasAvailableAccount,
      });
    });
  const sealedRoute = resolveSealedWorkerRoute({
    taskText,
    agent: planned.agent,
    adapters,
    rosterHash: planned.rosterHash,
  });
  if (executionMode === "isolated_worktree") {
    const liveAdapter = getAdapter(sealedRoute.routeContract.adapterId);
    if (
      !liveAdapter ||
      liveAdapter.kind !== "cli-pty" ||
      !isBuiltinAdapter(liveAdapter.id) ||
      !supportsEnforceableWorkspaceWriteNativeAuthority(liveAdapter)
    ) {
      throw new Error(
        `workspace_write_unsupported: ${sealedRoute.routeContract.adapterId} ` +
          "não possui sandbox nativo builtin qualificado para o dispatch selado",
      );
    }
  }
  const accountId = await awaitMissionSchedulerAuthorityFence({
    assertCurrentAuthority: assertCurrentPrevcAuthority,
    prepare: () =>
      missionSchedulerRouteRequiresAccount(
        sealedRoute.routeContract.adapterId,
        sealedRoute.routeContract.model,
      )
        ? resolveMissionSpawnAccountId(sealedRoute.decision.adapterId)
        : Promise.resolve(undefined),
  });
  if (executionMode === "read_only") {
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
  const workerId = planned.agent.agentName;
  const plannedAllowedTools = planned.agent.allowedTools ?? [];
  const dispatches = stores.taskDispatches.list(missionId);
  const workerSlotProjection = projectMissionSchedulerWorkerSlots(
    missionId,
    stores.missionPanes.list(missionId),
    dispatches,
  );
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
  if (!reservation.ok) throw new Error(reservation.error);

  let worktreeCreated = false;
  let dispatchLeaseToken: string | null = null;
  let dispatchRevision: number | null = null;
  let dispatchWorkerIncarnationId: string | null = null;
  let boundPaneId: string | null = null;
  let boundSessionId: string | null = null;
  try {
    assertCurrentPrevcAuthority();
    if (
      executionMode === "isolated_worktree" &&
      isGuidedDeliveryTaskKind(meta.guidedTaskKind)
    ) {
      // Beginner greenfields reach WorktreeManager with a real, clean commit.
      // The helper initializes only a physically empty folder or a clean
      // unborn repo and never stages user files.
      ensureGuidedGitBaseline(scope);
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
      agentRef: planned.agentRef,
      agentCategory: meta.agentCategory,
      rosterHash: planned.rosterHash,
      routeContract: sealedRoute.routeContract,
    });
    dispatchLeaseToken = claim.leaseToken;
    dispatchRevision = claim.revision;
    dispatchWorkerIncarnationId = claim.workerIncarnationId;
    const worktree =
      executionMode === "isolated_worktree"
        ? requireWorktreeRuntimeRegistry().create({
            scope,
            missionId,
            taskId,
            workerId,
            ownership: mapped.ownership,
            dependsOn: worktreeDependencies,
          })
        : null;
    worktreeCreated = worktree !== null;
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
      assertCurrentPrevcAuthority();
      const current = stores.taskDispatches.assertLifecycleAuthority({
        taskId,
        missionId,
        intentVersion: mission.intentContract!.intentVersion,
        expectedStates: ["spawning", "running"],
      });
      if (
        current.workerIncarnationId !== claim.workerIncarnationId ||
        current.workerId !== workerId ||
        current.agentRef !== planned.agentRef
      ) {
        throw new Error(
          "scheduler spawn authority diverged from the sealed worker incarnation",
        );
      }
    };
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
        agentName: planned.agent.agentName,
        workerIncarnationId: claim.workerIncarnationId,
        agentCategory: meta.agentCategory,
        role: "worker",
        title: task.title,
        prompt: buildMissionSchedulerTaskPrompt(
          { ...mapped, title: task.title, detail: decoded.body },
          {
            agentName: planned.agent.agentName,
            category: meta.agentCategory,
            executionMode,
          },
          dependencyHandoffs,
        ),
        allowedTools: [...(reservation.allowedTools ?? plannedAllowedTools)],
        allowedSkills:
          planned.agent.allowedSkills === null ||
          planned.agent.allowedSkills === undefined
            ? null
            : [...planned.agent.allowedSkills],
        readOnly: executionMode === "read_only",
        suppressOmpAutoSpawn: true,
      },
      {
        invocation: {
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
  } catch (error) {
    const failureDetail = missionSchedulerBootstrapFailureDetail(error);
    if (worktreeCreated) {
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
    try {
      persistMissionSchedulerDispatchFailure({
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
    throw error;
  } finally {
    reservation.release();
  }
}
