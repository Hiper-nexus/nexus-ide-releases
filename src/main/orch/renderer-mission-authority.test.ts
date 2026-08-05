import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { Handoff, Mission, Squad } from "../../shared/orch-types";
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
  bindMissionRuntimeSquad: vi.fn(),
  commitPlanPromotionRevision: vi.fn(),
  blockMission: vi.fn(),
  removeMission: vi.fn(),
  removeMissionIfUnchanged: vi.fn(),
  recordMissionPane: vi.fn(),
  removeMissionPane: vi.fn(),
  findMissionPaneByPaneId: vi.fn(),
  listMissionPanes: vi.fn(),
  listHandoffs: vi.fn(),
  getHandoff: vi.fn(),
  listTasks: vi.fn(),
  forScope: vi.fn(),
  orientationEnsure: vi.fn(),
  resolvePaneActivity: vi.fn(),
  validateAttachmentPaths: vi.fn(),
  snapshotAttachmentPaths: vi.fn(),
  requestMissionOrchestratorBootstrap: vi.fn(),
  ensureMissionPlanBeforeBootstrap: vi.fn(),
  resolveOrchestratorRuntime: vi.fn(),
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
import {
  getMissionPromptQueue,
  peekMissionPromptQueue,
  resetMissionPromptQueues,
} from "./mission-prompt-queue-registry";
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
const savedSquad: Squad = {
  id: "review-squad",
  name: "Review squad",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "## Política\nCoordene pelo contrato Nexus.",
  agents: [
    {
      id: "orch",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "codex",
      allowedTools: ["nexus_task"],
      allowedSkills: ["check-work"],
    },
  ],
};
const approvedRuntime = Object.freeze({
  adapterId: "codex",
  model: "gpt-5.6-sol",
  accountId: "account-a",
  effort: "high",
  readOnly: false as const,
  nativeReadOnly: true as const,
});

function physicalPlanHandoff(
  sessionId: string,
  issuedAt: number,
): Handoff {
  return {
    id: `handoff-${sessionId}`,
    missionId: mission.id,
    sessionId,
    fromAgent: "Maestro",
    authorityOrigin: "agent",
    mcpProvenance: {
      receiptId: `receipt-${sessionId}`,
      toolCallId: `tool-${sessionId}`,
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      missionId: mission.id,
      sessionId,
      authoritySha256: "a".repeat(64),
      issuedAt,
    },
    status: "success",
    claimTrust: "untrusted",
    summary: "# PRD\nPlano físico aprovado.",
    artifacts: [{ path: "plan.md" }],
    evidenceIds: [],
    evidenceTrust: "unverified",
    delivered: false,
    deliveryState: "queued",
    createdAt: issuedAt,
  };
}

const identityPin = (squad: Squad): Squad => squad;

const authority = new RendererMissionAuthority(
  { forScope: deps.forScope } as never,
  () => "context-revision-a",
  () => true,
  deps.resolvePaneActivity,
  deps.validateAttachmentPaths,
  deps.requestMissionOrchestratorBootstrap,
  () => savedSquad,
  deps.resolveOrchestratorRuntime,
  deps.snapshotAttachmentPaths,
  deps.ensureMissionPlanBeforeBootstrap,
  () => undefined,
  identityPin,
);

function useStatefulMission(initial: Mission): () => Mission {
  let current = initial;
  deps.getMission.mockImplementation(() => current);
  deps.updateMission.mockImplementation(
    (_missionId: string, patch: Partial<Mission>) => {
      current = { ...current, ...patch };
      return current;
    },
  );
  deps.bindMissionRuntimeSquad.mockImplementation(
    (_missionId: string, _expected: Mission, squadId: string) => {
      current = { ...current, squadId };
      return current;
    },
  );
  return () => current;
}

beforeEach(() => {
  vi.resetAllMocks();
  resetMissionPromptQueues();
  deps.getMission.mockReset();
  deps.setMissionOrchestratorSession.mockReset();
  deps.rebindMissionOrchestratorSession.mockReset();
  deps.updateMission.mockReset();
  deps.bindMissionRuntimeSquad.mockReset();
  deps.removeMission.mockReset();
  deps.removeMissionIfUnchanged.mockReset();
  deps.blockMission.mockReset();
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
  deps.rebindMissionOrchestratorSession.mockReturnValue(mission);
  deps.updateMission.mockReturnValue(mission);
  deps.bindMissionRuntimeSquad.mockImplementation(
    (missionId: string, expected: Mission, squadId: string) =>
      deps.updateMission(missionId, { ...expected, squadId }),
  );
  deps.removeMission.mockReturnValue(true);
  deps.removeMissionIfUnchanged.mockReturnValue("removed");
  deps.blockMission.mockImplementation(
    (_missionId: string, kind: "user" | "technical") => ({
      ...mission,
      status: "blocked",
      intentState:
        kind === "user" ? "blocked_user" : "blocked_technical",
      updatedAt: 2,
    }),
  );
  deps.listMissionPanes.mockReturnValue([]);
  deps.listHandoffs.mockReturnValue([]);
  deps.getHandoff.mockReturnValue(null);
  deps.listTasks.mockReturnValue([]);
  deps.recordMissionPane.mockReturnValue({
    id: "mpane-new",
    missionId: "mission-a",
    paneId: "pane-a",
  });
  deps.orientationEnsure.mockResolvedValue({ status: "ready" });
  deps.validateAttachmentPaths.mockImplementation((paths: string[]) =>
    paths.map((item) => `/validated/${item.split("/").at(-1)}`),
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
  deps.ensureMissionPlanBeforeBootstrap.mockReturnValue(undefined);
  deps.resolveOrchestratorRuntime.mockReturnValue(approvedRuntime);
  deps.commitPlanPromotionRevision.mockImplementation(
    (
      missionId: string,
      _expected: Mission,
      squadId: string,
      intentContract: Mission["intentContract"],
    ) =>
      deps.updateMission(missionId, {
        squadId,
        status: "pending",
        intentState: "ready_to_start",
        intentVersion: intentContract?.intentVersion,
        intentContract,
      }),
  );
  deps.forScope.mockReturnValue({
    missions: {
      create: deps.createMission,
      get: deps.getMission,
      setOrchestratorSession: deps.setMissionOrchestratorSession,
      rebindOrchestratorSession: deps.rebindMissionOrchestratorSession,
      update: deps.updateMission,
      bindMissionRuntimeSquad: deps.bindMissionRuntimeSquad,
      commitPlanPromotionRevision:
        deps.commitPlanPromotionRevision,
      block: deps.blockMission,
      remove: deps.removeMission,
      removeIfUnchanged: deps.removeMissionIfUnchanged,
    },
    missionPanes: {
      record: deps.recordMissionPane,
      remove: deps.removeMissionPane,
      findByPaneId: deps.findMissionPaneByPaneId,
      list: deps.listMissionPanes,
    },
    handoffs: { list: deps.listHandoffs, get: deps.getHandoff },
    tasks: { list: deps.listTasks },
  });
});

describe("renderer mission authority", () => {
  it("remove somente um draft vazio e revalida todos os receipts", () => {
    deps.getMission.mockReturnValue({
      ...mission,
      orchestratorSessionId: undefined,
      intentState: "awaiting_goal",
    });

    const candidate = authority.missionRemovalCandidateFromRenderer(
      owner,
      "mission-a",
    );
    expect(candidate).toEqual({
      missionId: "mission-a",
      title: "Review",
      fence: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      authority.removeMissionFromRenderer(
        owner,
        "mission-a",
        candidate!.fence,
      ),
    ).toBe(true);
    expect(deps.removeMissionIfUnchanged).toHaveBeenCalledWith(
      "mission-a",
      expect.objectContaining({ id: "mission-a", title: "Review" }),
    );
  });

  it.each([
    ["running", [], [{ id: "handoff-a" }], []],
    ["done", [], [], [{ id: "task-a" }]],
    ["blocked", [], [{ id: "handoff-a" }], []],
    ["pending", [], [], [{ id: "task-a" }]],
  ] as const)(
    "remove missão mesmo com status=%s ou atividade durável",
    (status, panes, handoffs, tasks) => {
      deps.getMission.mockReturnValue({
        ...mission,
        status,
        orchestratorSessionId: undefined,
        intentState: status === "pending" ? "awaiting_goal" : "executing",
      });
      deps.listMissionPanes.mockReturnValue(panes);
      deps.listHandoffs.mockReturnValue(handoffs);
      deps.listTasks.mockReturnValue(tasks);

      const candidate = authority.missionRemovalCandidateFromRenderer(
        owner,
        "mission-a",
      );
      expect(
        authority.removeMissionFromRenderer(
          owner,
          "mission-a",
          candidate!.fence,
        ),
      ).toBe(true);
      expect(deps.removeMissionIfUnchanged).toHaveBeenCalledWith(
        "mission-a",
        expect.objectContaining({ id: "mission-a", status }),
      );
    },
  );

  it("revoga a recuperação automática antes de permitir o delete", () => {
    const automatic = {
      ...approvedMission,
      status: "blocked" as const,
      orchestratorSessionId: undefined,
      intentState: "blocked_technical" as const,
    };
    const revoked = {
      ...automatic,
      intentState: "blocked_user" as const,
      updatedAt: 2,
    };
    deps.getMission.mockReturnValue(automatic);
    deps.blockMission.mockReturnValue(revoked);
    const candidate = authority.missionRemovalCandidateFromRenderer(
      owner,
      "mission-a",
    );

    expect(() =>
      authority.removeMissionFromRenderer(
        owner,
        "mission-a",
        candidate!.fence,
      ),
    ).toThrow(/recuperação automática|recovery_active/i);
    expect(deps.removeMissionIfUnchanged).not.toHaveBeenCalled();

    const prepared = authority.prepareMissionRemovalFromMain(
      owner,
      "mission-a",
      candidate!.fence,
    );
    expect(deps.blockMission).toHaveBeenCalledWith("mission-a", "user");
    expect(prepared!.fence).not.toBe(candidate!.fence);
    deps.getMission.mockReturnValue(revoked);
    expect(
      authority.removeMissionFromRenderer(
        owner,
        "mission-a",
        prepared!.fence,
      ),
    ).toBe(true);
  });

  it("revoga uma execução running antes do primeiro await de teardown", () => {
    const running = {
      ...mission,
      status: "running" as const,
      intentState: "executing" as const,
    };
    const blocked = {
      ...running,
      status: "blocked" as const,
      intentState: "blocked_user" as const,
      updatedAt: 2,
    };
    deps.getMission.mockReturnValue(running);
    deps.blockMission.mockReturnValue(blocked);
    const candidate = authority.missionRemovalCandidateFromRenderer(
      owner,
      "mission-a",
    );

    const prepared = authority.prepareMissionRemovalFromMain(
      owner,
      "mission-a",
      candidate!.fence,
    );

    expect(deps.blockMission).toHaveBeenCalledWith("mission-a", "user");
    expect(prepared).toEqual({
      missionId: "mission-a",
      title: "Review",
      fence: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(prepared!.fence).not.toBe(candidate!.fence);
  });

  it("remove missão bloqueada mesmo com sessão de orquestrador registrada", () => {
    deps.getMission.mockReturnValue({
      ...mission,
      status: "blocked",
      orchestratorSessionId: "pty-live",
      intentState: "blocked_user",
    });
    deps.listMissionPanes.mockReturnValue([]);
    deps.listHandoffs.mockReturnValue([]);
    deps.listTasks.mockReturnValue([]);

    const candidate = authority.missionRemovalCandidateFromRenderer(
      owner,
      "mission-a",
    );
    expect(
      authority.removeMissionFromRenderer(
        owner,
        "mission-a",
        candidate!.fence,
      ),
    ).toBe(true);
    expect(deps.removeMissionIfUnchanged).toHaveBeenCalledWith(
      "mission-a",
      expect.objectContaining({
        status: "blocked",
        intentState: "blocked_user",
      }),
    );
  });

  it("recusa o delete se a missão mudar depois do teardown", () => {
    const observed = {
      ...mission,
      orchestratorSessionId: undefined,
      intentState: "awaiting_goal" as const,
    };
    deps.getMission
      .mockReturnValueOnce(observed)
      .mockReturnValueOnce(observed)
      .mockReturnValueOnce({
        ...observed,
        description: "Estado alterado durante o teardown.",
        updatedAt: 2,
      });
    const candidate = authority.missionRemovalCandidateFromRenderer(
      owner,
      "mission-a",
    );
    const prepared = authority.prepareMissionRemovalFromMain(
      owner,
      "mission-a",
      candidate!.fence,
    );

    expect(() =>
      authority.removeMissionFromRenderer(
        owner,
        "mission-a",
        prepared!.fence,
      ),
    ).toThrow(/remoção.*stale|mudou.*teardown/i);
    expect(deps.removeMissionIfUnchanged).not.toHaveBeenCalled();
  });

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

    const queue = getMissionPromptQueue(scope, mission.id);
    expect(queue.executingId).toBeNull();
    expect(queue.items).toEqual([
      expect.objectContaining({
        kind: "user_goal",
        intentVersion: 1,
        status: "delivered",
      }),
    ]);
    expect(peekMissionPromptQueue(scope, mission.id).queued).toHaveLength(0);
  });

  it("keeps a goal waiting when it promises evidence in a later step", () => {
    const waitingMission = {
      ...mission,
      description: "Corrigir bugs que vou apontar na próxima etapa com prints",
      intentState: "awaiting_goal" as const,
      intentVersion: 1,
    };
    deps.updateMission.mockReturnValueOnce(waitingMission);

    const result = authority.submitIntentFromRenderer(owner, {
      missionId: mission.id,
      goal: "Corrigir bugs que vou apontar na próxima etapa com prints",
    });

    expect(result.intentState).toBe("awaiting_goal");
    expect(deps.updateMission).toHaveBeenCalledWith(
      mission.id,
      expect.objectContaining({
        intentState: "awaiting_goal",
        status: "pending",
        intentContract: expect.objectContaining({ evidenceAttached: false }),
      }),
    );
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
    const currentMission = useStatefulMission(awaitingApproval);

    const approvalReviewSha256 = "c".repeat(64);
    deps.ensureMissionPlanBeforeBootstrap.mockImplementationOnce(() => {
      expect(currentMission()).toMatchObject({
        status: "pending",
        intentState: "ready_to_start",
        intentContract: {
          approvedAt: expect.any(Number),
          approvalReviewSha256,
          dispatchedAt: undefined,
        },
      });
    });
    const result = authority.approveIntentFromRenderer(
      owner,
      { missionId: mission.id },
      undefined,
      approvalReviewSha256,
    );

    expect(result).toMatchObject({
      status: "running",
      intentState: "dispatched",
      intentContract: {
        intentVersion: 1,
        approvedAt: expect.any(Number),
        approvalReviewSha256,
        dispatchedAt: expect.any(Number),
        orchestratorRuntime: approvedRuntime,
      },
    });
    expect(deps.updateMission).toHaveBeenCalledWith(
      mission.id,
      expect.objectContaining({
        status: "pending",
        intentState: "ready_to_start",
        intentContract: expect.objectContaining({
          approvedAt: expect.any(Number),
          approvalReviewSha256,
          dispatchedAt: undefined,
        }),
      }),
    );
    expect(deps.updateMission).toHaveBeenLastCalledWith(
      mission.id,
      expect.objectContaining({
        status: "running",
        intentState: "dispatched",
        intentContract: expect.objectContaining({
          dispatchedAt: expect.any(Number),
        }),
      }),
    );
    expect(deps.ensureMissionPlanBeforeBootstrap).toHaveBeenCalledWith(
      scope,
      mission.id,
    );
    expect(
      deps.ensureMissionPlanBeforeBootstrap.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deps.updateMission.mock.invocationCallOrder.at(-1)!,
    );
    expect(
      deps.ensureMissionPlanBeforeBootstrap.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deps.requestMissionOrchestratorBootstrap.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects a malformed native-review receipt before any mission mutation", () => {
    expect(() =>
      authority.approveIntentFromRenderer(
        owner,
        { missionId: mission.id },
        undefined,
        "renderer-forged",
      ),
    ).toThrow(/approval_review_receipt_invalid/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
    expect(deps.requestMissionOrchestratorBootstrap).not.toHaveBeenCalled();
    expect(deps.updateMission).not.toHaveBeenCalledWith(mission.id, {
      status: "running",
    });
  });

  it("keeps native preview read-only and pins only after confirmation", () => {
    const awaitingApproval = {
      ...approvedMission,
      status: "pending" as const,
      intentState: "awaiting_approval" as const,
      intentContract: {
        ...approvedMission.intentContract,
        approvedAt: undefined,
        dispatchedAt: undefined,
        squadRevisionHash: undefined,
      },
    };
    const currentMission = useStatefulMission(awaitingApproval);
    const runtimeSquad: Squad = {
      ...savedSquad,
      id: "mission-runtime-123e4567-e89b-42d3-a456-426614174099",
      builtin: false,
      runtimeSourceSquadId: savedSquad.id,
      runtimeSourceSquadRevisionHash: snapshotSquadAuthority(savedSquad).hash,
    };
    const pinRuntimeSquad = vi.fn((source: Squad) =>
      source.id === runtimeSquad.id ? source : runtimeSquad,
    );
    const pinningAuthority = new RendererMissionAuthority(
      { forScope: deps.forScope } as never,
      () => "context-revision-a",
      () => true,
      deps.resolvePaneActivity,
      deps.validateAttachmentPaths,
      deps.requestMissionOrchestratorBootstrap,
      (squadId) =>
        squadId === runtimeSquad.id
          ? runtimeSquad
          : squadId === savedSquad.id
            ? savedSquad
            : null,
      deps.resolveOrchestratorRuntime,
      deps.snapshotAttachmentPaths,
      deps.ensureMissionPlanBeforeBootstrap,
      () => undefined,
      pinRuntimeSquad,
    );

    const candidate = pinningAuthority.missionApprovalCandidateFromRenderer(
      owner,
      { missionId: mission.id },
    );
    expect(pinRuntimeSquad).not.toHaveBeenCalled();
    expect(deps.bindMissionRuntimeSquad).not.toHaveBeenCalled();
    expect(currentMission().squadId).toBe(savedSquad.id);
    expect(candidate.squad.id).toBe(savedSquad.id);
    expect(candidate.squad.hash).toBe(snapshotSquadAuthority(savedSquad).hash);

    const result = pinningAuthority.approveIntentFromRenderer(
      owner,
      { missionId: mission.id },
      candidate.fence,
    );
    expect(result.squadId).toBe(runtimeSquad.id);
    expect(result.intentContract?.squadRevisionHash).toBe(
      snapshotSquadAuthority(runtimeSquad).hash,
    );
    expect(pinRuntimeSquad).toHaveBeenCalledOnce();
    expect(pinRuntimeSquad).toHaveBeenCalledWith(savedSquad);
    expect(deps.bindMissionRuntimeSquad).toHaveBeenCalledOnce();
  });

  it("rechecks every standard worker after native review before dispatch", () => {
    const guidedSquad = {
      ...savedSquad,
      id: "agentic-review-squad",
    };
    const awaitingApproval = {
      ...approvedMission,
      squadId: guidedSquad.id,
      status: "pending" as const,
      intentState: "awaiting_approval" as const,
      intentContract: {
        ...approvedMission.intentContract,
        approvedAt: undefined,
        dispatchedAt: undefined,
      },
    };
    const assertStandardSquadReadiness = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error(
          "squad_runtime_unavailable:executor-unavailable: Aider sem handoff físico",
        );
      });
    const gatedAuthority = new RendererMissionAuthority(
      { forScope: deps.forScope } as never,
      () => "context-revision-a",
      () => true,
      deps.resolvePaneActivity,
      deps.validateAttachmentPaths,
      deps.requestMissionOrchestratorBootstrap,
      () => guidedSquad,
      deps.resolveOrchestratorRuntime,
      deps.snapshotAttachmentPaths,
      deps.ensureMissionPlanBeforeBootstrap,
      assertStandardSquadReadiness,
      identityPin,
    );
    deps.getMission.mockReturnValue(awaitingApproval);

    const candidate = gatedAuthority.missionApprovalCandidateFromRenderer(
      owner,
      { missionId: mission.id },
    );
    expect(assertStandardSquadReadiness).toHaveBeenCalledTimes(1);

    expect(() =>
      gatedAuthority.approveIntentFromRenderer(
        owner,
        { missionId: mission.id },
        candidate.fence,
      ),
    ).toThrow(/executor-unavailable.*handoff físico/i);
    expect(assertStandardSquadReadiness).toHaveBeenCalledTimes(2);
    expect(deps.updateMission).not.toHaveBeenCalled();
    expect(deps.requestMissionOrchestratorBootstrap).not.toHaveBeenCalled();
  });

  it("preserves specialty squad contracts outside the beginner guided planner", () => {
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
    const guidedOnlyReadiness = vi.fn(() => {
      throw new Error("guided readiness must not govern specialty squads");
    });
    const specialtyAuthority = new RendererMissionAuthority(
      { forScope: deps.forScope } as never,
      () => "context-revision-a",
      () => true,
      deps.resolvePaneActivity,
      deps.validateAttachmentPaths,
      deps.requestMissionOrchestratorBootstrap,
      () => savedSquad,
      deps.resolveOrchestratorRuntime,
      deps.snapshotAttachmentPaths,
      deps.ensureMissionPlanBeforeBootstrap,
      guidedOnlyReadiness,
      identityPin,
    );
    deps.getMission.mockReturnValue(awaitingApproval);

    expect(() =>
      specialtyAuthority.missionApprovalCandidateFromRenderer(owner, {
        missionId: mission.id,
      }),
    ).not.toThrow();
    expect(guidedOnlyReadiness).not.toHaveBeenCalled();
  });

  it("persists a technical block and rejects the launcher before bootstrap when the plan cannot be sealed", () => {
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
    useStatefulMission(awaitingApproval);
    deps.ensureMissionPlanBeforeBootstrap.mockImplementationOnce(() => {
      throw new Error("guided_plan_route_unavailable");
    });

    expect(() =>
      authority.approveIntentFromRenderer(owner, {
        missionId: mission.id,
      }),
    ).toThrow(/guided_plan_preflight_blocked.*route_unavailable/i);
    expect(deps.requestMissionOrchestratorBootstrap).not.toHaveBeenCalled();
    expect(deps.updateMission).toHaveBeenLastCalledWith(
      mission.id,
      expect.objectContaining({
        status: "blocked",
        intentState: "blocked_technical",
        description: expect.stringMatching(
          /execução não iniciada.*guided_plan_route_unavailable.*CTA/is,
        ),
      }),
    );
    expect(
      deps.updateMission.mock.calls.some(
        ([, patch]) => (patch as Partial<Mission>).status === "running",
      ),
    ).toBe(false);
  });

  it("marca aprovação vigente no candidato de missão já em execução", () => {
    // A lane idempotente do approve (continuar bootstrap) precisa ser visível
    // ANTES do diálogo nativo — senão o operador reaprova em loop uma missão
    // que a própria autoridade já considera aprovada (voo real 05/08).
    deps.getMission.mockReturnValue({
      ...approvedMission,
      intentContract: {
        ...approvedMission.intentContract,
        orchestratorRuntime: approvedRuntime,
      },
    });
    expect(
      authority.missionApprovalCandidateFromRenderer(owner, {
        missionId: mission.id,
      }).approvalAlreadyCurrent,
    ).toBe(true);
  });

  it("não marca aprovação vigente enquanto o operador ainda precisa decidir", () => {
    deps.getMission.mockReturnValue({
      ...approvedMission,
      status: "pending" as const,
      intentState: "awaiting_approval" as const,
      intentContract: {
        ...approvedMission.intentContract,
        approvedAt: undefined,
        dispatchedAt: undefined,
        orchestratorRuntime: approvedRuntime,
      },
    });
    expect(
      authority.missionApprovalCandidateFromRenderer(owner, {
        missionId: mission.id,
      }).approvalAlreadyCurrent,
    ).toBe(false);
  });

  it("fence de aprovação invalida mudança de intent durante confirmação nativa", () => {
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
    deps.getMission.mockReturnValue(awaitingApproval);
    const candidate = authority.missionApprovalCandidateFromRenderer(owner, {
      missionId: mission.id,
    });
    expect(candidate).toMatchObject({
      missionId: mission.id,
      goal: "Review",
      lane: "standard",
      executionMode: "assisted",
      contextPolicy: "on-demand",
      acceptanceCriteria: ["Done"],
      intentVersion: 1,
      orchestratorRuntime: approvedRuntime,
    });

    deps.getMission.mockReturnValue({
      ...awaitingApproval,
      intentVersion: 2,
      intentContract: {
        ...awaitingApproval.intentContract,
        intentVersion: 2,
        goal: "Objetivo trocado durante o modal",
      },
    });
    expect(() =>
      authority.approveIntentFromRenderer(
        owner,
        { missionId: mission.id },
        candidate.fence,
      ),
    ).toThrow(/approval.*stale|intent.*changed/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
    expect(deps.requestMissionOrchestratorBootstrap).not.toHaveBeenCalled();
  });

  it("sela o runtime exato e invalida mudança de provider/account durante o modal", () => {
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
    deps.getMission.mockReturnValue(awaitingApproval);
    const candidate = authority.missionApprovalCandidateFromRenderer(owner, {
      missionId: mission.id,
    });

    deps.resolveOrchestratorRuntime.mockReturnValue({
      ...approvedRuntime,
      accountId: "account-b",
    });

    expect(() =>
      authority.approveIntentFromRenderer(
        owner,
        { missionId: mission.id },
        candidate.fence,
      ),
    ).toThrow(/approval.*stale|runtime.*changed/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
    expect(deps.requestMissionOrchestratorBootstrap).not.toHaveBeenCalled();
  });

  it("não abre aprovação quando o runtime main-owned está indisponível", () => {
    deps.getMission.mockReturnValue({
      ...approvedMission,
      status: "pending" as const,
      intentState: "awaiting_approval" as const,
      intentContract: {
        ...approvedMission.intentContract,
        approvedAt: undefined,
        dispatchedAt: undefined,
      },
    });
    deps.resolveOrchestratorRuntime.mockImplementationOnce(() => {
      throw new Error("Nenhuma conta tem credencial válida");
    });

    expect(() =>
      authority.missionApprovalCandidateFromRenderer(owner, {
        missionId: mission.id,
      }),
    ).toThrow(/credencial válida/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("recusa conteúdo que não cabe integralmente na revisão nativa", () => {
    const awaitingApproval = {
      ...approvedMission,
      status: "pending" as const,
      intentState: "awaiting_approval" as const,
      intentContract: {
        ...approvedMission.intentContract,
        goal: `Objetivo ${"x".repeat(6_100)}`,
        approvedAt: undefined,
        dispatchedAt: undefined,
      },
    };
    deps.getMission.mockReturnValue(awaitingApproval);

    expect(() =>
      authority.missionApprovalCandidateFromRenderer(owner, {
        missionId: mission.id,
      }),
    ).toThrow(/approval_review_too_large/i);

    deps.getMission.mockReturnValue({
      ...awaitingApproval,
      intentContract: {
        ...awaitingApproval.intentContract,
        goal: "Objetivo visualmente benigno\u202eexe.malicioso",
      },
    });
    expect(() =>
      authority.missionApprovalCandidateFromRenderer(owner, {
        missionId: mission.id,
      }),
    ).toThrow(/approval_review_unsafe/i);
  });

  it("inclui anexos validados no fence da aprovação", () => {
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
    deps.getMission.mockReturnValue(awaitingApproval);
    const candidate = authority.missionApprovalCandidateFromRenderer(owner, {
      missionId: mission.id,
      attachmentPaths: ["/staged/a.png"],
    });
    expect(candidate.attachmentPaths).toEqual(["/validated/a.png"]);
    expect(candidate.attachmentSnapshots).toEqual([
      {
        path: "/validated/a.png",
        sha256: "a".repeat(64),
        size: 128,
      },
    ]);

    expect(() =>
      authority.approveIntentFromRenderer(
        owner,
        { missionId: mission.id, attachmentPaths: ["/staged/b.png"] },
        candidate.fence,
      ),
    ).toThrow(/approval.*stale|attachments.*changed/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("invalida aprovação quando bytes mudam no mesmo caminho durante o modal", () => {
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
    deps.getMission.mockReturnValue(awaitingApproval);
    const input = {
      missionId: mission.id,
      attachmentPaths: ["/staged/a.png"],
    };
    const candidate = authority.missionApprovalCandidateFromRenderer(
      owner,
      input,
    );
    deps.snapshotAttachmentPaths.mockImplementation((paths: string[]) =>
      paths.map((attachmentPath) => ({
        path: attachmentPath,
        sha256: "b".repeat(64),
        size: 128,
      })),
    );

    expect(() =>
      authority.approveIntentFromRenderer(owner, input, candidate.fence),
    ).toThrow(/approval.*stale|attachments.*changed/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("invalida aprovação quando roster/instruções do squad mudam no modal", () => {
    let liveSquad = savedSquad;
    const squadAuthority = new RendererMissionAuthority(
      { forScope: deps.forScope } as never,
      () => "context-revision-a",
      () => true,
      deps.resolvePaneActivity,
      deps.validateAttachmentPaths,
      deps.requestMissionOrchestratorBootstrap,
      () => liveSquad,
      deps.resolveOrchestratorRuntime,
      undefined,
      undefined,
      () => undefined,
      identityPin,
    );
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
    deps.getMission.mockReturnValue(awaitingApproval);
    const candidate = squadAuthority.missionApprovalCandidateFromRenderer(
      owner,
      { missionId: mission.id },
    );
    liveSquad = {
      ...savedSquad,
      orchestratorInstructions:
        "## Política alterada\nExecute algo não exibido.",
    };

    expect(() =>
      squadAuthority.approveIntentFromRenderer(
        owner,
        { missionId: mission.id },
        candidate.fence,
      ),
    ).toThrow(/approval.*stale|squad.*changed/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("recusa promover plan pré-dispatch sem handoff físico", () => {
    const planMission = {
      ...approvedMission,
      status: "pending" as const,
      intentState: "ready_to_start" as const,
      intentVersion: 1,
      orchestratorSessionId: undefined,
      intentContract: {
        ...approvedMission.intentContract,
        lane: "plan" as const,
        intentVersion: 1,
        approvedAt: undefined,
        dispatchedAt: undefined,
      },
    };
    deps.getMission.mockReturnValue(planMission);
    expect(() =>
      authority.planPromotionCandidateFromRenderer(owner, {
        missionId: planMission.id,
      }),
    ).toThrow(/plan_handoff_missing|dispatch físico/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it.each([
    ["dispatched", "running"],
    ["executing", "running"],
    ["validating", "running"],
  ] as const)(
    "promove plan ativo em %s para v+1 não executável e preserva o vínculo a encerrar",
    (intentState, status) => {
      const activePlan = {
        ...approvedMission,
        status,
        intentState,
        intentVersion: 7,
        intentContract: {
          ...approvedMission.intentContract,
          lane: "plan" as const,
          intentVersion: 7,
          approvedAt: 700,
          dispatchedAt: 701,
        },
      };
      const handoff = physicalPlanHandoff("pty-a", 800);
      deps.listHandoffs.mockReturnValue([handoff]);
      deps.getHandoff.mockReturnValue(handoff);
      deps.getMission.mockReturnValue(activePlan);
      deps.updateMission.mockImplementation(
        (_missionId: string, patch: Record<string, unknown>) => ({
          ...deps.getMission(),
          ...patch,
        }),
      );

      const candidate = authority.planPromotionCandidateFromRenderer(owner, {
        missionId: activePlan.id,
      });
      deps.getMission.mockReturnValue({
        ...activePlan,
        orchestratorSessionId: undefined,
      });
      const detachedCandidate =
        authority.planPromotionCandidateAfterTeardownFromMain(
          owner,
          { missionId: activePlan.id },
          candidate.promotedPlan!,
        );
      const promoted = authority.promotePlanLaneFromRenderer(
        owner,
        { missionId: activePlan.id },
        detachedCandidate.fence,
        detachedCandidate.promotedPlan!,
        "d".repeat(64),
      );

      expect(promoted).toMatchObject({
        status: "pending",
        intentState: "ready_to_start",
        intentVersion: 8,
        orchestratorSessionId: undefined,
        intentContract: {
          lane: "standard",
          intentVersion: 8,
          approvedAt: expect.any(Number),
          approvalReviewSha256: "d".repeat(64),
        },
      });
      expect(promoted.intentContract?.dispatchedAt).toBeUndefined();
    },
  );

  it("recusa se o runtime do plano mudar durante a revisão nativa", () => {
    const activePlan = {
      ...approvedMission,
      status: "running" as const,
      intentState: "executing" as const,
      intentVersion: 4,
      orchestratorSessionId: "pty-plan-v4",
      intentContract: {
        ...approvedMission.intentContract,
        lane: "plan" as const,
        intentVersion: 4,
        approvedAt: 800,
        dispatchedAt: 801,
      },
    };
    const handoff = physicalPlanHandoff("pty-plan-v4", 900);
    deps.listHandoffs.mockReturnValue([handoff]);
    deps.getHandoff.mockReturnValue(handoff);
    deps.getMission.mockReturnValue(activePlan);
    const candidate = authority.planPromotionCandidateFromRenderer(owner, {
      missionId: activePlan.id,
    });
    deps.getMission.mockReturnValue({
      ...activePlan,
      orchestratorSessionId: undefined,
      intentContract: {
        ...activePlan.intentContract,
        goal: "Objetivo alterado durante o teardown",
      },
    });
    expect(() =>
      authority.promotePlanLaneFromRenderer(
        owner,
        { missionId: activePlan.id },
        candidate.fence,
        candidate.promotedPlan!,
      ),
    ).toThrow(/promotion.*stale|intent.*changed/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("invalida a revisão se somente a sessão do orquestrador for substituída", () => {
    const activePlan = {
      ...approvedMission,
      intentVersion: 4,
      orchestratorSessionId: "pty-plan-v4-a",
      intentContract: {
        ...approvedMission.intentContract,
        lane: "plan" as const,
        intentVersion: 4,
      },
    };
    const handoff = physicalPlanHandoff("pty-plan-v4-a", 900);
    deps.listHandoffs.mockReturnValue([handoff]);
    deps.getHandoff.mockReturnValue(handoff);
    deps.getMission
      .mockReturnValueOnce(activePlan)
      .mockReturnValueOnce({
        ...activePlan,
        orchestratorSessionId: "pty-plan-v4-b",
      });

    const candidate = authority.planPromotionCandidateFromRenderer(owner, {
      missionId: activePlan.id,
    });

    expect(() =>
      authority.promotePlanLaneFromRenderer(
        owner,
        { missionId: activePlan.id },
        candidate.fence,
        candidate.promotedPlan!,
      ),
    ).toThrow(/promotion_runtime_live|promotion.*stale/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("keeps main-owned bootstrap progressing after the approving renderer disappears", async () => {
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
    useStatefulMission(awaitingApproval);
    let rendererPresent = true;
    let bootstrapFinished = false;
    deps.requestMissionOrchestratorBootstrap.mockImplementationOnce(
      async () => {
        await Promise.resolve();
        bootstrapFinished = !rendererPresent;
        return { ok: true, missionId: mission.id };
      },
    );

    const approved = authority.approveIntentFromRenderer(owner, {
      missionId: mission.id,
    });
    rendererPresent = false;

    expect(approved).toMatchObject({
      status: "running",
      intentState: "dispatched",
    });
    expect(deps.requestMissionOrchestratorBootstrap).toHaveBeenCalledWith(
      scope,
      mission.id,
    );
    await vi.waitFor(() => expect(bootstrapFinished).toBe(true));
  });

  it("validates and persists attachment paths in the approved contract", () => {
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
    useStatefulMission(awaitingApproval);

    const result = authority.approveIntentFromRenderer(owner, {
      missionId: mission.id,
      evidenceAttached: true,
      attachmentPaths: ["/staged/print.png"],
    });

    expect(deps.validateAttachmentPaths).toHaveBeenCalledWith([
      "/staged/print.png",
    ]);
    expect(result.intentContract).toMatchObject({
      evidenceAttached: true,
      attachmentPaths: ["/validated/print.png"],
      attachmentSnapshots: [
        {
          path: "/validated/print.png",
          sha256: "a".repeat(64),
          size: 128,
        },
      ],
    });
    expect(deps.updateMission).toHaveBeenCalledWith(
      mission.id,
      expect.objectContaining({
        intentContract: expect.objectContaining({
          attachmentPaths: ["/validated/print.png"],
        }),
      }),
    );
  });

  it("leaves attachment paths absent when approval does not provide them", () => {
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
    useStatefulMission(awaitingApproval);

    const result = authority.approveIntentFromRenderer(owner, {
      missionId: mission.id,
    });

    expect(deps.validateAttachmentPaths).not.toHaveBeenCalled();
    expect(result.intentContract).not.toHaveProperty("attachmentPaths");
  });

  it("blocks final approval when promised evidence is still missing", () => {
    deps.getMission.mockReturnValueOnce({
      ...approvedMission,
      intentState: "ready_to_start" as const,
      intentContract: {
        ...approvedMission.intentContract,
        goal: "Corrigir bugs que vou apontar depois com prints",
        evidenceAttached: false,
      },
    });

    expect(() =>
      authority.approveIntentFromRenderer(owner, { missionId: mission.id }),
    ).toThrow(/evidence_required|Anexe os prints ou áudios/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("dispatches from awaiting_goal when a real goal is already compiled", () => {
    const waitingWithContract = {
      ...approvedMission,
      status: "pending" as const,
      intentState: "awaiting_goal" as const,
      intentContract: {
        ...approvedMission.intentContract,
        goal: "Atualize o repo e corrija o bug do print na tela ohmipy",
        approvedAt: undefined,
        dispatchedAt: undefined,
        evidenceAttached: false,
      },
    };
    useStatefulMission(waitingWithContract);

    const result = authority.approveIntentFromRenderer(owner, {
      missionId: mission.id,
    });

    expect(result).toMatchObject({
      status: "running",
      intentState: "dispatched",
    });
  });

  it("re-approves a mission whose preflight blocked it, clearing the stale note", () => {
    // Field trap (28/07): a mission blocked once by a transient preflight
    // failure (CLI not yet authenticated, dirty tree) could never be approved
    // again — "cannot dispatch from intent state blocked_technical" — so the
    // only exit was deleting it.
    const blocked = {
      ...approvedMission,
      status: "blocked" as const,
      intentState: "blocked_technical" as const,
      description:
        "Objetivo original.\n\n<!-- nexus:guided-plan-block -->\n## Execução não iniciada\nfalha anterior.",
      intentContract: {
        ...approvedMission.intentContract,
        goal: "Atualize o repo e corrija o bug do print na tela ohmipy",
        approvedAt: undefined,
        dispatchedAt: undefined,
        evidenceAttached: false,
      },
    };
    useStatefulMission(blocked);

    const result = authority.approveIntentFromRenderer(owner, {
      missionId: mission.id,
    });

    expect(result).toMatchObject({
      status: "running",
      intentState: "dispatched",
    });
    // The previous failure note must not survive as if it were current.
    const patched = deps.updateMission.mock.calls.find(
      (call) => (call[1] as Partial<Mission>)?.description !== undefined,
    );
    expect((patched?.[1] as Partial<Mission>)?.description).toBe(
      "Objetivo original.",
    );
    expect((patched?.[1] as Partial<Mission>)?.description).not.toContain(
      "guided-plan-block",
    );
  });

  it("still refuses re-approval of a blocked mission with no real goal", () => {
    useStatefulMission({
      ...approvedMission,
      status: "blocked" as const,
      intentState: "blocked_technical" as const,
      intentContract: {
        ...approvedMission.intentContract,
        goal: "   ",
        approvedAt: undefined,
        dispatchedAt: undefined,
      },
    });

    expect(() =>
      authority.approveIntentFromRenderer(owner, { missionId: mission.id }),
    ).toThrow(/intent_required/i);
  });

  it("refuses awaiting_goal start when evidence is still promised", () => {
    deps.getMission.mockReturnValueOnce({
      ...approvedMission,
      intentState: "awaiting_goal" as const,
      intentContract: {
        ...approvedMission.intentContract,
        goal: "Corrigir bugs que vou apontar na próxima etapa com prints",
        evidenceAttached: false,
      },
    });

    expect(() =>
      authority.approveIntentFromRenderer(owner, { missionId: mission.id }),
    ).toThrow(/evidence_required|Anexe os prints ou áudios/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
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
    expect(peekMissionPromptQueue(scope, mission.id).executing).toBeNull();
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
      expect(peekMissionPromptQueue(scope, mission.id).executing?.kind).toBe(
        "preflight",
      );
    });
    expect(
      authority.cancelPreparationFromRenderer(owner, {
        missionId: mission.id,
      }),
    ).toEqual({ cancelled: true });
    await expect(pending).rejects.toThrow(/cancelled by a newer intent/i);
    expect(observedSignal?.aborted).toBe(true);
    expect(peekMissionPromptQueue(scope, mission.id).cancelled).toHaveLength(1);
  });

  it("does not expose another workspace mission prompt queue", () => {
    deps.getMission.mockReturnValueOnce(null);
    expect(() =>
      authority.getPromptQueueFromRenderer(owner, {
        missionId: "mission-b",
      }),
    ).toThrow(/mission not found/i);
  });

  it("never accepts renderer-authored done and scopes other edits", () => {
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        status: "done",
      }),
    ).toThrow(/PREVC workflow reaches complete/);
    expect(deps.updateMission).not.toHaveBeenCalled();

    const demotion = {
      title: "Safer title",
      status: "blocked" as const,
    };
    const candidate = authority.missionLifecycleCandidateFromRenderer(
      owner,
      "mission-a",
      demotion,
    );
    expect(
      authority.updateMissionFromRenderer(
        owner,
        "mission-a",
        demotion,
        candidate.fence,
      ),
    ).toBe(mission);
    expect(deps.requireRendererWorkspaceScope).toHaveBeenCalledWith(owner);
    expect(deps.forScope).toHaveBeenCalledWith(scope);
    expect(deps.updateMission).toHaveBeenCalledWith("mission-a", {
      title: "Safer title",
      status: "blocked",
    });
  });

  it("não ressuscita missão bloqueada/failed por patch do renderer", () => {
    deps.getMission.mockReturnValue({
      ...approvedMission,
      status: "blocked",
      intentState: "blocked_user",
    });
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        status: "running",
      }),
    ).toThrow(/main-owned|resume flow/i);
    expect(deps.updateMission).not.toHaveBeenCalled();

    deps.getMission.mockReturnValue({
      ...approvedMission,
      status: "failed",
      intentState: "blocked_technical",
    });
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        status: "running",
      }),
    ).toThrow(/main-owned|resume flow/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
  });

  it("não permite reduzir milestones derivados após contrato aprovado", () => {
    deps.getMission.mockReturnValue(approvedMission);
    expect(() =>
      authority.updateMissionFromRenderer(owner, "mission-a", {
        milestones: [
          {
            id: "atalho",
            label: "Um único passo arbitrário",
            status: "pending",
          },
        ],
      }),
    ).toThrow(/milestones.*intent contract.*main-owned/i);
    expect(deps.updateMission).not.toHaveBeenCalled();
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
      risk: "sensitive" as const,
      executionMode: "autopilot" as const,
      contextPolicy: "on-demand" as const,
      intentVersion: 1,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 2,
      },
    };
    useStatefulMission({
      ...mission,
      orchestratorSessionId: undefined,
      intentState: "awaiting_approval",
      intentVersion: 1,
      intentContract,
    } as Mission);

    authority.approveIntentFromRenderer(owner, { missionId: "mission-a" });

    expect(deps.updateMission).toHaveBeenCalledWith(
      "mission-a",
      expect.objectContaining({
        status: "pending",
        intentState: "ready_to_start",
        intentContract: expect.objectContaining({
          approvedAt: expect.any(Number),
          dispatchedAt: undefined,
        }),
      }),
    );
    expect(deps.updateMission).toHaveBeenLastCalledWith(
      "mission-a",
      expect.objectContaining({
        status: "running",
        intentState: "dispatched",
        intentContract: expect.objectContaining({
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
});
