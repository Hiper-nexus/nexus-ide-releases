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
import {
  MERGE_VALIDATION_UPPER_BOUND_MS,
  STALL_DEADLINE_BUFFER_MS,
  STALLED_MERGE_ATTEMPT_MS,
} from "../runtime/merge-stall-watchdog";

beforeEach(() => {
  schedulerMocks.reconcileMissionScheduler.mockClear();
});

describe("orchestration coordinator scheduler participant", () => {
  it("does not preempt the packaged physical review council's own bound", () => {
    expect(MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS).toBeGreaterThan(
      20 * 60_000,
    );
  });

  it("keeps the stalled-merge deadline mirror derived from the real participant timeout", () => {
    // O watchdog de merge estagnado (runtime/merge-stall-watchdog.ts) espelha
    // este timeout em vez de importá-lo (ciclo runtime→orch). Este teste é a
    // trava anti-drift: se o timeout real mudar, o espelho tem que acompanhar,
    // e o deadline efetivo nunca pode ficar menor que o timeout da operação
    // (regra do buzz: deadline = timeout + buffer).
    expect(MERGE_VALIDATION_UPPER_BOUND_MS).toBe(
      MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS,
    );
    expect(STALL_DEADLINE_BUFFER_MS).toBeGreaterThan(0);
    expect(STALLED_MERGE_ATTEMPT_MS).toBe(
      MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS + STALL_DEADLINE_BUFFER_MS,
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
