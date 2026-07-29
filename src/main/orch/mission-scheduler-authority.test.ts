import { describe, expect, it } from "vitest";
import type { Handoff, Mission } from "../../shared/orch-types";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import {
  findCurrentSchedulerOwnedHandoffDispatch,
  missionHasSchedulerProgress,
} from "./mission-scheduler-authority";

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission-a",
    title: "Scheduler authority",
    description: "",
    status: "running",
    milestones: [],
    learnings: "",
    intentVersion: 7,
    orchestratorSessionId: "orchestrator-current",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: "handoff-a",
    missionId: "mission-a",
    sessionId: "worker-session",
    workerIncarnationId: "worker-incarnation",
    fromAgent: "worker-a",
    authorityOrigin: "agent",
    mcpProvenance: {
      receiptId: "physical-tool-call",
      toolCallId: "physical-tool-call",
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      missionId: "mission-a",
      sessionId: "worker-session",
      workerIncarnationId: "worker-incarnation",
      authoritySha256: "a".repeat(64),
      issuedAt: 2,
    },
    status: "success",
    claimTrust: "untrusted",
    summary: "Physical worker result",
    artifacts: [],
    evidenceIds: [],
    evidenceTrust: "unverified",
    delivered: false,
    deliveryState: "queued",
    createdAt: 3,
    ...overrides,
  };
}

function dispatch(
  overrides: Partial<TaskDispatchRecord> = {},
): TaskDispatchRecord {
  return {
    id: "dispatch-a",
    taskId: "task-a",
    missionId: "mission-a",
    intentVersion: 7,
    revision: 4,
    attempt: 1,
    state: "handoff_ready",
    leaseOwner: "nexus-main",
    leaseExpiresAt: 10_000,
    workerId: "worker-a",
    workerIncarnationId: "worker-incarnation",
    ownership: { files: [], symbols: [], domains: [] },
    executionMode: "read_only",
    sessionId: "worker-session",
    handoffId: "handoff-a",
    handoffAcceptedAt: 3,
    createdAt: 1,
    updatedAt: 3,
    projectId: "project-a",
    checkoutId: "checkout-a",
    ...overrides,
  };
}

describe("mission scheduler durable authority", () => {
  it("recognizes progress only for the current accepted kickoff revision", () => {
    expect(missionHasSchedulerProgress(mission(), true, [dispatch()])).toBe(
      true,
    );
    expect(
      missionHasSchedulerProgress(mission(), false, [dispatch()]),
    ).toBe(false);
    expect(
      missionHasSchedulerProgress(mission(), true, [
        dispatch({ intentVersion: 6 }),
      ]),
    ).toBe(false);
  });

  it("binds a scheduler-owned handoff to one exact physical dispatch", () => {
    expect(
      findCurrentSchedulerOwnedHandoffDispatch(
        mission(),
        true,
        handoff(),
        [dispatch()],
      ),
    ).toMatchObject({
      handoffId: "handoff-a",
      sessionId: "worker-session",
      workerIncarnationId: "worker-incarnation",
      intentVersion: 7,
      state: "handoff_ready",
    });
  });

  it.each([
    {
      name: "session mismatch",
      row: dispatch({ sessionId: "worker-stale" }),
    },
    {
      name: "incarnation mismatch",
      row: dispatch({ workerIncarnationId: "incarnation-stale" }),
    },
    {
      name: "handoff mismatch",
      row: dispatch({ handoffId: "handoff-stale" }),
    },
    {
      name: "unaccepted state",
      row: dispatch({ state: "running", handoffAcceptedAt: undefined }),
    },
  ])("rejects $name", ({ row }) => {
    expect(
      findCurrentSchedulerOwnedHandoffDispatch(
        mission(),
        true,
        handoff(),
        [row],
      ),
    ).toBeNull();
  });

  it("rejects the retired OMP transport provenance", () => {
    const current = handoff();
    expect(
      findCurrentSchedulerOwnedHandoffDispatch(
        mission(),
        true,
        {
          ...current,
          mcpProvenance: {
            ...current.mcpProvenance!,
            source: "omp-rpc-stdio",
          },
        },
        [dispatch()],
      ),
    ).toBeNull();
  });
});
