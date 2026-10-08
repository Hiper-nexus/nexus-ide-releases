import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { Squad } from "../../shared/orch-types";
import { testProjectScope } from "./__tests__/scope-fixture";

const deps = vi.hoisted(() => ({
  findPaneOwnedBy: vi.fn(),
  attachOrchMeta: vi.fn(),
  getOwnedAgentSessionInfo: vi.fn(),
  updateOwnedAgentSessionRole: vi.fn(),
  requireRendererWorkspaceScope: vi.fn(),
  getContextBySession: vi.fn(),
  restoreSessionAuthority: vi.fn(),
  promoteMissionSessionAuthority: vi.fn(),
  adoptUserSessionAsMissionOrchestrator: vi.fn(),
  adoptUserAgentSessionAsMissionOrchestrator: vi.fn(),
  getMission: vi.fn(),
  rebindMissionOrchestratorSession: vi.fn(),
  promotePaneToOrchestrator: vi.fn(),
  updateMission: vi.fn(),
  findMissionPaneByPaneId: vi.fn(),
  listMissionPanes: vi.fn(),
  forScope: vi.fn(),
  resolvePaneActivity: vi.fn(),
  getAdapter: vi.fn(),
  isBuiltinAdapter: vi.fn(),
  orchestrationEvidenceForAdapter: vi.fn(),
}));

vi.mock("./squad-store", () => ({
  getSquad: () => savedSquad,
  pinMissionRuntimeSquad: (squad: unknown) => squad,
}));
vi.mock("./pane-registry", () => ({
  findPaneOwnedBy: deps.findPaneOwnedBy,
  attachOrchMeta: deps.attachOrchMeta,
}));

vi.mock("../pty/pty-manager", () => ({
  getOwnedAgentSessionInfo: deps.getOwnedAgentSessionInfo,
  updateOwnedAgentSessionRole: deps.updateOwnedAgentSessionRole,
  adoptUserAgentSessionAsMissionOrchestrator: deps.adoptUserAgentSessionAsMissionOrchestrator,
  returnAdoptedAgentSessionToUser: vi.fn(),
}));

vi.mock("../persistence/renderer-workspace-scope", () => ({
  requireRendererWorkspaceScope: deps.requireRendererWorkspaceScope,
}));

vi.mock("./gate", () => ({
  getContextBySession: deps.getContextBySession,
  restoreSessionAuthority: deps.restoreSessionAuthority,
  promoteMissionSessionAuthority: deps.promoteMissionSessionAuthority,
  adoptUserSessionAsMissionOrchestrator: deps.adoptUserSessionAsMissionOrchestrator,
  demoteMissionOrchestratorSession: vi.fn(),
  rollbackSessionAuthorityMission: vi.fn(),
}));

vi.mock("../adapters/adapter-registry", () => ({
  getAdapter: deps.getAdapter,
  isBuiltinAdapter: deps.isBuiltinAdapter,
  orchestrationEvidenceForAdapter: deps.orchestrationEvidenceForAdapter,
}));


vi.mock("./pane-activity-summary", () => ({
  resolveMissionPaneActivity: deps.resolvePaneActivity,
}));

import { RendererMissionAuthority } from "./renderer-mission-authority";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { createMissionPaneAuthoritySeal } from "./mission-pane-authority";
import { beginOperatorTabResumeTransfer } from "./operator-tab-mission-resume";

const owner = { id: 7 } as WebContents;
const scope = testProjectScope({
  projectId: "project-a",
  checkoutId: "checkout-a",
  rootRealPath: "/workspace/a",
});
const mission = {
  id: "mission-a",
  title: "Review",
  description: "",
  status: "pending" as const,
  squadId: "review-squad",
  milestones: [],
  learnings: "",
  orchestratorSessionId: "pty-a",
  createdAt: 1,
  updatedAt: 1,
};
const session = {
  sessionId: "pty-a",
  paneId: "pane-a",
  adapterId: "codex",
  model: "gpt-5.4",
  accountId: "account-a",
  effort: "high",
  cwd: "/workspace/a/packages/app",
  scope,
  source: "legacy-squad" as const,
  role: "orchestrator" as const,
  squadId: "review-squad",
  agentName: "Maestro",
  immediateMissionTitle: "Review",
  immediateMissionGoal: "Review",
  allowedTools: ["nexus_pane_spawn"],
  allowedSkills: ["review"],
};
const savedSquad: Squad = {
  id: "review-squad",
  name: "Review squad",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "## Política\nCoordene pelo Nexus.",
  agents: [
    {
      id: "orch",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "codex",
      allowedTools: ["nexus_pane_spawn"],
      allowedSkills: ["review"],
    },
  ],
};
const approvedMission = {
  ...mission,
  status: "running" as const,
  intentState: "dispatched" as const,
  intentVersion: 1,
  intentContract: {
    version: 1 as const,
    source: "typed" as const,
    goal: "Review",
    acceptanceCriteria: ["Done"],
    risk: "normal" as const,
    executionMode: "assisted" as const,
    contextPolicy: "on-demand" as const,
    intentVersion: 1,
    approvedAt: 100,
    dispatchedAt: 100,
    budgets: {
      planningTokens: 1_200,
      executionTokens: 8_000,
      maxWorkers: 2,
    },
    squadRevisionHash: snapshotSquadAuthority(savedSquad).hash,
  },
};
const authority = new RendererMissionAuthority(
  { forScope: deps.forScope } as never,
  () => "context-revision-a",
  deps.resolvePaneActivity,
);

beforeEach(() => {
  vi.resetAllMocks();
  deps.getMission.mockReset();
  deps.rebindMissionOrchestratorSession.mockReset();
  deps.updateMission.mockReset();
  deps.findPaneOwnedBy.mockReturnValue({
    paneId: "pane-a",
    sessionId: "pty-a",
    title: "renderer-controlled title",
    kind: "cli-agent",
    adapterId: "renderer-controlled-adapter",
  });
  deps.getOwnedAgentSessionInfo.mockReturnValue(session);
  deps.requireRendererWorkspaceScope.mockReturnValue(scope);
  deps.getContextBySession.mockReturnValue({
    role: "orchestrator",
    scope,
    allowedTools: session.allowedTools,
    allowedSkills: session.allowedSkills,
  });
  deps.restoreSessionAuthority.mockReturnValue(true);
  deps.promoteMissionSessionAuthority.mockReturnValue(true);
  deps.updateOwnedAgentSessionRole.mockReturnValue(true);
  deps.adoptUserSessionAsMissionOrchestrator.mockReturnValue(true);
  deps.adoptUserAgentSessionAsMissionOrchestrator.mockReturnValue(true);
  deps.getMission.mockReturnValue(mission);
  deps.rebindMissionOrchestratorSession.mockReturnValue(mission);
  deps.promotePaneToOrchestrator.mockReturnValue({
    ...session,
    id: "mpane-promoted",
    missionId: "mission-a",
    paneId: "pane-a",
    role: "orchestrator",
  });
  deps.updateMission.mockReturnValue(mission);
  deps.getAdapter.mockReturnValue({ id: "codex", kind: "cli-pty" });
  deps.isBuiltinAdapter.mockReturnValue(true);
  deps.orchestrationEvidenceForAdapter.mockReturnValue("verified");
  deps.forScope.mockReturnValue({
    missions: {
      get: deps.getMission,
      rebindOrchestratorSession: deps.rebindMissionOrchestratorSession,
      update: deps.updateMission,
    },
    missionPanes: {
      findByPaneId: deps.findMissionPaneByPaneId,
      list: deps.listMissionPanes,
      promotePaneToOrchestrator: deps.promotePaneToOrchestrator,
    },
  });
});

describe("renderer mission authority", () => {

  it("rejects renderer-forged milestone completion and evidence", () => {
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        milestones: [
          {
            id: "step-a",
            label: "Forged",
            status: "done",
            evidenceIds: ["evidence-forged"],
          },
        ],
      }),
    ).toThrow(/milestone completion.*Nexus/i);

    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        milestones: [
          {
            id: "step-a",
            label: "Forged",
            status: "in-progress",
            evidenceIds: ["evidence-forged"],
          },
        ],
      }),
    ).toThrow(/milestone completion.*Nexus/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("rejects duplicate milestone ids and any mutation after completion", () => {
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        milestones: [
          { id: "same", label: "One" },
          { id: "same", label: "Two" },
        ],
      }),
    ).toThrow(/ids must be unique/i);

    deps.getMission.mockReturnValueOnce({ ...mission, status: "done" });
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        status: "blocked",
      }),
    ).toThrow(/completed missions are immutable/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("does not let renderer replacement erase a completed milestone", () => {
    deps.getMission.mockReturnValueOnce({
      ...mission,
      status: "running",
      milestones: [
        {
          id: "step-a",
          label: "Verified",
          status: "done",
          evidenceIds: ["evidence-a"],
        },
      ],
    });
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        milestones: [{ id: "step-b", label: "Replacement" }],
      }),
    ).toThrow(/completed mission milestones are immutable/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });


  it("restores only the owned persisted pane with the same scope and runtime metadata", () => {
    deps.getMission.mockReturnValue(approvedMission);
    deps.getContextBySession.mockReturnValue({
      role: "orchestrator",
      missionId: "mission-a",
      scope,
    });
    deps.getOwnedAgentSessionInfo.mockReturnValueOnce({
      ...session,
      source: "persisted-pane",
      missionId: "mission-a",
      readOnly: true,
    });
    deps.findMissionPaneByPaneId.mockReturnValue({
      id: "mpane-a",
      missionId: "mission-a",
      paneId: "pane-a",
      adapterId: "codex",
      model: "gpt-5.4",
      accountId: "account-a",
      effort: "high",
      cwd: "/workspace/a/packages/app",
      title: "Review · orq",
      agentName: "Maestro",
      role: "orchestrator",
      scope,
      allowedTools: ["nexus_pane_spawn"],
      allowedSkills: ["review"],
      readOnly: true,
      createdAt: 1,
    });

    expect(authority.restorePersistedPaneAuthority(owner, "pane-a")).toBe(true);
    expect(deps.restoreSessionAuthority).toHaveBeenCalledWith("pty-a", {
      missionId: "mission-a",
      contextRevision: "context-revision-a",
      role: "orchestrator",
      agentName: "Maestro",
      readOnly: true,
      allowedTools: ["nexus_pane_spawn"],
      allowedSkills: ["review"],
    });

    deps.getOwnedAgentSessionInfo.mockReturnValueOnce({
      ...session,
      source: "persisted-pane",
      scope: testProjectScope({ projectId: "project-b" }),
    });
    expect(authority.restorePersistedPaneAuthority(owner, "pane-a")).toBe(
      false,
    );

    deps.getOwnedAgentSessionInfo.mockReturnValueOnce({
      ...session,
      source: "persisted-pane",
      missionId: "mission-a",
    });
    deps.getMission.mockReturnValueOnce({
      ...approvedMission,
      intentVersion: 2,
    });
    expect(authority.restorePersistedPaneAuthority(owner, "pane-a")).toBe(false);
    expect(deps.restoreSessionAuthority).toHaveBeenCalledTimes(1);
  });

  it("rebinds only an owned restored orchestrator session for that mission", () => {
    deps.getMission.mockReturnValue({
      ...approvedMission,
      orchestratorSessionId: "pty-old",
    });
    deps.getContextBySession.mockReturnValue({
      role: "orchestrator",
      missionId: "mission-a",
      scope,
    });
    deps.getOwnedAgentSessionInfo.mockReturnValue({
      ...session,
      source: "persisted-pane",
      missionId: "mission-a",
    });
    deps.findMissionPaneByPaneId.mockReturnValue({
      id: "mpane-a",
      missionId: "mission-a",
      paneId: "pane-a",
      adapterId: "codex",
      model: "gpt-5.4",
      accountId: "account-a",
      effort: "high",
      cwd: session.cwd,
      title: "Review · orq",
      role: "orchestrator",
      scope,
      createdAt: 1,
    });

    expect(
      authority.rebindMissionFromRenderer(owner, "mission-a", "pty-a"),
    ).toBe(mission);
    expect(deps.rebindMissionOrchestratorSession).toHaveBeenCalledWith(
      "mission-a",
      "pty-a",
    );

    expect(
      authority.rebindMissionFromRenderer(owner, "mission-b", "pty-a"),
    ).toBeNull();
  });

  it("promotes any owned live mission pane to orchestrator by explicit operator action", () => {
    deps.getMission.mockReturnValue({
      ...approvedMission,
      orchestratorSessionId: "pty-old",
    });
    deps.findPaneOwnedBy.mockReturnValue({
      paneId: "pane-worker",
      sessionId: "pty-worker",
      title: "OpenCode worker",
      kind: "cli-agent",
      adapterId: "opencode",
    });
    deps.getOwnedAgentSessionInfo.mockReturnValue({
      ...session,
      sessionId: "pty-worker",
      paneId: "pane-worker",
      adapterId: "opencode",
      role: "worker",
      missionId: "mission-a",
      workerIncarnationId: "worker-incarnation-opencode",
      allowedTools: ["nexus_handoff_submit"],
    });
    deps.getContextBySession.mockReturnValue({
      role: "worker",
      missionId: "mission-a",
      scope,
      allowedTools: ["nexus_handoff_submit"],
      allowedSkills: null,
    });
    deps.getAdapter.mockReturnValue({ id: "opencode", kind: "cli-pty" });
    deps.isBuiltinAdapter.mockReturnValue(false);
    deps.orchestrationEvidenceForAdapter.mockReturnValue("experimental");
    deps.rebindMissionOrchestratorSession.mockReturnValue(approvedMission);

    const result = authority.promoteOrchestratorFromRenderer(
      owner,
      "mission-a",
      { paneId: "pane-worker" },
    );

    expect(result).toEqual({
      ok: true,
      mission: approvedMission,
      warning:
        'Provider "opencode" não é orquestrador verificado; promoção livre aplicada por ação explícita do operador.',
    });
    expect(deps.promotePaneToOrchestrator).toHaveBeenCalledWith(
      "mission-a",
      "pane-worker",
    );
    expect(deps.rebindMissionOrchestratorSession).toHaveBeenCalledWith(
      "mission-a",
      "pty-worker",
    );
    expect(deps.promoteMissionSessionAuthority).toHaveBeenCalledWith({
      missionId: "mission-a",
      promotedSessionId: "pty-worker",
      previousSessionId: "pty-old",
    });
    expect(deps.updateOwnedAgentSessionRole).toHaveBeenCalledWith(
      "pty-worker",
      {
        role: "orchestrator",
        missionId: "mission-a",
        allowedTools: null,
        allowedSkills: null,
        workerIncarnationId: null,
      },
    );
    expect(deps.attachOrchMeta).toHaveBeenCalledWith(
      owner,
      "pane-worker",
      expect.objectContaining({
        missionId: "mission-a",
        role: "orchestrator",
        scope,
        allowedTools: null,
      }),
    );
  });

  it("rejects promotion for a dead pane or another mission", () => {
    deps.getMission.mockReturnValue(approvedMission);
    deps.findPaneOwnedBy.mockReturnValueOnce(null);
    expect(
      authority.promoteOrchestratorFromRenderer(owner, "mission-a", {
        paneId: "pane-missing",
      }),
    ).toEqual({ ok: false, error: "pane_unavailable" });

    deps.findPaneOwnedBy.mockReturnValueOnce({
      paneId: "pane-worker",
      sessionId: "pty-worker",
      title: "Worker",
      kind: "cli-agent",
    });
    deps.getOwnedAgentSessionInfo.mockReturnValueOnce({
      ...session,
      sessionId: "pty-worker",
      paneId: "pane-worker",
      role: "worker",
      missionId: "mission-b",
    });
    expect(
      authority.promoteOrchestratorFromRenderer(owner, "mission-a", {
        paneId: "pane-worker",
      }),
    ).toEqual({ ok: false, error: "pane_mission_mismatch" });
  });

  it("F-996: revisor somente leitura da missão nunca vira orquestrador — nada é gravado", () => {
    deps.getMission.mockReturnValue({
      ...approvedMission,
      orchestratorSessionId: "pty-operator",
    });
    deps.findPaneOwnedBy.mockReturnValue({
      paneId: "pane-reviewer",
      sessionId: "pty-reviewer",
      title: "Revisão sênior · núcleo + segurança",
      kind: "cli-agent",
      adapterId: "codex",
    });
    const reviewer = {
      ...session,
      sessionId: "pty-reviewer",
      paneId: "pane-reviewer",
      adapterId: "codex",
      role: "worker" as const,
      missionId: "mission-a",
      workerIncarnationId: "worker-incarnation-reviewer",
      allowedTools: ["nexus_handoff_submit"],
    };
    const reviewerGate = {
      role: "worker",
      missionId: "mission-a",
      scope,
      allowedTools: ["nexus_handoff_submit"],
      allowedSkills: null,
    };

    // Cada sinal de somente leitura basta: ficha PTY, gate ou composição.
    for (const variant of ["pty", "gate", "spec"] as const) {
      deps.getOwnedAgentSessionInfo.mockReturnValue({
        ...reviewer,
        readOnly: variant === "pty",
      });
      deps.getContextBySession.mockReturnValue({
        ...reviewerGate,
        ...(variant === "gate" ? { readOnly: true } : {}),
      });
      deps.findMissionPaneByPaneId.mockReturnValue(
        variant === "spec"
          ? { id: "mpane-reviewer", missionId: "mission-a", paneId: "pane-reviewer", role: "worker", readOnly: true }
          : null,
      );

      expect(
        authority.promoteOrchestratorFromRenderer(owner, "mission-a", {
          paneId: "pane-reviewer",
        }),
      ).toEqual({ ok: false, error: "pane_read_only" });
    }
    expect(deps.promotePaneToOrchestrator).not.toHaveBeenCalled();
    expect(deps.rebindMissionOrchestratorSession).not.toHaveBeenCalled();
    expect(deps.promoteMissionSessionAuthority).not.toHaveBeenCalled();
    expect(deps.updateOwnedAgentSessionRole).not.toHaveBeenCalled();
    expect(deps.attachOrchMeta).not.toHaveBeenCalled();
  });

  it("F-996: o líder delegate-only (readOnly) da própria missão ainda é reconfirmado", () => {
    deps.getMission.mockReturnValue(approvedMission);
    deps.getOwnedAgentSessionInfo.mockReturnValue({
      ...session,
      missionId: "mission-a",
      readOnly: true,
    });
    deps.getContextBySession.mockReturnValue({
      role: "orchestrator",
      missionId: "mission-a",
      scope,
      readOnly: true,
      allowedTools: session.allowedTools,
      allowedSkills: session.allowedSkills,
    });
    deps.rebindMissionOrchestratorSession.mockReturnValue(approvedMission);

    expect(
      authority.promoteOrchestratorFromRenderer(owner, "mission-a", {
        paneId: "pane-a",
      }),
    ).toMatchObject({ ok: true });
  });

  describe("createPaneMissionFromRenderer (missão leve da aba)", () => {
    function wireLightMissionStore() {
      const created: Record<string, unknown>[] = [];
      let stored: Record<string, unknown> | null = null;
      const create = vi.fn((input: Record<string, unknown>) => {
        stored = { ...mission, ...input, id: "mission-light", status: "pending", squadId: undefined };
        created.push(input);
        return stored;
      });
      const update = vi.fn((_id: string, patch: Record<string, unknown>) => {
        stored = { ...stored!, ...patch };
        return stored;
      });
      const remove = vi.fn(() => true);
      deps.listMissionPanes.mockReturnValue([]);
      deps.getContextBySession.mockReturnValue({ role: "user", scope, allowedTools: null, allowedSkills: null });
      deps.getMission.mockImplementation((id: string) => (id === "mission-light" ? stored : null));
      deps.rebindMissionOrchestratorSession.mockImplementation(() => stored);
      deps.forScope.mockReturnValue({
        missions: {
          get: deps.getMission,
          list: () => [],
          create,
          update,
          remove,
          rebindOrchestratorSession: deps.rebindMissionOrchestratorSession,
        },
        missionPanes: {
          findByPaneId: deps.findMissionPaneByPaneId,
          list: deps.listMissionPanes,
          remove: vi.fn(),
          promotePaneToOrchestrator: deps.promotePaneToOrchestrator,
        },
      });
      return { created, create, update, remove };
    }

    it("cria missão Autopilot livre, sem squad, liderada pelo pane solto", () => {
      const store = wireLightMissionStore();
      deps.findPaneOwnedBy.mockReturnValue({
        paneId: "pane-b",
        sessionId: "pty-b",
        title: "Claude",
        kind: "cli-agent",
      });
      deps.getOwnedAgentSessionInfo.mockReturnValue({
        ...session,
        sessionId: "pty-b",
        paneId: "pane-b",
        role: "user",
        missionId: undefined,
        squadId: undefined,
      });

      const result = authority.createPaneMissionFromRenderer(owner, {
        paneId: "pane-b",
        title: "Missão · Checkout",
      });

      expect(result.ok).toBe(true);
      expect(result.mission?.id).toBe("mission-light");
      const input = store.created[0]!;
      expect(input.title).toBe("Missão · Checkout");
      expect(input.squadId).toBeUndefined();
      expect(input.orchestratorSessionId).toBe("pty-b");
      expect(input.intentContract).toMatchObject({
        executionMode: "autopilot",
        freeAgentChoice: true,
        workspaceBinding: { version: 1, adoptedPaneId: "pane-b" },
      });
      expect(store.update).toHaveBeenCalledWith("mission-light", { status: "running" });
      // A sessão `user` é ADOTADA (gate + ficha PTY), não "trocada de papel":
      // a primitiva de troca recusa `user` (P1 da revisão cruzada).
      expect(deps.adoptUserSessionAsMissionOrchestrator).toHaveBeenCalledWith(
        "pty-b",
        "mission-light",
        "context-revision-a",
      );
      expect(deps.adoptUserAgentSessionAsMissionOrchestrator).toHaveBeenCalledWith(
        "pty-b",
        "mission-light",
      );
      expect(deps.promoteMissionSessionAuthority).not.toHaveBeenCalled();
      // Nenhum outro orquestrador é tocado.
      expect(deps.updateOwnedAgentSessionRole).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
    });

    it("não arranca pane de outra missão e não cria nada", () => {
      const store = wireLightMissionStore();
      deps.findPaneOwnedBy.mockReturnValue({
        paneId: "pane-a",
        sessionId: "pty-a",
        kind: "cli-agent",
      });
      deps.getOwnedAgentSessionInfo.mockReturnValue({ ...session, missionId: "mission-a" });

      expect(
        authority.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · A" }),
      ).toEqual({ ok: false, error: "pane_mission_mismatch" });
      expect(store.create).not.toHaveBeenCalled();
      expect(deps.updateOwnedAgentSessionRole).not.toHaveBeenCalled();
    });

    it("promoção recusada desfaz a missão recém-criada", () => {
      const store = wireLightMissionStore();
      deps.findPaneOwnedBy.mockReturnValue({
        paneId: "pane-b",
        sessionId: "pty-b",
        kind: "cli-agent",
      });
      deps.getOwnedAgentSessionInfo.mockReturnValue({
        ...session,
        sessionId: "pty-b",
        paneId: "pane-b",
        role: "user",
        missionId: undefined,
      });
      deps.promotePaneToOrchestrator.mockReturnValue(null);
      deps.findMissionPaneByPaneId.mockReturnValue(null);
      store.create.mockImplementationOnce(() => ({ ...mission, id: "mission-light" }));
      deps.rebindMissionOrchestratorSession.mockReturnValue(null);

      const result = authority.createPaneMissionFromRenderer(owner, {
        paneId: "pane-b",
        title: "Missão · B",
      });
      expect(result.ok).toBe(false);
      expect(store.remove).toHaveBeenCalledWith("mission-light");
    });
  });

  it("lists reopen specs only inside the renderer main-owned scope", () => {
    const spec = {
      id: "mpane-a",
      missionId: "mission-a",
      paneId: "pane-a",
      adapterId: "codex",
      cwd: session.cwd,
      title: "Review · orq",
      role: "orchestrator" as const,
      scope,
      createdAt: 1,
    };
    // Activity summary rides the persisted-panes channel (zero-LLM harvest).
    const activity = {
      title: "review the diff",
      lastLine: "done",
      stoppedAt: 123,
      source: "transcript" as const,
    };
    deps.resolvePaneActivity.mockReturnValue(activity);
    deps.listMissionPanes.mockReturnValueOnce([spec]);
    expect(authority.listMissionPanesForRenderer(owner, "mission-a")).toEqual([
      { ...spec, activity },
    ]);
    expect(deps.resolvePaneActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        scope,
        paneId: "pane-a",
        adapterId: "codex",
        cwd: session.cwd,
      }),
    );

    // Resolver failures degrade to null — never break the reopen path.
    deps.resolvePaneActivity.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    deps.listMissionPanes.mockReturnValueOnce([spec]);
    expect(authority.listMissionPanesForRenderer(owner, "mission-a")).toEqual([
      { ...spec, activity: null },
    ]);

    deps.listMissionPanes.mockReturnValueOnce([
      { ...spec, scope: testProjectScope({ projectId: "project-b" }) },
    ]);
    expect(() =>
      authority.listMissionPanesForRenderer(owner, "mission-a"),
    ).toThrow(/outside renderer workspace scope/);
  });

  it("confirms restore only for the exact pane on the current approved revision", () => {
    const authoritySeal = createMissionPaneAuthoritySeal({
      mission: approvedMission,
      squad: savedSquad,
    });
    expect(authoritySeal).not.toBeNull();
    deps.getMission.mockReturnValue(approvedMission);
    deps.findMissionPaneByPaneId.mockReturnValue({
      id: "mpane-a",
      missionId: "mission-a",
      paneId: "pane-a",
      adapterId: "codex",
      cwd: session.cwd,
      title: "Review · orq",
      role: "orchestrator",
      scope,
      authoritySeal,
      createdAt: 1,
    });

    expect(
      authority.canRestoreMissionPaneForRenderer(
        owner,
        "mission-a",
        "pane-a",
      ),
    ).toBe(true);
    expect(
      authority.canRestoreMissionPaneForRenderer(
        owner,
        "mission-a",
        "pane-forged",
      ),
    ).toBe(false);

    // F-721: enquanto a retomada da aba leva a conversa deste líder para
    // outro pane, o restore do renderer não o religa.
    const release = beginOperatorTabResumeTransfer("mission-a", "pane-a");
    try {
      expect(
        authority.canRestoreMissionPaneForRenderer(owner, "mission-a", "pane-a"),
      ).toBe(false);
    } finally {
      release?.();
    }
    expect(
      authority.canRestoreMissionPaneForRenderer(owner, "mission-a", "pane-a"),
    ).toBe(true);
  });

  it("restaura pane cujo selo de workflow rotacionou no restart (aprovação intacta)", () => {
    const authoritySeal = createMissionPaneAuthoritySeal({
      mission: approvedMission,
      squad: savedSquad,
    });
    expect(authoritySeal).not.toBeNull();
    deps.getMission.mockReturnValue(approvedMission);
    deps.findMissionPaneByPaneId.mockReturnValue({
      id: "mpane-rotated",
      missionId: "mission-a",
      paneId: "pane-rotated",
      adapterId: "codex",
      cwd: session.cwd,
      title: "Motor",
      role: "worker",
      scope,
      authoritySeal: {
        ...authoritySeal!,
        contextRevision: "workflow-before-restart",
        contractHash: "workflow-before-restart",
      },
      createdAt: 1,
    });

    expect(
      authority.canRestoreMissionPaneForRenderer(
        owner,
        "mission-a",
        "pane-rotated",
      ),
    ).toBe(true);
  });

  it("recusa restore quando a aprovação (intent) mudou — isso pede replane", () => {
    const authoritySeal = createMissionPaneAuthoritySeal({
      mission: approvedMission,
      squad: savedSquad,
    });
    expect(authoritySeal).not.toBeNull();
    deps.getMission.mockReturnValue(approvedMission);
    deps.findMissionPaneByPaneId.mockReturnValue({
      id: "mpane-replanned",
      missionId: "mission-a",
      paneId: "pane-replanned",
      adapterId: "codex",
      cwd: session.cwd,
      title: "Motor",
      role: "worker",
      scope,
      authoritySeal: {
        ...authoritySeal!,
        intentVersion: 2,
        intentContractHash: "approved-then-replanned",
      },
      createdAt: 1,
    });

    expect(
      authority.canRestoreMissionPaneForRenderer(
        owner,
        "mission-a",
        "pane-replanned",
      ),
    ).toBe(false);
  });

  it("restaura pane sem selo gravado (Via Rápida não grava selo de autoridade)", () => {
    deps.getMission.mockReturnValue(approvedMission);
    deps.findMissionPaneByPaneId.mockReturnValue({
      id: "mpane-legacy",
      missionId: "mission-a",
      paneId: "pane-legacy",
      adapterId: "codex",
      cwd: session.cwd,
      title: "Legacy",
      role: "orchestrator",
      scope,
      createdAt: 1,
    });

    expect(
      authority.canRestoreMissionPaneForRenderer(
        owner,
        "mission-a",
        "pane-legacy",
      ),
    ).toBe(true);
  });

  it("never exposes a legacy PREVC reviewer to renderer reopen", () => {
    const orchestrator = {
      id: "mpane-orchestrator",
      missionId: "mission-a",
      paneId: "pane-orchestrator",
      adapterId: "codex",
      cwd: session.cwd,
      executionScope: scope,
      title: "Maestro",
      role: "orchestrator" as const,
      scope,
      createdAt: 1,
    };
    const reviewerSuffix = "a1b2c3d4e5f6";
    const ephemeralReviewer = {
      id: "mpane-reviewer",
      missionId: "mission-a",
      paneId: "pane-reviewer",
      adapterId: "claude",
      cwd: "/tmp/nexus-prevc-review-crashed/checkout",
      executionScope: {
        ...scope,
        rootRealPath: "/tmp/nexus-prevc-review-crashed/checkout",
      },
      title: `review-mission-a-1-${reviewerSuffix}`,
      agentName: `reviewer-claude-1-${reviewerSuffix}`,
      role: "worker" as const,
      readOnly: true,
      allowedTools: ["nexus_git_diff", "nexus_merge_review_submit"],
      scope,
      createdAt: 2,
    };
    deps.resolvePaneActivity.mockReturnValue(null);
    deps.listMissionPanes.mockReturnValueOnce([
      orchestrator,
      ephemeralReviewer,
    ]);

    expect(
      authority.listMissionPanesForRenderer(owner, "mission-a"),
    ).toEqual([
      expect.objectContaining({ paneId: "pane-orchestrator" }),
    ]);
    expect(deps.resolvePaneActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ paneId: "pane-reviewer" }),
    );
  });
});
