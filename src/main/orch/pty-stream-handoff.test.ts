import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGateContext } from "./gate";
import { testProjectScope } from "./__tests__/scope-fixture";

const mocks = vi.hoisted(() => ({
  getContextBySession: vi.fn(),
  markHandoffSubmitted: vi.fn(),
  onHandoffSubmitted: vi.fn(),
  getStores: vi.fn(),
  committedPhysicalWorkerHead: vi.fn(
    async (_ctx: unknown, requireHead: boolean) =>
      requireHead ? "a".repeat(40) : undefined,
  ),
  assertReadOnlyLaneObservationCurrent: vi.fn(),
}));

vi.mock("./gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gate")>()),
  getContextBySession: mocks.getContextBySession,
  markHandoffSubmitted: mocks.markHandoffSubmitted,
}));

vi.mock("./idle-delivery", () => ({
  onHandoffSubmitted: mocks.onHandoffSubmitted,
}));

vi.mock("./project-domain-store-registry", () => ({
  getProjectDomainStores: mocks.getStores,
}));

vi.mock("./http-mcp-boundary", () => ({
  runInsidePtyStreamAgentTransport: (
    _sessionId: string,
    _ctx: unknown,
    operation: () => unknown,
  ) => operation(),
  mintAgentTransportPhysicalReceipt: () => ({}),
}));

vi.mock("./physical-handoff-git", () => ({
  committedPhysicalWorkerHead: mocks.committedPhysicalWorkerHead,
  assertReadOnlyLaneObservationCurrent:
    mocks.assertReadOnlyLaneObservationCurrent,
  STALE_READ_ONLY_OBSERVATION_REASON: "stale_read_only_observation",
  StaleReadOnlyObservationError: class StaleReadOnlyObservationError extends Error {
    override name = "StaleReadOnlyObservationError";
  },
}));

vi.mock("./mission-event-emit", () => ({
  getMissionEventRuntimeManager: () => null,
}));

vi.mock("../jarvis/audit-log", () => ({
  auditIntent: vi.fn(),
  auditSuccess: vi.fn(),
  auditError: vi.fn(),
}));

import {
  extractPromotablePtyHandoffs,
  submitPtyStreamHandoff,
} from "./pty-stream-handoff";

const scope = testProjectScope();

const payload = {
  status: "success" as const,
  summary: "Interface implementada no pane sem tool MCP.",
  artifacts: [] as unknown[],
};

function workerCtx(): AgentGateContext {
  return {
    token: "worker-token",
    label: "agy-worker",
    role: "worker",
    missionId: "mission-a",
    sessionId: "agy-session",
    workerIncarnationId: "inc-a",
    agentName: "agy",
    contextRevision: "c".repeat(64),
    scope,
    allowedTools: [],
    allowedSkills: [],
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function approvedMission() {
  return {
    id: "mission-a",
    status: "running",
    intentState: "executing",
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: "Implementar interface",
      acceptanceCriteria: ["Done"],
      risk: "normal",
      executionMode: "assisted",
      contextPolicy: "on-demand",
      intentVersion: 1,
      approvedAt: 1,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 2,
      },
    },
  };
}

describe("extractPromotablePtyHandoffs", () => {
  it("promotes a bare NEXUS_HANDOFF snapshot and skips the kickoff placeholder", () => {
    const text =
      '### NEXUS_HANDOFF v1\n{"status":"success","summary":"<resumo objetivo do que fez>","artifacts":[]}\n' +
      'NEXUS_HANDOFF\n{"status":"success","summary":"Lista de missões renderiza cartões com scroll.","artifacts":[]}';
    expect(extractPromotablePtyHandoffs(text)).toEqual([
      {
        status: "success",
        summary: "Lista de missões renderiza cartões com scroll.",
        artifacts: [],
      },
    ]);
  });
});

describe("submitPtyStreamHandoff MCP parity", () => {
  beforeEach(() => {
    mocks.getContextBySession.mockReset();
    mocks.markHandoffSubmitted.mockReset();
    mocks.onHandoffSubmitted.mockReset();
    mocks.getStores.mockReset();
    mocks.assertReadOnlyLaneObservationCurrent.mockReset();
    mocks.committedPhysicalWorkerHead.mockReset();
    mocks.committedPhysicalWorkerHead.mockImplementation(
      async (_ctx: unknown, requireHead: boolean) =>
        requireHead ? "a".repeat(40) : undefined,
    );
  });
  it("persists without a bound task_dispatch and wakes the Maestro (express / AGY)", async () => {
    const submitWithReplay = vi.fn(() => ({
      handoff: {
        id: "hoff-a",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      replayed: false,
    }));
    const submitAndTransition = vi.fn();
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() },
      tasks: { list: () => [] },
      missionPanes: { list: () => [] },
      taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch:
          submitAndTransition,
      },
    });

    const result = await submitPtyStreamHandoff("agy-session", payload);

    expect(result.handoffId).toBe("hoff-a");
    expect(submitAndTransition).not.toHaveBeenCalled();
    expect(submitWithReplay).toHaveBeenCalledOnce();
    expect(mocks.committedPhysicalWorkerHead).toHaveBeenCalledWith(
      expect.anything(),
      false,
    );
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledOnce();
  });

  it("still binds a matching dispatch and requires HEAD when ceremonial work exists", async () => {
    const submitAndTransition = vi.fn(() => ({
      handoff: {
        id: "hoff-b",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      taskDispatch: { state: "handoff_submitted" },
      replayed: false,
    }));
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() },
      tasks: { list: () => [] },
      missionPanes: { list: () => [] },
      taskDispatches: {
        list: () => [
          {
            sessionId: "agy-session",
            workerIncarnationId: "inc-a",
            workerId: "agy",
            state: "running",
          },
        ],
      },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: vi.fn(),
        submitFromPhysicalAgentBoundaryAndTransitionDispatch:
          submitAndTransition,
      },
    });

    const result = await submitPtyStreamHandoff("agy-session", payload);

    expect(result.taskDispatchState).toBe("handoff_submitted");
    expect(submitAndTransition).toHaveBeenCalledOnce();
    expect(mocks.committedPhysicalWorkerHead).toHaveBeenCalledWith(
      expect.anything(),
      true,
    );
    expect(mocks.assertReadOnlyLaneObservationCurrent).toHaveBeenCalledOnce();
  });
});
