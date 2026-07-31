import { describe, expect, it, vi } from "vitest";

import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_EXECUTOR_NAME,
  realMissionE2EAdvisorSkipClis,
  realMissionE2EAdvisorTier,
} from "../shared/real-mission-e2e";
import {
  buildRealMissionParticipation,
  expectedRealMissionAdvisors,
  realMissionAdvisorPtyExpectations,
  realMissionAdvisorsMissingHandoff,
} from "./real-mission-e2e-participation";
import { ExactRealMissionPhysicalPtyGate } from "./real-mission-e2e-physical";
import type { PhysicalPtyAgent } from "./real-mission-e2e-physical";

describe("real mission advisor expectations", () => {
  it("lists the six advisor CLIs in canonical order with exact tiers", () => {
    const expectations = expectedRealMissionAdvisors([]);

    expect(expectations.map((entry) => entry.cli)).toEqual([
      "grok",
      "kimi",
      "agy",
      "opencode",
      "claude",
      "glm",
    ]);
    expect(
      expectations.map((entry) => [entry.cli, entry.tier, entry.skipped]),
    ).toEqual([
      ["grok", "mechanically-confined", null],
      ["kimi", "advisory-unconfined", null],
      ["agy", "advisory-unconfined", null],
      ["opencode", "advisory-unconfined", null],
      ["claude", "mechanically-confined", null],
      ["glm", "advisory-unconfined", null],
    ]);
    expect(realMissionE2EAdvisorTier("grok")).toBe("mechanically-confined");
    expect(realMissionE2EAdvisorTier("claude")).toBe("mechanically-confined");
    expect(realMissionE2EAdvisorTier("kimi")).toBe("advisory-unconfined");
    expect(realMissionE2EAdvisorTier("glm")).toBe("advisory-unconfined");
  });

  it("parses the skip env as a comma-separated CLI list in canonical order", () => {
    expect(
      realMissionE2EAdvisorSkipClis({
        NEXUS_REAL_MISSION_ADVISOR_SKIP: "opencode, grok ,unknown-cli,agy",
      }),
    ).toEqual(["grok", "agy", "opencode"]);
    expect(realMissionE2EAdvisorSkipClis({})).toEqual([]);
    expect(
      realMissionE2EAdvisorSkipClis({
        NEXUS_REAL_MISSION_ADVISOR_SKIP: "",
      }),
    ).toEqual([]);
  });

  it("marks skipped advisors and excludes them from the PTY fence", () => {
    const expectations = expectedRealMissionAdvisors(["kimi", "claude"]);

    expect(
      expectations.find((entry) => entry.cli === "kimi")?.skipped,
    ).toBe("no-credential");
    expect(
      expectations.find((entry) => entry.cli === "claude")?.skipped,
    ).toBe("no-credential");
    expect(
      realMissionAdvisorPtyExpectations(expectations).map((entry) => entry.cli),
    ).toEqual(["grok", "agy", "opencode", "glm"]);
  });

  it("reserves the claude advisor in the claude orchestrator variant", () => {
    const expectations = expectedRealMissionAdvisors([], {
      orchestratorCli: "claude",
    });

    expect(
      expectations.find((entry) => entry.cli === "claude")?.skipped,
    ).toBe("orchestrator-reserved");
    expect(
      expectations
        .filter((entry) => entry.cli !== "claude")
        .every((entry) => entry.skipped === null),
    ).toBe(true);
    // reserveClaude: nenhuma sessão worker claude entra na cerca física.
    expect(
      realMissionAdvisorPtyExpectations(expectations).map((entry) => entry.cli),
    ).toEqual(["grok", "kimi", "agy", "opencode", "glm"]);
    // A advisor reservada nunca entra na exigência de handoff.
    const participation = buildRealMissionParticipation({
      expectations,
      ptyByCli: new Map(),
      dispatches: [],
      handoffIssuedAt: () => null,
      firstNexusToolAt: () => null,
    });
    expect(participation.find((row) => row.cli === "claude")).toEqual({
      cli: "claude",
      tier: "mechanically-confined",
      skipped: "orchestrator-reserved",
      spawnedAt: null,
      firstNexusToolAt: null,
      handoffAt: null,
    });
    expect(realMissionAdvisorsMissingHandoff(participation)).toEqual([
      "grok",
      "kimi",
      "agy",
      "opencode",
      "glm",
    ]);
  });
});

describe("real mission advisor participation receipts", () => {
  const dispatches = [
    {
      agentRef: "e2e-advisor-grok",
      sessionId: "session-grok",
      handoffId: "handoff-grok",
      handoffAcceptedAt: 300,
    },
    {
      agentRef: "e2e-advisor-kimi",
      sessionId: "session-kimi",
      handoffId: "handoff-kimi",
      handoffAcceptedAt: 310,
    },
  ];

  it("records PTY spawn, first nexus_* tool and physical handoff per CLI", () => {
    const participation = buildRealMissionParticipation({
      expectations: expectedRealMissionAdvisors([]),
      ptyByCli: new Map([
        ["grok", { sessionId: "session-grok", spawnedAt: 100 }],
        ["kimi", { sessionId: "session-kimi", spawnedAt: 110 }],
      ]),
      dispatches,
      handoffIssuedAt: (handoffId) =>
        handoffId === "handoff-grok" ? 290 : null,
      firstNexusToolAt: (sessionId) =>
        sessionId === "session-grok" ? 150 : 160,
    });

    expect(participation).toHaveLength(REAL_MISSION_E2E_ADVISORS.length);
    expect(participation[0]).toEqual({
      cli: "grok",
      tier: "mechanically-confined",
      skipped: null,
      spawnedAt: 100,
      firstNexusToolAt: 150,
      handoffAt: 290,
    });
    // Sem issuedAt físico, o aceite durável do dispatch é o fallback fechado.
    expect(participation[1]).toEqual({
      cli: "kimi",
      tier: "advisory-unconfined",
      skipped: null,
      spawnedAt: 110,
      firstNexusToolAt: 160,
      handoffAt: 310,
    });
    // Advisors sem dispatch ficam sem recibo e entram na exigência.
    expect(participation[2]).toMatchObject({
      cli: "agy",
      spawnedAt: null,
      firstNexusToolAt: null,
      handoffAt: null,
    });
    expect(realMissionAdvisorsMissingHandoff(participation)).toEqual([
      "agy",
      "opencode",
      "claude",
      "glm",
    ]);
  });

  it("excludes skipped advisors from the handoff requirement", () => {
    const participation = buildRealMissionParticipation({
      expectations: expectedRealMissionAdvisors(["agy", "opencode", "claude"]),
      ptyByCli: new Map(),
      dispatches: [],
      handoffIssuedAt: () => null,
      firstNexusToolAt: () => null,
    });

    expect(participation[2]).toEqual({
      cli: "agy",
      tier: "advisory-unconfined",
      skipped: "no-credential",
      spawnedAt: null,
      firstNexusToolAt: null,
      handoffAt: null,
    });
    expect(realMissionAdvisorsMissingHandoff(participation)).toEqual([
      "grok",
      "kimi",
      "glm",
    ]);
  });

  it("credits a rerouted advisor through the substitute's durable directive", () => {
    // Gate 5 da 0.20.0 ao vivo: o claude morreu de 401, o reroute re-vinculou
    // a task selada ao grok (agent_ref trocou), e a checagem por agentRef
    // declarava o claude ausente numa missão DONE com 8/8 handoffs.
    const participation = buildRealMissionParticipation({
      expectations: expectedRealMissionAdvisors([]),
      ptyByCli: new Map([
        ["claude", { sessionId: "session-claude", spawnedAt: 90 }],
      ]),
      dispatches: [
        {
          agentRef: "e2e-advisor-grok",
          sessionId: "session-grok-substituto",
          handoffId: "handoff-claude-task",
          handoffAcceptedAt: 500,
          providerReroute: { fromAgentRef: "e2e-advisor-claude" },
        },
      ],
      handoffIssuedAt: (handoffId) =>
        handoffId === "handoff-claude-task" ? 480 : null,
      firstNexusToolAt: () => null,
    });

    const claude = participation.find((row) => row.cli === "claude");
    expect(claude).toMatchObject({ skipped: null, handoffAt: 480 });
    expect(realMissionAdvisorsMissingHandoff(participation)).not.toContain(
      "claude",
    );
  });
});

describe("real mission physical PTY gate with advisors", () => {
  const advisorAgent = (
    sessionId: string,
    cli: string,
    agentName: string,
    workerIncarnationId = `incarnation-${cli}`,
  ): PhysicalPtyAgent =>
    ({
      sessionId,
      missionId: "mission-e2e",
      adapterId: cli,
      role: "worker",
      agentName,
      workerIncarnationId,
      readOnly: true,
      nativeReadOnly: false,
    }) as unknown as PhysicalPtyAgent;

  const gate = () =>
    new ExactRealMissionPhysicalPtyGate(
      "mission-e2e",
      realMissionAdvisorPtyExpectations(expectedRealMissionAdvisors(["opencode"])),
    );

  it("accepts one physical session per expected advisor identity", () => {
    const fence = gate();
    const accepted = fence.inspect(
      "session-grok",
      advisorAgent("session-grok", "grok", "E2E Advisor Grok"),
    );
    expect(accepted).toMatchObject({
      kind: "accepted",
      identity: "advisor:grok",
    });

    // Uma segunda sessão para a mesma CLI é violação exata do roster.
    expect(
      fence.inspect(
        "session-grok-2",
        advisorAgent("session-grok-2", "grok", "E2E Advisor Grok"),
      ).kind,
    ).toBe("violation");
  });

  it("defers an advisor retry until its replacement is durably proven", () => {
    let replacementDecision: "accept" | "defer" | "reject" = "defer";
    const authorizeReplacement = vi.fn(() => replacementDecision);
    const fence = new ExactRealMissionPhysicalPtyGate(
      "mission-e2e",
      realMissionAdvisorPtyExpectations(
        expectedRealMissionAdvisors(["opencode"]),
      ),
      "codex",
      authorizeReplacement,
    );
    const first = advisorAgent(
      "session-grok-1",
      "grok",
      "E2E Advisor Grok",
      "incarnation-grok-1",
    );
    const retry = advisorAgent(
      "session-grok-2",
      "grok",
      "E2E Advisor Grok",
      "incarnation-grok-2",
    );

    expect(fence.inspect(first.sessionId, first)).toMatchObject({
      kind: "accepted",
      identity: "advisor:grok",
    });
    expect(fence.inspect(retry.sessionId, retry)).toEqual({
      kind: "deferred",
    });
    expect(fence.acceptedSessionCount).toBe(1);

    replacementDecision = "accept";
    expect(fence.inspect(retry.sessionId, retry)).toMatchObject({
      kind: "accepted",
      identity: "advisor:grok",
    });
    expect(fence.acceptedSessionCount).toBe(1);
    expect(fence.inspect(first.sessionId, first)).toEqual({
      kind: "unrelated",
    });
    expect(authorizeReplacement).toHaveBeenCalledTimes(2);
  });

  it("never replaces pipeline or same-incarnation sessions", () => {
    const authorizeReplacement = vi.fn(() => "accept" as const);
    const fence = new ExactRealMissionPhysicalPtyGate(
      "mission-e2e",
      realMissionAdvisorPtyExpectations(
        expectedRealMissionAdvisors(["opencode"]),
      ),
      "codex",
      authorizeReplacement,
    );
    const firstAdvisor = advisorAgent(
      "session-grok-1",
      "grok",
      "E2E Advisor Grok",
      "incarnation-grok",
    );
    const sameIncarnation = advisorAgent(
      "session-grok-2",
      "grok",
      "E2E Advisor Grok",
      "incarnation-grok",
    );
    const firstExecutor = {
      ...advisorAgent(
        "session-executor-1",
        "codex",
        REAL_MISSION_E2E_EXECUTOR_NAME,
        "incarnation-executor-1",
      ),
      readOnly: false,
    } as PhysicalPtyAgent;
    const retryExecutor = {
      ...firstExecutor,
      sessionId: "session-executor-2",
      workerIncarnationId: "incarnation-executor-2",
    } as PhysicalPtyAgent;

    expect(fence.inspect(firstAdvisor.sessionId, firstAdvisor).kind).toBe(
      "accepted",
    );
    expect(
      fence.inspect(sameIncarnation.sessionId, sameIncarnation).kind,
    ).toBe("violation");
    expect(fence.inspect(firstExecutor.sessionId, firstExecutor).kind).toBe(
      "accepted",
    );
    expect(fence.inspect(retryExecutor.sessionId, retryExecutor).kind).toBe(
      "violation",
    );
    expect(authorizeReplacement).not.toHaveBeenCalled();
  });

  it("rejects skipped or unknown advisor CLIs as roster violations", () => {
    const fence = gate();

    // OpenCode está skipped (fora do roster): sessão física dela é violação.
    expect(
      fence.inspect(
        "session-opencode",
        advisorAgent("session-opencode", "opencode", "E2E Advisor OpenCode"),
      ).kind,
    ).toBe("violation");
    // CLI sem rota advisory nunca entra na cerca.
    expect(
      fence.inspect(
        "session-aider",
        advisorAgent("session-aider", "aider", "E2E Advisor Aider"),
      ).kind,
    ).toBe("violation");
    expect(
      fence.inspect("session-other", null).kind,
    ).toBe("unrelated");
  });

  it("accepts the variant orchestrator CLI and rejects the other one", () => {
    const orchestratorAgent = (sessionId: string, cli: string) =>
      ({
        sessionId,
        missionId: "mission-e2e",
        adapterId: cli,
        role: "orchestrator",
        agentName: "E2E Orquestrador",
        squadId: "agentic-nexus-real-mission-e2e",
        readOnly: false,
        nativeReadOnly: false,
      }) as unknown as PhysicalPtyAgent;

    const claudeGate = new ExactRealMissionPhysicalPtyGate(
      "mission-e2e",
      realMissionAdvisorPtyExpectations(
        expectedRealMissionAdvisors([], { orchestratorCli: "claude" }),
      ),
      "claude",
    );
    expect(
      claudeGate.inspect(
        "session-orch",
        orchestratorAgent("session-orch", "claude"),
      ),
    ).toMatchObject({ kind: "accepted", identity: "orchestrator" });
    // Na variante claude, um orquestrador codex é violação exata do roster.
    expect(
      claudeGate.inspect(
        "session-orch-codex",
        orchestratorAgent("session-orch-codex", "codex"),
      ).kind,
    ).toBe("violation");

    const codexGate = new ExactRealMissionPhysicalPtyGate(
      "mission-e2e",
      [],
      "codex",
    );
    expect(
      codexGate.inspect(
        "session-orch-claude",
        orchestratorAgent("session-orch-claude", "claude"),
      ).kind,
    ).toBe("violation");
  });
});
