import { app } from "electron";
import type { WebContents } from "electron";

import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_CTA,
  REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_E2E_EXECUTOR_ID,
  REAL_MISSION_E2E_EXECUTOR_NAME,
  REAL_MISSION_E2E_ORCHESTRATOR_ID,
  REAL_MISSION_E2E_ORCHESTRATOR_NAME,
  REAL_MISSION_E2E_QA_ID,
  REAL_MISSION_E2E_QA_NAME,
  REAL_MISSION_E2E_REVIEWER_ID,
  REAL_MISSION_E2E_REVIEWER_NAME,
  REAL_MISSION_E2E_RESULT_CONTENT,
  parseRealMissionE2EEvidence,
  realMissionE2EAdvisorSkipClis,
  realMissionE2EOrchestratorCli,
  type RealMissionE2EEvidence,
  type RealMissionE2ELaunchSurface,
  type RealMissionE2EOrchestratorCli,
  type RealMissionE2EProductWizardReceipt,
} from "../shared/real-mission-e2e";
import {
  getAgentSessionInfo,
  getSessionState,
  listAgentSessions,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from "./pty/pty-manager";
import type { ProjectDomainStoreSuite } from "./orch/project-domain-store-registry";
import { missionKickoffFailureReasonFromDescription } from "./orch/mission-kickoff";
import { taskDispatchBlockDetailFromDescription } from "./orch/task-dispatch-persistence";
import { decodeTaskScheduleDetail } from "./orch/mission-scheduler-meta";
import { getContextWorkflowService } from "./context/context-workflow-registry";
import { readAuditLog, type AuditEntry } from "./jarvis/audit-log";
import {
  resolvePrivateRealMissionE2ESquadBinding,
  resolveProductWizardRealMissionE2ESquadBinding,
  type RealMissionE2ESquadBinding,
} from "./real-mission-e2e-fixture";
import {
  MISSION_DRIVER_WORKFLOW_STAGES,
  parseMissionDriverEvidenceBinding,
  parseMissionDriverEvidenceIds,
  readDurableAuthoritySnapshot,
  type MissionDriverStepReceipt,
  type MissionDriverWorkflowStage,
} from "./real-mission-e2e-authority";
import {
  isCodexMcpApprovalPrompt,
  realMissionInteractionCapture,
  type FailureCode,
} from "./real-mission-e2e-lifecycle";
import type { RealMissionE2EMissionInventoryFence } from "./real-mission-e2e-mission-inventory";
import {
  ExactRealMissionPhysicalPtyGate,
  hasCorrelatedPhysicalWorkerData,
  type KickoffCapture,
  type PhysicalPtyAgent,
  type PhysicalPtyCapture,
  type RealMissionPhysicalPtyAgent,
  type RealMissionPhysicalPtyIdentity,
  type RealMissionPhysicalPtyReplacement,
  type RealMissionPhysicalPtyReplacementDecision,
} from "./real-mission-e2e-physical";
import {
  buildRealMissionParticipation,
  expectedRealMissionAdvisors,
  realMissionAdvisorPtyExpectations,
  realMissionAdvisorsMissingHandoff,
  type RealMissionAdvisorExpectation,
  type RealMissionAdvisorPtyCapture,
  type RealMissionParticipation,
} from "./real-mission-e2e-participation";
import { freezeRealMissionE2EPrevCIfNeeded } from "./real-mission-e2e-prevc";
import {
  buildRepositoryProof,
  gitCommitIsAncestor,
  productWizardSquadBinding,
  sha256,
  type ScratchRepository,
} from "./real-mission-e2e-workspace";
import type { RealMissionEvidenceAttester } from "./real-mission-e2e-attestation";
import { hasAutomaticTechnicalRecovery } from "../shared/mission-recovery-policy";

// Receipts de ack/estado final de PTY podem aterrissar bem depois da
// transação de integração (campo: run físico com advisor AGY só estabilizou
// ~20s após o done). 120s ainda cabe folgado no budget do gate (done ~8min,
// timeout 32min) e não enfraquece o invariante — o parse completo é exigido.
const DONE_SETTLE_MS = 120_000;
const OBSERVE_INTERVAL_MS = 500;

/** Roster worker exato do harness: agentRef → categoria/CLI esperados. */
const HARNESS_WORKER_ROSTER = new Map<
  string,
  {
    readonly agentCategory: "executor" | "reviewer" | "scout";
    readonly cli: string;
  }
>([
  [
    REAL_MISSION_E2E_EXECUTOR_ID,
    { agentCategory: "executor", cli: "codex" },
  ],
  [
    REAL_MISSION_E2E_REVIEWER_ID,
    { agentCategory: "reviewer", cli: "codex" },
  ],
  [REAL_MISSION_E2E_QA_ID, { agentCategory: "reviewer", cli: "codex" }],
  ...REAL_MISSION_E2E_ADVISORS.map(
    (advisor) =>
      [
        advisor.id,
        { agentCategory: advisor.category, cli: advisor.cli },
      ] as const,
  ),
]);

type HarnessHandoffSource = "http-mcp" | "pty-stream";

/**
 * The release harness pins each worker to its real physical completion
 * transport. AGY 1.1 cannot consume Nexus MCP projections, so Main observes
 * its terminal marker and mints a PTY-stream receipt. Every other harness
 * worker remains HTTP-MCP-bound; widening PTY receipts globally would hide an
 * accidental MCP regression in another adapter.
 */
function harnessHandoffSource(
  agentRef: string | null | undefined,
): HarnessHandoffSource | null {
  const roster = agentRef ? HARNESS_WORKER_ROSTER.get(agentRef) : undefined;
  if (!roster) return null;
  return roster.cli === "agy" ? "pty-stream" : "http-mcp";
}

/** plannerIds que o Guided Planner pode selar para o roster do harness. */
function harnessPlannerId(plannerId: string): string | null {
  return plannerId === "guided-execution" ||
    plannerId === "guided-quality-gate" ||
    plannerId.startsWith("guided-review-") ||
    plannerId.startsWith("guided-advisory-")
    ? plannerId
    : null;
}

type HarnessWorkerAgentRef = NonNullable<
  RealMissionE2EEvidence["plan"]
>["tasks"][number]["agentRef"];

export class RealMissionObserver {
  readonly #owner: WebContents;
  readonly #runId: string;
  readonly #scratch: ScratchRepository;
  readonly #suite: ProjectDomainStoreSuite;
  readonly #missionId: string;
  readonly #launchSurface: RealMissionE2ELaunchSurface;
  readonly #squadBinding: RealMissionE2ESquadBinding;
  readonly #acceptanceCriteria: readonly string[];
  readonly #missionInventoryFence: RealMissionE2EMissionInventoryFence;
  readonly #wizardReceiptForMission: (
    missionId: string,
  ) => RealMissionE2EProductWizardReceipt | null;
  readonly #attestEvidence: RealMissionEvidenceAttester;
  readonly #onFinish: (code: FailureCode | null) => void;
  readonly #physicalPtyGate: ExactRealMissionPhysicalPtyGate;
  readonly #advisorExpectations: readonly RealMissionAdvisorExpectation[];
  readonly #advisorPty = new Map<string, RealMissionAdvisorPtyCapture[]>();
  readonly #kickoff: KickoffCapture = {
    sessionId: null,
    idleAt: null,
    busyAt: null,
    ptyDataAt: null,
    ptyChunkSha256: null,
  };
  readonly #physicalPty = new Map<string, PhysicalPtyCapture>();
  readonly #codexMcpPromptBuffers = new Map<string, string>();
  readonly #codexMcpPromptSessions = new Set<string>();
  #kickoffProven = false;
  #prevcFreezeAttempted = false;
  #changedBeforeWorker = false;
  #workerObserved = false;
  #doneSeenAt: number | null = null;
  #lastSettleLogAt = 0;
  /** Último motivo pelo qual a evidência pós-done não estabilizou. */
  #lastSettleErrorDetail: string | null = null;
  readonly #runStartedAt: number;
  #evaluationQueued = false;
  #stopped = false;
  #interval: ReturnType<typeof setInterval> | null = null;
  #unsubscribeStore: (() => void) | null = null;
  #untapState: (() => void) | null = null;
  #untapData: (() => void) | null = null;
  #untapExit: (() => void) | null = null;

  constructor(input: {
    owner: WebContents;
    runId: string;
    scratch: ScratchRepository;
    suite: ProjectDomainStoreSuite;
    missionId: string;
    launchSurface: RealMissionE2ELaunchSurface;
    squadBinding: RealMissionE2ESquadBinding;
    acceptanceCriteria: readonly string[];
    missionInventoryFence: RealMissionE2EMissionInventoryFence;
    wizardReceiptForMission: (
      missionId: string,
    ) => RealMissionE2EProductWizardReceipt | null;
    attestEvidence: RealMissionEvidenceAttester;
    onFinish: (code: FailureCode | null) => void;
    /** CLIs advisor sem credencial (launcher via env); default: process.env. */
    advisorSkipClis?: readonly string[];
    /** Variante de orquestrador do harness; default: env do processo. */
    orchestratorCli?: RealMissionE2EOrchestratorCli;
    /**
     * Início real do run físico. O probe pós-done precisa deste boundary:
     * o invariante de participação exige spawnedAt >= startedAt, então usar
     * o relógio da avaliação (pós-done) derruba o PASS deterministicamente.
     */
    startedAt?: number;
  }) {
    this.#owner = input.owner;
    this.#runId = input.runId;
    this.#scratch = input.scratch;
    this.#suite = input.suite;
    this.#missionId = input.missionId;
    this.#launchSurface = input.launchSurface;
    this.#squadBinding = input.squadBinding;
    this.#acceptanceCriteria = [...input.acceptanceCriteria];
    this.#missionInventoryFence = input.missionInventoryFence;
    this.#wizardReceiptForMission = input.wizardReceiptForMission;
    this.#attestEvidence = input.attestEvidence;
    this.#onFinish = input.onFinish;
    this.#runStartedAt = input.startedAt ?? Date.now();
    this.#advisorExpectations = expectedRealMissionAdvisors(
      input.advisorSkipClis ?? realMissionE2EAdvisorSkipClis(),
      {
        orchestratorCli:
          input.orchestratorCli ?? realMissionE2EOrchestratorCli(),
      },
    );
    this.#physicalPtyGate = new ExactRealMissionPhysicalPtyGate(
      input.missionId,
      realMissionAdvisorPtyExpectations(this.#advisorExpectations),
      input.orchestratorCli ?? realMissionE2EOrchestratorCli(),
      (replacement) => this.#authorizeAdvisorRetry(replacement),
    );
  }

  start(): void {
    if (!this.#observeMissionInventory()) return;
    this.#unsubscribeStore = this.#suite.missions.onChange(() => {
      if (this.#observeMissionInventory()) this.#queueEvaluation();
    });
    const unsubscribePanes = this.#suite.missionPanes.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribeDispatches = this.#suite.taskDispatches.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribeTasks = this.#suite.tasks.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribeHandoffs = this.#suite.handoffs.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribeAll = this.#unsubscribeStore;
    this.#unsubscribeStore = () => {
      unsubscribeAll?.();
      unsubscribePanes();
      unsubscribeDispatches();
      unsubscribeTasks();
      unsubscribeHandoffs();
    };
    this.#untapState = tapSessionState((sessionId, state) => {
      const accepted = this.#acceptMissionPhysicalPty(
        sessionId,
        getAgentSessionInfo(sessionId),
      );
      if (!accepted) return;
      const now = Date.now();
      const agent = accepted.agent;
      if (accepted.identity.startsWith("advisor:")) {
        // Record on any live state — packaged CLIs often skip a distinct
        // `spawning` edge the observer can see.
        if (state === "spawning" || state === "idle" || state === "busy") {
          this.#recordAdvisorSpawn(accepted.identity, sessionId, now);
        }
        this.#queueEvaluation();
        return;
      }
      // Record on any live state — packaged CLIs often skip a distinct
      // `spawning` edge the observer can see.
      if (state === "spawning" || state === "idle" || state === "busy") {
        this.#recordPhysicalSpawn(sessionId, agent, now);
      }
      if (agent.role !== "orchestrator") {
        this.#queueEvaluation();
        return;
      }
      this.#kickoff.sessionId = sessionId;
      if (!this.#kickoffProven && state === "idle") {
        this.#kickoff.idleAt = now;
        this.#kickoff.busyAt = null;
        this.#kickoff.ptyDataAt = null;
        this.#kickoff.ptyChunkSha256 = null;
      } else if (
        !this.#kickoffProven &&
        state === "busy" &&
        this.#kickoff.idleAt !== null
      ) {
        this.#kickoff.busyAt = now;
        this.#maybeSealKickoffProof();
      }
      this.#queueEvaluation();
    });
    this.#untapData = tapSessionData((sessionId, data) => {
      if (data.length === 0) return;
      const accepted = this.#acceptMissionPhysicalPty(
        sessionId,
        getAgentSessionInfo(sessionId),
      );
      if (!accepted) return;
      const agent = accepted.agent;
      if (accepted.identity.startsWith("advisor:")) {
        this.#recordAdvisorSpawn(accepted.identity, sessionId, Date.now());
        this.#queueEvaluation();
        return;
      }
      this.#recordPhysicalSpawn(sessionId, agent, Date.now());
      if (agent.adapterId === "codex") {
        const promptBuffer =
          `${this.#codexMcpPromptBuffers.get(sessionId) ?? ""}${data}`.slice(
            -8_192,
          );
        this.#codexMcpPromptBuffers.set(sessionId, promptBuffer);
        if (
          !this.#codexMcpPromptSessions.has(sessionId) &&
          isCodexMcpApprovalPrompt(promptBuffer)
        ) {
          this.#codexMcpPromptSessions.add(sessionId);
          // Fail before any keypress can be emitted. The gate never answers an
          // MCP approval question because doing so would hide the defect.
          this.#onFinish("mcp-prompt-detected");
          return;
        }
      }
      const physical = this.#physicalPty.get(sessionId);
      if (physical && physical.dataAt === null) {
        physical.dataAt = Date.now();
        physical.ptyChunkSha256 = sha256(data);
      }
      if (
        agent.role !== "orchestrator" ||
        this.#kickoffProven ||
        this.#kickoff.idleAt === null
      ) {
        this.#queueEvaluation();
        return;
      }
      this.#kickoff.sessionId = sessionId;
      this.#kickoff.ptyDataAt = Date.now();
      this.#kickoff.ptyChunkSha256 = sha256(data);
      this.#maybeSealKickoffProof();
      this.#queueEvaluation();
    });
    this.#untapExit = tapSessionExit((sessionId, agent) => {
      const accepted = this.#acceptMissionPhysicalPty(sessionId, agent);
      if (!accepted) return;
      if (accepted.identity.startsWith("advisor:")) {
        this.#recordAdvisorSpawn(accepted.identity, sessionId, Date.now());
        return;
      }
      this.#recordPhysicalSpawn(sessionId, accepted.agent, Date.now());
      if (
        accepted.agent.role === "orchestrator" &&
        sessionId === this.#kickoff.sessionId
      ) {
        this.#queueEvaluation();
      }
    });
    this.#interval = setInterval(() => this.#evaluate(), OBSERVE_INTERVAL_MS);
    this.#evaluate();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = null;
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = null;
    this.#untapState?.();
    this.#untapState = null;
    this.#untapData?.();
    this.#untapData = null;
    this.#untapExit?.();
    this.#untapExit = null;
    this.#codexMcpPromptBuffers.clear();
  }

  evidence(
    startedAt: number,
    status: "pass" | "fail",
    failureCode: FailureCode | null,
  ): RealMissionE2EEvidence {
    const mission = this.#suite.missions.get(this.#missionId);
    const wizardReceipt =
      this.#launchSurface === "product-wizard"
        ? this.#wizardReceiptForMission(this.#missionId)
        : null;
    const currentSquadBinding = (() => {
      if (!mission) return null;
      if (this.#launchSurface === "product-wizard") {
        return productWizardSquadBinding(mission);
      }
      // Private runs are armed against the exact source fixture, but approval
      // now seals a main-owned immutable `agentic-runtime-*` snapshot before
      // execution. Follow only that validated source → runtime lineage. This
      // is deliberately not a prefix/hash heuristic: the resolver rechecks
      // the source bytes, runtime metadata and exact executable roster.
      const missionSquadId = mission.squadId;
      if (typeof missionSquadId !== "string") return null;
      if (missionSquadId !== this.#squadBinding.squadId) {
        return resolveProductWizardRealMissionE2ESquadBinding(
          missionSquadId,
        );
      }
      return resolvePrivateRealMissionE2ESquadBinding();
    })();
    const squadBindingStillExact =
      currentSquadBinding !== null &&
      currentSquadBinding.sourceSquadId ===
        this.#squadBinding.sourceSquadId &&
      currentSquadBinding.sourceSquadRevisionHash ===
        this.#squadBinding.sourceSquadRevisionHash &&
      mission?.intentContract?.squadRevisionHash ===
        currentSquadBinding.squadRevisionHash;
    const effectiveSquadBinding = squadBindingStillExact
      ? currentSquadBinding
      : null;
    const dispatches = this.#suite.taskDispatches.list(this.#missionId);
    const durableAuthority = readDurableAuthoritySnapshot(
      this.#suite.scope,
      this.#missionId,
    );
    const auditEntries = readAuditLog(
      { scope: this.#suite.scope, missionId: this.#missionId },
      10_000,
    );
    const participation = this.#buildParticipation(auditEntries);
    const intentVersion = mission?.intentVersion ?? 0;
    const plannedTasks = mission
      ? this.#suite.tasks.listPlannedTasks(this.#missionId, intentVersion)
      : [];
    const plannedByTaskId = new Map(
      plannedTasks.map((planned) => [planned.taskId, planned]),
    );
    const planReceipt = mission
      ? this.#suite.tasks.getPlanReceipt(this.#missionId, intentVersion)
      : null;
    // CliAutomatedReviewer owns additional ephemeral merge/final panes. The
    // four-pane release contract is the approved roster graph, so its proof is
    // projected only from those exact main-owned identities.
    const paneRows = this.#suite.missionPanes
      .list(this.#missionId)
      .filter(
        (pane) =>
          pane.agentName !== undefined &&
          [
            REAL_MISSION_E2E_ORCHESTRATOR_NAME,
            REAL_MISSION_E2E_EXECUTOR_NAME,
            REAL_MISSION_E2E_REVIEWER_NAME,
            REAL_MISSION_E2E_QA_NAME,
          ].includes(pane.agentName),
      );
    const paneProofs = paneRows.map((pane) => {
      const dispatch = dispatches.find(
        (candidate) =>
          candidate.paneId === pane.paneId ||
          candidate.workerIncarnationId === pane.workerIncarnationId,
      );
      const sessionId =
        pane.role === "orchestrator"
          ? (mission?.orchestratorSessionId ?? null)
          : (dispatch?.sessionId ?? null);
      const agentRef =
        pane.agentName === REAL_MISSION_E2E_ORCHESTRATOR_NAME
          ? REAL_MISSION_E2E_ORCHESTRATOR_ID
          : pane.agentName === REAL_MISSION_E2E_EXECUTOR_NAME
            ? REAL_MISSION_E2E_EXECUTOR_ID
            : pane.agentName === REAL_MISSION_E2E_REVIEWER_NAME
              ? REAL_MISSION_E2E_REVIEWER_ID
              : pane.agentName === REAL_MISSION_E2E_QA_NAME
                ? REAL_MISSION_E2E_QA_ID
                : "unknown";
      const physical =
        sessionId === null ? null : (this.#physicalPty.get(sessionId) ?? null);
      const physicalMatches =
        physical?.role === pane.role &&
        (pane.role !== "worker" ||
          physical.workerIncarnationId === (pane.workerIncarnationId ?? null));
      return {
        role: pane.role,
        paneId: pane.paneId ?? pane.id,
        sessionId,
        adapterId: pane.adapterId,
        agentRef,
        workerIncarnationId: pane.workerIncarnationId ?? null,
        readOnly: physicalMatches ? physical.readOnly : null,
        nativeReadOnly: physicalMatches ? physical.nativeReadOnly : null,
        ptySpawnedAt: physicalMatches ? physical.spawnedAt : null,
        ptyDataAt: physicalMatches ? physical.dataAt : null,
        ptyChunkSha256: physicalMatches ? physical.ptyChunkSha256 : null,
      };
    });
    const dispatchProofs = dispatches.map((dispatch) => {
      const planned = plannedByTaskId.get(dispatch.taskId);
      const schedule = planned
        ? decodeTaskScheduleDetail(planned.plannedDetail).meta
        : null;
      const reservation = dispatch.routeReservationId
        ? this.#suite.missions.getRouteReservation(dispatch.routeReservationId)
        : null;
      return {
        taskId: dispatch.taskId,
        plannerId: planned ? harnessPlannerId(planned.plannerId) : null,
        agentRef: dispatch.agentRef ?? null,
        // Substituição por reroute: a prova precisa da origem selada para a
        // cadeia de exatidão casar plano↔dispatch pelo advisor original.
        providerReroute: dispatch.providerReroute
          ? {
              fromAgentRef: dispatch.providerReroute.fromAgentRef,
              toAgentRef: dispatch.providerReroute.toAgentRef,
            }
          : null,
        agentCategory: dispatch.agentCategory ?? null,
        executionMode: dispatch.executionMode,
        dependsOn: schedule ? [...schedule.dependsOn] : [],
        state: dispatch.state,
        routeReservationId: dispatch.routeReservationId ?? null,
        routeConsumedAt: reservation?.consumedAt ?? null,
        routeConsumerMatches:
          reservation?.consumedBySession === `dispatch:${dispatch.id}` &&
          reservation.missionId === mission?.id &&
          reservation.intentVersion === dispatch.intentVersion &&
          reservation.decision.adapterId === dispatch.adapterId &&
          reservation.decision.model === dispatch.model &&
          reservation.decision.effort === dispatch.effort &&
          dispatch.adapterId ===
            HARNESS_WORKER_ROSTER.get(dispatch.agentRef ?? "")?.cli &&
          // Plano e schedule guardam o agentRef SELADO original; um dispatch
          // re-roteado carrega o substituto, e a diretiva durável é a ponte.
          (planned?.agentRef ===
            (dispatch.providerReroute?.fromAgentRef ?? dispatch.agentRef)) &&
          planned?.agentCategory === dispatch.agentCategory &&
          (schedule?.agentRef ===
            (dispatch.providerReroute?.fromAgentRef ?? dispatch.agentRef)) &&
          schedule?.agentCategory === dispatch.agentCategory &&
          schedule?.executionMode === dispatch.executionMode,
        workerIncarnationId: dispatch.workerIncarnationId ?? null,
        sessionId: dispatch.sessionId ?? null,
        handoffId: dispatch.handoffId ?? null,
        handoffAcceptedAt: dispatch.handoffAcceptedAt ?? null,
        completedAt: dispatch.completedAt ?? null,
        integrationReceipt:
          dispatch.integrationReceipt?.kind === "worktree_integrated" &&
          /^[a-f0-9]{40,64}$/u.test(dispatch.integrationReceipt.reference)
            ? {
                kind: "worktree_integrated" as const,
                reference: dispatch.integrationReceipt.reference,
                completedAt: dispatch.integrationReceipt.completedAt,
                ...(dispatch.integrationReceipt.evidenceIds
                  ? {
                      evidenceIds: [...dispatch.integrationReceipt.evidenceIds],
                    }
                  : {}),
              }
            : dispatch.integrationReceipt?.kind ===
                  "worktree_validated_no_change" &&
                /^no-change:[a-f0-9]{40,64}:[a-f0-9]{64}$/u.test(
                  dispatch.integrationReceipt.reference,
                ) &&
                (dispatch.integrationReceipt.evidenceIds?.length ?? 0) > 0
              ? {
                  kind: "worktree_validated_no_change" as const,
                  reference: dispatch.integrationReceipt.reference,
                  completedAt: dispatch.integrationReceipt.completedAt,
                  evidenceIds: [...dispatch.integrationReceipt.evidenceIds!],
                }
              : dispatch.integrationReceipt?.kind === "read_only_validated" &&
                  /^[a-f0-9]{64}$/u.test(
                    dispatch.integrationReceipt.reference,
                  ) &&
                  (dispatch.integrationReceipt.evidenceIds?.length ?? 0) > 0
                ? {
                    kind: "read_only_validated" as const,
                    reference: dispatch.integrationReceipt.reference,
                    completedAt: dispatch.integrationReceipt.completedAt,
                    evidenceIds: [...dispatch.integrationReceipt.evidenceIds!],
                  }
                : null,
      };
    });
    // O plano selado agora é roster-complete: scouts advisor → executor →
    // revisor codex → reviewers advisor → QA. Qualquer tarefa fora do roster
    // exato do harness derruba a prova inteira (fail closed).
    const plan =
      planReceipt &&
      effectiveSquadBinding !== null &&
      planReceipt.squadId === effectiveSquadBinding.squadId &&
      plannedTasks.length > 0
        ? {
            version: 1 as const,
            squadId: planReceipt.squadId,
            planHash: planReceipt.planHash,
            rosterHash: planReceipt.rosterHash,
            tasks: plannedTasks.flatMap((planned) => {
              const schedule = decodeTaskScheduleDetail(
                planned.plannedDetail,
              ).meta;
              const roster = HARNESS_WORKER_ROSTER.get(planned.agentRef);
              const plannerId = harnessPlannerId(planned.plannerId);
              if (
                !roster ||
                plannerId === null ||
                planned.agentCategory !== roster.agentCategory ||
                (schedule?.executionMode !== "isolated_worktree" &&
                  schedule?.executionMode !== "read_only")
              ) {
                return [];
              }
              return [
                {
                  plannerId,
                  taskId: planned.taskId,
                  agentRef: planned.agentRef as HarnessWorkerAgentRef,
                  agentCategory: roster.agentCategory,
                  executionMode: schedule.executionMode,
                  dependsOn: [...schedule.dependsOn],
                },
              ];
            }),
          }
        : null;
    const repository = buildRepositoryProof(
      this.#scratch,
      this.#changedBeforeWorker,
    );
    const exactAuditIntent = (
      provenance: NonNullable<
        ReturnType<ProjectDomainStoreSuite["handoffs"]["get"]>
      >["mcpProvenance"],
    ): AuditEntry | null => {
      if (!provenance) return null;
      const matches = auditEntries.filter(
        (entry) =>
          entry.result === "intent" &&
          entry.tool === "nexus_handoff_submit" &&
          entry.source === provenance.source &&
          entry.session === provenance.sessionId &&
          entry.mission_id === provenance.missionId &&
          entry.invocation_id === provenance.toolCallId &&
          entry.project_id === this.#suite.scope.projectId &&
          entry.checkout_id === this.#suite.scope.checkoutId,
      );
      return matches.length === 1 ? matches[0]! : null;
    };
    const handoffProofs = dispatches.flatMap((dispatch) => {
      if (!dispatch.handoffId) return [];
      const handoff = this.#suite.handoffs.get(dispatch.handoffId);
      if (!handoff) return [];
      const provenance = handoff.mcpProvenance;
      const expectedSource = harnessHandoffSource(dispatch.agentRef);
      const physicalSource: HarnessHandoffSource | null =
        expectedSource !== null && provenance?.source === expectedSource
          ? expectedSource
          : null;
      const physicalProvenance = physicalSource ? provenance : null;
      const auditIntent = exactAuditIntent(physicalProvenance ?? undefined);
      const durableConsumption = durableAuthority.handoffConsumptions.get(
        handoff.id,
      );
      const deliveryAttempts = this.#suite.handoffs.listDeliveryAttempts(
        handoff.id,
      );
      return [
        {
          id: handoff.id,
          sessionId: handoff.sessionId ?? null,
          workerIncarnationId: handoff.workerIncarnationId ?? null,
          fromAgent: handoff.fromAgent ?? null,
          authorityOrigin: handoff.authorityOrigin ?? null,
          summarySha256: sha256(handoff.summary.trim()),
          physicalReceipt:
            physicalProvenance && physicalSource
              ? {
                  receiptId: physicalProvenance.receiptId,
                  handoffId: handoff.id,
                  toolCallId: physicalProvenance.toolCallId,
                  toolName: physicalProvenance.toolName,
                  source: physicalSource,
                  missionId: physicalProvenance.missionId,
                  sessionId: physicalProvenance.sessionId,
                  workerIncarnationId:
                    physicalProvenance.workerIncarnationId ?? null,
                  authoritySha256: physicalProvenance.authoritySha256,
                  worktreeHeadSha:
                    physicalProvenance.worktreeHeadSha ?? null,
                  issuedAt: physicalProvenance.issuedAt,
                  worktreeHeadIntegrated:
                    physicalProvenance.worktreeHeadSha !== undefined &&
                    repository.finalHeadSha !== null &&
                    gitCommitIsAncestor(
                      this.#scratch.workspacePath,
                      physicalProvenance.worktreeHeadSha,
                      repository.finalHeadSha,
                    ),
                }
              : null,
          auditIntent:
            physicalProvenance && physicalSource && auditIntent
              ? {
                  invocationId: auditIntent.invocation_id!,
                  toolName: "nexus_handoff_submit" as const,
                  source: physicalSource,
                  sessionId: auditIntent.session,
                  missionId: auditIntent.mission_id!,
                  scope: {
                    projectId: auditIntent.project_id,
                    checkoutId: auditIntent.checkout_id,
                  },
                  occurredAt: Date.parse(auditIntent.timestamp),
                }
              : null,
          status: handoff.status,
          deliveryState: handoff.deliveryState,
          delivered: handoff.delivered,
          consumedAt: durableConsumption?.consumed_at ?? null,
          consumedBySessionId: durableConsumption?.consumed_by_session ?? null,
          consumedDeliveryAttemptId:
            durableConsumption?.consumed_delivery_attempt_id ?? null,
          deliveryAttempts: deliveryAttempts.map((attempt) => ({
            id: attempt.id,
            handoffId: attempt.handoffId,
            missionId: attempt.missionId,
            orchestratorSessionId: attempt.orchestratorSessionId,
            attemptNo: attempt.attemptNo,
            state: attempt.state,
            startedAt: attempt.startedAt,
            acceptDeadlineAt: attempt.acceptDeadlineAt ?? null,
            acceptedAt: attempt.acceptedAt ?? null,
            failedAt: attempt.failedAt ?? null,
            failureCode: attempt.failureCode ?? null,
          })),
        },
      ];
    });
    const dependencyConsumptions = durableAuthority.dependencyConsumptions.map(
      (receipt) => ({
        missionId: receipt.mission_id,
        consumerTaskId: receipt.consumer_task_id,
        dependencyTaskId: receipt.dependency_task_id,
        handoffId: receipt.handoff_id,
        consumerSessionId: receipt.consumer_session_id,
        consumerWorkerIncarnationId: receipt.consumer_worker_incarnation_id,
        promptSha256: receipt.prompt_sha256,
        handoffSummarySha256: receipt.handoff_summary_sha256,
        consumedAt: receipt.consumed_at,
      }),
    );
    const completion: RealMissionE2EEvidence["completion"] = (() => {
      if (
        !mission ||
        mission.status !== "done" ||
        mission.intentState !== "done" ||
        !mission.orchestratorSessionId ||
        !plan ||
        mission.milestones.length !== this.#acceptanceCriteria.length ||
        mission.milestones.some(
          (milestone, index) =>
            milestone.id !== `step-${index + 1}` ||
            milestone.label !== this.#acceptanceCriteria[index] ||
            milestone.status !== "done" ||
            milestone.evidenceIds.length !== 1,
        )
      ) {
        return null;
      }
      try {
        const service = getContextWorkflowService(this.#suite.scope);
        const current = service.getMissionWorkflow(this.#missionId);
        const workflow = current.workflow;
        const driver = this.#suite.missions.getDriveRuntimeState(
          this.#missionId,
        );
        if (
          !current.contract ||
          !workflow ||
          workflow.stage !== "complete" ||
          !service.isMissionDriverComplete(
            this.#missionId,
            mission.milestones.map((milestone) => milestone.id),
          ) ||
          !driver ||
          driver.lastActionKind !== "complete" ||
          driver.lastOutcome !== "success" ||
          driver.lastAttemptAt === undefined ||
          driver.lastSuccessAt === undefined
        ) {
          return null;
        }
        const receiptByStepId = new Map(
          durableAuthority.missionStepReceipts.map((receipt) => [
            receipt.step_id,
            receipt,
          ]),
        );
        if (
          receiptByStepId.size !== mission.milestones.length ||
          durableAuthority.missionStepReceipts.length !==
            mission.milestones.length
        ) {
          return null;
        }
        const stepReceipts: MissionDriverStepReceipt[] = [];
        for (const milestone of mission.milestones) {
          const row = receiptByStepId.get(milestone.id);
          const evidenceIds = row
            ? parseMissionDriverEvidenceIds(row.evidence_ids_json)
            : null;
          const evidenceBinding = row
            ? parseMissionDriverEvidenceBinding(row.evidence_binding_json)
            : null;
          if (
            !row ||
            !MISSION_DRIVER_WORKFLOW_STAGES.has(
              row.from_stage as MissionDriverWorkflowStage,
            ) ||
            !MISSION_DRIVER_WORKFLOW_STAGES.has(
              row.to_stage as MissionDriverWorkflowStage,
            ) ||
            !evidenceIds ||
            !evidenceBinding ||
            evidenceIds.length !== milestone.evidenceIds.length ||
            evidenceIds.some((id, index) => id !== milestone.evidenceIds[index])
          ) {
            return null;
          }
          stepReceipts.push({
            stepId: row.step_id,
            fromStage: row.from_stage as MissionDriverWorkflowStage,
            toStage: row.to_stage as MissionDriverWorkflowStage,
            workflowRevisionBefore: row.workflow_revision_before,
            workflowRevisionAfter: row.workflow_revision_after,
            evidenceIds,
            evidenceBinding,
            completedAt: row.completed_at,
          });
        }
        return {
          origin: "mission-driver-prevc",
          missionId: mission.id,
          intentVersion: mission.intentVersion ?? 0,
          orchestratorSessionId: mission.orchestratorSessionId,
          planHash: plan.planHash,
          taskCount: plan.tasks.length,
          completedAt: driver.lastSuccessAt,
          driver: {
            revision: driver.revision,
            runStartedAt: driver.runStartedAt,
            attemptCount: driver.attemptCount,
            lastAttemptAt: driver.lastAttemptAt,
            lastSuccessAt: driver.lastSuccessAt,
            lastActionKind: "complete",
            lastOutcome: "success",
            updatedAt: driver.updatedAt,
          },
          workflow: {
            stage: "complete",
            revision: workflow.revision,
            route: [...workflow.route],
            binding: {
              missionId: workflow.binding.missionId,
              contractHash: workflow.binding.contractHash,
              contextHash: workflow.binding.contextHash,
              baseSha: workflow.binding.baseSha,
              headSha: workflow.binding.headSha,
              diffHash: workflow.binding.diffHash,
            },
          },
          milestones: mission.milestones.map((milestone) => ({
            stepId: milestone.id,
            label: milestone.label,
            status: "done" as const,
            evidenceIds: [...milestone.evidenceIds],
          })),
          stepReceipts,
        };
      } catch {
        // Incomplete/corrupt PREVC or Driver state remains a closed null proof.
        return null;
      }
    })();
    const missionProof: RealMissionE2EEvidence["mission"] =
      mission !== null &&
      effectiveSquadBinding !== null &&
      mission.squadId === effectiveSquadBinding.squadId
        ? {
            id: mission.id,
            status: mission.status,
            intentState: mission.intentState ?? null,
            intentVersion: mission.intentVersion ?? 0,
            squadId: effectiveSquadBinding.squadId,
            squadSourceId: effectiveSquadBinding.sourceSquadId,
            squadSourceRevisionHash:
              effectiveSquadBinding.sourceSquadRevisionHash,
            squadRevisionHash: effectiveSquadBinding.squadRevisionHash,
            approvedAt: mission.intentContract?.approvedAt ?? null,
            dispatchedAt: mission.intentContract?.dispatchedAt ?? null,
          }
        : null;
    return this.#attestEvidence({
      schemaVersion: REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
      runId: this.#runId,
      appVersion: app.getVersion(),
      startedAt,
      finishedAt: Date.now(),
      status,
      workspaceSha256: sha256(this.#scratch.workspacePath),
      expectedContentSha256: sha256(REAL_MISSION_E2E_RESULT_CONTENT),
      coverageTier: "guided-delivery-core",
      planOrigin: "production-guided-planner",
      prevcOrigin: "e2e-fixture",
      reviewOrigin: "production-physical-worker",
      qaOrigin: "production-physical-worker",
      launchSurface: this.#launchSurface,
      wizardCoverage:
        this.#launchSurface === "product-wizard" &&
        wizardReceipt?.missionId === this.#missionId
          ? "main-owned-product-sequence"
          : "not-covered",
      wizardReceipt,
      runtimeAttestation: null,
      interaction: {
        evidenceOrigin: "main-owned-instrumentation",
        ...realMissionInteractionCapture,
        codexMcpPromptCount: this.#codexMcpPromptSessions.size,
      },
      mission: missionProof,
      missionInventory: this.#missionInventoryFence.proof(
        this.#suite.missions.list(),
      ),
      kickoff: { ...this.#kickoff },
      plan,
      panes: paneProofs,
      physicalPty: {
        count: this.#physicalPty.size,
        ids: [...this.#physicalPty.keys()],
      },
      dispatches: dispatchProofs,
      handoffs: handoffProofs,
      // A prova sela só os handoffs aceitos dos workers da cadeia. No topology
      // delivery, a aceitação física da sessão atual já é autoridade durável;
      // consumo manual continua projetado quando realmente ocorreu.
      durableHandoffs: (() => {
        const ids = handoffProofs.flatMap((handoff) =>
          handoff.deliveryAttempts.some(
            (attempt) =>
              attempt.state === "accepted" &&
              attempt.orchestratorSessionId === this.#kickoff.sessionId,
          )
            ? [handoff.id]
            : [],
        );
        return { count: ids.length, ids };
      })(),
      dependencyConsumptions,
      participation,
      completion,
      repository,
      failure: failureCode
        ? {
            code: failureCode,
            reason:
              failureCode === "mission-blocked"
                ? missionKickoffFailureReasonFromDescription(
                    mission?.description ?? "",
                  )
                : null,
            detail:
              failureCode === "mission-blocked" ||
              failureCode === "mission-failed"
                ? taskDispatchBlockDetailFromDescription(
                    mission?.description ?? "",
                  )
                : // `invariant-failed` pós-done nascia SEM detail: o gate
                  // reportava "invariant-failed reason=null" e o motivo real
                  // — qual recibo não estabilizou — ficava só num console.warn
                  // que o gate não captura. Três execuções do release foram
                  // diagnosticadas no escuro por causa disso. O erro de
                  // estabilização é exatamente o "porquê" que este campo de
                  // texto livre existe para preservar.
                  (this.#lastSettleErrorDetail ?? null),
            cta: REAL_MISSION_E2E_CTA,
            snapshot: {
              missionStatus: mission?.status ?? null,
              paneCount: paneProofs.length,
              dispatchCount: dispatchProofs.length,
              handoffCount: handoffProofs.length,
            },
          }
        : null,
    });
  }

  #maybeSealKickoffProof(): void {
    if (
      this.#kickoff.idleAt !== null &&
      this.#kickoff.busyAt !== null &&
      this.#kickoff.ptyDataAt !== null &&
      this.#kickoff.ptyChunkSha256 !== null &&
      this.#kickoff.busyAt >= this.#kickoff.idleAt &&
      this.#kickoff.ptyDataAt >= this.#kickoff.idleAt
    ) {
      this.#kickoffProven = true;
    }
  }

  /** Freeze a real PREVC contract before main-owned worker/merge work. */
  #maybeFreezePrevC(): void {
    if (this.#stopped || !this.#kickoffProven) return;
    try {
      const result = freezeRealMissionE2EPrevCIfNeeded(
        this.#suite,
        this.#missionId,
        this.#suite.scope,
      );
      if (result.frozen) {
        this.#prevcFreezeAttempted = true;
        console.log(
          `[real-mission] PHASE phase=prevc-frozen mission=${this.#missionId}`,
        );
        return;
      }
      if (
        result.reason === "already-frozen" ||
        result.reason === "kickoff-pending" ||
        result.reason.startsWith("status-")
      ) {
        return;
      }
      if (
        !this.#prevcFreezeAttempted &&
        result.reason.startsWith("freeze-failed")
      ) {
        this.#prevcFreezeAttempted = true;
        console.error(`[real-mission] PREVC freeze failed: ${result.reason}`);
      }
    } catch (error) {
      if (!this.#prevcFreezeAttempted) {
        this.#prevcFreezeAttempted = true;
        console.error(
          "[real-mission] PREVC freeze threw:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  #acceptMissionPhysicalPty(
    sessionId: string,
    agent: PhysicalPtyAgent | null,
  ): { readonly identity: RealMissionPhysicalPtyIdentity; readonly agent: RealMissionPhysicalPtyAgent } | null {
    const inspected = this.#physicalPtyGate.inspect(sessionId, agent);
    if (inspected.kind === "violation") {
      console.error("[real-mission] physical PTY invariant violation", {
        sessionId,
        adapterId: agent?.adapterId ?? null,
        role: agent?.role ?? null,
        agentName: agent?.agentName ?? null,
        workerIncarnationId: agent?.workerIncarnationId ?? null,
      });
      this.#onFinish("invariant-failed");
    }
    return inspected.kind === "accepted"
      ? { identity: inspected.identity, agent: inspected.agent }
      : null;
  }

  #authorizeAdvisorRetry(
    replacement: RealMissionPhysicalPtyReplacement,
  ): RealMissionPhysicalPtyReplacementDecision {
    if (!replacement.identity.startsWith("advisor:")) return "reject";
    if (getSessionState(replacement.priorSessionId) !== null) return "reject";
    const cli = replacement.identity.slice("advisor:".length);
    const expected = this.#advisorExpectations.find(
      (candidate) =>
        candidate.cli === cli &&
        candidate.skipped === null &&
        candidate.agentName === replacement.nextAgent.agentName,
    );
    if (!expected) return "reject";
    const roster = HARNESS_WORKER_ROSTER.get(expected.agentRef);
    if (
      !roster ||
      roster.cli !== replacement.nextAgent.adapterId ||
      replacement.priorAgent.workerIncarnationId ===
        replacement.nextAgent.workerIncarnationId
    ) {
      return "reject";
    }
    const matches = this.#suite.taskDispatches
      .list(this.#missionId)
      .filter(
        (dispatch) =>
          dispatch.agentRef === expected.agentRef &&
          dispatch.agentCategory === roster.agentCategory &&
          dispatch.executionMode === "read_only" &&
          dispatch.adapterId === replacement.nextAgent.adapterId &&
          dispatch.routeContract?.adapterId ===
            replacement.nextAgent.adapterId &&
          Boolean(dispatch.routeReservationId) &&
          dispatch.workerId === replacement.nextAgent.agentName &&
          dispatch.workerIncarnationId ===
            replacement.nextAgent.workerIncarnationId &&
          dispatch.attempt > 1,
      );
    if (matches.length !== 1) return "reject";
    const dispatch = matches[0]!;
    if (dispatch.state === "spawning" && !dispatch.sessionId) return "defer";
    if (
      dispatch.sessionId === replacement.nextSessionId &&
      (dispatch.state === "running" ||
        dispatch.state === "handoff_ready" ||
        dispatch.state === "merging" ||
        dispatch.state === "completed")
    ) {
      return "accept";
    }
    return "reject";
  }

  /** PTY advisor fica fora do conjunto codex de quatro panes: vira recibo de
   * participação, nunca prova do pipeline executor → revisor → QA. */
  #recordAdvisorSpawn(
    identity: RealMissionPhysicalPtyIdentity,
    sessionId: string,
    at: number,
  ): void {
    if (!identity.startsWith("advisor:")) return;
    const cli = identity.slice("advisor:".length);
    // TODAS as sessões do CLI ficam registradas: retry do próprio advisor e
    // substituto de reroute são sessões distintas do MESMO cli, e quem decide
    // qual delas é a participação pessoal é o sessionId do dispatch pessoal
    // (participation builder). Sobrescrever misturava identidades — o recibo
    // do grok saía com firstNexusToolAt da sessão substituta (gate 9).
    const captures = this.#advisorPty.get(cli) ?? [];
    if (captures.some((capture) => capture.sessionId === sessionId)) return;
    this.#advisorPty.set(cli, [...captures, { sessionId, spawnedAt: at }]);
  }

  /** Recibos de participação por CLI advisor a partir das fontes físicas. */
  #buildParticipation(auditEntries: readonly AuditEntry[]): RealMissionParticipation {
    const firstNexusToolAt = (sessionId: string): number | null => {
      let first: number | null = null;
      for (const entry of auditEntries) {
        if (
          entry.session !== sessionId ||
          entry.mission_id !== this.#missionId ||
          !entry.tool.startsWith("nexus_")
        ) {
          continue;
        }
        const at = Date.parse(entry.timestamp);
        if (!Number.isFinite(at)) continue;
        if (first === null || at < first) first = at;
      }
      return first;
    };
    return buildRealMissionParticipation({
      expectations: this.#advisorExpectations,
      ptyByCli: this.#advisorPty,
      dispatches: this.#suite.taskDispatches.list(this.#missionId),
      handoffIssuedAt: (handoffId) =>
        this.#suite.handoffs.get(handoffId)?.mcpProvenance?.issuedAt ?? null,
      firstNexusToolAt,
    });
  }

  #recordPhysicalSpawn(
    sessionId: string,
    agent: RealMissionPhysicalPtyAgent,
    at: number,
  ): void {
    if (this.#physicalPty.has(sessionId)) return;
    this.#physicalPty.set(sessionId, {
      role: agent.role,
      workerIncarnationId: agent.workerIncarnationId ?? null,
      readOnly: agent.readOnly,
      nativeReadOnly: agent.nativeReadOnly ?? null,
      spawnedAt: at,
      dataAt: null,
      ptyChunkSha256: null,
    });
  }

  /** Backfill orch physical proof from kickoff when state taps missed spawn. */
  #backfillPhysicalFromKickoff(): void {
    const sessionId = this.#kickoff.sessionId;
    if (
      !sessionId ||
      this.#physicalPty.has(sessionId) ||
      this.#kickoff.idleAt === null ||
      this.#kickoff.ptyDataAt === null ||
      this.#kickoff.ptyChunkSha256 === null
    ) {
      return;
    }
    const agent = this.#acceptMissionPhysicalPty(
      sessionId,
      getAgentSessionInfo(sessionId),
    );
    if (!agent || agent.agent.role !== "orchestrator") return;
    this.#physicalPty.set(sessionId, {
      role: "orchestrator",
      workerIncarnationId: null,
      readOnly: agent.agent.readOnly,
      nativeReadOnly: agent.agent.nativeReadOnly ?? null,
      spawnedAt: this.#kickoff.idleAt,
      dataAt: this.#kickoff.ptyDataAt,
      ptyChunkSha256: this.#kickoff.ptyChunkSha256,
    });
  }

  #queueEvaluation(): void {
    if (this.#evaluationQueued || this.#stopped) return;
    this.#evaluationQueued = true;
    // setTimeout(0), never setImmediate: every store change re-queued an
    // immediate while live worker PTY output kept generating store changes
    // (activity heartbeats), so Electron's uv check phase never drained and
    // ALL main-process timers starved forever — waitForIdle hung, the
    // scheduler tick zombified and merge never ran. The timer queue cannot
    // starve itself.
    setTimeout(() => {
      this.#evaluationQueued = false;
      this.#evaluate();
    }, 0);
  }

  #observeMissionInventory(): boolean {
    if (this.#missionInventoryFence.observe(this.#suite.missions.list())) {
      return true;
    }
    this.#onFinish("invariant-failed");
    return false;
  }

  #evaluate(): void {
    if (this.#stopped) return;
    if (!this.#observeMissionInventory()) return;
    for (const agent of listAgentSessions()) {
      if (agent.missionId !== this.#missionId) continue;
      const accepted = this.#acceptMissionPhysicalPty(agent.sessionId, agent);
      if (!accepted) return;
      if (accepted.identity.startsWith("advisor:")) {
        this.#recordAdvisorSpawn(accepted.identity, agent.sessionId, Date.now());
        continue;
      }
      this.#recordPhysicalSpawn(agent.sessionId, accepted.agent, Date.now());
    }
    if (this.#owner.isDestroyed() || this.#owner.isCrashed()) {
      this.#onFinish("renderer-failed");
      return;
    }
    const mission = this.#suite.missions.get(this.#missionId);
    if (!mission) {
      this.#onFinish("observer-invalid");
      return;
    }
    this.#maybeFreezePrevC();
    this.#backfillPhysicalFromKickoff();
    const dispatches = this.#suite.taskDispatches.list(this.#missionId);
    // A durable dispatch row alone is not physical evidence. Correlate the
    // exact session + incarnation and require at least one real PTY data
    // chunk before relaxing the pre-worker repository invariant.
    if (hasCorrelatedPhysicalWorkerData(dispatches, this.#physicalPty)) {
      this.#workerObserved = true;
    }
    const integrationMayHaveStarted = dispatches.some(
      (dispatch) =>
        dispatch.state === "merging" || dispatch.state === "completed",
    );
    if (!this.#workerObserved || !integrationMayHaveStarted) {
      const repository = buildRepositoryProof(
        this.#scratch,
        this.#changedBeforeWorker,
      );
      if (
        repository.finalHeadSha !== this.#scratch.initialHeadSha ||
        !repository.clean
      ) {
        this.#changedBeforeWorker = true;
        this.#onFinish("invariant-failed");
        return;
      }
    }
    // `blocked_technical` is a durable retry checkpoint, not a terminal
    // outcome. The production bootstrap coordinator re-arms it with bounded
    // backoff; ending the gate on the first checkpoint would certify the exact
    // dead-end UX that the release is meant to prevent. A human block remains
    // terminal for unattended validation, while a stuck technical retry is
    // still caught by the outer real-mission timeout.
    if (
      mission.status === "blocked" &&
      !hasAutomaticTechnicalRecovery(mission)
    ) {
      this.#onFinish("mission-blocked");
      return;
    }
    if (mission.status === "failed") {
      this.#onFinish("mission-failed");
      return;
    }
    if (mission.status !== "done") {
      this.#doneSeenAt = null;
      return;
    }
    this.#doneSeenAt ??= Date.now();
    // Missão done sem o handoff físico de uma CLI advisor credenciada fecha o
    // gate com o código dedicado; advisors skipped (sem credencial) ficam
    // fora da exigência.
    const missingAdvisors = realMissionAdvisorsMissingHandoff(
      this.#buildParticipation(
        readAuditLog(
          { scope: this.#suite.scope, missionId: this.#missionId },
          10_000,
        ),
      ),
    );
    if (missingAdvisors.length > 0) {
      this.#onFinish("advisor-absent");
      return;
    }
    try {
      parseRealMissionE2EEvidence(this.evidence(this.#runStartedAt, "pass", null));
      this.#onFinish(null);
      return;
    } catch (settleError) {
      // Delivery acknowledgement and the final PTY state can land just after
      // the scheduler integration transaction. Give those bounded receipts a
      // settle window; never promote a partial snapshot to PASS. Log the
      // cause (throttled — this evaluates every 500ms) so an exhausted window
      // reports the actual missing receipt instead of a bare invariant-failed.
      const now = Date.now();
      // Guardado SEMPRE (não só quando o log throttled dispara): se a janela
      // esgotar, este é o único registro do recibo que faltou, e ele precisa
      // chegar ao arquivo de evidência que o gate deixa para trás.
      this.#lastSettleErrorDetail = (
        settleError instanceof Error ? settleError.message : String(settleError)
      ).slice(0, 4_000);
      if (now - this.#lastSettleLogAt >= 10_000) {
        this.#lastSettleLogAt = now;
        console.warn(
          `[real-mission] aguardando evidência estabilizar pós-done:`,
          settleError instanceof Error ? settleError.message : settleError,
        );
      }
    }
    if (Date.now() - this.#doneSeenAt >= DONE_SETTLE_MS) {
      this.#onFinish("invariant-failed");
    }
  }
}
