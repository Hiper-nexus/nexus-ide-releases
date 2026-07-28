import { describe, expect, it } from "vitest";

import {
  REAL_MISSION_E2E_ADVISORS,
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
      "omp",
      "claude",
    ]);
    expect(
      expectations.map((entry) => [entry.cli, entry.tier, entry.skipped]),
    ).toEqual([
      ["grok", "mechanically-confined", null],
      ["kimi", "advisory-unconfined", null],
      ["agy", "advisory-unconfined", null],
      ["opencode", "advisory-unconfined", null],
      ["omp", "advisory-unconfined", null],
      ["claude", "mechanically-confined", null],
    ]);
    expect(realMissionE2EAdvisorTier("grok")).toBe("mechanically-confined");
    expect(realMissionE2EAdvisorTier("claude")).toBe("mechanically-confined");
    expect(realMissionE2EAdvisorTier("kimi")).toBe("advisory-unconfined");
  });

  it("parses the skip env as a comma-separated CLI list in canonical order", () => {
    expect(
      realMissionE2EAdvisorSkipClis({
        NEXUS_REAL_MISSION_ADVISOR_SKIP: "omp, grok ,unknown-cli,agy",
      }),
    ).toEqual(["grok", "agy", "omp"]);
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
    ).toEqual(["grok", "agy", "opencode", "omp", "glm"]);
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
    ).toEqual(["grok", "kimi", "agy", "opencode", "omp", "glm"]);
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
      "omp",
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
      "omp",
      "claude",
      "glm",
    ]);
  });

  it("excludes skipped advisors from the handoff requirement", () => {
    const participation = buildRealMissionParticipation({
      expectations: expectedRealMissionAdvisors(["agy", "omp", "claude"]),
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
      "opencode",
      "glm",
    ]);
  });
});

describe("real mission physical PTY gate with advisors", () => {
  const advisorAgent = (
    sessionId: string,
    cli: string,
    agentName: string,
  ): PhysicalPtyAgent =>
    ({
      sessionId,
      missionId: "mission-e2e",
      adapterId: cli,
      role: "worker",
      agentName,
      workerIncarnationId: `incarnation-${cli}`,
      readOnly: true,
      nativeReadOnly: cli !== "kimi",
    }) as unknown as PhysicalPtyAgent;

  const gate = () =>
    new ExactRealMissionPhysicalPtyGate(
      "mission-e2e",
      realMissionAdvisorPtyExpectations(expectedRealMissionAdvisors(["omp"])),
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

  it("rejects skipped or unknown advisor CLIs as roster violations", () => {
    const fence = gate();

    // omp está skipped (fora do roster): sessão física dela é violação.
    expect(
      fence.inspect(
        "session-omp",
        advisorAgent("session-omp", "omp", "E2E Advisor OMP"),
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
        nativeReadOnly: true,
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
