import { describe, expect, it } from "vitest";

import { hasBoundHandoffForExactDispatchWorker } from "./task-dispatch-codec";
import type { TaskDispatchRecord } from "./task-dispatch-codec";

function dispatchRecord(
  overrides: Partial<TaskDispatchRecord> = {},
): TaskDispatchRecord {
  return {
    id: "dispatch-1",
    taskId: "task-1",
    missionId: "mission-1",
    intentVersion: 1,
    revision: 3,
    attempt: 1,
    state: "handoff_ready",
    leaseOwner: "main-orchestration-coordinator",
    leaseExpiresAt: 1_000,
    workerId: "worker-1",
    workerIncarnationId: "inc-1",
    ownership: { files: [], symbols: [], domains: [] },
    executionMode: "read_only",
    paneId: "pane-1",
    sessionId: "session-1",
    handoffId: "handoff-1",
    createdAt: 1,
    updatedAt: 2,
    projectId: "project-a",
    checkoutId: "checkout-a",
    ...overrides,
  };
}

describe("hasBoundHandoffForExactDispatchWorker", () => {
  const identity = {
    missionId: "mission-1",
    sessionId: "session-1",
    workerIncarnationId: "inc-1",
  };

  it("recognizes the handoff bound to the exact worker incarnation", () => {
    expect(
      hasBoundHandoffForExactDispatchWorker(dispatchRecord(), identity),
    ).toBe(true);
  });

  it("fails closed without a dispatch or without a bound handoff", () => {
    expect(hasBoundHandoffForExactDispatchWorker(null, identity)).toBe(false);
    expect(
      hasBoundHandoffForExactDispatchWorker(
        dispatchRecord({ handoffId: undefined, state: "running" }),
        identity,
      ),
    ).toBe(false);
  });

  it("rejects a handoff bound to another mission, session or incarnation", () => {
    expect(
      hasBoundHandoffForExactDispatchWorker(
        dispatchRecord({ missionId: "mission-OTHER" }),
        identity,
      ),
    ).toBe(false);
    expect(
      hasBoundHandoffForExactDispatchWorker(
        dispatchRecord({ sessionId: "session-OTHER" }),
        identity,
      ),
    ).toBe(false);
    expect(
      hasBoundHandoffForExactDispatchWorker(
        dispatchRecord({ workerIncarnationId: "inc-OTHER" }),
        identity,
      ),
    ).toBe(false);
  });

  it("matches any session only when the caller has no session identity yet", () => {
    expect(
      hasBoundHandoffForExactDispatchWorker(dispatchRecord(), {
        ...identity,
        sessionId: null,
      }),
    ).toBe(true);
    expect(
      hasBoundHandoffForExactDispatchWorker(
        dispatchRecord({ workerIncarnationId: "inc-OTHER" }),
        { ...identity, sessionId: null },
      ),
    ).toBe(false);
  });
});
