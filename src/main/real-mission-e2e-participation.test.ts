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
  it('lists the five advisor CLIs in canonical order with exact tiers', () => {
    const expectations = expectedRealMissionAdvisors([]);

    expect(expectations.map((entry) => entry.cli)).toEqual([
      'kimi',
      "agy",
      "opencode",
      "claude",
      "glm",
    ]);
    expect(
      expectations.map((entry) => [entry.cli, entry.tier, entry.skipped]),
    ).toEqual([
      ['kimi', "advisory-unconfined", null],
      ["agy", "advisory-unconfined", null],
      ["opencode", "advisory-unconfined", null],
      ["claude", "mechanically-confined", null],
      ["glm", "advisory-unconfined", null],
    ]);
    expect(realMissionE2EAdvisorTier('claude')).toBe("mechanically-confined");
    expect(realMissionE2EAdvisorTier("kimi")).toBe("advisory-unconfined");
    expect(realMissionE2EAdvisorTier("glm")).toBe("advisory-unconfined");
  });

  it("parses the skip env as a comma-separated CLI list in canonical order", () => {
    expect(
      realMissionE2EAdvisorSkipClis({
        NEXUS_REAL_MISSION_ADVISOR_SKIP: "opencode, grok ,unknown-cli,agy",
      }),
    ).toEqual(['agy', "opencode"]);
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
    ).toEqual(['agy', "opencode", "glm"]);
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
    ).toEqual(['kimi', "agy", "opencode", "glm"]);
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
      'kimi',
      "agy",
      "opencode",
      "glm",
    ]);
  });
});

describe("real mission advisor participation receipts", () => {
  const dispatches = [
    {
      agentRef: 'e2e-advisor-claude',
      sessionId: 'session-claude',
      handoffId: 'handoff-claude',
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
        ['claude', [{ sessionId: 'session-claude', spawnedAt: 100 }]],
        ["kimi", [{ sessionId: "session-kimi", spawnedAt: 110 }]],
      ]),
      dispatches,
      handoffIssuedAt: (handoffId) =>
        handoffId === 'handoff-claude' ? 290 : null,
      firstNexusToolAt: (sessionId) =>
        sessionId === 'session-claude' ? 150 : 160,
    });

    expect(participation).toHaveLength(REAL_MISSION_E2E_ADVISORS.length);
    expect(participation.find((row) => row.cli === 'claude')).toEqual({
      cli: 'claude',
      tier: "mechanically-confined",
      skipped: null,
      spawnedAt: 100,
      firstNexusToolAt: 150,
      handoffAt: 290,
    });
    // Sem issuedAt físico, o aceite durável do dispatch é o fallback fechado.
    expect(participation.find((row) => row.cli === 'kimi')).toEqual({
      cli: "kimi",
      tier: "advisory-unconfined",
      skipped: null,
      spawnedAt: 110,
      firstNexusToolAt: 160,
      handoffAt: 310,
    });
    // Advisors sem dispatch ficam sem recibo e entram na exigência.
    expect(participation.find((row) => row.cli === 'agy')).toMatchObject({
      cli: "agy",
      spawnedAt: null,
      firstNexusToolAt: null,
      handoffAt: null,
    });
    expect(realMissionAdvisorsMissingHandoff(participation)).toEqual([
      "agy",
      "opencode",
      'glm',
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

    expect(participation.find((row) => row.cli === 'agy')).toEqual({
      cli: "agy",
      tier: "advisory-unconfined",
      skipped: "no-credential",
      spawnedAt: null,
      firstNexusToolAt: null,
      handoffAt: null,
    });
    expect(realMissionAdvisorsMissingHandoff(participation)).toEqual([
      'kimi',
      "glm",
    ]);
  });

  it("marks a rerouted advisor as provider-rerouted instead of absent or fake", () => {
    // Gates 5-6 da 0.20.x ao vivo: o claude morreu de 401 e o reroute
    // re-vinculou a task selada ao Kimi. Declará-lo ausente derrubava uma
    // missão DONE 8/8; emprestar o handoff do substituto era mentira que o
    // invariante profundo (firstNexusToolAt da sessão própria) flagrou. A
    // verdade é um skip explícito: task entregue, participação pessoal não.
    const participation = buildRealMissionParticipation({
      expectations: expectedRealMissionAdvisors([]),
      ptyByCli: new Map([
        ["claude", [{ sessionId: "session-claude", spawnedAt: 90 }]],
      ]),
      dispatches: [
        {
          agentRef: 'e2e-advisor-kimi',
          sessionId: 'session-kimi-substituto',
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
    expect(claude).toEqual({
      cli: "claude",
      tier: "mechanically-confined",
      skipped: "provider-rerouted",
      spawnedAt: null,
      firstNexusToolAt: null,
      handoffAt: null,
    });
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
      missionId: 'mission-e2e',
      adapterId: cli,
      role: 'worker',
      agentName,
      workerIncarnationId,
      readOnly: true,
      nativeReadOnly: false,
    }) as unknown as PhysicalPtyAgent;

  const gate = () =>
    new ExactRealMissionPhysicalPtyGate(
      'mission-e2e',
      realMissionAdvisorPtyExpectations(
        expectedRealMissionAdvisors(['opencode']),
      ),
    );

  it('accepts one physical session per expected advisor identity', () => {
    const fence = gate();
    const accepted = fence.inspect(
      'session-claude',
      advisorAgent('session-claude', 'claude', 'E2E Advisor Claude'),
    );
    expect(accepted).toMatchObject({
      kind: 'accepted',
      identity: 'advisor:claude',
    });

    // Uma segunda sessão para a mesma CLI é violação exata do roster.
    expect(
      fence.inspect(
        'session-claude-2',
        advisorAgent('session-claude-2', 'claude', 'E2E Advisor Claude'),
      ).kind,
    ).toBe('violation');
  });

  it('defers an advisor retry until its replacement is durably proven', () => {
    let replacementDecision: 'accept' | 'defer' | 'reject' = 'defer';
    const authorizeReplacement = vi.fn(() => replacementDecision);
    const fence = new ExactRealMissionPhysicalPtyGate(
      'mission-e2e',
      realMissionAdvisorPtyExpectations(
        expectedRealMissionAdvisors(['opencode']),
      ),
      'codex',
      authorizeReplacement,
    );
    const first = advisorAgent(
      'session-claude-1',
      'claude',
      'E2E Advisor Claude',
      'incarnation-claude-1',
    );
    const retry = advisorAgent(
      'session-claude-2',
      'claude',
      'E2E Advisor Claude',
      'incarnation-claude-2',
    );

    expect(fence.inspect(first.sessionId, first)).toMatchObject({
      kind: 'accepted',
      identity: 'advisor:claude',
    });
    expect(fence.inspect(retry.sessionId, retry)).toEqual({
      kind: 'deferred',
    });
    expect(fence.acceptedSessionCount).toBe(1);

    replacementDecision = 'accept';
    expect(fence.inspect(retry.sessionId, retry)).toMatchObject({
      kind: 'accepted',
      identity: 'advisor:claude',
    });
    expect(fence.acceptedSessionCount).toBe(1);
    expect(fence.inspect(first.sessionId, first)).toEqual({
      kind: 'unrelated',
    });
    expect(authorizeReplacement).toHaveBeenCalledTimes(2);
  });

  it('never replaces pipeline or same-incarnation sessions', () => {
    const authorizeReplacement = vi.fn(() => 'accept' as const);
    const fence = new ExactRealMissionPhysicalPtyGate(
      'mission-e2e',
      realMissionAdvisorPtyExpectations(
        expectedRealMissionAdvisors(['opencode']),
      ),
      'codex',
      authorizeReplacement,
    );
    const firstAdvisor = advisorAgent(
      'session-claude-1',
      'claude',
      'E2E Advisor Claude',
      'incarnation-claude',
    );
    const sameIncarnation = advisorAgent(
      'session-claude-2',
      'claude',
      'E2E Advisor Claude',
      'incarnation-claude',
    );
    const firstExecutor = {
      ...advisorAgent(
        'session-executor-1',
        'codex',
        REAL_MISSION_E2E_EXECUTOR_NAME,
        'incarnation-executor-1',
      ),
      readOnly: false,
    } as PhysicalPtyAgent;
    const retryExecutor = {
      ...firstExecutor,
      sessionId: 'session-executor-2',
      workerIncarnationId: 'incarnation-executor-2',
    } as PhysicalPtyAgent;

    expect(fence.inspect(firstAdvisor.sessionId, firstAdvisor).kind).toBe(
      'accepted',
    );
    expect(fence.inspect(sameIncarnation.sessionId, sameIncarnation).kind).toBe(
      'violation',
    );
    expect(fence.inspect(firstExecutor.sessionId, firstExecutor).kind).toBe(
      'accepted',
    );
    expect(fence.inspect(retryExecutor.sessionId, retryExecutor).kind).toBe(
      'violation',
    );
    expect(authorizeReplacement).not.toHaveBeenCalled();
  });

  it('rejects skipped or unknown advisor CLIs as roster violations', () => {
    const fence = gate();

    // OpenCode está skipped (fora do roster): sessão física dela é violação.
    expect(
      fence.inspect(
        'session-opencode',
        advisorAgent('session-opencode', 'opencode', 'E2E Advisor OpenCode'),
      ).kind,
    ).toBe('violation');
    // CLI sem rota advisory nunca entra na cerca.
    expect(
      fence.inspect(
        'session-aider',
        advisorAgent('session-aider', 'aider', 'E2E Advisor Aider'),
      ).kind,
    ).toBe('violation');
    expect(fence.inspect('session-other', null).kind).toBe('unrelated');
  });

  it('accepts the variant orchestrator CLI and rejects the other one', () => {
    const orchestratorAgent = (sessionId: string, cli: string) =>
      ({
        sessionId,
        missionId: 'mission-e2e',
        adapterId: cli,
        role: 'orchestrator',
        agentName: 'E2E Orquestrador',
        squadId: 'agentic-nexus-real-mission-e2e',
        readOnly: false,
        nativeReadOnly: false,
      }) as unknown as PhysicalPtyAgent;

    const claudeGate = new ExactRealMissionPhysicalPtyGate(
      'mission-e2e',
      realMissionAdvisorPtyExpectations(
        expectedRealMissionAdvisors([], { orchestratorCli: 'claude' }),
      ),
      'claude',
    );
    expect(
      claudeGate.inspect(
        'session-orch',
        orchestratorAgent('session-orch', 'claude'),
      ),
    ).toMatchObject({ kind: 'accepted', identity: 'orchestrator' });
    // Na variante claude, um orquestrador codex é violação exata do roster.
    expect(
      claudeGate.inspect(
        'session-orch-codex',
        orchestratorAgent('session-orch-codex', 'codex'),
      ).kind,
    ).toBe('violation');

    const codexGate = new ExactRealMissionPhysicalPtyGate(
      'mission-e2e',
      [],
      'codex',
    );
    expect(
      codexGate.inspect(
        'session-orch-claude',
        orchestratorAgent('session-orch-claude', 'claude'),
      ).kind,
    ).toBe('violation');
  });

  it('defers then accepts orchestrator technical-recovery replacement', () => {
    let replacementDecision: 'accept' | 'defer' | 'reject' = 'defer';
    const authorizeReplacement = vi.fn(() => replacementDecision);
    const fence = new ExactRealMissionPhysicalPtyGate(
      'mission-e2e',
      [],
      'claude',
      authorizeReplacement,
    );
    const orchestratorAgent = (sessionId: string) =>
      ({
        sessionId,
        missionId: 'mission-e2e',
        adapterId: 'claude',
        role: 'orchestrator',
        agentName: 'E2E Orquestrador',
        squadId: 'agentic-nexus-real-mission-e2e',
        readOnly: false,
        nativeReadOnly: false,
      }) as unknown as PhysicalPtyAgent;
    const first = orchestratorAgent('session-orch-1');
    const recovery = orchestratorAgent('session-orch-2');

    expect(fence.inspect(first.sessionId, first)).toMatchObject({
      kind: 'accepted',
      identity: 'orchestrator',
    });
    expect(fence.inspect(recovery.sessionId, recovery)).toEqual({
      kind: 'deferred',
    });
    expect(fence.acceptedSessionCount).toBe(1);

    replacementDecision = 'accept';
    expect(fence.inspect(recovery.sessionId, recovery)).toMatchObject({
      kind: 'accepted',
      identity: 'orchestrator',
    });
    expect(fence.acceptedSessionCount).toBe(1);
    expect(authorizeReplacement).toHaveBeenCalled();
  });
});
