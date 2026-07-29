import { describe, expect, it, vi } from "vitest";
import type { MissionPaneSpec } from "../../shared/orch-types";
import {
  assertWorkerBudget,
  compileIntentContract,
} from "../../shared/mission-intent";
import { testProjectScope } from "./__tests__/scope-fixture";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import {
  projectMissionSchedulerWorkerSlots,
  TaskDispatchWorkerRetirementCoordinator,
} from "./task-dispatch-worker-retirement";
import { runMissionSchedulerLaunchPass } from "./mission-scheduler-pass";

const scope = testProjectScope();
const missionId = "mission-retirement";

function dispatch(
  taskId: string,
  overrides: Partial<TaskDispatchRecord> = {},
): TaskDispatchRecord {
  return {
    id: `dispatch-${taskId}`,
    taskId,
    missionId,
    intentVersion: 1,
    revision: 1,
    attempt: 1,
    state: "completed",
    leaseOwner: "main",
    leaseExpiresAt: 10_000,
    workerId: `worker-${taskId}`,
    workerIncarnationId: `incarnation-${taskId}`,
    ownership: { files: [], symbols: [], domains: [] },
    executionMode: "isolated_worktree",
    paneId: `pane-${taskId}`,
    sessionId: `session-${taskId}`,
    createdAt: 1,
    updatedAt: 2,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    ...overrides,
  };
}

function workerRow(taskId: string): MissionPaneSpec {
  return {
    id: `row-${taskId}`,
    missionId,
    adapterId: "codex",
    title: `Worker ${taskId}`,
    role: "worker",
    paneId: `pane-${taskId}`,
    workerIncarnationId: `incarnation-${taskId}`,
    createdAt: 1,
  };
}

describe("task dispatch worker retirement", () => {
  it("retires terminal A and admits B with maxWorkers=1", async () => {
    const terminalA = dispatch("a");
    const byTask = new Map([[terminalA.taskId, terminalA]]);
    let physicalPaneState: "idle" | "exited" = "idle";
    const closeWorker = vi.fn(async () => {
      physicalPaneState = "exited";
      return true;
    });
    const coordinator = new TaskDispatchWorkerRetirementCoordinator();

    expect(physicalPaneState).toBe("idle");
    await coordinator.retireMissionWorkers({
      scope,
      missionId,
      dispatches: [terminalA],
      deps: {
        getDispatch: (taskId) => byTask.get(taskId) ?? null,
        closeWorker,
      },
    });

    const slots = projectMissionSchedulerWorkerSlots(
      missionId,
      [workerRow("a")],
      [terminalA],
    );
    const baseContract = compileIntentContract({
      goal: "Executar A e depois B",
      acceptanceCriteria: ["B foi fisicamente despachada"],
      intentVersion: 1,
      source: "typed",
      lane: "standard",
    });
    const contract = {
      ...baseContract,
      budgets: { ...baseContract.budgets, maxWorkers: 1 },
    };
    const reservation = assertWorkerBudget(
      contract,
      slots.activeDispatchCount,
    );
    const dispatchB = vi.fn();
    if (reservation.ok) dispatchB("b");

    expect(closeWorker).toHaveBeenCalledWith({
      paneId: "pane-a",
      sessionId: "session-a",
      missionId,
      taskId: "a",
      workerIncarnationId: "incarnation-a",
      scope,
    });
    expect(physicalPaneState).toBe("exited");
    expect(slots.activeDispatchCount).toBe(0);
    expect(slots.unmanagedRows).toEqual([]);
    expect(reservation.ok).toBe(true);
    expect(dispatchB).toHaveBeenCalledWith("b");
  });

  it("admits the successor in the same pass after natural-exit retirement", async () => {
    const terminal = dispatch("executor");
    const coordinator = new TaskDispatchWorkerRetirementCoordinator();
    let staleRendererLeaf = true;
    const launchNext = vi.fn((
      slots: ReturnType<typeof projectMissionSchedulerWorkerSlots>,
    ) => slots.activeDispatchCount === 0 && !staleRendererLeaf
      ? "reviewer-launched"
      : "blocked");

    const result = await runMissionSchedulerLaunchPass({
      reconcile: () => undefined,
      retireWorkers: async () => {
        await coordinator.retireMissionWorkers({
          scope,
          missionId,
          dispatches: [terminal],
          deps: {
            getDispatch: () => terminal,
            closeWorker: async () => {
              staleRendererLeaf = false;
              return true;
            },
          },
        });
      },
      snapshot: () =>
        projectMissionSchedulerWorkerSlots(
          missionId,
          [workerRow("executor")],
          [terminal],
        ),
      launchNext,
    });

    expect(result).toBe("reviewer-launched");
    expect(launchNext).toHaveBeenCalledOnce();
  });

  it("keeps capacity fail-closed when physical close is not proven", async () => {
    const terminalA = dispatch("a");
    const coordinator = new TaskDispatchWorkerRetirementCoordinator();
    const closeWorker = vi.fn(async () => false);

    await expect(
      coordinator.retireMissionWorkers({
        scope,
        missionId,
        dispatches: [terminalA],
        deps: {
          getDispatch: () => terminalA,
          closeWorker,
        },
      }),
    ).rejects.toThrow(/exit_unproven/i);

    expect(closeWorker).toHaveBeenCalledOnce();
  });

  it("finishes the in-flight close, preserves the exact abort reason, and starts no sibling", async () => {
    const terminalA = dispatch("a");
    const terminalB = dispatch("b");
    const byTask = new Map([
      [terminalA.taskId, terminalA],
      [terminalB.taskId, terminalB],
    ]);
    const controller = new AbortController();
    const reason = new Error("orchestration coordinator stopped");
    const closeWorker = vi.fn(async () => {
      controller.abort(reason);
      return true;
    });
    const coordinator = new TaskDispatchWorkerRetirementCoordinator();

    await expect(
      coordinator.retireMissionWorkers({
        scope,
        missionId,
        dispatches: [terminalA, terminalB],
        signal: controller.signal,
        deps: {
          getDispatch: (taskId) => byTask.get(taskId) ?? null,
          closeWorker,
        },
      }),
    ).rejects.toBe(reason);

    expect(closeWorker).toHaveBeenCalledOnce();
  });

  it("makes a successful retirement replay idempotent", async () => {
    const terminalA = dispatch("a");
    const coordinator = new TaskDispatchWorkerRetirementCoordinator();
    const closeWorker = vi.fn(async () => true);
    const input = {
      scope,
      missionId,
      dispatches: [terminalA],
      deps: {
        getDispatch: () => terminalA,
        closeWorker,
      },
    };

    await expect(coordinator.retireMissionWorkers(input)).resolves.toMatchObject({
      retiredTaskIds: ["a"],
      alreadyRetiredTaskIds: [],
    });
    await expect(coordinator.retireMissionWorkers(input)).resolves.toMatchObject({
      retiredTaskIds: [],
      alreadyRetiredTaskIds: ["a"],
    });
    expect(closeWorker).toHaveBeenCalledOnce();
  });

  it("never closes a stale worker incarnation", async () => {
    const stale = dispatch("a", {
      workerIncarnationId: "incarnation-stale",
      sessionId: "session-stale",
    });
    const current = dispatch("a", {
      workerIncarnationId: "incarnation-current",
      sessionId: "session-current",
    });
    const closeWorker = vi.fn(async () => true);
    const coordinator = new TaskDispatchWorkerRetirementCoordinator();

    await expect(
      coordinator.retireMissionWorkers({
        scope,
        missionId,
        dispatches: [stale],
        deps: {
          getDispatch: () => current,
          closeWorker,
        },
      }),
    ).rejects.toThrow(/stale_before/i);
    expect(closeWorker).not.toHaveBeenCalled();
  });

  it("preserves manual and ambiguously bound panes in the live-pane count", () => {
    const manual = {
      ...workerRow("manual"),
      workerIncarnationId: undefined,
    };
    const mismatched = workerRow("ambiguous");
    const terminal = dispatch("ambiguous", {
      paneId: "pane-other",
    });

    const slots = projectMissionSchedulerWorkerSlots(
      missionId,
      [manual, mismatched],
      [terminal],
    );

    expect(slots.activeDispatchCount).toBe(0);
    expect(slots.unmanagedRows).toEqual([manual, mismatched]);
  });

  it("keeps a suspended physical dispatch occupying capacity", () => {
    const suspended = dispatch("paused", { state: "suspended" });
    const slots = projectMissionSchedulerWorkerSlots(
      missionId,
      [workerRow("paused")],
      [suspended],
    );

    expect(slots.activeDispatchCount).toBe(1);
    expect(slots.unmanagedRows).toEqual([]);
  });
});
