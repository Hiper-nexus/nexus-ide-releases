import { describe, expect, it, vi } from "vitest";

import {
  MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX,
  persistMissionSchedulerDispatchFailure,
} from "./mission-scheduler-dispatch-transaction";
import { TASK_DISPATCH_SESSION_EXIT_REASON } from "./task-dispatch-persistence";

function blockedBootstrapSnapshot(
  overrides: Partial<{
    state:
      | "running"
      | "blocked"
      | "failed"
      | "completed"
      | "suspended"
      | "superseded";
    revision: number;
    paneId: string;
    sessionId: string;
    workerIncarnationId: string;
    lastError: string;
  }> = {},
) {
  return {
    state: "blocked" as const,
    revision: 5,
    paneId: "pane-bootstrap",
    sessionId: "session-bootstrap",
    workerIncarnationId: "worker-incarnation-bootstrap",
    lastError: TASK_DISPATCH_SESSION_EXIT_REASON,
    ...overrides,
  };
}

describe("mission scheduler dispatch bootstrap failure provenance", () => {
  it("refines the exact generic exit block with the real bootstrap cause", () => {
    const current = blockedBootstrapSnapshot();
    const refineBootstrapSessionExitBlock = vi.fn();
    const fail = vi.fn();
    const store = {
      get: vi.fn(() => current),
      refineBootstrapSessionExitBlock,
      fail,
    };

    expect(
      persistMissionSchedulerDispatchFailure({
        store,
        missionId: "mission-bootstrap",
        taskId: "task-bootstrap",
        leaseToken: "lease-bootstrap",
        paneId: current.paneId,
        sessionId: current.sessionId,
        workerIncarnationId: current.workerIncarnationId,
        error: new Error("modelo gpt-bootstrap não está disponível"),
      }),
    ).toBe("refined");

    expect(refineBootstrapSessionExitBlock).toHaveBeenCalledWith({
      taskId: "task-bootstrap",
      missionId: "mission-bootstrap",
      revision: current.revision,
      leaseToken: "lease-bootstrap",
      paneId: current.paneId,
      sessionId: current.sessionId,
      workerIncarnationId: current.workerIncarnationId,
      error:
        `${MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX} ` +
        "modelo gpt-bootstrap não está disponível",
    });
    expect(fail).not.toHaveBeenCalled();
  });

  it("keeps a generic post-bootstrap exit unchanged without catch-bound identity", () => {
    const current = blockedBootstrapSnapshot();
    const refineBootstrapSessionExitBlock = vi.fn();
    const fail = vi.fn();

    expect(
      persistMissionSchedulerDispatchFailure({
        store: {
          get: () => current,
          refineBootstrapSessionExitBlock,
          fail,
        },
        missionId: "mission-execution",
        taskId: "task-execution",
        leaseToken: "lease-execution",
        paneId: null,
        sessionId: null,
        workerIncarnationId: null,
        error: new Error("exit observado depois da execução"),
      }),
    ).toBe("unchanged");

    expect(refineBootstrapSessionExitBlock).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("never refines a substituted session or a non-generic blocked cause", () => {
    const refineBootstrapSessionExitBlock = vi.fn();
    const fail = vi.fn();
    const exact = blockedBootstrapSnapshot();
    const inputs = [
      {
        current: exact,
        sessionId: "session-substituted",
      },
      {
        current: blockedBootstrapSnapshot({
          lastError: "Worker pediu uma decisão humana explícita.",
        }),
        sessionId: exact.sessionId,
      },
    ];

    for (const candidate of inputs) {
      expect(
        persistMissionSchedulerDispatchFailure({
          store: {
            get: () => candidate.current,
            refineBootstrapSessionExitBlock,
            fail,
          },
          missionId: "mission-bootstrap",
          taskId: "task-bootstrap",
          leaseToken: "lease-bootstrap",
          paneId: exact.paneId,
          sessionId: candidate.sessionId,
          workerIncarnationId: exact.workerIncarnationId,
          error: new Error("causa que não possui a autoridade exata"),
        }),
      ).toBe("unchanged");
    }

    expect(refineBootstrapSessionExitBlock).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("persists the real cause through the ordinary lease fence if exit did not win", () => {
    const current = blockedBootstrapSnapshot({
      state: "running",
      lastError: "",
    });
    const refineBootstrapSessionExitBlock = vi.fn();
    const fail = vi.fn();

    expect(
      persistMissionSchedulerDispatchFailure({
        store: {
          get: () => current,
          refineBootstrapSessionExitBlock,
          fail,
        },
        missionId: "mission-bootstrap",
        taskId: "task-bootstrap",
        leaseToken: "lease-bootstrap",
        paneId: current.paneId,
        sessionId: current.sessionId,
        workerIncarnationId: current.workerIncarnationId,
        error: "falha antes do exit tap",
      }),
    ).toBe("failed");

    expect(fail).toHaveBeenCalledWith({
      taskId: "task-bootstrap",
      revision: current.revision,
      leaseToken: "lease-bootstrap",
      error:
        `${MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX} ` +
        "falha antes do exit tap",
    });
    expect(refineBootstrapSessionExitBlock).not.toHaveBeenCalled();
  });
});
