import { beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMocks = vi.hoisted(() => ({
  reconcileMissionScheduler: vi.fn<
    (signal?: AbortSignal) => Promise<void>
  >(async () => undefined),
}));

vi.mock("./mission-scheduler-production", () => ({
  MISSION_SCHEDULER_TICK_MS: 5_000,
  reconcileMissionScheduler: schedulerMocks.reconcileMissionScheduler,
  setMissionSchedulerReconcileRequest: vi.fn(),
}));

import {
  MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS,
  runMissionSchedulerCoordinatorParticipant,
} from "./orchestration-coordinator";

beforeEach(() => {
  schedulerMocks.reconcileMissionScheduler.mockClear();
});

describe("orchestration coordinator scheduler participant", () => {
  it("does not preempt the packaged physical review council's own bound", () => {
    expect(MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS).toBeGreaterThan(
      20 * 60_000,
    );
  });

  it("forwards the reconciler AbortSignal without replacing its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("participant mission-scheduler exceeded 30000ms");
    schedulerMocks.reconcileMissionScheduler.mockImplementationOnce(
      async (signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(reason);
        throw signal?.reason;
      },
    );

    await expect(
      runMissionSchedulerCoordinatorParticipant(1, controller.signal),
    ).rejects.toBe(reason);
    expect(schedulerMocks.reconcileMissionScheduler).toHaveBeenCalledWith(
      controller.signal,
    );
  });
});
