import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterInfo } from "../../shared/adapter-types";
import type { Handoff, Mission, Squad } from "../../shared/orch-types";
import { compileIntentContract } from "../../shared/mission-intent";
import {
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_RESULT_FILE,
  createRealMissionE2ESquadFixture,
} from "../../shared/real-mission-e2e";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  decodeTaskScheduleDetail,
  encodeTaskScheduleDetail,
} from "./mission-scheduler-meta";
import { finalizeGuidedNoChangeQualityGate } from "./mission-scheduler-production";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import { plannedTaskId, snapshotTaskPlanRoster } from "./task-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import {
  ensureGuidedMissionPlan,
  approvedIntentRequiresReadOnlyQualityGate,
  guidedLiveRosterAdapter,
  GUIDED_GREENFIELD_OWNERSHIP,
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
  listRepositoryOwnershipClaims,
  repositoryOwnershipClaimsFromGitTree,
  type GuidedMissionPlannerDeps,
} from "./guided-mission-planner";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import {
  WorktreeManager,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "../runtime/worktree-manager";
import { enforceOwnershipOnDiff } from "./mission-scheduler";
import type { GitRunOptions, GitRunner } from "../runtime/git-command";
import { selectPhysicalPlanHandoff } from "./plan-promotion-authority";

const scope = testProjectScope({ rootRealPath: "/workspace/guided" });

class MemoryWorktreeStateStore implements WorktreeStateStore {
  readonly #states = new Map<string, WorktreeStateSnapshot>();

  read(scopeKey: string): WorktreeStateSnapshot {
    return this.#states.get(scopeKey) ?? { revision: 0, records: [] };
  }

  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean {
    const current = this.read(scopeKey);
    if (current.revision !== expectedRevision) return false;
    this.#states.set(scopeKey, {
      revision: current.revision + 1,
      records: structuredClone(records),
    });
    return true;
  }
}

const squad: Squad = {
  id: "agentic-guided-squad",
  name: "Guided squad",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "Coordene pelo Nexus.",
  agents: [
    {
      id: "orch",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "claude",
    },
    {
      id: "frontend",
      agentName: "Frontend",
      category: "executor",
      cli: "codex",
      effort: "medium",
    },
    {
      id: "generalist",
      agentName: "Generalist (omp)",
      category: "executor",
      cli: "codex",
      effort: "medium",
    },
    {
      id: "qa",
      agentName: "QA de execução",
      category: "reviewer",
      cli: "codex",
      effort: "high",
    },
    {
      id: "reviewer",
      agentName: "Revisor sênior",
      category: "reviewer",
      cli: "codex",
      effort: "high",
    },
  ],
};

function mission(overrides: Partial<Mission> = {}): Mission {
  const base = compileIntentContract({
    goal: "Implemente a entrega aprovada com testes reais",
    acceptanceCriteria: ["Código pronto", "Testes relevantes verdes"],
    intentVersion: 3,
    source: "typed",
    lane: "standard",
  });
  return {
    id: "mission-guided",
    title: "Entrega guiada",
    description: base.goal,
    status: "running",
    squadId: squad.id,
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion: 3,
    intentContract: {
      ...base,
      approvedAt: 10,
      dispatchedAt: 10,
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function squadWithAgentCli(agentId: string, cli: string): Squad {
  return {
    ...squad,
    agents: squad.agents.map((agent) =>
      agent.id === agentId ? { ...agent, cli } : agent,
    ),
  };
}

function missionForSquad(liveSquad: Squad): Mission {
  const current = mission();
  return {
    ...current,
    intentContract: {
      ...current.intentContract!,
      squadRevisionHash: snapshotSquadAuthority(liveSquad).hash,
    },
  };
}

function denseUiMission(): Mission {
  const goal = ("Melhorar a interface React " + "g".repeat(20_000)).slice(
    0,
    16_384,
  );
  const contract = compileIntentContract({
    goal,
    acceptanceCriteria: Array.from({ length: 21 }, () => "c".repeat(2_048)),
    intentVersion: 3,
    source: "typed",
    lane: "standard",
  });
  return mission({
    description: goal,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 10,
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
    },
  });
}

function liveAdapter(
  id: string,
  installed = true,
): ReturnType<GuidedMissionPlannerDeps["listLiveAdapters"]>[number] {
  return {
    id,
    installed,
    models: {
      list: [`${id}-default`],
      default: `${id}-default`,
    },
  };
}

function adapterInfo(id: string): AdapterInfo {
  const codex = id === "codex";
  // Espelha o registry de produção: codex (caso especial), grok (Seatbelt
  // `--sandbox read-only`) e claude (argv governado) têm confinamento nativo
  // read-only enforceável; kimi/agy/opencode/omp seguem a rota advisory.
  const nativeReadOnly = codex || id === "grok" || id === "claude";
  return {
    id,
    kind: "cli-pty",
    label: id,
    icon: "",
    models: { list: [`${id}-default`], default: `${id}-default` },
    installed: true,
    installCommand: "",
    idleTimeoutMs: 800,
    orchestratorCapable: codex,
    autonomousWorkspaceWriteCapable: codex,
    orchestrationEvidence: codex ? "verified" : "unsupported",
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: nativeReadOnly,
      governedWriter: codex,
      verifiedMaestro: codex,
    },
  };
}

function providerBackedLiveAdapter(
  adapterId: string,
  overrides: Partial<
    Omit<Parameters<typeof guidedLiveRosterAdapter>[0]["provider"], "adapterId">
  > = {},
  accountAvailable = true,
): ReturnType<GuidedMissionPlannerDeps["listLiveAdapters"]>[number] {
  const defaultModel = overrides.defaultModel ?? `${adapterId}-default`;
  return guidedLiveRosterAdapter({
    provider: {
      adapterId,
      enabled: true,
      installed: true,
      authStrategy: "subscription",
      models: [defaultModel],
      defaultModel,
      ...overrides,
    },
    accountAvailable,
  });
}

function harness(
  options: {
    currentMission?: Mission;
    liveSquad?: Squad;
    adapters?: readonly ReturnType<
      GuidedMissionPlannerDeps["listLiveAdapters"]
    >[number][];
    existing?: readonly Record<string, unknown>[];
  } = {},
) {
  const currentMission = options.currentMission ?? mission();
  const createPlanAtomically = vi.fn(
    (input: {
      missionId: string;
      intentVersion: number;
      rows: readonly {
        plannerId: string;
        title: string;
        detail: string;
        agentRef: string;
        agentCategory: "executor" | "reviewer" | "scout" | "architect";
      }[];
    }) =>
      input.rows.map((row, index) => ({
        id: plannedTaskId(input.missionId, input.intentVersion, row.plannerId),
        missionId: input.missionId,
        title: row.title,
        detail: row.detail,
        status: "pending" as const,
        createdAt: index + 1,
        updatedAt: index + 1,
        ...scope,
      })),
  );
  const listPlannedTasks = vi.fn(() => options.existing ?? []);
  const suite = {
    missions: { get: vi.fn(() => currentMission) },
    tasks: {
      scope,
      listPlannedTasks,
      createPlanAtomically,
    },
  } as unknown as Pick<ProjectDomainStoreSuite, "missions" | "tasks">;
  const deps: GuidedMissionPlannerDeps = {
    getSquad: vi.fn(() => options.liveSquad ?? squad),
    getAdapterInfo: vi.fn((adapterId) => adapterInfo(adapterId)),
    listMissionWorktrees: vi.fn(() => []),
    listLiveAdapters: vi.fn(
      () =>
        options.adapters ?? [
          liveAdapter("codex"),
          liveAdapter("omp"),
          liveAdapter("glm"),
          liveAdapter("claude"),
        ],
    ),
    listRepositoryOwnership: vi.fn(() => ["package.json", "src", "tests"]),
    assertStandardSquadReadiness: vi.fn(),
  };
  return {
    suite,
    deps,
    createPlanAtomically,
    listPlannedTasks,
  };
}

function sealedGuidedV2Receipt() {
  const firstPass = harness();
  ensureGuidedMissionPlan(firstPass.suite, "mission-guided", firstPass.deps);
  const rows = firstPass.createPlanAtomically.mock.calls[0]![0].rows;
  const rosterHash = snapshotTaskPlanRoster(squad.agents).hash;
  return rows.map((row, index) => {
    const taskId = plannedTaskId("mission-guided", 3, row.plannerId);
    const task = {
      id: taskId,
      missionId: "mission-guided",
      title: row.title,
      detail: row.detail,
      status: "pending" as const,
      createdAt: index + 1,
      updatedAt: index + 1,
      ...scope,
    };
    return {
      plannerId: row.plannerId,
      taskId,
      missionId: "mission-guided",
      intentVersion: 3,
      squadId: squad.id,
      rosterHash,
      agentRef: row.agentRef,
      agentCategory: row.agentCategory,
      agent: squad.agents.find((agent) => agent.id === row.agentRef)!,
      plannedTitle: row.title,
      plannedDetail: row.detail,
      task,
    };
  });
}

describe("Guided Planner v2", () => {
  it("adds the exact approved greenfield artifact without opening unrelated files", () => {
    const contract = compileIntentContract({
      goal: REAL_MISSION_E2E_GOAL,
      acceptanceCriteria: [
        ...REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
      ],
      intentVersion: 3,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      description: contract.goal,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
      },
    });
    const h = harness({ currentMission });

    expect(
      ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    const implementation = h.createPlanAtomically.mock.calls[0]![0].rows.find(
      (row) => row.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    if (!implementation) throw new Error("missing guided implementation");
    const ownership =
      decodeTaskScheduleDetail(implementation.detail).meta?.ownership;
    if (!ownership) throw new Error("missing guided ownership");

    expect(ownership.files).toContain(REAL_MISSION_E2E_RESULT_FILE);
    expect(
      enforceOwnershipOnDiff([REAL_MISSION_E2E_RESULT_FILE], ownership),
    ).toMatchObject({ ok: true, undeclaredFiles: [] });
    expect(
      enforceOwnershipOnDiff(["unrelated.txt"], ownership),
    ).toMatchObject({
      ok: false,
      undeclaredFiles: ["unrelated.txt"],
    });
    expect(ownership.files).not.toContain("unrelated.txt");
    expect(ownership.files).not.toContain("**");
  });

  it("seals the schema-v9 multi-CLI advisory fan-out around the codex chain", () => {
    const liveSquad = createRealMissionE2ESquadFixture();
    const contract = compileIntentContract({
      goal: REAL_MISSION_E2E_GOAL,
      acceptanceCriteria: [
        ...REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
      ],
      intentVersion: 3,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      squadId: liveSquad.id,
      description: contract.goal,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
        squadRevisionHash: snapshotSquadAuthority(liveSquad).hash,
      },
    });
    const h = harness({
      currentMission,
      liveSquad,
      adapters: [
        liveAdapter("codex"),
        // grok/agy chegam ao roster com o model default do produto selado.
        {
          id: "grok",
          installed: true,
          models: { list: ["grok-4.5"], default: "grok-4.5" },
        },
        liveAdapter("kimi"),
        {
          id: "agy",
          installed: true,
          models: {
            list: ["gemini-3.6-flash-high"],
            default: "gemini-3.6-flash-high",
          },
        },
        liveAdapter("opencode"),
        liveAdapter("omp"),
        liveAdapter("claude"),
      ],
    });

    expect(
      ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const schedules = rows.map((row) => ({
      plannerId: row.plannerId,
      ...decodeTaskScheduleDetail(row.detail).meta!,
    }));

    // Fan-out consultivo: scouts advisor (read_only) → executor codex →
    // revisor codex → reviewers advisor (read_only) → QA codex read_only.
    const advisoryIds = [
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-omp",
    ];
    const reviewIds = [
      "e2e-reviewer",
      "e2e-advisor-grok",
      "e2e-advisor-claude",
    ];
    expect(schedules).toEqual([
      ...advisoryIds.map((agentRef, index) =>
        expect.objectContaining({
          plannerId: `guided-advisory-${index + 1}-${agentRef}`,
          agentRef,
          agentCategory: "scout",
          executionMode: "read_only",
          dependsOn:
            index === 0
              ? []
              : [
                  plannedTaskId(
                    currentMission.id,
                    3,
                    `guided-advisory-${index}-${advisoryIds[index - 1]}`,
                  ),
                ],
        }),
      ),
      expect.objectContaining({
        plannerId: GUIDED_MISSION_PLANNER_TASK_ID,
        agentRef: "e2e-executor",
        agentCategory: "executor",
        executionMode: "isolated_worktree",
        dependsOn: [
          plannedTaskId(
            currentMission.id,
            3,
            "guided-advisory-4-e2e-advisor-omp",
          ),
        ],
      }),
      ...reviewIds.map((agentRef, index) =>
        expect.objectContaining({
          plannerId: `guided-review-${index + 1}-${agentRef}`,
          agentRef,
          agentCategory: "reviewer",
          executionMode: "read_only",
          dependsOn: [
            plannedTaskId(
              currentMission.id,
              3,
              index === 0
                ? GUIDED_MISSION_PLANNER_TASK_ID
                : `guided-review-${index}-${reviewIds[index - 1]}`,
            ),
          ],
        }),
      ),
      expect.objectContaining({
        plannerId: GUIDED_MISSION_QA_TASK_ID,
        agentRef: "e2e-qa",
        agentCategory: "reviewer",
        executionMode: "read_only",
        dependsOn: [
          plannedTaskId(
            currentMission.id,
            3,
            "guided-review-3-e2e-advisor-claude",
          ),
        ],
      }),
    ]);
  });

  it("seals the claude-orchestrator variant chain without any claude worker", () => {
    const liveSquad = createRealMissionE2ESquadFixture([], "claude");
    const contract = compileIntentContract({
      goal: REAL_MISSION_E2E_GOAL,
      acceptanceCriteria: [
        ...REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
      ],
      intentVersion: 3,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      squadId: liveSquad.id,
      description: contract.goal,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
        squadRevisionHash: snapshotSquadAuthority(liveSquad).hash,
      },
    });
    const h = harness({
      currentMission,
      liveSquad,
      adapters: [
        liveAdapter("codex"),
        {
          id: "grok",
          installed: true,
          models: { list: ["grok-4.5"], default: "grok-4.5" },
        },
        liveAdapter("kimi"),
        {
          id: "agy",
          installed: true,
          models: {
            list: ["gemini-3.6-flash-high"],
            default: "gemini-3.6-flash-high",
          },
        },
        liveAdapter("opencode"),
        liveAdapter("omp"),
        liveAdapter("claude"),
      ],
    });

    expect(
      ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const schedules = rows.map((row) => ({
      plannerId: row.plannerId,
      ...decodeTaskScheduleDetail(row.detail).meta!,
    }));

    // Variante claude: advisor claude reservada (orquestrador) — a cadeia
    // termina a revisão independente no grok e nenhum worker é claude.
    const advisoryIds = [
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-omp",
    ];
    const reviewIds = ["e2e-reviewer", "e2e-advisor-grok"];
    expect(schedules).toEqual([
      ...advisoryIds.map((agentRef, index) =>
        expect.objectContaining({
          plannerId: `guided-advisory-${index + 1}-${agentRef}`,
          agentRef,
          agentCategory: "scout",
          executionMode: "read_only",
          dependsOn:
            index === 0
              ? []
              : [
                  plannedTaskId(
                    currentMission.id,
                    3,
                    `guided-advisory-${index}-${advisoryIds[index - 1]}`,
                  ),
                ],
        }),
      ),
      expect.objectContaining({
        plannerId: GUIDED_MISSION_PLANNER_TASK_ID,
        agentRef: "e2e-executor",
        agentCategory: "executor",
        executionMode: "isolated_worktree",
        dependsOn: [
          plannedTaskId(
            currentMission.id,
            3,
            "guided-advisory-4-e2e-advisor-omp",
          ),
        ],
      }),
      ...reviewIds.map((agentRef, index) =>
        expect.objectContaining({
          plannerId: `guided-review-${index + 1}-${agentRef}`,
          agentRef,
          agentCategory: "reviewer",
          executionMode: "read_only",
          dependsOn: [
            plannedTaskId(
              currentMission.id,
              3,
              index === 0
                ? GUIDED_MISSION_PLANNER_TASK_ID
                : `guided-review-${index}-${reviewIds[index - 1]}`,
            ),
          ],
        }),
      ),
      expect.objectContaining({
        plannerId: GUIDED_MISSION_QA_TASK_ID,
        agentRef: "e2e-qa",
        agentCategory: "reviewer",
        executionMode: "read_only",
        dependsOn: [
          plannedTaskId(
            currentMission.id,
            3,
            "guided-review-2-e2e-advisor-grok",
          ),
        ],
      }),
    ]);
    expect(
      rows.every((row) => !row.agentRef.includes("claude")),
    ).toBe(true);
  });

  it("admits only exact credentialless OpenCode models when no usable account exists", () => {
    const provider = {
      adapterId: "opencode",
      enabled: true,
      installed: true,
      authStrategy: "login-needed",
      models: [
        "opencode/big-pickle",
        "openrouter/openai/gpt-5",
        "opencode/unreviewed-free",
      ],
      defaultModel: "opencode/big-pickle",
    };

    expect(
      guidedLiveRosterAdapter({
        provider,
        accountAvailable: false,
      }),
    ).toEqual({
      id: "opencode",
      installed: true,
      models: {
        list: ["opencode/big-pickle"],
        default: "opencode/big-pickle",
      },
    });
    expect(
      guidedLiveRosterAdapter({
        provider: {
          ...provider,
          models: ["openrouter/openai/gpt-5"],
          defaultModel: "openrouter/openai/gpt-5",
        },
        accountAvailable: false,
      }),
    ).toMatchObject({
      installed: false,
      models: { list: [] },
    });
  });

  it("rejects login-needed OMP through the production roster conversion", () => {
    const omp = providerBackedLiveAdapter("omp", {
      authStrategy: "login-needed",
      models: ["anthropic/claude-sonnet"],
      defaultModel: "anthropic/claude-sonnet",
    });
    expect(omp).toMatchObject({
      id: "omp",
      installed: false,
      models: { list: [] },
    });

    const liveSquad = squadWithAgentCli("generalist", "omp");
    const h = harness({
      currentMission: missionForSquad(liveSquad),
      liveSquad,
      adapters: [
        providerBackedLiveAdapter("codex"),
        omp,
        providerBackedLiveAdapter("glm"),
        providerBackedLiveAdapter("claude"),
      ],
    });
    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_roster_route_unavailable.*generalist\/omp/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("does not let a mixed authenticated OpenCode catalog bypass an unavailable account", () => {
    const provider = {
      adapterId: "opencode",
      enabled: true,
      installed: true,
      authStrategy: "subscription",
      models: ["opencode/big-pickle", "openrouter/openai/gpt-5"],
      defaultModel: "openrouter/openai/gpt-5",
    };

    expect(
      guidedLiveRosterAdapter({
        provider,
        accountAvailable: false,
      }),
    ).toEqual({
      id: "opencode",
      installed: true,
      models: {
        list: ["opencode/big-pickle"],
        default: "openrouter/openai/gpt-5",
      },
    });
    expect(
      guidedLiveRosterAdapter({
        provider,
        accountAvailable: true,
      }).models.list,
    ).toEqual(["opencode/big-pickle", "openrouter/openai/gpt-5"]);
  });

  it("seals one honest task for every approved worker identity", () => {
    const h = harness();

    const result = ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps);

    expect(result).toEqual({
      applicable: true,
      sealed: true,
      reason: "sealed",
      workerAgentRef: "generalist",
      taskId: plannedTaskId(
        "mission-guided",
        3,
        GUIDED_MISSION_PLANNER_TASK_ID,
      ),
    });
    expect(h.createPlanAtomically).toHaveBeenCalledOnce();
    const input = h.createPlanAtomically.mock.calls[0]![0];
    expect(input).toMatchObject({
      missionId: "mission-guided",
      intentVersion: 3,
      squad: { id: squad.id, agents: squad.agents },
      rows: [
        expect.objectContaining({
          agentRef: "frontend",
          agentCategory: "executor",
        }),
        expect.objectContaining({
          plannerId: GUIDED_MISSION_PLANNER_TASK_ID,
          agentRef: "generalist",
          agentCategory: "executor",
        }),
        expect.objectContaining({
          agentRef: "reviewer",
          agentCategory: "reviewer",
        }),
        expect.objectContaining({
          plannerId: GUIDED_MISSION_QA_TASK_ID,
          agentRef: "qa",
          agentCategory: "reviewer",
        }),
      ],
    });
    expect(input.rows).toHaveLength(
      squad.agents.filter((agent) => agent.category !== "orchestrator").length,
    );
    expect(new Set(input.rows.map((row) => row.agentRef))).toEqual(
      new Set(["frontend", "generalist", "qa", "reviewer"]),
    );
    const advisoryRow = input.rows.find((row) => row.agentRef === "frontend")!;
    const executionRow = input.rows.find(
      (row) => row.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    )!;
    const independentReviewRow = input.rows.find(
      (row) => row.agentRef === "reviewer",
    )!;
    const qualityGateRow = input.rows.find(
      (row) => row.plannerId === GUIDED_MISSION_QA_TASK_ID,
    )!;
    const advisory = decodeTaskScheduleDetail(advisoryRow.detail);
    expect(advisory.meta).toMatchObject({
      dependsOn: [],
      agentRef: "frontend",
      agentCategory: "executor",
      executionMode: "read_only",
    });
    expect(advisory.body).toContain("executor consultivo");
    expect(advisory.body).toContain("Não edite arquivos");

    const execution = decodeTaskScheduleDetail(executionRow.detail);
    expect(execution.meta).toMatchObject({
      dependsOn: [plannedTaskId("mission-guided", 3, advisoryRow.plannerId)],
      ownership: {
        files: ["package.json", "src", "tests"],
        domains: ["guided-implementation", "sequential-only"],
      },
      agentRef: "generalist",
      agentCategory: "executor",
      executionMode: "isolated_worktree",
    });
    expect(execution.body).toContain("Objetivo aprovado:");
    expect(execution.body).toContain("Testes relevantes verdes");

    const independentReview = decodeTaskScheduleDetail(
      independentReviewRow.detail,
    );
    expect(independentReview.meta).toMatchObject({
      dependsOn: [
        plannedTaskId("mission-guided", 3, GUIDED_MISSION_PLANNER_TASK_ID),
      ],
      agentRef: "reviewer",
      agentCategory: "reviewer",
      executionMode: "read_only",
    });
    expect(independentReview.body).toContain("revisor independente");

    const qualityGate = decodeTaskScheduleDetail(qualityGateRow.detail);
    expect(qualityGate.meta).toMatchObject({
      dependsOn: [
        plannedTaskId("mission-guided", 3, independentReviewRow.plannerId),
      ],
      ownership: {
        files: ["package.json", "src", "tests"],
        domains: ["guided-quality-gate", "sequential-only"],
      },
      agentRef: "qa",
      agentCategory: "reviewer",
      executionMode: "isolated_worktree",
    });
    expect(qualityGate.body).toContain(
      "gate corretivo independente da entrega já integrada",
    );
    expect(qualityGate.body).toContain(
      "Não crie mudança cosmética, documento decorativo nem commit vazio",
    );
    expect(qualityGate.body).toContain(
      "envie handoff success descrevendo exatamente os checks executados",
    );
    expect(qualityGate.body).toContain(
      "receipt físico de validação sem mudança",
    );
  });

  it("honors an explicit natural-language QA read-only constraint", () => {
    const base = compileIntentContract({
      goal:
        "Crie resultado.txt. O executor deve editar e commitar; a revisão " +
        "independente e o QA devem validar de forma somente leitura.",
      acceptanceCriteria: ["resultado.txt validado"],
      intentVersion: 3,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      description: base.goal,
      intentContract: {
        ...base,
        approvedAt: 10,
        dispatchedAt: 10,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
      },
    });
    expect(
      approvedIntentRequiresReadOnlyQualityGate(currentMission),
    ).toBe(true);
    const h = harness({ currentMission });

    expect(
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const qa = decodeTaskScheduleDetail(
      rows.find(
        (row) => row.plannerId === GUIDED_MISSION_QA_TASK_ID,
      )!.detail,
    );
    const review = decodeTaskScheduleDetail(
      rows.find((row) => row.agentRef === "reviewer")!.detail,
    );

    expect(qa.meta).toMatchObject({
      agentRef: "qa",
      agentCategory: "reviewer",
      executionMode: "read_only",
      ownership: {
        domains: ["guided-quality-gate", "sequential-only"],
      },
    });
    expect(qa.body).toContain(
      "gate final independente e mecanicamente somente leitura",
    );
    expect(qa.body).toContain(
      "não o corrija: envie handoff blocked",
    );
    expect(qa.body).not.toContain("Faça commit");
    expect(review.body).toContain(
      "QA final também será mecanicamente read-only",
    );
  });

  it("uses the combined sealed-detail budget instead of a smaller prompt-only cap", () => {
    const h = harness({ currentMission: denseUiMission() });

    expect(
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const implementation = rows.find(
      (row) => row.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    if (!implementation) throw new Error("missing guided implementation");
    expect(
      decodeTaskScheduleDetail(implementation.detail).body.length,
    ).toBeGreaterThan(60_000);
    expect(rows.every((row) => row.detail.length <= 65_536)).toBe(true);
  });

  it("fails before persistence when ownership pushes the encoded detail past 64 KiB", () => {
    const h = harness({ currentMission: denseUiMission() });
    const ownership = repositoryOwnershipClaimsFromGitTree(
      Array.from(
        { length: 400 },
        (_, index) =>
          `tracked-root-${String(index).padStart(4, "0")}-${"x".repeat(35)}.txt`,
      ),
    );
    vi.mocked(h.deps.listRepositoryOwnership).mockReturnValue(ownership);

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(
      /guided_plan_task_detail_too_large: guided-advisory-.*ownership.*dependências/i,
    );
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("seals a roster-complete Guided v2 graph for the promoted builtin delivery squad", () => {
    const promotedSquad: Squad = {
      ...squad,
      id: "nexus-story-impl",
      builtin: true,
      agents: squad.agents.map((agent) => ({ ...agent })),
    };
    const base = mission();
    const planContract = compileIntentContract({
      goal: base.intentContract!.goal,
      acceptanceCriteria: [...base.intentContract!.acceptanceCriteria],
      intentVersion: 2,
      source: "typed",
      lane: "plan",
    });
    const planMission: Mission = {
      ...base,
      intentVersion: 2,
      orchestratorSessionId: "session-plan-v2",
      intentContract: {
        ...planContract,
        approvedAt: 2,
        dispatchedAt: 2,
      },
    };
    const planHandoff: Handoff = {
      id: "handoff-plan-v2",
      missionId: planMission.id,
      sessionId: "session-plan-v2",
      fromAgent: "Maestro",
      authorityOrigin: "agent",
      mcpProvenance: {
        receiptId: "receipt-plan-v2",
        toolCallId: "tool-plan-v2",
        toolName: "nexus_handoff_submit",
        source: "http-mcp",
        authoritySha256: "a".repeat(64),
        missionId: planMission.id,
        sessionId: "session-plan-v2",
        issuedAt: 2,
      },
      status: "success",
      summary: "# PRD aprovado\nEntregar o sistema completo.",
      artifacts: [],
      evidenceIds: [],
      evidenceTrust: "unverified",
      claimTrust: "untrusted",
      delivered: true,
      deliveryState: "submitted",
      submittedAt: 2,
      createdAt: 2,
    };
    const promotedPlan = selectPhysicalPlanHandoff({
      mission: planMission,
      handoffs: {
        list: () => [planHandoff],
        get: () => planHandoff,
      },
    });
    const promoted = mission({
      squadId: promotedSquad.id,
      intentContract: {
        ...base.intentContract!,
        squadRevisionHash: snapshotSquadAuthority(promotedSquad).hash,
        promotedPlan,
      },
    });
    const h = harness({
      currentMission: promoted,
      liveSquad: promotedSquad,
    });

    const result = ensureGuidedMissionPlan(h.suite, promoted.id, h.deps);

    expect(result).toMatchObject({
      applicable: true,
      sealed: true,
      reason: "sealed",
    });
    expect(h.deps.assertStandardSquadReadiness).toHaveBeenCalledWith(
      promotedSquad,
    );
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    expect(rows).toHaveLength(
      promotedSquad.agents.filter((agent) => agent.category !== "orchestrator")
        .length,
    );
    expect(new Set(rows.map((row) => row.agentRef))).toEqual(
      new Set(
        promotedSquad.agents
          .filter((agent) => agent.category !== "orchestrator")
          .map((agent) => agent.id),
      ),
    );
    expect(rows.every((row) => decodeTaskScheduleDetail(row.detail).meta)).toBe(
      true,
    );
  });

  it("carries the sealed executor → QA contract through real worktrees and a physical no-change receipt", async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-wave-e2e-"),
    );
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-wave-runtime-"),
    );
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      git(rootRealPath, "init", "--quiet");
      git(rootRealPath, "symbolic-ref", "HEAD", "refs/heads/main");
      git(rootRealPath, "config", "user.name", "Nexus Test");
      git(rootRealPath, "config", "user.email", "nexus@example.test");
      fs.writeFileSync(path.join(rootRealPath, "app.txt"), "base\n");
      git(rootRealPath, "add", "app.txt");
      git(rootRealPath, "commit", "--quiet", "-m", "baseline");

      const waveSquad: Squad = {
        ...squad,
        agents: squad.agents.filter((agent) =>
          ["orch", "generalist", "qa"].includes(agent.id),
        ),
      };
      const waveMission = mission({
        intentContract: {
          ...mission().intentContract!,
          squadRevisionHash: snapshotSquadAuthority(waveSquad).hash,
        },
      });
      const h = harness({
        currentMission: waveMission,
        liveSquad: waveSquad,
      });
      const deps: GuidedMissionPlannerDeps = {
        ...h.deps,
        listRepositoryOwnership: () => ["app.txt"],
      };
      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", deps),
      ).toMatchObject({ applicable: true, sealed: true });
      const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
      const execution = decodeTaskScheduleDetail(rows[0]!.detail);
      const qualityGate = decodeTaskScheduleDetail(rows[1]!.detail);
      if (!execution.meta || !qualityGate.meta) {
        throw new Error("guided plan rows must carry sealed schedule metadata");
      }
      const executionMeta = execution.meta;
      const qualityGateMeta = qualityGate.meta;
      const executionTaskId = plannedTaskId(
        "mission-guided",
        3,
        GUIDED_MISSION_PLANNER_TASK_ID,
      );
      const qualityGateTaskId = plannedTaskId(
        "mission-guided",
        3,
        GUIDED_MISSION_QA_TASK_ID,
      );
      expect(qualityGateMeta.dependsOn).toEqual([executionTaskId]);

      const actualScope = testProjectScope({ rootRealPath });
      const manager = new WorktreeManager({
        runtimeRoot,
        stateStore: new MemoryWorktreeStateStore(),
        now: () => 10,
      });
      const executionAgent = squad.agents.find(
        (agent) => agent.id === executionMeta.agentRef,
      )!;
      const executorWorktree = manager.create({
        scope: actualScope,
        missionId: "mission-guided",
        taskId: executionTaskId,
        workerId: executionAgent.agentName,
        ownership: executionMeta.ownership,
      });
      fs.writeFileSync(
        path.join(executorWorktree.worktreePath, "app.txt"),
        "implemented\n",
      );
      git(executorWorktree.worktreePath, "add", "app.txt");
      git(
        executorWorktree.worktreePath,
        "commit",
        "--quiet",
        "-m",
        "implement guided goal",
      );
      const preparedExecution = manager.prepareIntegration(
        actualScope,
        "mission-guided",
        executionTaskId,
      );
      manager.markQueued(
        actualScope,
        "mission-guided",
        executionTaskId,
        preparedExecution.taskHeadSha,
      );
      git(rootRealPath, "cherry-pick", preparedExecution.taskHeadSha);
      manager.markIntegrated(
        actualScope,
        "mission-guided",
        executionTaskId,
        git(rootRealPath, "rev-parse", "HEAD"),
      );

      const qualityAgent = squad.agents.find(
        (agent) => agent.id === qualityGateMeta.agentRef,
      )!;
      const qaWorktree = manager.create({
        scope: actualScope,
        missionId: "mission-guided",
        taskId: qualityGateTaskId,
        workerId: qualityAgent.agentName,
        ownership: qualityGateMeta.ownership,
        dependsOn: qualityGateMeta.dependsOn.map((taskId) => ({
          missionId: "mission-guided",
          taskId,
        })),
      });
      const handoffReady: TaskDispatchRecord = {
        id: "dispatch-guided-quality-gate",
        taskId: qualityGateTaskId,
        missionId: "mission-guided",
        intentVersion: 3,
        revision: 4,
        attempt: 1,
        state: "handoff_ready",
        leaseOwner: "main",
        leaseExpiresAt: 1_000,
        workerId: qualityAgent.agentName,
        workerIncarnationId: "worker-incarnation-qa",
        ownership: qualityGateMeta.ownership,
        executionMode: "isolated_worktree",
        agentRef: qualityGateMeta.agentRef,
        agentCategory: qualityGateMeta.agentCategory,
        paneId: "pane-qa",
        sessionId: "session-qa",
        handoffId: "handoff-qa",
        projectId: actualScope.projectId,
        checkoutId: actualScope.checkoutId,
        createdAt: 1,
        updatedAt: 2,
      };
      const mergingDispatch: TaskDispatchRecord = {
        ...handoffReady,
        state: "merging",
        revision: handoffReady.revision + 1,
      };
      const complete = vi.fn();

      await expect(
        finalizeGuidedNoChangeQualityGate(
          {
            scope: actualScope,
            missionId: "mission-guided",
            taskId: qualityGateTaskId,
            dispatch: handoffReady,
          },
          {
            prepare: () =>
              manager.prepareNoChangeValidation(
                actualScope,
                "mission-guided",
                qualityGateTaskId,
              ),
            beginMerge: () => mergingDispatch,
            assertAuthority: () => mergingDispatch,
            validate: (context) => {
              expect(context).toMatchObject({
                checkoutPath: qaWorktree.worktreePath,
                integrationBaseSha: qaWorktree.baseSha,
                taskHeadSha: qaWorktree.baseSha,
                changedFiles: [],
              });
              return {
                sensorsPassed: true,
                reviewPassed: true,
                evidenceIds: ["sensor:guided-e2e", "review:guided-e2e"],
              };
            },
            markValidated: (prepared) => {
              manager.markValidatedNoChange(
                actualScope,
                "mission-guided",
                qualityGateTaskId,
                prepared.taskHeadSha,
                prepared.integrationHeadSha,
              );
            },
            complete,
            now: () => 42,
          },
        ),
      ).resolves.toBe(true);

      expect(
        manager.get(actualScope, "mission-guided", qualityGateTaskId),
      ).toMatchObject({
        status: "integrated",
        taskHeadSha: qaWorktree.baseSha,
        integratedSha: qaWorktree.baseSha,
      });
      expect(complete).toHaveBeenCalledWith(
        mergingDispatch.revision,
        expect.objectContaining({
          kind: "worktree_validated_no_change",
          reference: expect.stringMatching(
            /^no-change:[a-f0-9]{40,64}:[a-f0-9]{64}$/,
          ),
          evidenceIds: ["sensor:guided-e2e", "review:guided-e2e"],
        }),
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("fails closed instead of silently omitting an approved worker whose CLI is unavailable", () => {
    const liveSquad = squadWithAgentCli("generalist", "omp");
    const h = harness({
      currentMission: missionForSquad(liveSquad),
      liveSquad,
      adapters: [
        liveAdapter("codex"),
        liveAdapter("omp", false),
        liveAdapter("glm"),
        liveAdapter("claude"),
      ],
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_roster_route_unavailable.*generalist\/omp/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("fails closed without a task receipt when no approved executor route is live", () => {
    const h = harness({
      adapters: [
        liveAdapter("codex", false),
        liveAdapter("omp", false),
        liveAdapter("glm"),
        liveAdapter("claude"),
      ],
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_roster_route_unavailable/);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("fails closed before persistence when the approved QA/reviewer route is unavailable", () => {
    const h = harness({
      adapters: [
        liveAdapter("codex", false),
        liveAdapter("omp"),
        liveAdapter("glm", false),
        liveAdapter("claude"),
      ],
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_roster_route_unavailable/);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("runs qualified scout and architect advisory identities as pre-execution read-only tasks", () => {
    const expandedSquad: Squad = {
      ...squad,
      agents: [
        ...squad.agents,
        {
          id: "scout",
          agentName: "Scout de código",
          category: "scout",
          cli: "codex",
        },
        {
          id: "architect",
          agentName: "Arquiteto de solução",
          category: "architect",
          cli: "codex",
        },
      ],
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(expandedSquad).hash,
      },
    });
    const h = harness({ currentMission, liveSquad: expandedSquad });

    ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps);

    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    expect(rows).toHaveLength(
      expandedSquad.agents.filter((agent) => agent.category !== "orchestrator")
        .length,
    );
    for (const agentRef of ["scout", "architect"] as const) {
      const row = rows.find((candidate) => candidate.agentRef === agentRef)!;
      expect(decodeTaskScheduleDetail(row.detail).meta).toMatchObject({
        agentRef,
        executionMode: "read_only",
        ownership: {
          domains: ["guided-advisory", "sequential-only"],
        },
      });
      expect(rows.indexOf(row)).toBeLessThan(
        rows.findIndex(
          (candidate) => candidate.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
        ),
      );
    }
  });

  it("rejects a mixed roster whose Kimi/OMP/AGY/Grok workers lack a qualified workspace sandbox", () => {
    const fallbackSquad: Squad = {
      ...squad,
      agents: [
        {
          id: "orch",
          agentName: "Maestro",
          category: "orchestrator",
          cli: "claude",
        },
        {
          id: "primary-codex",
          agentName: "Generalist principal",
          category: "executor",
          cli: "codex",
          effort: "high",
        },
        {
          id: "secondary-agy",
          agentName: "Executor AGY",
          category: "executor",
          cli: "agy",
        },
        {
          id: "scout-kimi",
          agentName: "Scout Kimi",
          category: "scout",
          cli: "kimi",
        },
        {
          id: "architect-grok",
          agentName: "Architect Grok",
          category: "architect",
          cli: "grok",
        },
        {
          id: "qa-omp",
          agentName: "QA OMP",
          category: "reviewer",
          cli: "omp",
          effort: "high",
        },
        {
          id: "review-longcat",
          agentName: "Reviewer LongCat",
          category: "reviewer",
          cli: "longcat",
        },
      ],
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(fallbackSquad).hash,
      },
    });
    const h = harness({
      currentMission,
      liveSquad: fallbackSquad,
      adapters: [
        liveAdapter("claude"),
        liveAdapter("codex"),
        liveAdapter("omp"),
        liveAdapter("agy"),
        liveAdapter("kimi"),
        liveAdapter("grok"),
        liveAdapter("longcat"),
      ],
    });
    vi.mocked(h.deps.assertStandardSquadReadiness).mockImplementationOnce(
      () => {
        throw new Error(
          "squad_runtime_unavailable:worker-unavailable: OMP/Kimi/AGY/Grok sem sandbox de workspace confiável",
        );
      },
    );

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/worker-unavailable.*sandbox de workspace/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("fails closed when the approved squad has no non-Claude QA/reviewer", () => {
    const executionOnlySquad: Squad = {
      ...squad,
      agents: squad.agents.filter(
        (agent) => agent.category !== "reviewer" || agent.cli === "claude",
      ),
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(executionOnlySquad).hash,
      },
    });
    const h = harness({
      currentMission,
      liveSquad: executionOnlySquad,
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_reviewer_missing/);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("keeps reserveClaude: a Claude executor is never selected as a worker", () => {
    const claudeOnlySquad: Squad = {
      ...squad,
      agents: squad.agents.filter(
        (agent) => agent.category === "orchestrator" || agent.cli === "claude",
      ),
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(claudeOnlySquad).hash,
      },
    });
    const h = harness({ currentMission, liveSquad: claudeOnlySquad });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/executor.*não-Claude/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it.each([
    ["automation", "standard", "automation-owned"],
    ["typed", "plan", "lane-not-standard"],
    ["typed", "consult", "lane-not-standard"],
    ["typed", "ops", "lane-not-standard"],
  ] as const)(
    "leaves source=%s lane=%s to its specialized flow",
    (source, lane, reason) => {
      const currentMission = mission({
        intentContract: {
          ...mission().intentContract!,
          source,
          lane,
        },
      });
      const h = harness({ currentMission });

      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
      ).toEqual({ applicable: false, sealed: false, reason });
      expect(h.deps.listLiveAdapters).not.toHaveBeenCalled();
      expect(h.deps.listRepositoryOwnership).not.toHaveBeenCalled();
      expect(h.createPlanAtomically).not.toHaveBeenCalled();
    },
  );

  it.each(["nexus-review", "nexus-research", "kimi-cell", "user-squad"])(
    "leaves manual/specialty squad %s to its established orchestrator plan",
    (squadId) => {
      const specialty: Squad = {
        ...squad,
        id: squadId,
        agents: squad.agents.map((agent) => ({ ...agent })),
      };
      const currentMission = mission({
        squadId,
        intentContract: {
          ...mission().intentContract!,
          squadRevisionHash: snapshotSquadAuthority(specialty).hash,
        },
      });
      const h = harness({
        currentMission,
        liveSquad: specialty,
      });

      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
      ).toEqual({
        applicable: false,
        sealed: false,
        reason: "squad-not-engine-generated",
      });
      expect(h.deps.getSquad).not.toHaveBeenCalled();
      expect(h.deps.listLiveAdapters).not.toHaveBeenCalled();
      expect(h.createPlanAtomically).not.toHaveBeenCalled();
    },
  );

  it("blocks a valid roster-bound pre-v2 receipt during upgrade/recovery", () => {
    const taskId = plannedTaskId(
      "mission-guided",
      3,
      "legacy-orchestrator-task",
    );
    const h = harness({
      existing: [
        {
          plannerId: "legacy-orchestrator-task",
          taskId,
          agentRef: "frontend",
          agentCategory: "executor",
        },
      ],
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_legacy_receipt_blocked.*roster-complete v2/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("recovers only an immutable roster-complete Guided v2 receipt", () => {
    const existing = sealedGuidedV2Receipt();
    const recovery = harness({ existing });
    const implementation = existing.find(
      (entry) => entry.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    if (!implementation) throw new Error("missing guided implementation");

    expect(
      ensureGuidedMissionPlan(recovery.suite, "mission-guided", recovery.deps),
    ).toEqual({
      applicable: true,
      sealed: false,
      reason: "already-sealed",
      workerAgentRef: implementation.agentRef,
      taskId: implementation.taskId,
    });
    expect(recovery.createPlanAtomically).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "squadId",
      mutate: (entry: ReturnType<typeof sealedGuidedV2Receipt>[number]) => ({
        ...entry,
        squadId: "agentic-other-squad",
      }),
    },
    {
      label: "rosterHash",
      mutate: (entry: ReturnType<typeof sealedGuidedV2Receipt>[number]) => ({
        ...entry,
        rosterHash: "b".repeat(64),
      }),
    },
  ])(
    "rejects a recovered receipt with stale $label authority",
    ({ mutate }) => {
      const existing = sealedGuidedV2Receipt();
      const recovery = harness({
        existing: existing.map((entry, index) =>
          index === 0 ? mutate(entry) : entry,
        ),
      });

      expect(() =>
        ensureGuidedMissionPlan(
          recovery.suite,
          "mission-guided",
          recovery.deps,
        ),
      ).toThrow(
        /guided_plan_legacy_receipt_blocked.*squad\/roster atualmente aprovado/i,
      );
      expect(recovery.createPlanAtomically).not.toHaveBeenCalled();
    },
  );

  it("rejects a sequential receipt whose Guided stages are semantically reordered", () => {
    const existing = sealedGuidedV2Receipt();
    const advisory = existing.find((entry) =>
      entry.plannerId.startsWith("guided-advisory-"),
    );
    const implementation = existing.find(
      (entry) => entry.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    const review = existing.find((entry) =>
      entry.plannerId.startsWith("guided-review-"),
    );
    const qualityGate = existing.find(
      (entry) => entry.plannerId === GUIDED_MISSION_QA_TASK_ID,
    );
    if (!advisory || !implementation || !review || !qualityGate) {
      throw new Error("missing Guided v2 stages");
    }
    const dependencies = new Map<string, readonly string[]>([
      [implementation.taskId, []],
      [review.taskId, [implementation.taskId]],
      [advisory.taskId, [review.taskId]],
      [qualityGate.taskId, [advisory.taskId]],
    ]);
    const reordered = existing.map((entry) => {
      const decoded = decodeTaskScheduleDetail(entry.task.detail);
      if (!decoded.meta) throw new Error("missing sealed schedule metadata");
      const detail = encodeTaskScheduleDetail(decoded.body, {
        ...decoded.meta,
        dependsOn: dependencies.get(entry.taskId)!,
      });
      return {
        ...entry,
        plannedDetail: detail,
        task: { ...entry.task, detail },
      };
    });
    const recovery = harness({ existing: reordered });

    expect(() =>
      ensureGuidedMissionPlan(recovery.suite, "mission-guided", recovery.deps),
    ).toThrow(
      /guided_plan_legacy_receipt_blocked.*advisory.*implementation.*independent-review.*quality-gate/i,
    );
    expect(recovery.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("revalidates the physical worker roster before recovering an older sealed plan", () => {
    const taskId = plannedTaskId(
      "mission-guided",
      3,
      "legacy-orchestrator-task",
    );
    const h = harness({
      existing: [
        {
          plannerId: "legacy-orchestrator-task",
          taskId,
          agentRef: "frontend",
          agentCategory: "executor",
        },
      ],
    });
    vi.mocked(h.deps.assertStandardSquadReadiness).mockImplementationOnce(
      () => {
        throw new Error(
          "squad_runtime_unavailable:worker-unavailable: Aider sem handoff físico",
        );
      },
    );

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/worker-unavailable.*Aider.*handoff físico/i);
    expect(h.deps.assertStandardSquadReadiness).toHaveBeenCalledWith(squad);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("builds explicit ownership without root wildcards or Nexus authority paths", () => {
    const claims = repositoryOwnershipClaimsFromGitTree([
      ".",
      "*",
      ".context",
      ".context/contract.json",
      ".git",
      ".nexus",
      ".env",
      "PRODUCT.md",
      "src",
      "packages",
      "custom.config.ts",
    ]);

    expect(claims).toEqual(
      expect.arrayContaining(["src", "packages", "custom.config.ts"]),
    );
    expect(claims).not.toEqual(
      expect.arrayContaining([
        ".",
        "*",
        ".context",
        ".context/contract.json",
        ".git",
        ".nexus",
        ".env",
        "PRODUCT.md",
      ]),
    );
  });

  it("bounds every Git inventory probe through the hardened runner", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-inventory-runner-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      fs.writeFileSync(path.join(rootRealPath, "placeholder.txt"), "x");
      const run = vi.fn(
        (cwd: string, args: readonly string[], options?: GitRunOptions) => {
          expect(cwd).toBe(rootRealPath);
          expect(options?.timeoutMs).toBe(10_000);
          if (args[0] === "rev-parse") {
            return { status: 0, stdout: "true\n", stderr: "" };
          }
          if (args[0] === "ls-tree") {
            return { status: 0, stdout: "src\0package.json\0", stderr: "" };
          }
          throw new Error(`unexpected Git command: ${args.join(" ")}`);
        },
      );
      const git: GitRunner = { run };

      const claims = listRepositoryOwnershipClaims(
        testProjectScope({ rootRealPath }),
        git,
      );

      expect(claims).toEqual(expect.arrayContaining(["src", "package.json"]));
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls.flatMap((call) => call[1])).not.toContain("-C");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("seals a safe greenfield inventory for a physically empty folder", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-empty-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      const claims = listRepositoryOwnershipClaims(
        testProjectScope({ rootRealPath }),
      );

      expect(claims).toEqual(
        expect.arrayContaining([
          "package.json",
          "src",
          "tests",
          "index.html",
          "eslint.config.js",
          "next.config.ts",
          "postcss.config.mjs",
          "components.json",
        ]),
      );
      expect(claims).not.toContain(".");
      expect(claims).not.toContain("*");

      const h = harness();
      const deps: GuidedMissionPlannerDeps = {
        ...h.deps,
        listRepositoryOwnership: () => claims,
      };
      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", deps),
      ).toMatchObject({ applicable: true, sealed: true });
      expect(h.createPlanAtomically.mock.calls[0]![0].rows).toHaveLength(4);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("covers common web, backend, CLI, mobile and service scaffold roots explicitly", () => {
    expect(GUIDED_GREENFIELD_OWNERSHIP).toEqual(
      expect.arrayContaining([
        ".dockerignore",
        "Dockerfile",
        "Cargo.toml",
        "CMakeLists.txt",
        "Package.swift",
        "go.mod",
        "main.go",
        "pyproject.toml",
        "requirements.txt",
        "pom.xml",
        "build.gradle.kts",
        "composer.json",
        "Gemfile",
        "pubspec.yaml",
        "docker-compose.yml",
        "index.html",
        "eslint.config.js",
        "next.config.ts",
        "postcss.config.mjs",
        "components.json",
        "tsconfig.app.json",
        "tsconfig.node.json",
        "tailwind.config.ts",
        "playwright.config.ts",
      ]),
    );
    expect(GUIDED_GREENFIELD_OWNERSHIP).not.toEqual(
      expect.arrayContaining([
        ".",
        "*",
        "**",
        ".env",
        ".git",
        ".github",
        ".nexus",
        ".npmrc",
        "PRODUCT.md",
      ]),
    );
  });

  it("seals the same safe greenfield inventory for git init without HEAD", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-unborn-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      execFileSync("git", ["-C", rootRealPath, "init", "--quiet"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      expect(() =>
        execFileSync(
          "git",
          ["-C", rootRealPath, "rev-parse", "--verify", "HEAD^{commit}"],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).toThrow();

      const claims = listRepositoryOwnershipClaims(
        testProjectScope({ rootRealPath }),
      );
      expect(claims).toEqual(
        expect.arrayContaining(["package.json", "src", "tests"]),
      );
      expect(claims).not.toContain(".git");

      const h = harness();
      const deps: GuidedMissionPlannerDeps = {
        ...h.deps,
        listRepositoryOwnership: () => claims,
      };
      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", deps),
      ).toMatchObject({ applicable: true, sealed: true });
      expect(h.createPlanAtomically.mock.calls[0]![0].rows).toHaveLength(4);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("gives one actionable stop for an unborn repository with user files", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-unborn-dirty-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      execFileSync("git", ["-C", rootRealPath, "init", "--quiet"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      fs.writeFileSync(
        path.join(rootRealPath, "user-draft.txt"),
        "preserve me\n",
      );

      expect(() =>
        listRepositoryOwnershipClaims(testProjectScope({ rootRealPath })),
      ).toThrow(
        /faça o primeiro commit dos arquivos existentes.*tente iniciar a missão novamente/i,
      );
      expect(
        fs.readFileSync(path.join(rootRealPath, "user-draft.txt"), "utf8"),
      ).toBe("preserve me\n");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
