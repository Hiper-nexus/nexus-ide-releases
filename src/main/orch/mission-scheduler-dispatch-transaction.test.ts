import { describe, expect, it, vi } from "vitest";

import {
  MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX,
  MissionSchedulerCapacityWaitError,
  assertMissionSchedulerPreProviderAuthority,
  captureMissionSchedulerPreProviderAuthority,
  isMissionSchedulerCapacityWait,
  isMissionSchedulerRetryableDispatchError,
  persistMissionSchedulerDispatchFailure,
} from "./mission-scheduler-dispatch-transaction";
import { TASK_DISPATCH_SESSION_EXIT_REASON } from "./task-dispatch-persistence";
import { compileIntentContract } from "../../shared/mission-intent";
import type { Mission, Squad } from "../../shared/orch-types";
import type { PlannedTaskRecord } from "./task-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";

const authoritySquad: Squad = {
  id: "agentic-scheduler-authority",
  name: "Scheduler authority",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "Coordene a missão aprovada.",
  agents: [
    {
      id: "orchestrator",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "codex",
    },
    {
      id: "executor",
      agentName: "Executor",
      category: "executor",
      cli: "codex",
      allowedTools: ["Read", "Edit"],
    },
  ],
};

function schedulerAuthorityFixture(): {
  mission: Mission;
  planned: PlannedTaskRecord;
  squad: Squad;
} {
  const intent = compileIntentContract({
    goal: "Executar sem aguardar o freeze PREVC",
    acceptanceCriteria: ["O merge continua validado pelo Main"],
    intentVersion: 3,
    source: "typed",
    lane: "standard",
  });
  const mission: Mission = {
    id: "mission-scheduler-authority",
    title: "Autoridade do scheduler",
    description: intent.goal,
    status: "running",
    squadId: authoritySquad.id,
    milestones: [],
    learnings: "",
    intentState: "executing",
    intentVersion: 3,
    intentContract: {
      ...intent,
      approvedAt: 10,
      dispatchedAt: 11,
      squadRevisionHash: snapshotSquadAuthority(authoritySquad).hash,
    },
    createdAt: 1,
    updatedAt: 2,
  };
  const planned: PlannedTaskRecord = {
    plannerId: "implementation",
    taskId: "task-scheduler-authority",
    missionId: mission.id,
    intentVersion: 3,
    squadId: authoritySquad.id,
    rosterHash: "a".repeat(64),
    agentRef: "executor",
    agentCategory: "executor",
    agent: authoritySquad.agents[1]!,
    plannedTitle: "Implementar",
    plannedDetail: "Aplicar a correção aprovada.",
    task: {
      id: "task-scheduler-authority",
      missionId: mission.id,
      title: "Implementar",
      detail: "Aplicar a correção aprovada.",
      status: "pending",
      projectId: "project-a",
      checkoutId: "checkout-a",
      createdAt: 1,
      updatedAt: 1,
    },
  };
  return { mission, planned, squad: authoritySquad };
}

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
  it("captures guided dispatch authority without requiring a PREVC workflow", () => {
    const fixture = schedulerAuthorityFixture();

    const authority = captureMissionSchedulerPreProviderAuthority(fixture);

    expect(authority).toMatchObject({
      missionId: fixture.mission.id,
      intentVersion: 3,
      taskId: fixture.planned.taskId,
      squadRevisionHash: fixture.mission.intentContract?.squadRevisionHash,
    });
    expect(() =>
      assertMissionSchedulerPreProviderAuthority({
        expected: authority,
        ...fixture,
      }),
    ).not.toThrow();
  });

  it("rejects intent, plan and squad drift across asynchronous preparation", () => {
    const fixture = schedulerAuthorityFixture();
    const expected = captureMissionSchedulerPreProviderAuthority(fixture);
    const changedIntent: Mission = {
      ...fixture.mission,
      intentContract: {
        ...fixture.mission.intentContract!,
        goal: "Objetivo alterado depois da aprovação",
      },
    };
    const changedPlan: PlannedTaskRecord = {
      ...fixture.planned,
      plannedTitle: "Plano substituído",
      task: {
        ...fixture.planned.task,
        title: "Plano substituído",
      },
    };
    const changedSquad: Squad = {
      ...fixture.squad,
      orchestratorInstructions: "Instruções alteradas depois da aprovação.",
    };

    expect(() =>
      assertMissionSchedulerPreProviderAuthority({
        expected,
        mission: changedIntent,
        planned: fixture.planned,
        squad: fixture.squad,
      }),
    ).toThrow(/intent authority changed/i);
    expect(() =>
      assertMissionSchedulerPreProviderAuthority({
        expected,
        mission: fixture.mission,
        planned: changedPlan,
        squad: fixture.squad,
      }),
    ).toThrow(/plan authority changed/i);
    expect(() =>
      assertMissionSchedulerPreProviderAuthority({
        expected,
        mission: fixture.mission,
        planned: fixture.planned,
        squad: changedSquad,
      }),
    ).toThrow(/squad changed after mission approval/i);
  });

  it("keeps sealed intent authority stable while runtime spend is recorded", () => {
    const fixture = schedulerAuthorityFixture();
    const expected = captureMissionSchedulerPreProviderAuthority(fixture);
    const withRuntimeLedger: Mission = {
      ...fixture.mission,
      intentContract: {
        ...fixture.mission.intentContract!,
        spentSteps: (fixture.mission.intentContract?.spentSteps ?? 0) + 1,
        spentTokens: (fixture.mission.intentContract?.spentTokens ?? 0) + 200,
      },
    };

    expect(() =>
      assertMissionSchedulerPreProviderAuthority({
        expected,
        mission: withRuntimeLedger,
        planned: fixture.planned,
        squad: fixture.squad,
      }),
    ).not.toThrow();
  });

  it("classifies capacity and transient provider bootstrap failures as retryable", () => {
    expect(
      isMissionSchedulerCapacityWait(
        new MissionSchedulerCapacityWaitError(
          "maxWorkers=1 is already reserved",
        ),
      ),
    ).toBe(true);
    expect(
      isMissionSchedulerCapacityWait(
        new Error("maxWorkers=1 já está reservado por dispatches duráveis"),
      ),
    ).toBe(true);
    expect(
      isMissionSchedulerCapacityWait(new Error("worker spawn failed")),
    ).toBe(false);
    expect(
      isMissionSchedulerRetryableDispatchError(
        new Error("worker spawn failed"),
      ),
    ).toBe(true);
    const corruption = new Error("dispatch database is corrupt");
    corruption.name = "ScopedStoreCorruptionError";
    expect(isMissionSchedulerRetryableDispatchError(corruption)).toBe(false);
  });

  it("refines the exact generic exit block with the real bootstrap cause", () => {
    const current = blockedBootstrapSnapshot();
    const refineBootstrapSessionExitBlock = vi.fn();
    const fail = vi.fn();
    const store = {
      get: vi.fn(() => current),
      refineBootstrapSessionExitBlock,
      failSupersededBootstrap: vi.fn(),
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

  it("does not persist the blocked-state authority error when session exit won", () => {
    const current = blockedBootstrapSnapshot();
    const refineBootstrapSessionExitBlock = vi.fn();

    expect(
      persistMissionSchedulerDispatchFailure({
        store: {
          get: () => current,
          refineBootstrapSessionExitBlock,
          failSupersededBootstrap: vi.fn(),
          fail: vi.fn(),
        },
        missionId: "mission-bootstrap",
        taskId: "task-bootstrap",
        leaseToken: "lease-bootstrap",
        paneId: current.paneId,
        sessionId: current.sessionId,
        workerIncarnationId: current.workerIncarnationId,
        error: new Error(
          "dispatch sem autoridade de efeito no estado blocked",
        ),
      }),
    ).toBe("refined");

    expect(refineBootstrapSessionExitBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        error:
          `${MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX} ` +
          "agent session exited during boot before prompt acceptance",
      }),
    );
  });

  it("terminalizes the exact superseded bootstrap when the catch proves a terminal cause", () => {
    const current = blockedBootstrapSnapshot({ state: "superseded" });
    const failSupersededBootstrap = vi.fn();
    const fail = vi.fn();

    expect(
      persistMissionSchedulerDispatchFailure({
        store: {
          get: () => current,
          refineBootstrapSessionExitBlock: vi.fn(),
          failSupersededBootstrap,
          fail,
        },
        missionId: "mission-bootstrap",
        taskId: "task-bootstrap",
        leaseToken: "lease-bootstrap",
        paneId: current.paneId,
        sessionId: current.sessionId,
        workerIncarnationId: current.workerIncarnationId,
        error: new Error(
          "scheduler dispatch plan authority changed before provider effect",
        ),
      }),
    ).toBe("failed");

    expect(failSupersededBootstrap).toHaveBeenCalledWith({
      taskId: "task-bootstrap",
      missionId: "mission-bootstrap",
      leaseToken: "lease-bootstrap",
      paneId: current.paneId,
      sessionId: current.sessionId,
      workerIncarnationId: current.workerIncarnationId,
      error:
        `${MISSION_SCHEDULER_BOOTSTRAP_FAILURE_PREFIX} ` +
        "scheduler dispatch plan authority changed before provider effect",
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
          failSupersededBootstrap: vi.fn(),
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
            failSupersededBootstrap: vi.fn(),
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
          failSupersededBootstrap: vi.fn(),
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
