import { describe, expect, it, vi } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { Handoff, Mission } from "../../shared/orch-types";
import { TEAM_READ_ONLY_FANOUT_DOMAIN } from "../../shared/mission-topology";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import {
  findCurrentSchedulerOwnedHandoffDispatch,
  missionHasSchedulerProgress,
  reconcileMissionCompletionAfterSchedulerTick,
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

  it("keeps an unmarked sealed delivery receipt PREVC-owned when wording resembles fan-out", async () => {
    const intent = compileIntentContract({
      goal: "todos os panes me falam o que fazem nesta missão",
      acceptanceCriteria: ["A entrega permanece validada"],
      intentVersion: 7,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      squadId: "nexus-story-impl",
      intentContract: {
        ...intent,
        approvedAt: 1,
        dispatchedAt: 2,
        promotedPlan: {} as never,
      },
      intentState: "executing",
    });
    const runGuidedBridge = vi.fn(async () => undefined);
    const completeLegacy = vi.fn();

    await expect(
      reconcileMissionCompletionAfterSchedulerTick({
        mission: currentMission,
        dispatches: [
          dispatch({
            executionMode: "isolated_worktree",
            ownership: {
              files: ["src"],
              symbols: [],
              domains: ["guided-implementation"],
            },
          }),
        ],
        runGuidedBridge,
        completeLegacy,
      }),
    ).resolves.toBe("guided");
    expect(runGuidedBridge).toHaveBeenCalledOnce();
    expect(completeLegacy).not.toHaveBeenCalled();
  });

  it("completes Wave Pack via legacy when every dispatch carries the pack marker", async () => {
    const intent = compileIntentContract({
      goal: "implementar as stories do plano promovido",
      acceptanceCriteria: ["Stories entregues"],
      intentVersion: 7,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      squadId: "nexus-story-impl",
      intentContract: {
        ...intent,
        approvedAt: 1,
        dispatchedAt: 2,
        promotedPlan: {} as never,
      },
      intentState: "executing",
    });
    const runGuidedBridge = vi.fn(async () => undefined);
    const completeLegacy = vi.fn();

    await expect(
      reconcileMissionCompletionAfterSchedulerTick({
        mission: currentMission,
        dispatches: [
          dispatch({
            executionMode: "isolated_worktree",
            ownership: {
              files: ["src"],
              symbols: [],
              domains: [
                "guided-implementation",
                "wave-pack",
                "wave-pack-story:story-1-1",
              ],
            },
          }),
          dispatch({
            taskId: "task-b",
            executionMode: "isolated_worktree",
            ownership: {
              files: ["src"],
              symbols: [],
              domains: [
                "guided-implementation",
                "wave-pack",
                "wave-pack-story:story-1-2",
              ],
            },
          }),
        ],
        runGuidedBridge,
        completeLegacy,
      }),
    ).resolves.toBe("legacy");
    expect(completeLegacy).toHaveBeenCalledWith(7);
    expect(runGuidedBridge).not.toHaveBeenCalled();
  });

  it("refuses mixed fan-out markers for a saved squad instead of completing as legacy", async () => {
    const intent = compileIntentContract({
      goal: "todos os panes me falam o que fazem nesta missão",
      acceptanceCriteria: ["A topologia selada deve ser homogênea"],
      intentVersion: 7,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      squadId: "saved-mixed-squad",
      intentContract: {
        ...intent,
        approvedAt: 1,
        dispatchedAt: 2,
      },
      intentState: "executing",
    });
    const runGuidedBridge = vi.fn(async () => undefined);
    const completeLegacy = vi.fn();

    await expect(
      reconcileMissionCompletionAfterSchedulerTick({
        mission: currentMission,
        dispatches: [
          dispatch({
            ownership: {
              files: [],
              symbols: [],
              domains: [TEAM_READ_ONLY_FANOUT_DOMAIN],
            },
          }),
          dispatch({
            taskId: "task-b",
            ownership: {
              files: [],
              symbols: [],
              domains: [],
            },
          }),
        ],
        runGuidedBridge,
        completeLegacy,
      }),
    ).resolves.toBe("none");
    expect(runGuidedBridge).not.toHaveBeenCalled();
    expect(completeLegacy).not.toHaveBeenCalled();
  });

  it("routes an all-marker sealed fan-out without reclassifying its goal", async () => {
    const intent = compileIntentContract({
      goal: "Entregar o fluxo guiado normalmente",
      acceptanceCriteria: ["Cada resposta física é consumida"],
      intentVersion: 7,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      squadId: "agentic-guided-fanout",
      intentContract: {
        ...intent,
        approvedAt: 1,
        dispatchedAt: 2,
      },
      intentState: "executing",
    });
    const runGuidedBridge = vi.fn(async () => undefined);
    const completeLegacy = vi.fn();

    await expect(
      reconcileMissionCompletionAfterSchedulerTick({
        mission: currentMission,
        dispatches: [
          dispatch({
            ownership: {
              files: [],
              symbols: [],
              domains: [TEAM_READ_ONLY_FANOUT_DOMAIN],
            },
          }),
          dispatch({
            taskId: "task-b",
            ownership: {
              files: [],
              symbols: [],
              domains: [
                "guided-advisory",
                TEAM_READ_ONLY_FANOUT_DOMAIN,
              ],
            },
          }),
        ],
        runGuidedBridge,
        completeLegacy,
      }),
    ).resolves.toBe("legacy");
    expect(runGuidedBridge).not.toHaveBeenCalled();
    expect(completeLegacy).toHaveBeenCalledOnce();
    expect(completeLegacy).toHaveBeenCalledWith(7);
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
