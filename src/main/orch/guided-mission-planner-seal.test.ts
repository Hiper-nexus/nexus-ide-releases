import { describe, expect, it } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { Handoff, Mission } from "../../shared/orch-types";
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
import { selectPhysicalPlanHandoff } from "./plan-promotion-authority";

const MULTI_STORY_PLAN = `
# PRD

### Story 1.1: Login

As a user I want login.

### Story 1.2: Logout

As a user I want logout.
`;

function promotedMissionWithStories(
  overrides: Partial<NonNullable<Mission["intentContract"]>> = {},
): Mission {
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
    orchestratorSessionId: "session-plan-wave",
    intentContract: {
      ...planContract,
      approvedAt: 2,
      dispatchedAt: 2,
    },
  };
  const planHandoff: Handoff = {
    id: "handoff-plan-wave",
    missionId: planMission.id,
    sessionId: "session-plan-wave",
    fromAgent: "Maestro",
    authorityOrigin: "agent",
    mcpProvenance: {
      receiptId: "receipt-plan-wave",
      toolCallId: "tool-plan-wave",
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      authoritySha256: "b".repeat(64),
      missionId: planMission.id,
      sessionId: "session-plan-wave",
      issuedAt: 2,
    },
    status: "success",
    summary: MULTI_STORY_PLAN,
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
  return mission({
    intentContract: {
      ...base.intentContract!,
      promotedPlan,
      ...overrides,
    },
  });
}

describe("Guided Planner v2", () => {
  it("names an unapproved intent as unbound instead of accusing an intact squad", () => {
    const approved = mission();
    const unboundContract = { ...approved.intentContract! };
    delete (unboundContract as { squadRevisionHash?: string })
      .squadRevisionHash;
    const h = harness({
      currentMission: {
        ...approved,
        intentState: "awaiting_approval",
        intentContract: unboundContract,
      },
    });
    // `squadRevisionHash` é opcional no contrato, então `undefined !== hash`
    // era sempre verdadeiro e o planner acusava "o squad mudou depois da
    // aprovação" para uma equipe que ninguém tocou. A causa real — missão não
    // aprovada — precisa de nome próprio, senão a única ação que destrava
    // (aprovar) fica escondida atrás de uma auditoria inútil da equipe.
    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_squad_unbound/i);
    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).not.toThrow(/guided_plan_squad_stale/i);
  });

  it("still reports a genuinely changed squad as stale", () => {
    const h = harness();
    const tampered = {
      ...squad,
      agents: squad.agents.map((agent) => ({ ...agent, model: "tampered" })),
    };
    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", {
        ...h.deps,
        getSquad: () => tampered,
      }),
    ).toThrow(/guided_plan_squad_stale/i);
  });

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

    // Fan-out consultivo: advisors read_only independentes + executor codex;
    // depois a cadeia codex revisor → QA.
    const advisoryIds = [
      "e2e-advisor-grok",
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-claude",
      "e2e-advisor-glm",
    ];
    const reviewIds = ["e2e-reviewer"];
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
            "guided-review-1-e2e-reviewer",
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

    // Variante claude: advisor claude reservada (orquestrador) e todos os
    // outros advisors permanecem no fan-out independente.
    const advisoryIds = [
      "e2e-advisor-grok",
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-glm",
    ];
    const reviewIds = ["e2e-reviewer"];
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
            "guided-review-1-e2e-reviewer",
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
      topology: "delivery",
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

describe("saved-team (mission-runtime) sealing", () => {
  const SAVED_TEAM_SNAPSHOT_ID =
    "mission-runtime-0c83c9b1-6ab8-4b35-a9b4-6468b001c92c";

  it("seals the guided plan for a saved-team snapshot with an executor", () => {
    const liveSquad = { ...squad, id: SAVED_TEAM_SNAPSHOT_ID };
    const contract = compileIntentContract({
      goal: "crie um arquivo TESTE-PARALELO.md na raiz com um resumo do projeto",
      intentVersion: 3,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      squadId: SAVED_TEAM_SNAPSHOT_ID,
      description: contract.goal,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
        squadRevisionHash: snapshotSquadAuthority(liveSquad).hash,
      },
    });
    const h = harness({ currentMission, liveSquad });

    // Before the fix this returned applicable:false
    // ("squad-not-engine-generated") and Modo Squad missions ran forever with
    // zero sealed tasks until the orchestrator gave up.
    expect(
      ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    expect(h.createPlanAtomically).toHaveBeenCalledOnce();
  });

  it("keeps review-only saved teams on the orchestrator-authored route", () => {
    const reviewOnly = {
      ...squad,
      id: SAVED_TEAM_SNAPSHOT_ID,
      agents: squad.agents.filter((agent) => agent.category !== "executor"),
    };
    const contract = compileIntentContract({
      goal: "crie um arquivo TESTE-PARALELO.md na raiz com um resumo do projeto",
      intentVersion: 3,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      squadId: SAVED_TEAM_SNAPSHOT_ID,
      description: contract.goal,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
        squadRevisionHash: snapshotSquadAuthority(reviewOnly).hash,
      },
    });
    const h = harness({ currentMission, liveSquad: reviewOnly });

    expect(
      ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps),
    ).toMatchObject({
      applicable: false,
      reason: "squad-not-engine-generated",
    });
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("honors forced orchestrationMode on promoted multi-story seal", () => {
    const guided = promotedMissionWithStories({ orchestrationMode: "guided" });
    const guidedHarness = harness({ currentMission: guided });
    expect(
      ensureGuidedMissionPlan(guidedHarness.suite, guided.id, guidedHarness.deps),
    ).toMatchObject({
      applicable: true,
      sealed: true,
      topology: "delivery",
    });

    const pack = promotedMissionWithStories({ orchestrationMode: "pack" });
    const packHarness = harness({ currentMission: pack });
    expect(
      ensureGuidedMissionPlan(packHarness.suite, pack.id, packHarness.deps),
    ).toMatchObject({
      applicable: true,
      sealed: true,
      topology: "wave-pack",
    });
    const packRows = packHarness.createPlanAtomically.mock.calls[0]![0].rows;
    expect(
      packRows.every((row) =>
        decodeTaskScheduleDetail(row.detail).meta?.ownership.domains.includes(
          "wave-pack",
        ),
      ),
    ).toBe(true);
  });

  it("smoke: Pack seals one parallel task per BMAD story plus QA gate", () => {
    const pack = promotedMissionWithStories({ orchestrationMode: "pack" });
    const h = harness({ currentMission: pack });
    const result = ensureGuidedMissionPlan(h.suite, pack.id, h.deps);
    expect(result).toMatchObject({
      applicable: true,
      sealed: true,
      topology: "wave-pack",
    });

    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const decoded = rows.map((row: { detail: string }) =>
      decodeTaskScheduleDetail(row.detail),
    );
    const storyRows = decoded.filter((entry) =>
      entry.meta?.ownership.domains.some((domain) =>
        domain.startsWith("wave-pack-story:"),
      ),
    );
    const qaRows = decoded.filter((entry) =>
      entry.meta?.ownership.domains.includes("guided-quality-gate"),
    );

    // MULTI_STORY_PLAN has Story 1.1 + 1.2 → two writers, not one Guided primary.
    expect(storyRows).toHaveLength(2);
    expect(
      new Set(
        storyRows.map(
          (entry) =>
            entry.meta!.ownership.domains.find((domain) =>
              domain.startsWith("wave-pack-story:"),
            ),
        ),
      ).size,
    ).toBe(2);
    expect(
      storyRows.every(
        (entry) =>
          entry.meta?.executionMode === "isolated_worktree" &&
          entry.meta.parallelEligible === true &&
          entry.meta.agentCategory === "executor",
      ),
    ).toBe(true);
    expect(qaRows).toHaveLength(1);
    // QA waits on every story wave — dependency cardinality is the Pack contract.
    expect(qaRows[0]!.meta?.dependsOn).toHaveLength(2);
    // Stories share inventory as merge permit; exclusivity is story domains.
    expect(
      storyRows.every((entry) => (entry.meta?.ownership.files.length ?? 0) > 0),
    ).toBe(true);
  });
});
