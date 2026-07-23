import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { Squad } from "../../shared/orch-types";
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from "../../shared/pet-studio";
import { testProjectScope } from "./__tests__/scope-fixture";

const deps = vi.hoisted(() => ({
  findPaneOwnedBy: vi.fn(),
  attachOrchMeta: vi.fn(),
  getOwnedAgentSessionInfo: vi.fn(),
  consumeMissionOrchestratorGrant: vi.fn(),
  bindOwnedAgentSessionMission: vi.fn(),
  hasMissionOrchestratorGrant: vi.fn(),
  rollbackOwnedAgentSessionMission: vi.fn(),
  orchTerminateSession: vi.fn(async () => true),
  requireRendererWorkspaceScope: vi.fn(),
  getContextBySession: vi.fn(),
  restoreSessionAuthority: vi.fn(),
  rollbackSessionAuthorityMission: vi.fn(),
  createMission: vi.fn(),
  getMission: vi.fn(),
  setMissionOrchestratorSession: vi.fn(),
  rebindMissionOrchestratorSession: vi.fn(),
  updateMission: vi.fn(),
  removeMission: vi.fn(),
  recordMissionPane: vi.fn(),
  removeMissionPane: vi.fn(),
  findMissionPaneByPaneId: vi.fn(),
  listMissionPanes: vi.fn(),
  forScope: vi.fn(),
  orientationEnsure: vi.fn(),
  resolvePaneActivity: vi.fn(),
  validateAttachmentPaths: vi.fn(),
  snapshotAttachmentPaths: vi.fn(),
  requestMissionOrchestratorBootstrap: vi.fn(),
}));

vi.mock("./pane-registry", () => ({
  findPaneOwnedBy: deps.findPaneOwnedBy,
  attachOrchMeta: deps.attachOrchMeta,
}));

vi.mock("../pty/pty-manager", () => ({
  getOwnedAgentSessionInfo: deps.getOwnedAgentSessionInfo,
  consumeMissionOrchestratorGrant: deps.consumeMissionOrchestratorGrant,
  bindOwnedAgentSessionMission: deps.bindOwnedAgentSessionMission,
  hasMissionOrchestratorGrant: deps.hasMissionOrchestratorGrant,
  rollbackOwnedAgentSessionMission: deps.rollbackOwnedAgentSessionMission,
  orchTerminateSession: deps.orchTerminateSession,
}));

vi.mock("../persistence/renderer-workspace-scope", () => ({
  requireRendererWorkspaceScope: deps.requireRendererWorkspaceScope,
}));

vi.mock("./gate", () => ({
  getContextBySession: deps.getContextBySession,
  restoreSessionAuthority: deps.restoreSessionAuthority,
  rollbackSessionAuthorityMission: deps.rollbackSessionAuthorityMission,
}));

vi.mock("../context/orientation/orientation-service", () => ({
  tryGetProjectOrientationService: () => ({ ensure: deps.orientationEnsure }),
}));

vi.mock("./pane-activity-summary", () => ({
  resolveMissionPaneActivity: deps.resolvePaneActivity,
}));

import { RendererMissionAuthority } from "./renderer-mission-authority";
import { resetMissionPromptQueues } from "./mission-prompt-queue-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";

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
  () => true,
  deps.resolvePaneActivity,
  deps.validateAttachmentPaths,
  deps.requestMissionOrchestratorBootstrap,
  () => savedSquad,
  () => ({
    adapterId: "codex",
    model: "gpt-5.4",
    accountId: "account-a",
    effort: "high",
    readOnly: false,
    nativeReadOnly: true,
  }),
  deps.snapshotAttachmentPaths,
);

beforeEach(() => {
  vi.resetAllMocks();
  resetMissionPromptQueues();
  deps.getMission.mockReset();
  deps.setMissionOrchestratorSession.mockReset();
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
  deps.consumeMissionOrchestratorGrant.mockReturnValue(session);
  deps.bindOwnedAgentSessionMission.mockReturnValue(true);
  deps.hasMissionOrchestratorGrant.mockReturnValue(true);
  deps.requireRendererWorkspaceScope.mockReturnValue(scope);
  deps.getContextBySession.mockReturnValue({
    role: "orchestrator",
    scope,
    allowedTools: session.allowedTools,
    allowedSkills: session.allowedSkills,
  });
  deps.restoreSessionAuthority.mockReturnValue(true);
  deps.createMission.mockImplementation((input) => ({
    ...mission,
    ...input,
  }));
  deps.getMission.mockReturnValue(mission);
  deps.setMissionOrchestratorSession.mockReturnValue(mission);
  deps.rebindMissionOrchestratorSession.mockReturnValue(mission);
  deps.updateMission.mockImplementation((_missionId, patch) => ({
    ...((
      deps.createMission.mock.results.at(-1)?.value as
        | typeof mission
        | undefined
    ) ?? mission),
    ...patch,
  }));
  deps.recordMissionPane.mockReturnValue({
    id: "mpane-new",
    missionId: "mission-a",
    paneId: "pane-a",
  });
  deps.orientationEnsure.mockResolvedValue({ status: "ready" });
  deps.validateAttachmentPaths.mockImplementation((paths: string[]) =>
    paths.map((item) => `/validated/${item.split('/').at(-1)}`),
  );
  deps.snapshotAttachmentPaths.mockImplementation((paths: string[]) =>
    paths.map((attachmentPath) => ({
      path: attachmentPath,
      sha256: "a".repeat(64),
      size: 128,
    })),
  );
  deps.requestMissionOrchestratorBootstrap.mockResolvedValue({
    ok: true,
    missionId: mission.id,
  });
  deps.forScope.mockReturnValue({
    missions: {
      create: deps.createMission,
      get: deps.getMission,
      setOrchestratorSession: deps.setMissionOrchestratorSession,
      rebindOrchestratorSession: deps.rebindMissionOrchestratorSession,
      update: deps.updateMission,
      remove: deps.removeMission,
    },
    missionPanes: {
      record: deps.recordMissionPane,
      remove: deps.removeMissionPane,
      findByPaneId: deps.findMissionPaneByPaneId,
      list: deps.listMissionPanes,
    },
  });
});

describe("renderer mission authority", () => {
  it("rolls pane persistence back without revoking a dispatched contract", () => {
    deps.getMission.mockReturnValueOnce(approvedMission);
    deps.restoreSessionAuthority.mockReturnValueOnce(false);

    expect(() =>
      authority.bindOrchestratorToMissionFromRenderer(owner, {
        missionId: "mission-a",
        title: "Review",
        squadId: "review-squad",
        orchestratorPane: { paneId: "pane-a" },
      }),
    ).toThrow(/failed to bind mission/i);

    expect(deps.removeMissionPane).toHaveBeenCalledWith("mpane-new");
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

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

  it("creates from main-owned session metadata and ignores forged pane fields", () => {
    const result = authority.createMissionFromRenderer(owner, {
      title: "Review",
      squadId: "review-squad",
      orchestratorPane: {
        paneId: "pane-a",
        adapterId: "evil-adapter",
        model: "evil-model",
        accountId: "evil-account",
        cwd: "/etc",
        title: "evil-title",
        agentName: "evil-agent",
      },
    });

    expect(result).toMatchObject({
      id: mission.id,
      squadId: mission.squadId,
      status: "running",
    });
    expect(deps.createMission).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Review",
        squadId: "review-squad",
        orchestratorSessionId: "pty-a",
        intentState: "dispatched",
        intentVersion: 1,
        intentContract: expect.objectContaining({
          approvedAt: expect.any(Number),
          dispatchedAt: expect.any(Number),
          goal: expect.any(String),
          budgets: expect.objectContaining({ maxWorkers: expect.any(Number) }),
        }),
      }),
    );
    expect(deps.recordMissionPane).toHaveBeenCalledWith({
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
      allowedTools: ["nexus_pane_spawn"],
      allowedSkills: ["review"],
      authoritySeal: expect.objectContaining({
        intentVersion: 1,
        squadRevisionHash: snapshotSquadAuthority(savedSquad).hash,
      }),
    });
    expect(deps.consumeMissionOrchestratorGrant).toHaveBeenCalledWith(
      owner,
      "pty-a",
      "review-squad",
    );
  });

  it("rejects title drift after spawn, terminates the session and creates no mission", () => {
    deps.getOwnedAgentSessionInfo.mockReturnValueOnce({
      ...session,
      immediateMissionTitle: "Approved exact goal",
    });

    expect(() =>
      authority.createMissionFromRenderer(owner, {
        title: "Renderer-swapped goal",
        squadId: "review-squad",
        orchestratorPane: { paneId: "pane-a" },
      }),
    ).toThrow(/goal.*native-confirmed grant/i);
    expect(deps.orchTerminateSession).toHaveBeenCalledWith("pty-a");
    expect(deps.createMission).not.toHaveBeenCalled();
    expect(deps.recordMissionPane).not.toHaveBeenCalled();
  });

  it("persists the full native-confirmed Pet briefing as the canonical contract goal", () => {
    const goal =
      "Crie o mascote usando a referência exata `/ws/cat.png`; " +
      "execute geração, montagem, QA e empacote spritesheet.webp.";
    const petSession = {
      ...session,
      squadId: PET_STUDIO_SQUAD_ID,
      allowedTools: PET_STUDIO_SQUAD.agents[0]!.allowedTools,
      allowedSkills: PET_STUDIO_SQUAD.agents[0]!.allowedSkills,
      immediateMissionTitle: "Criar mascote cat",
      immediateMissionGoal: goal,
    };
    deps.getOwnedAgentSessionInfo.mockReturnValueOnce(petSession);
    deps.consumeMissionOrchestratorGrant.mockReturnValueOnce(petSession);
    deps.getContextBySession.mockReturnValueOnce({
      role: "orchestrator",
      scope,
      allowedTools: petSession.allowedTools,
      allowedSkills: petSession.allowedSkills,
    });
    const petAuthority = new RendererMissionAuthority(
      { forScope: deps.forScope } as never,
      () => "context-revision-a",
      () => true,
      deps.resolvePaneActivity,
      deps.validateAttachmentPaths,
      deps.requestMissionOrchestratorBootstrap,
      () => PET_STUDIO_SQUAD,
      () => ({
        adapterId: "codex",
        model: "gpt-5.4",
        accountId: "account-a",
        effort: "high",
        readOnly: false,
        nativeReadOnly: true,
      }),
      deps.snapshotAttachmentPaths,
    );

    petAuthority.createMissionFromRenderer(owner, {
      title: "Criar mascote cat",
      goal,
      squadId: PET_STUDIO_SQUAD_ID,
      orchestratorPane: { paneId: "pane-a" },
    });

    expect(deps.createMission).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Criar mascote cat",
        description: goal,
        intentContract: expect.objectContaining({
          goal,
          budgets: expect.objectContaining({ maxWorkers: 0 }),
          deniedTools: expect.arrayContaining([
            "pane_spawn",
            "route_task",
            "worktree_merge",
          ]),
        }),
      }),
    );
    const created = deps.createMission.mock.calls.at(-1)?.[0];
    expect(created.intentContract.acceptanceCriteria.join("\n")).not.toMatch(
      /workers?|PREVC/i,
    );
  });

  it("rejects immediate creation when main policy did not grant the exception", () => {
    const strictAuthority = new RendererMissionAuthority(
      { forScope: deps.forScope } as never,
      () => "context-revision-a",
      () => false,
    );

    expect(() =>
      strictAuthority.createMissionFromRenderer(owner, {
        title: "Review",
        squadId: "review-squad",
        orchestratorPane: { paneId: "pane-a" },
      }),
    ).toThrow(/immediate.*not authorized|intent-first/i);
    expect(deps.createMission).not.toHaveBeenCalled();
  });

  it("binds only with approval for the exact mission intent version", () => {
    deps.getMission.mockReturnValueOnce({
      ...approvedMission,
      intentVersion: 2,
    });

    expect(() =>
      authority.bindOrchestratorToMissionFromRenderer(owner, {
        missionId: "mission-a",
        title: "Review",
        squadId: "review-squad",
        orchestratorPane: { paneId: "pane-a" },
      }),
    ).toThrow(/approval_required|current intent/i);
    expect(deps.recordMissionPane).not.toHaveBeenCalled();
  });

  it("fails closed before creating when pane ownership or promotion is absent", () => {
    deps.findPaneOwnedBy.mockReturnValueOnce(null);
    expect(() =>
      authority.createMissionFromRenderer(owner, {
        title: "Review",
        squadId: "review-squad",
        orchestratorPane: { paneId: "pane-a" },
      }),
    ).toThrow(/owned registered pane/);
    expect(deps.createMission).not.toHaveBeenCalled();

    deps.findPaneOwnedBy.mockReturnValueOnce({
      paneId: "pane-a",
      sessionId: "pty-a",
      title: "A",
      kind: "cli-agent",
    });
    deps.hasMissionOrchestratorGrant.mockReturnValueOnce(false);
    expect(() =>
      authority.createMissionFromRenderer(owner, {
        title: "Review",
        squadId: "review-squad",
        orchestratorPane: { paneId: "pane-a" },
      }),
    ).toThrow(/promotion grant/);
    expect(deps.createMission).not.toHaveBeenCalled();
  });

  it("compensates a failed cross-store/session commit without consuming the grant", () => {
    deps.restoreSessionAuthority.mockReturnValueOnce(false);

    expect(() =>
      authority.createMissionFromRenderer(owner, {
        title: "Review",
        squadId: "review-squad",
        orchestratorPane: { paneId: "pane-a" },
      }),
    ).toThrow(/failed to bind mission/);

    expect(deps.removeMission).toHaveBeenCalledWith("mission-a");
    expect(deps.consumeMissionOrchestratorGrant).not.toHaveBeenCalled();
    expect(deps.rollbackOwnedAgentSessionMission).not.toHaveBeenCalled();
    expect(deps.orchTerminateSession).toHaveBeenCalledWith("pty-a");
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
});
