import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { testProjectScope } from "./__tests__/scope-fixture";

const deps = vi.hoisted(() => ({
  findPaneOwnedBy: vi.fn(),
  attachOrchMeta: vi.fn(),
  getOwnedAgentSessionInfo: vi.fn(),
  consumeMissionOrchestratorGrant: vi.fn(),
  bindOwnedAgentSessionMission: vi.fn(),
  hasMissionOrchestratorGrant: vi.fn(),
  rollbackOwnedAgentSessionMission: vi.fn(),
  requireRendererWorkspaceScope: vi.fn(),
  getContextBySession: vi.fn(),
  restoreSessionAuthority: vi.fn(),
  rollbackSessionAuthorityMission: vi.fn(),
  createMission: vi.fn(),
  getMission: vi.fn(),
  setMissionOrchestratorSession: vi.fn(),
  updateMission: vi.fn(),
  removeMission: vi.fn(),
  recordMissionPane: vi.fn(),
  removeMissionPane: vi.fn(),
  findMissionPaneByPaneId: vi.fn(),
  listMissionPanes: vi.fn(),
  forScope: vi.fn(),
  orientationEnsure: vi.fn(),
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

import { RendererMissionAuthority } from "./renderer-mission-authority";
import {
  getMissionPromptQueue,
  peekMissionPromptQueue,
  resetMissionPromptQueues,
} from "./mission-prompt-queue-registry";

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
  allowedTools: ["nexus_pane_spawn"],
  allowedSkills: ["review"],
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
  },
};
const authority = new RendererMissionAuthority(
  { forScope: deps.forScope } as never,
  () => "context-revision-a",
  () => true,
);

beforeEach(() => {
  vi.resetAllMocks();
  resetMissionPromptQueues();
  deps.getMission.mockReset();
  deps.setMissionOrchestratorSession.mockReset();
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
  deps.createMission.mockReturnValue(mission);
  deps.getMission.mockReturnValue(mission);
  deps.setMissionOrchestratorSession.mockReturnValue(mission);
  deps.updateMission.mockReturnValue(mission);
  deps.recordMissionPane.mockReturnValue({
    id: "mpane-new",
    missionId: "mission-a",
    paneId: "pane-a",
  });
  deps.orientationEnsure.mockResolvedValue({ status: "ready" });
  deps.forScope.mockReturnValue({
    missions: {
      create: deps.createMission,
      get: deps.getMission,
      setOrchestratorSession: deps.setMissionOrchestratorSession,
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
  it("turns the approved intent criteria into durable PREVC milestones", () => {
    authority.submitIntentFromRenderer(owner, {
      missionId: "mission-a",
      goal: "Implementar e revisar a correção",
      acceptanceCriteria: ["Implementação concluída", "QA sem regressões"],
    });

    expect(deps.updateMission).toHaveBeenCalledWith(
      "mission-a",
      expect.objectContaining({
        intentContract: expect.objectContaining({
          executionMode: "autopilot",
          lane: "standard",
        }),
        milestones: [
          {
            id: "step-1",
            label: "Implementação concluída",
            status: "pending",
            evidenceIds: [],
          },
          {
            id: "step-2",
            label: "QA sem regressões",
            status: "pending",
            evidenceIds: [],
          },
        ],
      }),
    );
  });

  it("propagates lane=consult into the intent contract (read-only delivery)", () => {
    authority.submitIntentFromRenderer(owner, {
      missionId: "mission-a",
      goal: "Ler logs da Vercel e resumir erros de deploy",
      lane: "consult",
    });

    expect(deps.updateMission).toHaveBeenCalledWith(
      "mission-a",
      expect.objectContaining({
        intentContract: expect.objectContaining({
          lane: "consult",
          budgets: expect.objectContaining({ maxWorkers: 0 }),
        }),
      }),
    );
  });

  it("delivers a submitted goal through the synchronous compiler queue", () => {
    const plannedMission = {
      ...mission,
      description: "Review the authentication flow",
      intentState: "awaiting_approval" as const,
      intentVersion: 1,
    };
    deps.updateMission.mockReturnValueOnce(plannedMission);

    expect(
      authority.submitIntentFromRenderer(owner, {
        missionId: mission.id,
        goal: "Review the authentication flow",
        source: "typed",
      }),
    ).toBe(plannedMission);

    const queue = getMissionPromptQueue(mission.id);
    expect(queue.executingId).toBeNull();
    expect(queue.items).toEqual([
      expect.objectContaining({
        kind: "user_goal",
        intentVersion: 1,
        status: "delivered",
      }),
    ]);
    expect(peekMissionPromptQueue(mission.id).queued).toHaveLength(0);
  });

  it("approves and dispatches a sensitive goal in one user action", () => {
    const awaitingApproval = {
      ...approvedMission,
      status: "pending" as const,
      intentState: "awaiting_approval" as const,
      intentContract: {
        ...approvedMission.intentContract,
        approvedAt: undefined,
        dispatchedAt: undefined,
      },
    };
    deps.getMission.mockReturnValueOnce(awaitingApproval);
    deps.updateMission.mockImplementationOnce(
      (_missionId: string, patch: Record<string, unknown>) => ({
        ...awaitingApproval,
        ...patch,
      }),
    );

    const result = authority.approveIntentFromRenderer(owner, {
      missionId: mission.id,
    });

    expect(result).toMatchObject({
      status: "running",
      intentState: "dispatched",
      intentContract: {
        intentVersion: 1,
        approvedAt: expect.any(Number),
        dispatchedAt: expect.any(Number),
      },
    });
    expect(deps.updateMission).toHaveBeenCalledWith(
      mission.id,
      expect.objectContaining({
        status: "running",
        intentState: "dispatched",
      }),
    );
  });

  it("keeps prepare-project executing until the main-owned warm completes", async () => {
    const preparedMission = {
      ...mission,
      intentState: "awaiting_goal" as const,
      intentVersion: 1,
    };
    deps.getMission.mockReturnValue(preparedMission);
    deps.updateMission.mockReturnValue(preparedMission);
    const result = await authority.prepareProjectFromRenderer(owner, {
      missionId: mission.id,
    });
    expect(result).toBe(preparedMission);
    expect(deps.orientationEnsure).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        reason: "pre-kickoff",
        force: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(peekMissionPromptQueue(mission.id).executing).toBeNull();
  });

  it("aborts the real prepare-project warm when renderer cancels", async () => {
    const preparedMission = {
      ...mission,
      intentState: "awaiting_goal" as const,
      intentVersion: 1,
    };
    deps.getMission.mockReturnValue(preparedMission);
    deps.updateMission.mockReturnValue(preparedMission);
    let observedSignal: AbortSignal | undefined;
    deps.orientationEnsure.mockImplementationOnce(
      async (_scope: unknown, options: { signal?: AbortSignal }) => {
        observedSignal = options.signal;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
        return { status: "ready" };
      },
    );
    const pending = authority.prepareProjectFromRenderer(owner, {
      missionId: mission.id,
    });
    await vi.waitFor(() => {
      expect(peekMissionPromptQueue(mission.id).executing?.kind).toBe("preflight");
    });
    expect(authority.cancelPreparationFromRenderer(owner, {
      missionId: mission.id,
    })).toEqual({ cancelled: true });
    await expect(pending).rejects.toThrow(/cancelled by a newer intent/i);
    expect(observedSignal?.aborted).toBe(true);
    expect(peekMissionPromptQueue(mission.id).cancelled).toHaveLength(1);
  });

  it("does not expose another workspace mission prompt queue", () => {
    deps.getMission.mockReturnValueOnce(null);
    expect(() => authority.getPromptQueueFromRenderer(owner, {
      missionId: "mission-b",
    })).toThrow(/mission not found/i);
  });

  it("never accepts renderer-authored done and scopes other edits", () => {
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        status: "done",
      }),
    ).toThrow(/PREVC workflow reaches complete/);
    expect(deps.updateMission).not.toHaveBeenCalled();

    expect(
      authority.updateMissionFromRenderer(owner, "mission-a", {
        title: "Safer title",
        status: "blocked",
      }),
    ).toBe(mission);
    expect(deps.requireRendererWorkspaceScope).toHaveBeenCalledWith(owner);
    expect(deps.forScope).toHaveBeenCalledWith(scope);
    expect(deps.updateMission).toHaveBeenCalledWith("mission-a", {
      title: "Safer title",
      status: "blocked",
    });
  });

  it("refuses to approve a contract compiled for an older intent version", () => {
    deps.getMission.mockReturnValueOnce({
      ...mission,
      intentState: "ready_to_start",
      intentVersion: 2,
      intentContract: {
        version: 1,
        source: "typed",
        goal: "Current-looking but stale goal",
        acceptanceCriteria: ["Done"],
        risk: "normal",
        executionMode: "assisted",
        contextPolicy: "on-demand",
        intentVersion: 1,
        budgets: {
          planningTokens: 1_200,
          executionTokens: 8_000,
          maxWorkers: 2,
        },
      },
    });

    expect(() =>
      authority.approveIntentFromRenderer(owner, { missionId: "mission-a" }),
    ).toThrow(/stale.*intent|intent.*version/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("records current approval and dispatch before a pane is bound", () => {
    const intentContract = {
      version: 1 as const,
      source: "typed" as const,
      goal: "Sensitive goal",
      acceptanceCriteria: ["Done"],
      risk: "elevated" as const,
      executionMode: "autopilot" as const,
      contextPolicy: "on-demand" as const,
      intentVersion: 1,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 2,
      },
    };
    deps.getMission.mockReturnValueOnce({
      ...mission,
      orchestratorSessionId: undefined,
      intentState: "awaiting_approval",
      intentVersion: 1,
      intentContract,
    });
    deps.updateMission.mockImplementationOnce((_id, patch) => ({
      ...mission,
      ...patch,
    }));

    authority.approveIntentFromRenderer(owner, { missionId: "mission-a" });

    expect(deps.updateMission).toHaveBeenCalledWith(
      "mission-a",
      expect.objectContaining({
        status: "running",
        intentState: "dispatched",
        intentContract: expect.objectContaining({
          approvedAt: expect.any(Number),
          dispatchedAt: expect.any(Number),
        }),
      }),
    );
  });

  it("rejects binding an approved plan that was not dispatched", () => {
    const approvedContract = {
      version: 1 as const,
      source: "typed" as const,
      goal: "Approved goal",
      acceptanceCriteria: ["Done"],
      risk: "normal" as const,
      executionMode: "autopilot" as const,
      contextPolicy: "on-demand" as const,
      intentVersion: 1,
      approvedAt: 100,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 2,
      },
    };
    const approvedMission = {
      ...mission,
      status: "pending" as const,
      orchestratorSessionId: undefined,
      intentState: "ready_to_start" as const,
      intentVersion: 1,
      intentContract: approvedContract,
    };
    deps.getMission.mockReturnValueOnce(approvedMission);

    expect(() =>
      authority.bindOrchestratorToMissionFromRenderer(owner, {
        missionId: "mission-a",
        title: "Review",
        squadId: "review-squad",
        orchestratorPane: { paneId: "pane-a" },
      }),
    ).toThrow(/approved and dispatched/i);
    expect(deps.recordMissionPane).not.toHaveBeenCalled();
  });

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

    expect(result).toBe(mission);
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
    });
    expect(deps.consumeMissionOrchestratorGrant).toHaveBeenCalledWith(
      owner,
      "pty-a",
      "review-squad",
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
      createdAt: 1,
    });

    expect(authority.restorePersistedPaneAuthority(owner, "pane-a")).toBe(true);
    expect(deps.restoreSessionAuthority).toHaveBeenCalledWith("pty-a", {
      missionId: "mission-a",
      contextRevision: "context-revision-a",
      role: "orchestrator",
      agentName: "Maestro",
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
    expect(deps.setMissionOrchestratorSession).toHaveBeenCalledWith(
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
    deps.listMissionPanes.mockReturnValueOnce([spec]);
    expect(authority.listMissionPanesForRenderer(owner, "mission-a")).toEqual([
      spec,
    ]);

    deps.listMissionPanes.mockReturnValueOnce([
      { ...spec, scope: testProjectScope({ projectId: "project-b" }) },
    ]);
    expect(() =>
      authority.listMissionPanesForRenderer(owner, "mission-a"),
    ).toThrow(/outside renderer workspace scope/);
  });
});
