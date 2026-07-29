import { describe, expect, it } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import {
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_RESULT_FILE,
  createRealMissionE2ESquadFixture,
} from "../../shared/real-mission-e2e";
import {
  decodeTaskScheduleDetail,
} from "./mission-scheduler-meta";
import { plannedTaskId } from "./task-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import {
  ensureGuidedMissionPlan,
  guidedLiveRosterAdapter,
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
} from "./guided-mission-planner";
import { enforceOwnershipOnDiff } from "./mission-scheduler";
import {
  harness,
  liveAdapter,
  mission,
  missionForSquad,
  providerBackedLiveAdapter,
  squad,
  squadWithAgentCli,
} from "./guided-mission-planner-test-harness";

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
        liveAdapter("claude"),
        liveAdapter("glm"),
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
      "e2e-advisor-glm",
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
          dependsOn: [],
        }),
      ),
      expect.objectContaining({
        plannerId: GUIDED_MISSION_PLANNER_TASK_ID,
        agentRef: "e2e-executor",
        agentCategory: "executor",
        executionMode: "isolated_worktree",
        dependsOn: [],
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
        liveAdapter("claude"),
        liveAdapter("glm"),
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
      "e2e-advisor-glm",
    ];
    const reviewIds = ["e2e-reviewer", "e2e-advisor-grok"];
    expect(schedules).toEqual([
      ...advisoryIds.map((agentRef, index) =>
        expect.objectContaining({
          plannerId: `guided-advisory-${index + 1}-${agentRef}`,
          agentRef,
          agentCategory: "scout",
          executionMode: "read_only",
          dependsOn: [],
        }),
      ),
      expect.objectContaining({
        plannerId: GUIDED_MISSION_PLANNER_TASK_ID,
        agentRef: "e2e-executor",
        agentCategory: "executor",
        executionMode: "isolated_worktree",
        dependsOn: [],
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

  it("rejects login-needed AGY through the production roster conversion", () => {
    const agy = providerBackedLiveAdapter("agy", {
      authStrategy: "login-needed",
      models: ["gemini-3.6-pro-high"],
      defaultModel: "gemini-3.6-pro-high",
    });
    expect(agy).toMatchObject({
      id: "agy",
      installed: false,
      models: { list: [] },
    });

    const liveSquad = squadWithAgentCli("generalist", "agy");
    const h = harness({
      currentMission: missionForSquad(liveSquad),
      liveSquad,
      adapters: [
        providerBackedLiveAdapter("codex"),
        agy,
        providerBackedLiveAdapter("glm"),
        providerBackedLiveAdapter("claude"),
      ],
    });
    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_roster_route_unavailable.*generalist\/agy/i);
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
      dependsOn: [],
      ownership: {
        files: ["package.json", "src/app.ts", "tests/app.test.ts"],
        domains: ["guided-implementation"],
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
        files: ["package.json", "src/app.ts", "tests/app.test.ts"],
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

});
