import { describe, expect, it, vi } from "vitest";

import { compileIntentContract } from "../../shared/mission-intent";
import type { Handoff, Mission, Squad } from "../../shared/orch-types";
import {
  compileMissionContract,
  type WorkflowStage,
} from "../context/contract-compiler";
import type { ContextWorkflowService } from "../context/context-workflow-service";
import { publishFinalValidationHandoff } from "./final-validation-handoff";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import {
  snapshotTaskPlanRoster,
  type PlannedTaskRecord,
  type TaskPlanReceipt,
} from "./task-store";
import type { WorktreeRecord } from "../runtime/worktree-contract";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  inspectGuidedPrevcPostMergeAuthority,
  runGuidedPrevcPostMergeBridge,
  type PrevcAutopilotCoordinatorDependencies,
} from "./prevc-autopilot-coordinator";

const BASE_SHA = "a".repeat(40);
const FINAL_SHA = "b".repeat(40);
const EMPTY_DIFF = "c".repeat(64);
const FINAL_DIFF = "d".repeat(64);
const CONTEXT_HASH = "e".repeat(64);
const PLAN_HASH = "1".repeat(64);
const GUIDED_SQUAD: Squad = {
  id: "agentic-guided-bridge",
  name: "Entrega guiada",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "Coordene o plano selado pelo Nexus.",
  agents: [
    {
      id: "orchestrator",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "claude",
    },
    {
      id: "scout",
      agentName: "Scout",
      category: "scout",
      cli: "codex",
    },
    {
      id: "executor",
      agentName: "Executor",
      category: "executor",
      cli: "codex",
    },
  ],
};
const SQUAD_REVISION_HASH = snapshotSquadAuthority(GUIDED_SQUAD).hash;
const PLAN_ROSTER_HASH = snapshotTaskPlanRoster(GUIDED_SQUAD.agents).hash;

let missionSequence = 0;

function milestoneIds(): string[] {
  return Array.from({ length: 6 }, (_, index) =>
    `milestone:${String(index + 1).repeat(64)}`.slice(0, 74),
  );
}

function createWorld(
  options: {
    readonly sensorPasses?: boolean;
    readonly prematureComplete?: boolean;
    readonly review?: (
      assertCurrentAuthority: () => void,
      mutate: () => void,
    ) => Promise<void>;
  } = {},
) {
  missionSequence += 1;
  const missionId = `mission-bridge-${missionSequence}`;
  const scope = testProjectScope({
    rootRealPath: `/workspace/prevc-bridge-${missionSequence}`,
  });
  const intent = compileIntentContract({
    goal: "Entregar o sistema aprovado com validação final",
    acceptanceCriteria: ["Entrega integrada, revisada e testada"],
    source: "typed",
    lane: "standard",
    intentVersion: 3,
  });
  let liveSquad: Squad = {
    ...GUIDED_SQUAD,
    agents: GUIDED_SQUAD.agents.map((agent) => ({ ...agent })),
  };
  let mission: Mission = {
    id: missionId,
    title: "Entrega guiada",
    description: intent.goal,
    status: "running",
    squadId: liveSquad.id,
    milestones: Array.from({ length: 6 }, (_, index) => ({
      id: `step-${index + 1}`,
      label: `Etapa ${index + 1}`,
      status: "pending" as const,
      evidenceIds: [],
    })),
    learnings: "",
    intentState: "executing",
    intentVersion: 3,
    intentContract: {
      ...intent,
      approvedAt: 10,
      dispatchedAt: 11,
      squadRevisionHash: SQUAD_REVISION_HASH,
    },
    createdAt: 1,
    updatedAt: 11,
  };
  const contract = compileMissionContract(
    {
      schemaVersion: 1,
      scope,
      missionId,
      baseCommit: BASE_SHA,
      contextRevision: CONTEXT_HASH,
      goal: intent.goal,
      acceptanceCriteria: [
        {
          id: "criterion-1",
          statement: intent.acceptanceCriteria[0]!,
          requiredSensorIds: ["unit"],
          invariantRefs: [],
          requiredArtifactIds: [],
        },
      ],
      impactedDomains: ["delivery"],
      requestedSensors: ["unit"],
    },
    {
      invariantRefs: new Set(),
      availableSensorIds: new Set(["unit"]),
      blockingConflictIds: [],
    },
  );
  const author = {
    id: "nexus-guided-preflight",
    sessionId: `main:${missionId}`,
    provider: "nexus-main",
  };
  let workflow = options.prematureComplete
    ? {
        risk: contract.risk,
        binding: {
          projectId: scope.projectId,
          checkoutId: scope.checkoutId,
          missionId,
          contractHash: contract.contractHash,
          contextHash: contract.contextRevision,
          baseSha: BASE_SHA,
          headSha: FINAL_SHA,
          diffHash: FINAL_DIFF,
        },
        route: contract.route,
        stage: "complete" as WorkflowStage,
        completedStages: [
          "planning" as WorkflowStage,
          "execution" as WorkflowStage,
          "validation-primary" as WorkflowStage,
        ],
        reviewers: [],
        revision: 3,
      }
    : {
        risk: contract.risk,
        binding: {
          projectId: scope.projectId,
          checkoutId: scope.checkoutId,
          missionId,
          contractHash: contract.contractHash,
          contextHash: contract.contextRevision,
          baseSha: BASE_SHA,
          headSha: BASE_SHA,
          diffHash: EMPTY_DIFF,
        },
        route: contract.route,
        stage: "execution" as WorkflowStage,
        completedStages: ["planning" as WorkflowStage],
        reviewers: [],
        revision: 2,
      };
  let currentEvidenceIds: string[] = options.prematureComplete
    ? ["sensor:unit", "review:final"]
    : [];
  let receipt: TaskPlanReceipt = {
    version: 1,
    missionId,
    intentVersion: 3,
    planHash: PLAN_HASH,
    squadId: mission.squadId!,
    rosterHash: PLAN_ROSTER_HASH,
    agents: liveSquad.agents.map((agent) => ({ ...agent })),
    tasks: [
      {
        plannerId: "advisory",
        taskId: "task-read-only",
        title: "Advisory",
        detail: "sealed",
        agentRef: "scout",
        agentCategory: "scout",
      },
      {
        plannerId: "implementation",
        taskId: "task-isolated",
        title: "Implementation",
        detail: "sealed",
        agentRef: "executor",
        agentCategory: "executor",
      },
    ],
    createdAt: 2,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
  };
  const planned = receipt.tasks.map((entry, index): PlannedTaskRecord => ({
    plannerId: entry.plannerId,
    taskId: entry.taskId,
    missionId,
    intentVersion: 3,
    squadId: receipt.squadId,
    rosterHash: receipt.rosterHash,
    agentRef: entry.agentRef,
    agentCategory: entry.agentCategory,
    agent: {
      id: entry.agentRef,
      agentName: entry.agentRef === "executor" ? "Executor" : "Scout",
      category: entry.agentCategory,
      cli: "codex",
    },
    plannedTitle: entry.title,
    plannedDetail: entry.detail,
    task: {
      id: entry.taskId,
      missionId,
      title: entry.title,
      detail: entry.detail,
      status: "done",
      createdAt: index + 1,
      updatedAt: index + 10,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    },
  }));
  const dispatch = (
    taskId: string,
    executionMode: "read_only" | "isolated_worktree",
  ): TaskDispatchRecord =>
    ({
      id: `dispatch-${taskId}`,
      taskId,
      missionId,
      intentVersion: 3,
      revision: 5,
      attempt: 1,
      state: "completed",
      leaseOwner: "main",
      leaseExpiresAt: 100,
      workerId: taskId === "task-isolated" ? "Executor" : "Scout",
      ownership: { files: [], symbols: [], domains: [] },
      executionMode,
      integrationReceipt: {
        kind:
          executionMode === "read_only"
            ? "read_only_validated"
            : "worktree_integrated",
        reference: executionMode === "read_only" ? FINAL_SHA : FINAL_SHA,
        completedAt: 20,
        evidenceIds: ["evidence-physical"],
      },
      completedAt: 20,
      createdAt: 3,
      updatedAt: 20,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    }) as TaskDispatchRecord;
  let dispatches = [
    dispatch("task-read-only", "read_only"),
    dispatch("task-isolated", "isolated_worktree"),
  ];
  let worktrees: WorktreeRecord[] = [
    {
      id: "worktree-isolated",
      scopeKey: "scope",
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      missionId,
      taskId: "task-isolated",
      taskKey: `${missionId}:task-isolated`,
      workerId: "Executor",
      rootRealPath: scope.rootRealPath,
      worktreePath: `${scope.rootRealPath}/.worktrees/task-isolated`,
      branchRef: "refs/heads/task-isolated",
      integrationRef: "refs/heads/main",
      baseSha: BASE_SHA,
      ownership: { files: ["src"], symbols: [], domains: [] },
      dependencies: [],
      status: "integrated",
      taskHeadSha: FINAL_SHA,
      integratedSha: FINAL_SHA,
      createdAt: 3,
      updatedAt: 20,
    },
  ];
  const handoffs: Handoff[] = [];
  const sensorCalls = vi.fn();
  const reviewCalls = vi.fn();
  const recordMilestones = vi.fn(
    (_missionId: string, sourceEvidenceIds: readonly string[]) => {
      const ids = milestoneIds();
      currentEvidenceIds = [...sourceEvidenceIds, ...ids];
      return ids;
    },
  );
  const advance = vi.fn((_missionId: string, next: WorkflowStage) => {
    if (workflow.stage === "execution" && next === "validation-primary") {
      workflow = {
        ...workflow,
        binding: {
          ...workflow.binding,
          headSha: FINAL_SHA,
          diffHash: FINAL_DIFF,
        },
        stage: next,
        completedStages: [...workflow.completedStages, "execution"],
        revision: workflow.revision + 1,
      };
      return workflow;
    }
    throw new Error(`unexpected transition ${workflow.stage}->${next}`);
  });
  const workflowService = {
    getMissionWorkflow: () => ({
      contract: { contract, author, frozenAt: 1 },
      workflow,
    }),
    compileMissionSnapshot: () => ({
      markdown: "# Current context",
    }),
    advance,
    runSensor: async (
      _missionId: string,
      _sensorId: string,
      authority: { assertCurrentAuthority?: () => void },
    ) => {
      authority.assertCurrentAuthority?.();
      sensorCalls();
      await Promise.resolve();
      authority.assertCurrentAuthority?.();
      const passes = options.sensorPasses !== false;
      return {
        id: "sensor:unit",
        sensorId: "unit",
        exitCode: passes ? 0 : 1,
        timedOut: false,
      };
    },
    recordMergeReviewReport: vi.fn(),
    recordMilestoneValidationEvidence: recordMilestones,
    listCurrentPersistedEvidenceIds: () => [...currentEvidenceIds],
    inspectCurrentBindingReviewGate: () =>
      Object.freeze({
        ready: false,
        reason: "review-quorum-missing",
        evidenceIds: Object.freeze([] as string[]),
        reportCount: 0,
      }),
  } as unknown as ContextWorkflowService;
  const suite = {
    scope,
    missions: {
      get: (candidateId: string) =>
        candidateId === missionId ? mission : null,
      hasCurrentKickoffAcceptance: (candidateId: string) =>
        candidateId === missionId,
    },
    tasks: {
      getPlanReceipt: (candidateId: string, intentVersion: number) =>
        candidateId === missionId && intentVersion === 3 ? receipt : null,
      listPlannedTasks: (candidateId: string, intentVersion: number) =>
        candidateId === missionId && intentVersion === 3 ? planned : [],
      // An unrelated historical row must never participate in terminality.
      list: () => [
        ...planned.map((entry) => entry.task),
        {
          ...planned[0]!.task,
          id: "old-intent-task",
          status: "running",
        },
      ],
    },
    taskDispatches: {
      list: (candidateId: string) =>
        candidateId === missionId ? dispatches : [],
    },
    missionPanes: {
      list: (candidateId: string) =>
        candidateId === missionId
          ? [
              {
                id: "pane-row-executor",
                missionId,
                paneId: "pane-executor",
                adapterId: "codex",
                cwd: `${scope.rootRealPath}/.worktrees/task-isolated`,
                title: "Executor",
                agentName: "Executor",
                role: "worker",
                createdAt: 4,
              },
            ]
          : [],
    },
    handoffs: {
      list: ({ missionId: requested }: { missionId: string }) =>
        requested === missionId ? [...handoffs] : [],
      submit: (input: {
        status: "success";
        summary: string;
        evidenceIds: string[];
        missionId: string;
        fromAgent: string;
      }) => {
        const handoff = {
          id: `handoff-final-${handoffs.length + 1}`,
          ...input,
          artifacts: [],
          evidenceTrust: "nexus-trusted",
          evidenceBinding: {
            missionId,
            workflowRevision: workflow.revision,
            contextRevision: contract.contextRevision,
            contractHash: contract.contractHash,
            baseSha: BASE_SHA,
            headSha: workflow.binding.headSha,
            diffHash: workflow.binding.diffHash,
          },
          delivered: false,
          deliveryState: "submitted",
          submittedAt: 30,
          createdAt: 30,
        } as unknown as Handoff;
        handoffs.push(handoff);
        return handoff;
      },
    },
  } as unknown as ProjectDomainStoreSuite;
  const requestDriverTick = vi.fn(() => true);
  const publishFinalHandoff = vi.fn(publishFinalValidationHandoff);
  let physicalPlanAuthority = true;
  const hasVerifiedPhysicalPlanAuthority = vi.fn(() => physicalPlanAuthority);
  const dependencies: PrevcAutopilotCoordinatorDependencies = {
    storesForScope: () => suite,
    workflowForScope: () => workflowService,
    getSquad: (squadId) => (squadId === liveSquad.id ? liveSquad : null),
    listMissionWorktrees: () => worktrees,
    inspectGit: () => ({
      baseSha: BASE_SHA,
      headSha: FINAL_SHA,
      diffHash: FINAL_DIFF,
    }),
    hasVerifiedPhysicalPlanAuthority,
    reviewDependencies: () => ({
      runReview: async (input) => {
        input.assertCurrentAuthority?.();
        reviewCalls();
        await options.review?.(
          input.assertCurrentAuthority ?? (() => {}),
          () => {
            mission = {
              ...mission,
              intentContract: {
                ...mission.intentContract!,
                goal: "intent tampered after review await",
              },
            };
          },
        );
        input.assertCurrentAuthority?.();
        return {
          ready: true,
          gate: {
            ready: true,
            reason: "ready",
            blockingFindingCount: 0,
            reportCount: 1,
          },
          reports: [],
          evidenceIds: ["review:final"],
        };
      },
    }),
    publishFinalHandoff,
    requestDriverTick,
  };
  return {
    scope,
    missionId,
    dependencies,
    sensorCalls,
    reviewCalls,
    recordMilestones,
    publishFinalHandoff,
    requestDriverTick,
    hasVerifiedPhysicalPlanAuthority,
    handoffs,
    get mission() {
      return mission;
    },
    set mission(next: Mission) {
      mission = next;
    },
    get squad() {
      return liveSquad;
    },
    set squad(next: Squad) {
      liveSquad = next;
    },
    get receipt() {
      return receipt;
    },
    set receipt(next: TaskPlanReceipt) {
      receipt = next;
    },
    get worktrees() {
      return worktrees;
    },
    set worktrees(next: WorktreeRecord[]) {
      worktrees = next;
    },
    get dispatches() {
      return dispatches;
    },
    set dispatches(next: TaskDispatchRecord[]) {
      dispatches = next;
    },
    set physicalPlanAuthority(next: boolean) {
      physicalPlanAuthority = next;
    },
  };
}

describe("production guided PREVC post-merge bridge", () => {
  it("accepts current completed dispatches, including read-only tasks without fake worktrees", async () => {
    const world = createWorld();
    expect(SQUAD_REVISION_HASH).not.toBe(PLAN_ROSTER_HASH);

    const result = await runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      world.dependencies,
    );

    expect(result).toMatchObject({
      applicable: true,
      ready: true,
      driverWakeRequested: true,
      autopilot: {
        state: "validation-primary",
        transitions: ["execution->validation-primary"],
        finalHandoffId: "handoff-final-1",
      },
    });
    expect(world.sensorCalls).toHaveBeenCalledOnce();
    expect(world.reviewCalls).toHaveBeenCalledOnce();
    expect(world.recordMilestones).toHaveBeenCalledOnce();
    expect(world.handoffs).toHaveLength(1);
    expect(world.handoffs[0]).toMatchObject({
      fromAgent: "nexus-prevc-autopilot",
      evidenceTrust: "nexus-trusted",
      evidenceIds: milestoneIds(),
    });
    expect(world.requestDriverTick).toHaveBeenCalledOnce();
    expect(world.mission.status).toBe("running");
    expect(
      world.mission.milestones.every((step) => step.status === "pending"),
    ).toBe(true);
  });

  it("treats a non-running guided mission as initially not ready without PREVC effects", async () => {
    const world = createWorld();
    world.mission = {
      ...world.mission,
      status: "blocked",
      intentState: "blocked_technical",
    };

    const inspection = inspectGuidedPrevcPostMergeAuthority(
      world.scope,
      world.missionId,
      world.dependencies,
    );
    const result = await runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      world.dependencies,
    );

    expect(inspection).toEqual({
      ready: false,
      reason: "mission is not running",
    });
    expect(result).toEqual({
      applicable: true,
      ready: false,
      reason: "mission is not running",
      driverWakeRequested: false,
    });
    expect(world.hasVerifiedPhysicalPlanAuthority).not.toHaveBeenCalled();
    expect(world.sensorCalls).not.toHaveBeenCalled();
    expect(world.reviewCalls).not.toHaveBeenCalled();
    expect(world.recordMilestones).not.toHaveBeenCalled();
    expect(world.publishFinalHandoff).not.toHaveBeenCalled();
    expect(world.handoffs).toEqual([]);
    expect(world.requestDriverTick).not.toHaveBeenCalled();
  });

  it("keeps a running mission fail-closed when intent versions diverge", () => {
    const world = createWorld();
    const approvedIntentVersion = world.mission.intentContract?.intentVersion;
    if (approvedIntentVersion === undefined) {
      throw new Error("test fixture requires an approved intent contract");
    }
    world.mission = {
      ...world.mission,
      intentVersion: approvedIntentVersion + 1,
    };

    expect(() =>
      inspectGuidedPrevcPostMergeAuthority(
        world.scope,
        world.missionId,
        world.dependencies,
      ),
    ).toThrow(/guided post-merge intent authority is stale/i);
    expect(world.hasVerifiedPhysicalPlanAuthority).not.toHaveBeenCalled();
    expect(world.sensorCalls).not.toHaveBeenCalled();
    expect(world.reviewCalls).not.toHaveBeenCalled();
    expect(world.publishFinalHandoff).not.toHaveBeenCalled();
    expect(world.handoffs).toEqual([]);
    expect(world.requestDriverTick).not.toHaveBeenCalled();
  });

  it("rejects a stale live squad revision before and during post-merge work", () => {
    const staleAtInspection = createWorld();
    staleAtInspection.squad = {
      ...staleAtInspection.squad,
      orchestratorInstructions: "playbook alterado depois da aprovação",
    };
    expect(() =>
      inspectGuidedPrevcPostMergeAuthority(
        staleAtInspection.scope,
        staleAtInspection.missionId,
        staleAtInspection.dependencies,
      ),
    ).toThrow(/squad revision authority diverged/i);

    const staleInFlight = createWorld();
    const inspection = inspectGuidedPrevcPostMergeAuthority(
      staleInFlight.scope,
      staleInFlight.missionId,
      staleInFlight.dependencies,
    );
    if (!inspection.ready) throw new Error("expected current PREVC authority");
    staleInFlight.squad = {
      ...staleInFlight.squad,
      nativeInstructions: "autoridade nativa alterada",
    };
    expect(() => inspection.assertCurrentAuthority()).toThrow(
      /squad revision authority diverged/i,
    );
  });

  it("rejects a stale canonical task-plan roster before and during post-merge work", () => {
    const staleAtInspection = createWorld();
    staleAtInspection.receipt = {
      ...staleAtInspection.receipt,
      rosterHash: "9".repeat(64),
    };
    expect(() =>
      inspectGuidedPrevcPostMergeAuthority(
        staleAtInspection.scope,
        staleAtInspection.missionId,
        staleAtInspection.dependencies,
      ),
    ).toThrow(/plan roster authority diverged/i);

    const staleInFlight = createWorld();
    const inspection = inspectGuidedPrevcPostMergeAuthority(
      staleInFlight.scope,
      staleInFlight.missionId,
      staleInFlight.dependencies,
    );
    if (!inspection.ready) throw new Error("expected current PREVC authority");
    staleInFlight.receipt = {
      ...staleInFlight.receipt,
      rosterHash: "8".repeat(64),
    };
    expect(() => inspection.assertCurrentAuthority()).toThrow(
      /plan roster authority diverged/i,
    );
  });

  it("rejects a task-plan receipt bound to another squad id", () => {
    const world = createWorld();
    world.receipt = {
      ...world.receipt,
      squadId: "agentic-another-squad",
    };

    expect(() =>
      inspectGuidedPrevcPostMergeAuthority(
        world.scope,
        world.missionId,
        world.dependencies,
      ),
    ).toThrow(/plan\/squad identity authority diverged/i);
  });

  it("requires an integrated physical worktree for each isolated dispatch", async () => {
    const world = createWorld();
    world.worktrees = [];

    const inspection = inspectGuidedPrevcPostMergeAuthority(
      world.scope,
      world.missionId,
      world.dependencies,
    );
    const result = await runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      world.dependencies,
    );

    expect(inspection).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/dispatches.*not all completed/i),
    });
    expect(result.ready).toBe(false);
    expect(world.sensorCalls).not.toHaveBeenCalled();
    expect(world.reviewCalls).not.toHaveBeenCalled();
    expect(world.handoffs).toEqual([]);
    expect(world.requestDriverTick).not.toHaveBeenCalled();
  });

  it("rejects a durable completed replay when its physical plan proof was tampered", async () => {
    const world = createWorld();
    world.physicalPlanAuthority = false;

    const inspection = inspectGuidedPrevcPostMergeAuthority(
      world.scope,
      world.missionId,
      world.dependencies,
    );
    const result = await runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      world.dependencies,
    );

    expect(inspection).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/physical authority/i),
    });
    expect(result.ready).toBe(false);
    expect(world.hasVerifiedPhysicalPlanAuthority).toHaveBeenCalled();
    expect(world.sensorCalls).not.toHaveBeenCalled();
    expect(world.handoffs).toEqual([]);
    expect(world.requestDriverTick).not.toHaveBeenCalled();
  });

  it("coalesces concurrent scheduler/manual bridge attempts into one validation flight", async () => {
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const world = createWorld({
      review: async () => reviewGate,
    });

    const first = runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      world.dependencies,
    );
    const second = runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      world.dependencies,
    );
    await vi.waitFor(() => expect(world.reviewCalls).toHaveBeenCalledOnce());
    releaseReview();

    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(world.sensorCalls).toHaveBeenCalledOnce();
    expect(world.reviewCalls).toHaveBeenCalledOnce();
    expect(world.publishFinalHandoff).toHaveBeenCalledOnce();
    expect(world.handoffs).toHaveLength(1);
    expect(world.requestDriverTick).toHaveBeenCalledOnce();
  });

  it("recovers final receipt when workflow reached complete without the atomic path", async () => {
    const world = createWorld({ prematureComplete: true });

    const result = await runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      world.dependencies,
    );

    expect(result).toMatchObject({
      applicable: true,
      ready: true,
      driverWakeRequested: true,
      autopilot: {
        state: "complete",
        finalHandoffId: "handoff-final-1",
        reason: expect.stringMatching(/atomic mission-step receipt/i),
      },
    });
    expect(world.sensorCalls).not.toHaveBeenCalled();
    expect(world.reviewCalls).not.toHaveBeenCalled();
    expect(world.recordMilestones).toHaveBeenCalledOnce();
    expect(world.publishFinalHandoff).toHaveBeenCalledOnce();
    expect(world.handoffs).toHaveLength(1);
    expect(world.handoffs[0]).toMatchObject({
      fromAgent: "nexus-prevc-autopilot",
      evidenceTrust: "nexus-trusted",
      evidenceIds: milestoneIds(),
    });
    expect(world.requestDriverTick).toHaveBeenCalledOnce();
  });

  it("recovers a crash after durable handoff publication without rerunning validation", async () => {
    const world = createWorld();
    const durablePublish = world.dependencies.publishFinalHandoff;
    let crashOnce = true;
    const crashDependencies: PrevcAutopilotCoordinatorDependencies = {
      ...world.dependencies,
      publishFinalHandoff: (input, store) => {
        const handoff = durablePublish(input, store);
        if (crashOnce) {
          crashOnce = false;
          throw new Error("simulated crash after handoff commit");
        }
        return handoff;
      },
    };

    await expect(
      runGuidedPrevcPostMergeBridge(
        world.scope,
        world.missionId,
        crashDependencies,
      ),
    ).rejects.toThrow(/simulated crash/i);
    expect(world.handoffs).toHaveLength(1);
    expect(world.requestDriverTick).not.toHaveBeenCalled();

    const replay = await runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      crashDependencies,
    );

    expect(replay).toMatchObject({
      ready: true,
      driverWakeRequested: true,
      autopilot: { finalHandoffId: "handoff-final-1" },
    });
    expect(world.sensorCalls).toHaveBeenCalledOnce();
    expect(world.reviewCalls).toHaveBeenCalledOnce();
    expect(world.handoffs).toHaveLength(1);
    expect(world.requestDriverTick).toHaveBeenCalledOnce();
  });

  it("revokes the flight when intent authority changes across a reviewer await", async () => {
    const world = createWorld({
      review: async (_assertCurrentAuthority, mutate) => {
        await Promise.resolve();
        mutate();
      },
    });

    await expect(
      runGuidedPrevcPostMergeBridge(
        world.scope,
        world.missionId,
        world.dependencies,
      ),
    ).rejects.toThrow(/mission authority was revoked/i);

    expect(world.handoffs).toEqual([]);
    expect(world.requestDriverTick).not.toHaveBeenCalled();
    expect(world.mission.status).toBe("running");
  });

  it("keeps validation failure fail-closed and never wakes completion", async () => {
    const world = createWorld({ sensorPasses: false });

    const result = await runGuidedPrevcPostMergeBridge(
      world.scope,
      world.missionId,
      world.dependencies,
    );

    expect(result).toMatchObject({
      applicable: true,
      ready: false,
      reason: "sensor failed: unit",
    });
    expect(world.reviewCalls).not.toHaveBeenCalled();
    expect(world.recordMilestones).not.toHaveBeenCalled();
    expect(world.handoffs).toEqual([]);
    expect(world.requestDriverTick).not.toHaveBeenCalled();
    expect(world.mission.status).toBe("running");
  });
});
