import { describe, expect, it, vi } from "vitest";
import { createMissionSchedulerTickLifecycle } from "./mission-scheduler-tick-lifecycle";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("mission scheduler tick lifecycle", () => {
  it("coalesces wakes during an in-flight legacy tick into exactly one trailing pass", async () => {
    let running = true;
    const releases: Array<() => void> = [];
    const runPass = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const lifecycle = createMissionSchedulerTickLifecycle({
      runPass,
      isLegacyLoopRunning: () => running,
    });

    lifecycle.requestLegacyPass();
    const flight = lifecycle.reconcile();
    await flushMicrotasks();
    expect(runPass).toHaveBeenCalledTimes(1);

    lifecycle.requestLegacyPass();
    lifecycle.requestLegacyPass();
    lifecycle.requestLegacyPass();
    expect(runPass).toHaveBeenCalledTimes(1);

    let settled = false;
    void flight.then(() => {
      settled = true;
    });
    releases[0]?.();
    await flushMicrotasks();
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    // Wakes emitted by the bounded convergence pass cannot create a spin.
    lifecycle.requestLegacyPass();
    lifecycle.requestLegacyPass();
    releases[1]?.();
    await flight;
    expect(runPass).toHaveBeenCalledTimes(2);

    // The flight is released normally; the next interval/event can run.
    lifecycle.requestLegacyPass();
    const nextFlight = lifecycle.reconcile();
    await flushMicrotasks();
    expect(runPass).toHaveBeenCalledTimes(3);
    releases[2]?.();
    await nextFlight;
    running = false;
  });

  it("keeps production reconciliation single-flight without an internal trailing pass", async () => {
    let release: (() => void) | undefined;
    const runPass = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const lifecycle = createMissionSchedulerTickLifecycle({
      runPass,
      isLegacyLoopRunning: () => true,
    });

    const first = lifecycle.reconcile();
    const second = lifecycle.reconcile();
    expect(second).toBe(first);
    await flushMicrotasks();
    expect(runPass).toHaveBeenCalledTimes(1);

    lifecycle.requestLegacyPass();
    release?.();
    await first;
    expect(runPass).toHaveBeenCalledTimes(1);
  });
});
