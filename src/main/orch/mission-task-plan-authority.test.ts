import { describe, expect, it, vi } from "vitest";
import type { Squad } from "../../shared/orch-types";
import { compileIntentContract } from "../../shared/mission-intent";
import type { AgentGateContext } from "./gate";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import { plannedTaskId } from "./task-store";
import {
  planMissionTasks,
  type MissionTaskPlanAuthorityDeps,
} from "./mission-task-plan-authority";
import { testProjectScope } from "./__tests__/scope-fixture";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";

const scope = testProjectScope();

const squad: Squad = {
  id: "squad-a",
  name: "Squad A",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "",
  agents: [
    {
      id: "maestro",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "claude",
    },
    {
      id: "builder",
      agentName: "Builder",
      category: "executor",
      cli: "codex",
    },
    {
      id: "reviewer",
      agentName: "Reviewer",
      category: "reviewer",
      cli: "glm",
    },
    {
      id: "claude-reviewer",
      agentName: "Claude Reviewer",
      category: "reviewer",
      cli: "claude",
    },
    {
      id: "omp-scout",
      agentName: "OMP Scout",
      category: "scout",
      cli: "omp",
    },
  ],
};

function orchestratorContext(
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return {
    token: "token",
    label: "Maestro",
    role: "orchestrator",
    sessionId: "session-a",
    missionId: "mission-a",
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function harness(
  options: {
    mission?: Record<string, unknown> | null;
    worktrees?: readonly unknown[];
    liveSquad?: Squad;
  } = {},
) {
  const createPlanAtomically = vi.fn(
    (input: {
      missionId: string;
      intentVersion: number;
      rows: readonly { plannerId: string; title: string; detail: string }[];
    }) =>
      input.rows.map((row, index) => ({
        id: plannedTaskId(input.missionId, input.intentVersion, row.plannerId),
        missionId: input.missionId,
        title: row.title,
        detail: row.detail,
        status: "pending" as const,
        createdAt: index + 1,
        updatedAt: index + 1,
        projectId: scope.projectId,
        checkoutId: scope.checkoutId,
      })),
  );
  const suite = {
    missions: {
      get: vi.fn(() =>
        options.mission === null
          ? null
          : (options.mission ?? (() => {
              const contract = compileIntentContract({
                goal: "Executar plano selado",
                intentVersion: 7,
              });
              return {
              id: "mission-a",
              status: "running",
              description: contract.goal,
              intentState: "dispatched",
              intentVersion: 7,
              orchestratorSessionId: "session-a",
              squadId: squad.id,
              intentContract: {
                ...contract,
                approvedAt: 1,
                dispatchedAt: 1,
                squadRevisionHash: snapshotSquadAuthority(squad).hash,
              },
            };
          })()),
      ),
    },
    tasks: { createPlanAtomically },
  } as unknown as Pick<ProjectDomainStoreSuite, "missions" | "tasks">;
  const deps: MissionTaskPlanAuthorityDeps = {
    getSquad: vi.fn(() => options.liveSquad ?? squad),
    listMissionWorktrees: vi.fn(() => options.worktrees ?? []),
  };
  return { suite, deps, createPlanAtomically };
}

const validTask = {
  id: "build",
  title: "Build",
  detail: "Implement the change",
  agentRef: "Builder",
  category: "executor",
  executionMode: "isolated_worktree",
  ownership: {
    files: ["src/build.ts"],
    symbols: ["build"],
    domains: ["backend"],
  },
};

describe("mission task plan authority", () => {
  it("resolves the sticky roster, seals deterministic ids and returns the store response", () => {
    const { suite, deps, createPlanAtomically } = harness();
    const result = planMissionTasks(
      {
        action: "plan",
        missionId: "mission-a",
        tasks: [
          validTask,
          {
            id: "review",
            title: "Review",
            agentRef: "reviewer",
            category: "reviewer",
            executionMode: "read_only",
            ownership: { files: [], symbols: [], domains: ["review"] },
            dependsOn: ["build"],
          },
        ],
      },
      orchestratorContext(),
      suite,
      deps,
    );

    expect(createPlanAtomically).toHaveBeenCalledOnce();
    expect(createPlanAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-a",
        intentVersion: 7,
        squad: { id: squad.id, agents: squad.agents },
        rows: [
          expect.objectContaining({
            plannerId: "build",
            agentRef: "builder",
            agentCategory: "executor",
          }),
          expect.objectContaining({
            plannerId: "review",
            agentRef: "reviewer",
            agentCategory: "reviewer",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      missionId: "mission-a",
      planned: [
        {
          plannerId: "build",
          taskId: plannedTaskId("mission-a", 7, "build"),
          agentRef: "builder",
          category: "executor",
          executionMode: "isolated_worktree",
        },
        {
          plannerId: "review",
          taskId: plannedTaskId("mission-a", 7, "review"),
          dependsOn: [plannedTaskId("mission-a", 7, "build")],
          agentRef: "reviewer",
          category: "reviewer",
          executionMode: "read_only",
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.planned[0])).toBe(true);
  });

  it("checks orchestrator authority before consulting mutable plan state", () => {
    const { suite, deps } = harness();
    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [validTask] },
        orchestratorContext({ role: "worker" }),
        suite,
        deps,
      ),
    ).toThrow("only an orchestrator can plan mission tasks");
    expect(deps.listMissionWorktrees).not.toHaveBeenCalled();
    expect(deps.getSquad).not.toHaveBeenCalled();
  });

  it("rejects a stale orchestrator session before sealing the task plan", () => {
    const { suite, deps, createPlanAtomically } = harness();
    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [validTask] },
        orchestratorContext({ sessionId: "session-stale" }),
        suite,
        deps,
      ),
    ).toThrow(/orchestrator_session_stale/);
    expect(createPlanAtomically).not.toHaveBeenCalled();
    expect(deps.getSquad).not.toHaveBeenCalled();
  });

  it("does not reseal a mission after its first worktree allocation", () => {
    const { suite, deps, createPlanAtomically } = harness({
      worktrees: [{ taskId: "existing" }],
    });
    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [validTask] },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).toThrow(
      "mission task plan is sealed after the first worktree allocation",
    );
    expect(createPlanAtomically).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...validTask, agentRef: "" }, /requires agentRef from the saved squad/],
    [
      { ...validTask, category: "reviewer" },
      /category does not match roster agent builder/,
    ],
    [
      {
        ...validTask,
        agentRef: "claude-reviewer",
        category: "reviewer",
      },
      /reserveClaude/,
    ],
    [
      { ...validTask, ownership: { files: [] } },
      /isolated_worktree requires explicit ownership\.files/,
    ],
    [
      { ...validTask, executionMode: "read_only" },
      /read_only is restricted to scout\/reviewer/,
    ],
    [
      {
        ...validTask,
        agentRef: "omp-scout",
        category: "scout",
        executionMode: "read_only",
      },
      /read_only requires a mechanically confined CLI/,
    ],
  ])(
    "rejects an invalid roster/execution row without persisting it",
    (task, error) => {
      const { suite, deps, createPlanAtomically } = harness();
      expect(() =>
        planMissionTasks(
          { missionId: "mission-a", tasks: [task] },
          orchestratorContext(),
          suite,
          deps,
        ),
      ).toThrow(error);
      expect(createPlanAtomically).not.toHaveBeenCalled();
    },
  );

  it("requires a closed dependency graph before the atomic store call", () => {
    const { suite, deps, createPlanAtomically } = harness();
    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [{ ...validTask, dependsOn: ["outside-receipt"] }],
        },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).toThrow(/depends on unknown task outside-receipt/);
    expect(createPlanAtomically).not.toHaveBeenCalled();
  });

  it("enforces the exact one-worker target sealed by a scheduled mission", () => {
    const baseContract = compileIntentContract({
      goal: "Executar job agendado com o worker selado",
      intentVersion: 7,
    });
    const mission = {
      id: "mission-a",
      status: "running",
      description: baseContract.goal,
      intentState: "dispatched",
      intentVersion: 7,
      squadId: squad.id,
      intentContract: {
        ...baseContract,
        approvedAt: 1,
        dispatchedAt: 1,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
        requiredWorkerAgentRef: "builder",
      },
    };
    const { suite, deps, createPlanAtomically } = harness({ mission });

    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [
            { ...validTask, agentRef: "reviewer", category: "reviewer" },
          ],
        },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).toThrow(/scheduled.*exact.*builder/i);
    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [
            validTask,
            {
              ...validTask,
              id: "second",
              title: "Second",
              ownership: { ...validTask.ownership, files: ["src/second.ts"] },
            },
          ],
        },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).toThrow(/scheduled.*single task/i);
    expect(createPlanAtomically).not.toHaveBeenCalled();

    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [validTask] },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).not.toThrow();
    expect(createPlanAtomically).toHaveBeenCalledOnce();
  });

  it("rejeita roster alterado depois da aprovação sem criar tasks", () => {
    const changedSquad: Squad = {
      ...squad,
      agents: squad.agents.map((agent) =>
        agent.id === "builder" ? { ...agent, cli: "glm" } : agent,
      ),
    };
    const { suite, deps, createPlanAtomically } = harness({
      liveSquad: changedSquad,
    });

    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [validTask] },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).toThrow(/saved squad changed.*reapprove/i);
    expect(createPlanAtomically).not.toHaveBeenCalled();
  });
});
