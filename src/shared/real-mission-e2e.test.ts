import { describe, expect, it } from "vitest";

import {
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
  isRealMissionE2EPreApprovalMission,
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
      }),
    ).toEqual({
      workspacePath: "/tmp/nexus-real-workspace",
      rendererFailureToken,
      // Ausente = variante codex (default do harness).
      orchestratorCli: "codex",
    });
    expect(
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: "/tmp/nexus-real-workspace",
        rendererFailureToken,
        orchestratorCli: "claude",
      }).orchestratorCli,
    ).toBe("claude");
    expect(() =>
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: "/tmp/nexus-real-workspace",
        rendererFailureToken,
        orchestratorCli: "grok",
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
          id: "e2e-advisor-grok",
          category: "reviewer",
          cli: "grok",
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
          id: "e2e-advisor-omp",
          category: "scout",
          cli: "omp",
          allowedTools: [],
        },
        {
          id: "e2e-advisor-claude",
          category: "reviewer",
          cli: "claude",
          allowedTools: [],
        },
      ],
    });
    // Advisors sem credencial (env NEXUS_REAL_MISSION_ADVISOR_SKIP) ficam
    // fora do roster; o pipeline codex nunca muda.
    const skipped = createRealMissionE2ESquadFixture(["grok", "omp"]);
    expect(skipped.agents.map((agent) => agent.id)).toEqual([
      REAL_MISSION_E2E_ORCHESTRATOR_ID,
      REAL_MISSION_E2E_EXECUTOR_ID,
      REAL_MISSION_E2E_REVIEWER_ID,
      REAL_MISSION_E2E_QA_ID,
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-claude",
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

  it("arms observation only for the exact sealed pre-approval fixture", () => {
    const mission = {
      id: "mission-e2e",
      status: "pending",
      intentState: "ready_to_start",
      intentVersion: 1,
      squadId: REAL_MISSION_E2E_SQUAD_ID,
      intentContract: {
        version: 1,
        source: "typed",
        goal: REAL_MISSION_E2E_GOAL,
        executionMode: "autopilot",
        lane: "standard",
        contextPolicy: "minimal",
        intentVersion: 1,
        acceptanceCriteria: [...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA],
      },
    } as const;

    expect(isRealMissionE2EPreApprovalMission(mission)).toBe(true);
    expect(
      isRealMissionE2EPreApprovalMission({
        ...mission,
        status: "running",
      }),
    ).toBe(false);
    expect(
      isRealMissionE2EPreApprovalMission({
        ...mission,
        intentContract: {
          ...mission.intentContract,
          approvedAt: 10,
          dispatchedAt: 10,
        },
      }),
    ).toBe(false);
    expect(
      isRealMissionE2EPreApprovalMission({
        ...mission,
        intentContract: {
          ...mission.intentContract,
          goal: "forged goal",
        },
      }),
    ).toBe(false);
  });

  it("accepts only a strict missionId observation payload", () => {
    expect(
      realMissionE2EObservePayloadSchema.parse({ missionId: "mission-1" }),
    ).toEqual({ missionId: "mission-1" });
    expect(() =>
      realMissionE2EObservePayloadSchema.parse({
        missionId: "mission-1",
        workspacePath: "/forged",
      }),
    ).toThrow();
    expect(() =>
      realMissionE2EObservePayloadSchema.parse({ missionId: "../mission" }),
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
      "e2e-advisor-grok",
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-omp",
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

  it("derives the expected task chain without the reserved claude advisor", () => {
    const presentClis = ["grok", "kimi", "agy", "opencode", "omp"];
    const chain = realMissionE2EExpectedTaskChain(presentClis);

    expect(chain.map((member) => member.agentRef)).toEqual([
      "e2e-advisor-kimi",
      "e2e-advisor-agy",
      "e2e-advisor-opencode",
      "e2e-advisor-omp",
      "e2e-executor",
      "e2e-reviewer",
      "e2e-advisor-grok",
      "e2e-qa",
    ]);
    expect(chain.map((member) => member.plannerId)).toEqual([
      "guided-advisory-1-e2e-advisor-kimi",
      "guided-advisory-2-e2e-advisor-agy",
      "guided-advisory-3-e2e-advisor-opencode",
      "guided-advisory-4-e2e-advisor-omp",
      "guided-execution",
      "guided-review-1-e2e-reviewer",
      "guided-review-2-e2e-advisor-grok",
      "guided-quality-gate",
    ]);
    // Nenhum worker claude em nenhuma posição da cadeia.
    expect(chain.every((member) => member.cli !== "claude")).toBe(true);
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
    expect(claudeCriteria.slice(0, -1)).toEqual([
      ...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
    ]);
  });

  it("arms observation for the variant pre-approval intent only with the variant criteria", () => {
    const baseMission = {
      id: "mission-e2e",
      status: "pending",
      intentState: "ready_to_start",
      intentVersion: 1,
      squadId: REAL_MISSION_E2E_SQUAD_ID,
      orchestratorSessionId: null,
      intentContract: {
        version: 1,
        source: "typed",
        goal: REAL_MISSION_E2E_GOAL,
        executionMode: "autopilot",
        lane: "standard",
        contextPolicy: "minimal",
        intentVersion: 1,
      },
    };
    const variantMission = {
      ...baseMission,
      intentContract: {
        ...baseMission.intentContract,
        acceptanceCriteria: [
          ...REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA,
        ],
      },
    };
    expect(isRealMissionE2EPreApprovalMission(variantMission, "claude")).toBe(
      true,
    );
    // Critérios da variante errada não abrem observação.
    expect(isRealMissionE2EPreApprovalMission(variantMission, "codex")).toBe(
      false,
    );
    const codexMission = {
      ...baseMission,
      intentContract: {
        ...baseMission.intentContract,
        acceptanceCriteria: [...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA],
      },
    };
    expect(isRealMissionE2EPreApprovalMission(codexMission, "claude")).toBe(
      false,
    );
  });
});
