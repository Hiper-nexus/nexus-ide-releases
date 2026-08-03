import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_ORCHESTRATOR_NAME,
  REAL_MISSION_E2E_SQUAD_ID,
} from "../shared/real-mission-e2e";
import type { FailureCode } from "./real-mission-e2e-lifecycle";
import type { RealMissionE2EMissionInventoryFence } from "./real-mission-e2e-mission-inventory";

const harness = vi.hoisted(() => ({
  finishes: [] as (FailureCode | null)[],
  stateTap: null as
    | ((sessionId: string, state: "spawning" | "idle" | "busy" | "exited") => void)
    | null,
  agentInfos: new Map<string, unknown>(),
  sessionStates: new Map<string, "spawning" | "idle" | "busy" | "exited">(),
  auditEntries: [] as unknown[],
  mission: null as unknown,
  dispatches: [] as unknown[],
  handoffs: new Map<string, unknown>(),
  deliveryAttempts: new Map<string, unknown[]>(),
  runtimeSquadBinding: null as {
    readonly squadId: string;
    readonly sourceSquadId: string;
    readonly sourceSquadRevisionHash: string;
    readonly squadRevisionHash: string;
  } | null,
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

vi.mock("./pty/pty-manager", () => ({
  getAgentSessionInfo: (sessionId: string) =>
    harness.agentInfos.get(sessionId) ?? null,
  getSessionState: (sessionId: string) =>
    harness.sessionStates.get(sessionId) ?? null,
  listAgentSessions: () => [],
  tapSessionState: (
    callback: (sessionId: string, state: string) => void,
  ) => {
    harness.stateTap = callback as typeof harness.stateTap;
    return () => {};
  },
  tapSessionData: () => () => {},
  tapSessionExit: () => () => {},
}));

vi.mock("./jarvis/audit-log", () => ({
  readAuditLog: () => harness.auditEntries,
}));

vi.mock("./real-mission-e2e-prevc", () => ({
  freezeRealMissionE2EPrevCIfNeeded: () => ({
    frozen: false,
    reason: "kickoff-pending",
  }),
}));

vi.mock("./real-mission-e2e-workspace", () => ({
  buildRepositoryProof: () => ({
    initialHeadSha: "a".repeat(40),
    finalHeadSha: "a".repeat(40),
    resultSha256: null,
    commitCount: 1,
    clean: true,
    changedBeforeWorker: false,
    exactSingleCommit: false,
  }),
  gitCommitIsAncestor: () => false,
  productWizardSquadBinding: () => null,
  sha256: (value: string) => `sha256:${value}`,
}));

vi.mock("./real-mission-e2e-fixture", () => ({
  resolvePrivateRealMissionE2ESquadBinding: () => ({
    squadId: REAL_MISSION_E2E_SQUAD_ID,
    sourceSquadId: REAL_MISSION_E2E_SQUAD_ID,
    sourceSquadRevisionHash: "a".repeat(64),
    squadRevisionHash: "a".repeat(64),
  }),
  resolveProductWizardRealMissionE2ESquadBinding: () =>
    harness.runtimeSquadBinding,
}));

vi.mock("./real-mission-e2e-authority", () => ({
  MISSION_DRIVER_WORKFLOW_STAGES: new Set(),
  parseMissionDriverEvidenceBinding: () => null,
  parseMissionDriverEvidenceIds: () => null,
  readDurableAuthoritySnapshot: () => ({
    handoffConsumptions: new Map(),
    dependencyConsumptions: [],
    missionStepReceipts: [],
  }),
}));

vi.mock("./orch/mission-kickoff", () => ({
  missionKickoffFailureReasonFromDescription: () => null,
}));

vi.mock("./orch/mission-scheduler-meta", () => ({
  decodeTaskScheduleDetail: () => ({ meta: null }),
}));

vi.mock("./context/context-workflow-registry", () => ({
  getContextWorkflowService: () => {
    throw new Error("context workflow unavailable in observer test");
  },
}));

vi.mock("./real-mission-e2e-lifecycle", () => ({
  isCodexMcpApprovalPrompt: () => false,
  realMissionInteractionCapture: {
    nativeDialogCount: 0,
    missionApprovalDialogCount: 0,
    missionApprovalAcceptedCount: 0,
  },
}));

import { RealMissionObserver } from "./real-mission-e2e-observer";

const MISSION_ID = "mission-e2e";
const owner = {
  isDestroyed: () => false,
  isCrashed: () => false,
} as unknown as WebContents;

const squadBinding = {
  squadId: REAL_MISSION_E2E_SQUAD_ID,
  sourceSquadId: REAL_MISSION_E2E_SQUAD_ID,
  sourceSquadRevisionHash: "a".repeat(64),
  squadRevisionHash: "a".repeat(64),
} as const;

const inventoryFenceStub = {
  observe: () => true,
  proof: () => ({
    evidenceOrigin: "main-owned-mission-store-inventory",
    selectedMissionId: MISSION_ID,
    observedMissionCount: 1,
    observedMissionIds: [MISSION_ID],
    finalMissionCount: 1,
    finalMissionIds: [MISSION_ID],
    exactSingleProductMission: true,
  }),
} as unknown as RealMissionE2EMissionInventoryFence;

function suiteStub() {
  return {
    scope: {
      installationId: "installation-e2e",
      projectId: "project-e2e",
      checkoutId: "checkout-e2e",
      rootRealPath: "/workspace/e2e",
    },
    missions: {
      get: () => harness.mission,
      list: () => (harness.mission ? [harness.mission] : []),
      onChange: () => () => {},
      getRouteReservation: () => null,
      getDriveRuntimeState: () => null,
    },
    missionPanes: { list: () => [], onChange: () => () => {} },
    taskDispatches: {
      list: () => harness.dispatches,
      onChange: () => () => {},
    },
    tasks: {
      listPlannedTasks: () => [],
      getPlanReceipt: () => null,
      onChange: () => () => {},
    },
    handoffs: {
      get: (id: string) => harness.handoffs.get(id) ?? null,
      listDeliveryAttempts: (id: string) =>
        harness.deliveryAttempts.get(id) ?? [],
      onChange: () => () => {},
    },
  } as unknown as ConstructorParameters<typeof RealMissionObserver>[0]["suite"];
}

function doneMission() {
  return {
    id: MISSION_ID,
    status: "done",
    intentState: "done",
    intentVersion: 1,
    squadId: REAL_MISSION_E2E_SQUAD_ID,
    orchestratorSessionId: "session-orch",
    milestones: [],
    intentContract: {
      squadRevisionHash: squadBinding.squadRevisionHash,
    },
  };
}

it("follows only the exact main-owned runtime snapshot after private approval", () => {
  const runtimeSquadId =
    "agentic-runtime-11111111-1111-4111-8111-111111111111";
  harness.runtimeSquadBinding = {
    squadId: runtimeSquadId,
    sourceSquadId: REAL_MISSION_E2E_SQUAD_ID,
    sourceSquadRevisionHash: squadBinding.sourceSquadRevisionHash,
    squadRevisionHash: "b".repeat(64),
  };
  harness.mission = {
    ...doneMission(),
    squadId: runtimeSquadId,
    intentContract: {
      squadRevisionHash: harness.runtimeSquadBinding.squadRevisionHash,
    },
  };

  const observer = createObserver();
  const evidence = observer.evidence(100, "fail", "invariant-failed");

  expect(evidence.mission).toMatchObject({
    squadId: runtimeSquadId,
    squadSourceId: REAL_MISSION_E2E_SQUAD_ID,
    squadSourceRevisionHash: squadBinding.sourceSquadRevisionHash,
    squadRevisionHash: "b".repeat(64),
  });
  observer.stop();
});

it("fails closed when the runtime snapshot hash diverges from the approved intent", () => {
  const runtimeSquadId =
    "agentic-runtime-22222222-2222-4222-8222-222222222222";
  harness.runtimeSquadBinding = {
    squadId: runtimeSquadId,
    sourceSquadId: REAL_MISSION_E2E_SQUAD_ID,
    sourceSquadRevisionHash: squadBinding.sourceSquadRevisionHash,
    squadRevisionHash: "b".repeat(64),
  };
  harness.mission = {
    ...doneMission(),
    squadId: runtimeSquadId,
    intentContract: { squadRevisionHash: "c".repeat(64) },
  };

  const observer = createObserver();
  expect(
    observer.evidence(100, "fail", "invariant-failed").mission,
  ).toBeNull();
  observer.stop();
});

function createObserver(options?: {
  advisorSkipClis?: readonly string[];
  startedAt?: number;
}): RealMissionObserver {
  return new RealMissionObserver({
    owner,
    runId: "run-test",
    scratch: {
      workspacePath: "/workspace/e2e",
      initialHeadSha: "a".repeat(40),
    },
    suite: suiteStub(),
    missionId: MISSION_ID,
    launchSurface: "private-runner",
    squadBinding,
    acceptanceCriteria: REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
    missionInventoryFence: inventoryFenceStub,
    wizardReceiptForMission: () => null,
    attestEvidence: (evidence) => evidence,
    onFinish: (code) => {
      harness.finishes.push(code);
    },
    ...(options?.advisorSkipClis
      ? { advisorSkipClis: options.advisorSkipClis }
      : {}),
    ...(options?.startedAt !== undefined
      ? { startedAt: options.startedAt }
      : {}),
  });
}

type TestAdvisorCli = "agy" | "grok";
type TestHandoffSource = "http-mcp" | "pty-stream";

function seedAdvisorPhysicalHandoff(
  cli: TestAdvisorCli,
  source: TestHandoffSource,
): { readonly sessionId: string; readonly issuedAt: number } {
  const agentRef = `e2e-advisor-${cli}`;
  const agentName = cli === "agy" ? "E2E Advisor Agy" : "E2E Advisor Grok";
  const sessionId = `session-${cli}`;
  const workerIncarnationId = `incarnation-${cli}`;
  const handoffId = `handoff-${cli}`;
  const toolCallId = `tool-call-${cli}`;
  const issuedAt = 290;

  harness.mission = {
    id: MISSION_ID,
    status: "running",
    intentVersion: 1,
    squadId: REAL_MISSION_E2E_SQUAD_ID,
    intentContract: {
      squadRevisionHash: squadBinding.squadRevisionHash,
    },
  };
  harness.agentInfos.set(sessionId, {
    sessionId,
    missionId: MISSION_ID,
    adapterId: cli,
    role: "worker",
    agentName,
    workerIncarnationId,
    readOnly: true,
    nativeReadOnly: false,
  });
  harness.dispatches = [
    {
      taskId: `task-${cli}`,
      agentRef,
      executionMode: "read_only",
      state: "handoff_ready",
      sessionId,
      workerIncarnationId,
      handoffId,
      handoffAcceptedAt: 300,
    },
  ];
  harness.handoffs.set(handoffId, {
    id: handoffId,
    sessionId,
    workerIncarnationId,
    fromAgent: agentName,
    authorityOrigin: "agent",
    summary: `achados do advisor ${cli}`,
    mcpProvenance: {
      receiptId: toolCallId,
      toolCallId,
      toolName: "nexus_handoff_submit",
      source,
      missionId: MISSION_ID,
      sessionId,
      workerIncarnationId,
      authoritySha256: "b".repeat(64),
      worktreeHeadSha: "a".repeat(40),
      issuedAt,
    },
    status: "success",
    deliveryState: "submitted",
    delivered: true,
  });
  harness.auditEntries = [
    {
      timestamp: new Date(280).toISOString(),
      session: sessionId,
      project_id: "project-e2e",
      checkout_id: "checkout-e2e",
      mission_id: MISSION_ID,
      source,
      tool: "nexus_handoff_submit",
      args: {},
      result: "intent",
      invocation_id: toolCallId,
      duration_ms: 0,
      user_authorized: false,
    },
  ];
  return { sessionId, issuedAt };
}

describe("real mission observer advisor participation", () => {
  beforeEach(() => {
    harness.finishes = [];
    harness.stateTap = null;
    harness.agentInfos = new Map();
    harness.sessionStates = new Map();
    harness.auditEntries = [];
    harness.mission = null;
    harness.dispatches = [];
    harness.handoffs = new Map();
    harness.deliveryAttempts = new Map();
  });

  it("finishes with advisor-absent when done misses a credentialed advisor handoff", () => {
    harness.mission = doneMission();
    // Só grok submeteu handoff: as demais advisors credenciadas faltam.
    harness.dispatches = [
      {
        agentRef: "e2e-advisor-grok",
        sessionId: "session-grok",
        handoffId: "handoff-grok",
        handoffAcceptedAt: 300,
      },
    ];
    harness.handoffs.set("handoff-grok", {
      mcpProvenance: { issuedAt: 290 },
    });

    const observer = createObserver();
    observer.start();

    expect(harness.finishes).toEqual(["advisor-absent"]);
    observer.stop();
  });

  it("does not fire advisor-absent when env-skipped advisors are the only absent ones", () => {
    harness.mission = doneMission();

    const observer = createObserver({
      advisorSkipClis: [
        "grok",
        "kimi",
        "agy",
        "opencode",
        "claude",
        "glm",
      ],
    });
    observer.start();

    expect(harness.finishes).not.toContain("advisor-absent");
    const evidence = observer.evidence(Date.now(), "fail", "timeout");
    expect(evidence.participation).toHaveLength(6);
    expect(
      evidence.participation.every(
        (row) =>
          row.skipped === "no-credential" &&
          row.spawnedAt === null &&
          row.firstNexusToolAt === null &&
          row.handoffAt === null,
      ),
    ).toBe(true);
    observer.stop();
  });

  it("records spawn, first nexus_* tool and handoff receipts in the evidence", () => {
    harness.mission = {
      id: MISSION_ID,
      status: "running",
      orchestratorSessionId: "session-orch",
    };
    harness.agentInfos.set("session-orch", {
      sessionId: "session-orch",
      missionId: MISSION_ID,
      adapterId: "codex",
      role: "orchestrator",
      agentName: REAL_MISSION_E2E_ORCHESTRATOR_NAME,
      squadId: REAL_MISSION_E2E_SQUAD_ID,
      readOnly: false,
      nativeReadOnly: false,
    });
    harness.agentInfos.set("session-grok", {
      sessionId: "session-grok",
      missionId: MISSION_ID,
      adapterId: "grok",
      role: "worker",
      agentName: "E2E Advisor Grok",
      workerIncarnationId: "incarnation-grok",
      readOnly: true,
      nativeReadOnly: false,
    });
    harness.dispatches = [
      {
        agentRef: "e2e-advisor-grok",
        sessionId: "session-grok",
        handoffId: "handoff-grok",
        handoffAcceptedAt: 300,
      },
    ];
    harness.handoffs.set("handoff-grok", {
      id: "handoff-grok",
      sessionId: "session-grok",
      workerIncarnationId: "incarnation-grok",
      fromAgent: "E2E Advisor Grok",
      authorityOrigin: "agent",
      summary: "achados do advisor grok",
      mcpProvenance: { issuedAt: 290 },
      status: "success",
      deliveryState: "consumed",
      delivered: true,
    });
    harness.deliveryAttempts.set("handoff-grok", [
      {
        id: "attempt-grok",
        handoffId: "handoff-grok",
        missionId: MISSION_ID,
        orchestratorSessionId: "session-orch",
        attemptNo: 1,
        state: "accepted",
        startedAt: 291,
        acceptDeadlineAt: 301,
        acceptedAt: 300,
        failedAt: null,
        failureCode: null,
      },
    ]);
    harness.auditEntries = [
      {
        session: "session-grok",
        mission_id: MISSION_ID,
        tool: "nexus_task_show",
        timestamp: new Date(150).toISOString(),
        result: "allow",
      },
      {
        session: "session-grok",
        mission_id: MISSION_ID,
        tool: "nexus_handoff_submit",
        timestamp: new Date(280).toISOString(),
        result: "intent",
      },
      {
        session: "session-orch",
        mission_id: MISSION_ID,
        tool: "nexus_mission_update",
        timestamp: new Date(50).toISOString(),
        result: "allow",
      },
    ];

    const observer = createObserver();
    observer.start();
    harness.stateTap?.("session-orch", "idle");
    harness.stateTap?.("session-grok", "busy");

    const evidence = observer.evidence(Date.now(), "fail", "timeout");
    const grok = evidence.participation.find((row) => row.cli === "grok");
    expect(grok).toMatchObject({
      tier: "mechanically-confined",
      skipped: null,
      firstNexusToolAt: 150,
      handoffAt: 290,
    });
    expect(typeof grok?.spawnedAt).toBe("number");
    expect(evidence.durableHandoffs).toEqual({
      count: 1,
      ids: ["handoff-grok"],
    });
    // A sessão advisor nunca entra no conjunto PTY codex de quatro panes.
    expect(evidence.physicalPty.ids).not.toContain("session-grok");
    observer.stop();
  });

  it("projects AGY's exact Main-owned PTY-stream handoff and audit receipt", () => {
    const { sessionId, issuedAt } = seedAdvisorPhysicalHandoff(
      "agy",
      "pty-stream",
    );
    const observer = createObserver();
    observer.start();
    harness.stateTap?.(sessionId, "busy");

    const evidence = observer.evidence(Date.now(), "fail", "timeout");
    const handoff = evidence.handoffs.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    const participation = evidence.participation.find(
      (row) => row.cli === "agy",
    );

    expect(handoff?.physicalReceipt).toMatchObject({
      source: "pty-stream",
      sessionId,
      issuedAt,
    });
    expect(handoff?.auditIntent).toMatchObject({
      source: "pty-stream",
      sessionId,
      occurredAt: 280,
    });
    expect(participation).toMatchObject({
      skipped: null,
      firstNexusToolAt: 280,
      handoffAt: issuedAt,
    });
    observer.stop();
  });

  it("does not project PTY-stream provenance for a non-AGY advisor", () => {
    const { sessionId } = seedAdvisorPhysicalHandoff("grok", "pty-stream");
    const observer = createObserver();

    const evidence = observer.evidence(Date.now(), "fail", "timeout");
    const handoff = evidence.handoffs.find(
      (candidate) => candidate.sessionId === sessionId,
    );

    expect(handoff?.physicalReceipt).toBeNull();
    expect(handoff?.auditIntent).toBeNull();
  });

  it("does not project HTTP-MCP provenance for AGY's PTY-pinned route", () => {
    const { sessionId } = seedAdvisorPhysicalHandoff("agy", "http-mcp");
    const observer = createObserver();

    const evidence = observer.evidence(Date.now(), "fail", "timeout");
    const handoff = evidence.handoffs.find(
      (candidate) => candidate.sessionId === sessionId,
    );

    expect(handoff?.physicalReceipt).toBeNull();
    expect(handoff?.auditIntent).toBeNull();
  });

  it("keeps a proven advisor retry and attributes evidence to the current session", () => {
    harness.mission = { id: MISSION_ID, status: "running" };
    harness.agentInfos.set("session-grok-1", {
      sessionId: "session-grok-1",
      missionId: MISSION_ID,
      adapterId: "grok",
      role: "worker",
      agentName: "E2E Advisor Grok",
      workerIncarnationId: "incarnation-grok-1",
      readOnly: true,
      nativeReadOnly: false,
    });
    harness.sessionStates.set("session-grok-1", "busy");
    harness.dispatches = [
      {
        agentRef: "e2e-advisor-grok",
        adapterId: "grok",
        workerId: "E2E Advisor Grok",
        workerIncarnationId: "incarnation-grok-1",
        attempt: 1,
        state: "running",
        executionMode: "read_only",
        agentCategory: "scout",
        sessionId: "session-grok-1",
      },
    ];

    const observer = createObserver();
    observer.start();
    harness.stateTap?.("session-grok-1", "busy");

    harness.sessionStates.delete("session-grok-1");
    harness.agentInfos.set("session-grok-2", {
      sessionId: "session-grok-2",
      missionId: MISSION_ID,
      adapterId: "grok",
      role: "worker",
      agentName: "E2E Advisor Grok",
      workerIncarnationId: "incarnation-grok-2",
      readOnly: true,
      nativeReadOnly: false,
    });
    harness.sessionStates.set("session-grok-2", "busy");
    harness.dispatches = [
      {
        agentRef: "e2e-advisor-grok",
        adapterId: "grok",
        workerId: "E2E Advisor Grok",
        workerIncarnationId: "incarnation-grok-2",
        attempt: 2,
        state: "spawning",
        executionMode: "read_only",
        agentCategory: "scout",
        routeReservationId: "route-grok-2",
        routeContract: { adapterId: "grok" },
      },
    ];

    harness.stateTap?.("session-grok-2", "busy");
    expect(harness.finishes).toEqual([]);

    harness.dispatches = [
      {
        ...(harness.dispatches[0] as Record<string, unknown>),
        state: "running",
        sessionId: "session-grok-2",
      },
    ];
    harness.auditEntries = [
      {
        session: "session-grok-2",
        mission_id: MISSION_ID,
        tool: "nexus_task_show",
        timestamp: new Date(200).toISOString(),
        result: "allow",
      },
    ];

    harness.stateTap?.("session-grok-2", "busy");

    expect(harness.finishes).toEqual([]);
    const grok = observer
      .evidence(Date.now(), "fail", "timeout")
      .participation.find((row) => row.cli === "grok");
    expect(grok?.firstNexusToolAt).toBe(200);
    observer.stop();
  });

  it("rejects an advisor replacement while the prior physical session is live", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.mission = { id: MISSION_ID, status: "running" };
    harness.agentInfos.set("session-grok-1", {
      sessionId: "session-grok-1",
      missionId: MISSION_ID,
      adapterId: "grok",
      role: "worker",
      agentName: "E2E Advisor Grok",
      workerIncarnationId: "incarnation-grok-1",
      readOnly: true,
      nativeReadOnly: false,
    });
    harness.sessionStates.set("session-grok-1", "busy");
    const observer = createObserver();
    observer.start();
    harness.stateTap?.("session-grok-1", "busy");

    harness.agentInfos.set("session-grok-2", {
      sessionId: "session-grok-2",
      missionId: MISSION_ID,
      adapterId: "grok",
      role: "worker",
      agentName: "E2E Advisor Grok",
      workerIncarnationId: "incarnation-grok-2",
      readOnly: true,
      nativeReadOnly: false,
    });
    harness.sessionStates.set("session-grok-2", "busy");
    harness.dispatches = [
      {
        agentRef: "e2e-advisor-grok",
        adapterId: "grok",
        workerId: "E2E Advisor Grok",
        workerIncarnationId: "incarnation-grok-2",
        attempt: 2,
        state: "running",
        executionMode: "read_only",
        agentCategory: "scout",
        routeReservationId: "route-grok-2",
        routeContract: { adapterId: "grok" },
        sessionId: "session-grok-2",
      },
    ];

    harness.stateTap?.("session-grok-2", "busy");

    expect(harness.finishes).toEqual(["invariant-failed"]);
    expect(errorLog).toHaveBeenCalledWith(
      "[real-mission] physical PTY invariant violation",
      expect.objectContaining({
        sessionId: "session-grok-2",
        adapterId: "grok",
        agentName: "E2E Advisor Grok",
        workerIncarnationId: "incarnation-grok-2",
      }),
    );
    observer.stop();
    errorLog.mockRestore();
  });

  it("fails closed when a skipped advisor opens a physical session", () => {
    harness.mission = { id: MISSION_ID, status: "running" };
    harness.agentInfos.set("session-kimi", {
      sessionId: "session-kimi",
      missionId: MISSION_ID,
      adapterId: "kimi",
      role: "worker",
      agentName: "E2E Advisor Kimi",
      workerIncarnationId: "incarnation-kimi",
      readOnly: true,
      nativeReadOnly: false,
    });

    const observer = createObserver({ advisorSkipClis: ["kimi"] });
    observer.start();
    harness.stateTap?.("session-kimi", "busy");

    expect(harness.finishes).toEqual(["invariant-failed"]);
    observer.stop();
  });

  it("keeps observing an approved technical retry but closes on a human block", () => {
    harness.mission = {
      id: MISSION_ID,
      status: "blocked",
      intentState: "blocked_technical",
      intentVersion: 1,
      squadId: REAL_MISSION_E2E_SQUAD_ID,
      milestones: [],
      intentContract: {
        goal: "Executar a missão real",
        intentVersion: 1,
        approvedAt: 100,
        dispatchedAt: 110,
        squadRevisionHash: squadBinding.squadRevisionHash,
      },
    };

    const observer = createObserver();
    observer.start();
    expect(harness.finishes).toEqual([]);
    observer.stop();

    harness.mission = {
      ...(harness.mission as Record<string, unknown>),
      intentState: "blocked_user",
    };
    const humanBlockedObserver = createObserver();
    humanBlockedObserver.start();

    expect(harness.finishes).toEqual(["mission-blocked"]);
    humanBlockedObserver.stop();

    harness.finishes = [];
    harness.mission = {
      ...(harness.mission as Record<string, unknown>),
      intentState: "blocked_technical",
      description:
        "[NEXUS_FAILURE:terminal] a autoridade aprovada divergiu",
    };
    const terminalBlockedObserver = createObserver();
    terminalBlockedObserver.start();

    expect(harness.finishes).toEqual(["mission-blocked"]);
    terminalBlockedObserver.stop();
  });

  // REGRESSÃO: três execuções do gate de release reprovaram com
  // "invariant-failed reason=null" e detail nulo. O motivo real — qual recibo
  // não estabilizou pós-done — existia só num console.warn throttled que o
  // gate não captura, e o arquivo de evidência que sobrevive à execução saía
  // sem o "porquê". Diagnosticamos três releases no escuro por causa disso.
  it("preserva no detail o motivo de a evidência pós-done não estabilizar", () => {
    harness.mission = {
      id: MISSION_ID,
      status: "done",
      intentState: "done",
      intentVersion: 1,
      squadId: REAL_MISSION_E2E_SQUAD_ID,
      milestones: [],
      intentContract: {
        goal: "Executar a missão real",
        intentVersion: 1,
        approvedAt: 100,
        dispatchedAt: 110,
        squadRevisionHash: squadBinding.squadRevisionHash,
      },
    };

    // Mesmo cenário determinístico do teste abaixo: o probe pós-done falha.
    const observer = createObserver({
      advisorSkipClis: ["agy", "grok", "kimi", "opencode", "glm", "claude"],
      startedAt: 123_000,
    });
    observer.start();

    const failed = observer.evidence(123_000, "fail", "invariant-failed");

    expect(failed.failure?.code).toBe("invariant-failed");
    expect(failed.failure?.detail).toBeTruthy();
    expect(typeof failed.failure?.detail).toBe("string");
    // Um bloqueio de missão continua usando a descrição, não o settle error.
    expect(
      observer.evidence(123_000, "fail", "mission-blocked").failure?.detail,
    ).not.toBe(failed.failure?.detail);
    observer.stop();
  });

  it("probes the post-done PASS evidence with the run startedAt, not the evaluation clock", () => {
    harness.mission = {
      id: MISSION_ID,
      status: "done",
      intentState: "done",
      intentVersion: 1,
      squadId: REAL_MISSION_E2E_SQUAD_ID,
      milestones: [],
      intentContract: {
        goal: "Executar a missão real",
        intentVersion: 1,
        approvedAt: 100,
        dispatchedAt: 110,
        squadRevisionHash: squadBinding.squadRevisionHash,
      },
    };

    const observer = createObserver({
      advisorSkipClis: ["agy", "grok", "kimi", "opencode", "glm", "claude"],
      startedAt: 123_000,
    });
    const evidenceSpy = vi.spyOn(observer, "evidence");
    observer.start();

    // O probe pós-done é o único caminho de PASS; usar o relógio da avaliação
    // (pós-done) como startedAt derruba o invariante spawnedAt >= startedAt
    // deterministicamente — foi o invariant-failed do run físico.
    const passProbes = evidenceSpy.mock.calls.filter(
      (call) => call[1] === "pass",
    );
    expect(passProbes.length).toBeGreaterThan(0);
    expect(passProbes[0]?.[0]).toBe(123_000);
    observer.stop();
  });
});
