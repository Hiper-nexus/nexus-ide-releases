import { describe, expect, it } from "vitest";

import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_CRITERION,
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_EXECUTOR_ID,
  REAL_MISSION_E2E_FLAG,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_ORCHESTRATOR_ID,
  REAL_MISSION_E2E_PRODUCT_WIZARD_FLAG,
  REAL_MISSION_E2E_QA_ID,
  REAL_MISSION_E2E_REVIEWER_ID,
  REAL_MISSION_E2E_SQUAD_ID,
  createRealMissionE2ESquadFixture,
  isExclusiveRealMissionE2E,
  isRealMissionE2E,
  isRealMissionE2EReviewReadyMission,
  isRealMissionE2ERendererFailureSignal,
  realMissionE2EAcceptanceCriteria,
  realMissionE2ELaunchSurface,
  realMissionE2EObservePayloadSchema,
  realMissionE2EExpectedTaskChain,
  realMissionE2EPrepareFixturePayloadSchema,
  realMissionE2ERendererFailureSignal,
  realMissionE2ERunPayloadSchema,
} from "./real-mission-e2e";
import { rendererFailureToken } from "./real-mission-e2e-test-support";

describe("real mission E2E launch flag", () => {
  it("accepts only the exact explicit flag", () => {
    expect(isRealMissionE2E(["/app", REAL_MISSION_E2E_FLAG])).toBe(true);
    expect(isRealMissionE2E(["/app", `${REAL_MISSION_E2E_FLAG}=1`])).toBe(
      false,
    );
    expect(isRealMissionE2E(["/app", "nexus-real-mission-e2e"])).toBe(false);
    expect(
      isRealMissionE2E(["/app", REAL_MISSION_E2E_PRODUCT_WIZARD_FLAG]),
    ).toBe(true);
    expect(
      realMissionE2ELaunchSurface(
        ["/app", REAL_MISSION_E2E_PRODUCT_WIZARD_FLAG],
        {},
      ),
    ).toBe("product-wizard");
  });

  it("rejects duplicate and packaged-smoke combinations", () => {
    expect(isExclusiveRealMissionE2E(["/app", REAL_MISSION_E2E_FLAG])).toBe(
      true,
    );
    expect(
      isExclusiveRealMissionE2E([
        "/app",
        REAL_MISSION_E2E_FLAG,
        REAL_MISSION_E2E_FLAG,
      ]),
    ).toBe(false);
    expect(
      isExclusiveRealMissionE2E([
        "/app",
        REAL_MISSION_E2E_FLAG,
        "nexus-smoke-test",
      ]),
    ).toBe(false);
    expect(
      isExclusiveRealMissionE2E([
        "/app",
        REAL_MISSION_E2E_FLAG,
        REAL_MISSION_E2E_PRODUCT_WIZARD_FLAG,
      ]),
    ).toBe(false);
    expect(
      realMissionE2ELaunchSurface(
        ["/app", REAL_MISSION_E2E_FLAG],
        { NEXUS_REAL_MISSION_PRODUCT_WIZARD_E2E: "1" },
      ),
    ).toBeNull();
  });
});

describe("real mission E2E closed receipts", () => {
  it("binds a renderer failure signal to the main-issued 256-bit nonce", () => {
    const signal = realMissionE2ERendererFailureSignal(rendererFailureToken);
    expect(signal).toBe(`renderer-failed:${rendererFailureToken}`);
    expect(
      isRealMissionE2ERendererFailureSignal(signal, rendererFailureToken),
    ).toBe(true);
    expect(isRealMissionE2ERendererFailureSignal(signal, "e".repeat(64))).toBe(
      false,
    );
    expect(
      isRealMissionE2ERendererFailureSignal(
        `${signal}:forged`,
        rendererFailureToken,
      ),
    ).toBe(false);
  });

  it("requires the main-issued failure nonce in the strict run payload", () => {
    expect(
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: "/tmp/nexus-real-workspace",
        rendererFailureToken,
        admittedAdvisorClis: REAL_MISSION_E2E_ADVISORS.map(
          (advisor) => advisor.cli,
        ),
      }),
    ).toEqual({
      workspacePath: "/tmp/nexus-real-workspace",
      rendererFailureToken,
      // Ausente = variante codex (default do harness).
      orchestratorCli: "codex",
      admittedAdvisorClis: REAL_MISSION_E2E_ADVISORS.map(
        (advisor) => advisor.cli,
      ),
    });
    expect(
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: "/tmp/nexus-real-workspace",
        rendererFailureToken,
        orchestratorCli: "claude",
        admittedAdvisorClis: REAL_MISSION_E2E_ADVISORS.map(
          (advisor) => advisor.cli,
        ),
      }).orchestratorCli,
    ).toBe("claude");
    expect(() =>
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: "/tmp/nexus-real-workspace",
        rendererFailureToken,
        orchestratorCli: "grok",
        admittedAdvisorClis: REAL_MISSION_E2E_ADVISORS.map(
          (advisor) => advisor.cli,
        ),
      }),
    ).toThrow();
    expect(() =>
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: "/tmp/nexus-real-workspace",
      }),
    ).toThrow();
    expect(() =>
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: "/tmp/nexus-real-workspace",
        rendererFailureToken: "predictable",
        admittedAdvisorClis: REAL_MISSION_E2E_ADVISORS.map(
          (advisor) => advisor.cli,
        ),
      }),
    ).toThrow();
  });

  it("binds the main-owned squad fixture to the strict nonce payload", () => {
    expect(
      realMissionE2EPrepareFixturePayloadSchema.parse({
        rendererFailureToken,
      }),
    ).toEqual({ rendererFailureToken });
    expect(() =>
      realMissionE2EPrepareFixturePayloadSchema.parse({
        rendererFailureToken,
        squad: { id: "forged" },
      }),
    ).toThrow();
    const fixture = createRealMissionE2ESquadFixture();
    expect(fixture).toMatchObject({
      id: REAL_MISSION_E2E_SQUAD_ID,
      builtin: false,
      agents: [
        {
          id: REAL_MISSION_E2E_ORCHESTRATOR_ID,
          category: "orchestrator",
          cli: "codex",
          allowedTools: null,
        },
        {
          id: REAL_MISSION_E2E_EXECUTOR_ID,
          category: "executor",
          cli: "codex",
          allowedTools: [],
        },
        {
          id: REAL_MISSION_E2E_REVIEWER_ID,
          category: "reviewer",
          cli: "codex",
          allowedTools: [],
        },
        {
          id: REAL_MISSION_E2E_QA_ID,
          category: "reviewer",
          cli: "codex",
          allowedTools: [],
        },
        {
          id: "e2e-advisor-kimi",
          category: "scout",
          cli: "kimi",
          allowedTools: [],
        },
        {
          id: "e2e-advisor-agy",
          category: "scout",
          cli: "agy",
          allowedTools: [],
        },
        {
          id: "e2e-advisor-opencode",
          category: "scout",
          cli: "opencode",
          allowedTools: [],
        },
        {
          id: "e2e-advisor-claude",
          category: "scout",
          cli: "claude",
          allowedTools: [],
        },
        {
          id: "e2e-advisor-glm",
          category: "scout",
          cli: "glm",
          allowedTools: [],
        },
      ],
    });
    // Advisors sem credencial (env NEXUS_REAL_MISSION_ADVISOR_SKIP) ficam
    // fora do roster; o pipeline codex nunca muda.
    const skipped = createRealMissionE2ESquadFixture(["kimi"]);
    expect(skipped.agents.map((agent) => agent.id)).toEqual([
      REAL_MISSION_E2E_ORCHESTRATOR_ID,
      REAL_MISSION_E2E_EXECUTOR_ID,
      REAL_MISSION_E2E_REVIEWER_ID,
      REAL_MISSION_E2E_QA_ID,
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-claude",
      "e2e-advisor-glm",
    ]);
    expect(fixture.orchestratorInstructions).toContain(
      "Guided Planner, dispatch e integração pertencem ao main",
    );
    expect(fixture.orchestratorInstructions).toContain(
      "O executor precisa criar e commitar o artefato",
    );
    expect(fixture.orchestratorInstructions).toContain(
      "PROIBIDO usar nexus_mission_set_status com blocked ou failed",
    );
    expect(fixture.orchestratorInstructions).toContain("e2e-reviewer");
    expect(fixture.orchestratorInstructions).toContain("e2e-qa");
    expect(REAL_MISSION_E2E_SQUAD_ID).toMatch(/^agentic-/u);
  });

  it("arms observation only for the exact canonical review fence", () => {
    const reviewSha256 = "a".repeat(64);
    const squadRevisionHash = "b".repeat(64);
    const mission = {
      id: "mission-e2e",
      status: "pending",
      intentState: "ready_to_start",
      intentVersion: 1,
      squadId: "agentic-runtime-11111111-1111-4111-8111-111111111111",
      orchestratorSessionId: null,
      intentContract: {
        version: 1,
        source: "typed",
        goal: REAL_MISSION_E2E_GOAL,
        executionMode: "autopilot",
        lane: "standard",
        contextPolicy: "minimal",
        contextPaths: ["README.md"],
        intentVersion: 1,
        acceptanceCriteria: [...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA],
        approvedAt: 10,
        approvalReviewSha256: reviewSha256,
        squadRevisionHash,
        orchestratorRuntime: { adapterId: "codex" },
      },
    } as const;
    const expectation = {
      missionId: mission.id,
      squadId: mission.squadId,
      squadRevisionHash,
      reviewSha256,
      orchestratorCli: "codex" as const,
      acceptanceCriteria: REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
      contextPaths: ["README.md"],
    };

    expect(isRealMissionE2EReviewReadyMission(mission, expectation)).toBe(true);
    expect(
      isRealMissionE2EReviewReadyMission(
        { ...mission, status: "running" },
        expectation,
      ),
    ).toBe(false);
    expect(
      isRealMissionE2EReviewReadyMission(
        {
          ...mission,
          intentContract: {
            ...mission.intentContract,
            approvalReviewSha256: "c".repeat(64),
          },
        },
        expectation,
      ),
    ).toBe(false);
    expect(
      isRealMissionE2EReviewReadyMission(
        {
          ...mission,
          intentContract: {
            ...mission.intentContract,
            goal: "forged goal",
          },
        },
        expectation,
      ),
    ).toBe(false);
  });

  it("accepts only explicit review-fence or sanitized-failure observations", () => {
    expect(
      realMissionE2EObservePayloadSchema.parse({
        kind: "mission-review",
        missionId: "mission-1",
        reviewSha256: "a".repeat(64),
      }),
    ).toEqual({
      kind: "mission-review",
      missionId: "mission-1",
      reviewSha256: "a".repeat(64),
    });
    expect(
      realMissionE2EObservePayloadSchema.parse({
        kind: "renderer-failure",
        signal: realMissionE2ERendererFailureSignal(rendererFailureToken),
      }),
    ).toEqual({
      kind: "renderer-failure",
      signal: realMissionE2ERendererFailureSignal(rendererFailureToken),
    });
    expect(() =>
      realMissionE2EObservePayloadSchema.parse({
        kind: "mission-review",
        missionId: "mission-1",
      }),
    ).toThrow();
    expect(() =>
      realMissionE2EObservePayloadSchema.parse({
        kind: "renderer-failure",
        signal: "../failure",
      }),
    ).toThrow();
  });

});

describe("real mission E2E claude orchestrator variant", () => {
  it("compiles the fixture with a claude orchestrator and no claude advisor", () => {
    const fixture = createRealMissionE2ESquadFixture([], "claude");

    expect(fixture.agents[0]).toMatchObject({
      id: REAL_MISSION_E2E_ORCHESTRATOR_ID,
      category: "orchestrator",
      cli: "claude",
      allowedTools: null,
    });
    // reserveClaude: a advisor claude nunca entra no roster da variante.
    expect(fixture.agents.some((agent) => agent.id === "e2e-advisor-claude"))
      .toBe(false);
    expect(fixture.agents.map((agent) => agent.id)).toEqual([
      "e2e-orchestrator",
      "e2e-executor",
      "e2e-reviewer",
      "e2e-qa",
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-glm",
    ]);
    // O pipeline executor → revisor → QA continua codex nas duas variantes.
    expect(
      fixture.agents
        .filter((agent) =>
          ["e2e-executor", "e2e-reviewer", "e2e-qa"].includes(agent.id),
        )
        .every((agent) => agent.cli === "codex"),
    ).toBe(true);
  });

  it("derives the exact fan-out and review DAG without the reserved claude advisor", () => {
    const presentClis = ["kimi", "agy", "opencode", "glm"];
    const chain = realMissionE2EExpectedTaskChain(presentClis);

    expect(chain.map((member) => member.agentRef)).toEqual([
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-glm",
      "e2e-executor",
      "e2e-reviewer",
      "e2e-qa",
    ]);
    expect(chain.map((member) => member.plannerId)).toEqual([
      "guided-advisory-1-e2e-advisor-kimi",
      "guided-advisory-2-e2e-advisor-agy",
      "guided-advisory-3-e2e-advisor-opencode",
      "guided-advisory-4-e2e-advisor-glm",
      "guided-execution",
      "guided-review-1-e2e-reviewer",
      "guided-quality-gate",
    ]);
    // Uma raiz a menos desde a saída do grok da fixture (0.28.0).
    expect(chain.map((member) => member.dependsOnPlannerIds)).toEqual([
      [],
      [],
      [],
      [],
      [],
      ["guided-execution"],
      ["guided-review-1-e2e-reviewer"],
    ]);
    // Nenhum worker claude OAuth em nenhuma posição da cadeia (glm ≠ claude).
    expect(chain.every((member) => member.cli !== "claude")).toBe(true);
    expect(chain.some((member) => member.cli === "glm")).toBe(true);
  });

  it("selects the variant acceptance criteria with the extra proof obligation", () => {
    expect(realMissionE2EAcceptanceCriteria("codex")).toBe(
      REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
    );
    const claudeCriteria = realMissionE2EAcceptanceCriteria("claude");
    expect(claudeCriteria).toBe(
      REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA,
    );
    expect(claudeCriteria).toHaveLength(
      REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.length + 1,
    );
    expect(claudeCriteria.at(-1)).toBe(
      REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_CRITERION,
    );
    expect(claudeCriteria[8]).not.toContain("claude");
    expect(claudeCriteria.slice(0, 8)).toEqual(
      REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.slice(0, 8),
    );
    expect(claudeCriteria[9]).toBe(
      REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[9],
    );
  });

  it("makes post-QA authority and advisor preflight semantics explicit", () => {
    expect(REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[5]).toContain(
      "read_only_validated",
    );
    expect(REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[5]).toContain(
      "worktree_validated_no_change",
    );
    expect(REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[7]).toContain(
      "Depois do handoff do QA",
    );
    expect(REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[7]).toContain(
      "prova Main-owned",
    );
    expect(REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[7]).toContain(
      "read_only_validated",
    );
    expect(REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[7]).toContain(
      "worktree_validated_no_change",
    );
    const criteria = realMissionE2EAcceptanceCriteria("codex", [
      "opencode",
      "claude",
      "glm",
    ]);
    const advisorCriterion = criteria.find((criterion) =>
      criterion.includes("guided-advisory"),
    );
    const prevcCriterion = criteria.find((criterion) =>
      criterion.includes("reviewer PREVC"),
    );
    expect(advisorCriterion).toContain("opencode, claude, glm");
    expect(advisorCriterion).not.toMatch(/\b(?:grok|kimi|agy)\b/u);
    expect(advisorCriterion).toContain("nexus_handoff_submit");
    expect(prevcCriterion).toContain("nexus_merge_review_submit");
    expect(prevcCriterion).not.toContain("nexus_handoff_submit");
    expect(REAL_MISSION_E2E_GOAL).not.toContain("terceiro handoff");
    expect(REAL_MISSION_E2E_GOAL).toContain(
      "cadeia de entrega executor → revisor → QA",
    );
  });

  it("keeps every admitted advisor in the advisory lane", () => {
    const admitted = ["opencode", "claude", "glm"];
    const chain = realMissionE2EExpectedTaskChain(admitted);
    expect(
      chain
        .filter((member) => member.kind === "advisory")
        .map((member) => member.cli),
    ).toEqual(admitted);
    expect(
      chain.filter((member) => member.kind === "review").map((member) => member.cli),
    ).toEqual(["codex"]);
  });

  it("arms the variant review only with its exact criteria and runtime", () => {
    const reviewSha256 = "a".repeat(64);
    const squadRevisionHash = "b".repeat(64);
    const mission = {
      id: "mission-e2e",
      status: "pending",
      intentState: "ready_to_start",
      intentVersion: 1,
      squadId: "agentic-runtime-11111111-1111-4111-8111-111111111111",
      orchestratorSessionId: null,
      intentContract: {
        version: 1,
        source: "typed",
        goal: REAL_MISSION_E2E_GOAL,
        executionMode: "autopilot",
        lane: "standard",
        contextPolicy: "minimal",
        contextPaths: ["README.md"],
        intentVersion: 1,
        acceptanceCriteria: [
          ...REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA,
        ],
        approvedAt: 10,
        approvalReviewSha256: reviewSha256,
        squadRevisionHash,
        orchestratorRuntime: { adapterId: "claude" },
      },
    } as const;
    const expectation = {
      missionId: mission.id,
      squadId: mission.squadId,
      squadRevisionHash,
      reviewSha256,
      orchestratorCli: "claude" as const,
      acceptanceCriteria:
        REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA,
      contextPaths: ["README.md"],
    };

    expect(isRealMissionE2EReviewReadyMission(mission, expectation)).toBe(true);
    expect(
      isRealMissionE2EReviewReadyMission(mission, {
        ...expectation,
        orchestratorCli: "codex",
      }),
    ).toBe(false);
    expect(
      isRealMissionE2EReviewReadyMission(mission, {
        ...expectation,
        acceptanceCriteria: REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
      }),
    ).toBe(false);
  });
});
