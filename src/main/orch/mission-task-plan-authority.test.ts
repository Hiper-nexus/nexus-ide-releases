import { describe, expect, it, vi } from "vitest";
import type { Squad } from "../../shared/orch-types";
import type { AdapterInfo } from "../../shared/adapter-types";
import { compileIntentContract } from "../../shared/mission-intent";
import type { AgentGateContext } from "./gate";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import { plannedTaskId } from "./task-store";
import {
  planMissionTasks,
  sealMainOwnedMissionTaskPlan,
  type MissionTaskPlanAuthorityDeps,
} from "./mission-task-plan-authority";
import { testProjectScope } from "./__tests__/scope-fixture";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";

const scope = testProjectScope();

function adapterInfo(
  id: string,
  overrides: Partial<AdapterInfo> = {},
): AdapterInfo {
  const codex = id === "codex";
  return {
    id,
    kind: "cli-pty",
    label: id,
    icon: "",
    models: { list: [`${id}-model`], default: `${id}-model` },
    installed: true,
    installCommand: "",
    idleTimeoutMs: 800,
    orchestratorCapable: codex,
    taskHandoffCapable: true,
    autonomousWorkspaceWriteCapable: codex,
    orchestrationEvidence: codex ? "verified" : "unsupported",
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: codex,
      governedWriter: codex,
      verifiedMaestro: codex,
    },
    ...overrides,
  };
}

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
      cli: "codex",
    },
    {
      id: "architect",
      agentName: "Architect",
      category: "architect",
      cli: "codex",
    },
    {
      id: "claude-reviewer",
      agentName: "Claude Reviewer",
      category: "reviewer",
      cli: "claude",
    },
    {
      id: "opencode-scout",
      agentName: "OpenCode Scout",
      category: "scout",
      cli: "opencode",
    },
    {
      id: "glm-scout",
      agentName: "GLM Scout",
      category: "scout",
      cli: "glm",
    },
    {
      id: "custom-reviewer",
      agentName: "Custom Reviewer",
      category: "reviewer",
      cli: "custom-cli",
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
    adapterOverrides?: Readonly<Record<string, AdapterInfo>>;
    squadCliPolicy?: "governed" | "operator-choice";
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
    getAdapterInfo: vi.fn(
      (adapterId) =>
        options.adapterOverrides?.[adapterId] ?? adapterInfo(adapterId),
    ),
    listMissionWorktrees: vi.fn(() => options.worktrees ?? []),
    squadCliPolicy: () => options.squadCliPolicy ?? "operator-choice",
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
  it("lets trusted main seal the approved plan before an orchestrator session exists", () => {
    const contract = compileIntentContract({
      goal: "Executar antes do bootstrap físico",
      intentVersion: 7,
    });
    const mission = {
      id: "mission-a",
      status: "pending",
      description: contract.goal,
      intentState: "ready_to_start",
      intentVersion: 7,
      orchestratorSessionId: undefined,
      squadId: squad.id,
      intentContract: {
        ...contract,
        approvedAt: 1,
        approvalReviewSha256: "a".repeat(64),
        dispatchedAt: undefined,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
      },
    };
    const { suite, deps, createPlanAtomically } = harness({ mission });

    const result = sealMainOwnedMissionTaskPlan(
      { missionId: "mission-a", tasks: [validTask] },
      scope,
      suite,
      deps,
      {
        kind: "approved-preflight",
        intentVersion: 7,
        approvedAt: 1,
        approvalReviewSha256: "a".repeat(64),
      },
    );

    expect(createPlanAtomically).toHaveBeenCalledOnce();
    expect(result.planned[0]).toMatchObject({
      plannerId: "build",
      agentRef: "builder",
      executionMode: "isolated_worktree",
    });
  });

  it("does not let an ordinary caller seal a merely approved pending mission", () => {
    const contract = compileIntentContract({
      goal: "Não despachar antes do receipt",
      intentVersion: 7,
    });
    const pendingMission = {
      id: "mission-a",
      status: "pending",
      description: contract.goal,
      intentState: "ready_to_start",
      intentVersion: 7,
      orchestratorSessionId: undefined,
      squadId: squad.id,
      intentContract: {
        ...contract,
        approvedAt: 1,
        dispatchedAt: undefined,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
      },
    };
    const { suite, deps, createPlanAtomically } = harness({
      mission: pendingMission,
    });

    expect(() =>
      sealMainOwnedMissionTaskPlan(
        { missionId: "mission-a", tasks: [validTask] },
        scope,
        suite,
        deps,
      ),
    ).toThrow(/exact main-owned approved preflight/i);
    expect(createPlanAtomically).not.toHaveBeenCalled();
  });

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

  it("keeps non-qualified writers behind the explicit Hardened policy", () => {
    const { suite, deps, createPlanAtomically } = harness({
      squadCliPolicy: "governed",
    });
    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [
            {
              ...validTask,
              agentRef: "glm-scout",
              category: "scout",
              executionMode: "isolated_worktree",
            },
          ],
        },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).toThrow(/governed writer/);
    expect(createPlanAtomically).not.toHaveBeenCalled();
  });

  it("allows a broad greenfield envelope in Autopilot but keeps Hardened partitioned", () => {
    const greenfieldTask = {
      ...validTask,
      ownership: {
        ...validTask.ownership,
        files: Array.from(
          { length: 24 },
          (_, index) => `greenfield-root-${index}/entry.ts`,
        ),
      },
    };
    const autopilot = harness({ squadCliPolicy: "operator-choice" });
    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [greenfieldTask] },
        orchestratorContext(),
        autopilot.suite,
        autopilot.deps,
      ),
    ).not.toThrow();
    expect(autopilot.createPlanAtomically).toHaveBeenCalledOnce();

    const hardened = harness({ squadCliPolicy: "governed" });
    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [greenfieldTask] },
        orchestratorContext(),
        hardened.suite,
        hardened.deps,
      ),
    ).toThrow(/ownership\.files looks repo-wide/i);
    expect(hardened.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("lets an authenticated autopilot CLI own its isolated worktree", () => {
    const { suite, deps, createPlanAtomically } = harness();
    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [
            {
              ...validTask,
              agentRef: "glm-scout",
              category: "scout",
              executionMode: "isolated_worktree",
            },
          ],
        },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).not.toThrow();
    expect(createPlanAtomically).toHaveBeenCalledOnce();
  });

  it("admits a read_only advisor on a CLI with no native confinement", () => {
    // The boundary for these CLIs is the Nexus kernel sandbox, applied at
    // spawn (advisory-process-sandbox), not a profile the provider ships. Any
    // CLI the operator installs is advisory the moment its adapter exists —
    // there is no allowlist to extend.
    const { suite, deps } = harness();

    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [
            {
              ...validTask,
              agentRef: "glm-scout",
              category: "scout",
              executionMode: "read_only",
              ownership: undefined,
            },
          ],
        },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).not.toThrow();
  });

  it.each([
    ["executor", "builder"],
    ["reviewer", "reviewer"],
    ["architect", "architect"],
  ] as const)(
    "allows a mechanically confined %s to contribute through read_only",
    (category, agentRef) => {
      const { suite, deps, createPlanAtomically } = harness();

      expect(() =>
        planMissionTasks(
          {
            missionId: "mission-a",
            tasks: [
              {
                ...validTask,
                agentRef,
                category,
                executionMode: "read_only",
                ownership: {
                  files: ["src"],
                  symbols: [],
                  domains: ["guided-advisory"],
                },
              },
            ],
          },
          orchestratorContext(),
          suite,
          deps,
        ),
      ).not.toThrow();
      expect(createPlanAtomically).toHaveBeenCalledOnce();
    },
  );

  it("allows an advisory MCP-only CLI to join read_only scout/reviewer tasks", () => {
    const { suite, deps, createPlanAtomically } = harness();

    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [
            {
              ...validTask,
              agentRef: "opencode-scout",
              category: "scout",
              executionMode: "read_only",
              ownership: {
                files: ["src"],
                symbols: [],
                domains: ["guided-advisory"],
              },
            },
          ],
        },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).not.toThrow();
    expect(createPlanAtomically).toHaveBeenCalledOnce();
  });

  it("accepts a custom handoff reviewer in operator-choice and keeps Hardened confined", () => {
    const task = {
      ...validTask,
      agentRef: "custom-reviewer",
      category: "reviewer" as const,
      executionMode: "read_only" as const,
    };
    const open = harness({ squadCliPolicy: "operator-choice" });
    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [task] },
        orchestratorContext(),
        open.suite,
        open.deps,
      ),
    ).not.toThrow();
    expect(open.createPlanAtomically).toHaveBeenCalledOnce();

    const hardened = harness({ squadCliPolicy: "governed" });
    expect(() =>
      planMissionTasks(
        { missionId: "mission-a", tasks: [task] },
        orchestratorContext(),
        hardened.suite,
        hardened.deps,
      ),
    ).toThrow(/mechanically confined|release-enabled/i);
    expect(hardened.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("keeps reserveClaude when the squad orchestrator is Claude", () => {
    const { suite, deps, createPlanAtomically } = harness();

    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [
            {
              ...validTask,
              agentRef: "claude-reviewer",
              category: "reviewer",
              executionMode: "read_only",
            },
          ],
        },
        orchestratorContext(),
        suite,
        deps,
      ),
    ).toThrow(/reserveClaude/);
    expect(createPlanAtomically).not.toHaveBeenCalled();
  });

  it("allows a read-only-only qualification only for reviewer/scout tasks", () => {
    const readOnlyCodex = adapterInfo("codex", {
      autonomousWorkspaceWriteCapable: false,
      capabilities: {
        launchable: true,
        promptInjectable: true,
        statusObservable: true,
        resumable: true,
        autonomousReadOnly: true,
        governedWriter: false,
        verifiedMaestro: false,
      },
    });
    const options = {
      adapterOverrides: { codex: readOnlyCodex },
      squadCliPolicy: "governed" as const,
    } as const;

    const accepted = harness(options);
    expect(() =>
      planMissionTasks(
        {
          missionId: "mission-a",
          tasks: [{
            ...validTask,
            agentRef: "reviewer",
            category: "reviewer",
            executionMode: "read_only",
          }],
        },
        orchestratorContext(),
        accepted.suite,
        accepted.deps,
      ),
    ).not.toThrow();
    expect(accepted.createPlanAtomically).toHaveBeenCalledOnce();

    for (const task of [
      { ...validTask, executionMode: "read_only" },
      { ...validTask, executionMode: "isolated_worktree" },
    ]) {
      const rejected = harness(options);
      expect(() =>
        planMissionTasks(
          { missionId: "mission-a", tasks: [task] },
          orchestratorContext(),
          rejected.suite,
          rejected.deps,
        ),
      ).toThrow(/reviewer\/scout|governed writer/i);
      expect(rejected.createPlanAtomically).not.toHaveBeenCalled();
    }
  });

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
