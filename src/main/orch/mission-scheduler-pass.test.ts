import { describe, expect, it, vi } from "vitest";
import {
  createSchedulerRuntimeState,
  runSchedulerTick,
  type SchedulerRuntimeTask,
} from "./mission-scheduler-runtime";
import { runMissionSchedulerLaunchPass } from "./mission-scheduler-pass";

const ownership = Object.freeze({
  files: Object.freeze(["src"]),
  symbols: Object.freeze([]),
  domains: Object.freeze(["sequential-only"]),
});

describe("mission scheduler same-tick launch pass", () => {
  it("rethrows the exact abort reason before later scheduler effects and works with a fresh signal", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const abortReason = new Error("PREVC preparation timed out");
    const retireWorkers = vi.fn();
    const snapshot = vi.fn(() => "snapshot");
    const launchNext = vi.fn(() => "launched");
    const observedSignals: Array<AbortSignal | undefined> = [];

    await expect(
      runMissionSchedulerLaunchPass({
        signal: firstController.signal,
        reconcile: (signal) => {
          observedSignals.push(signal);
          firstController.abort(abortReason);
        },
        retireWorkers,
        snapshot,
        launchNext,
      }),
    ).rejects.toBe(abortReason);

    expect(observedSignals).toEqual([firstController.signal]);
    expect(retireWorkers).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(launchNext).not.toHaveBeenCalled();

    await expect(
      runMissionSchedulerLaunchPass({
        signal: secondController.signal,
        reconcile: (signal) => {
          observedSignals.push(signal);
        },
        retireWorkers,
        snapshot,
        launchNext,
      }),
    ).resolves.toBe("launched");

    expect(observedSignals).toEqual([
      firstController.signal,
      secondController.signal,
    ]);
    expect(retireWorkers).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(launchNext).toHaveBeenCalledOnce();
  });

  it("re-reads completion after reconciliation and launches the successor without a timer pause", async () => {
    let predecessorMerged = false;
    const order: string[] = [];
    const dispatched = vi.fn(async () => undefined);
    const snapshot = (): readonly SchedulerRuntimeTask[] => [
      {
        id: "predecessor",
        status: "done",
        dependsOn: [],
        ownership,
        merged: predecessorMerged,
      },
      {
        id: "successor",
        status: "pending",
        dependsOn: ["predecessor"],
        ownership,
        merged: false,
      },
    ];

    const result = await runMissionSchedulerLaunchPass({
      reconcile: () => {
        order.push("reconcile");
        predecessorMerged = true;
      },
      retireWorkers: () => {
        order.push("retire");
      },
      snapshot: () => {
        order.push("snapshot");
        return snapshot();
      },
      launchNext: (current) => {
        order.push("launch");
        return runSchedulerTick(
          {
            isParallelSchedulerEnabled: () => false,
            listTasks: () => current,
            listActiveWorkers: () => [],
            scheduleConfig: () => ({
              configuredCap: 1,
              cores: 4,
              paneBudget: 4,
            }),
            now: () => 1,
            dispatchTask: dispatched,
            getChangedFiles: async () => [],
            mergeTask: async () => undefined,
            markMerged: async () => undefined,
            markFailed: async () => undefined,
            reRunSequentially: async () => undefined,
          },
          createSchedulerRuntimeState(),
        );
      },
    });

    expect(order).toEqual(["reconcile", "retire", "snapshot", "launch"]);
    expect(result.dispatched).toEqual(["successor"]);
    expect(dispatched).toHaveBeenCalledOnce();
  });
});
