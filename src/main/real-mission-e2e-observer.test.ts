import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
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
  auditEntries: [] as unknown[],
  mission: null as unknown,
  dispatches: [] as unknown[],
  handoffs: new Map<string, unknown>(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

vi.mock("./pty/pty-manager", () => ({
  getAgentSessionInfo: (sessionId: string) =>
    harness.agentInfos.get(sessionId) ?? null,
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
  resolvePrivateRealMissionE2ESquadBinding: () => null,
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
      listDeliveryAttempts: () => [],
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

function createObserver(options?: {
  advisorSkipClis?: readonly string[];
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
  });
}

describe("real mission observer advisor participation", () => {
  beforeEach(() => {
    harness.finishes = [];
    harness.stateTap = null;
    harness.agentInfos = new Map();
    harness.auditEntries = [];
    harness.mission = null;
    harness.dispatches = [];
    harness.handoffs = new Map();
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
      advisorSkipClis: ["grok", "kimi", "agy", "opencode", "omp", "claude"],
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
    harness.mission = { id: MISSION_ID, status: "running" };
    harness.agentInfos.set("session-grok", {
      sessionId: "session-grok",
      missionId: MISSION_ID,
      adapterId: "grok",
      role: "worker",
      agentName: "E2E Advisor Grok",
      workerIncarnationId: "incarnation-grok",
      readOnly: true,
      nativeReadOnly: true,
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
    // A sessão advisor nunca entra no conjunto PTY codex de quatro panes.
    expect(evidence.physicalPty.ids).not.toContain("session-grok");
    observer.stop();
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
});
