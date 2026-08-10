import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { Handoff, Mission, Squad } from "../../shared/orch-types";
import { testProjectScope } from "./__tests__/scope-fixture";

const deps = vi.hoisted(() => ({
  findPaneOwnedBy: vi.fn(),
  attachOrchMeta: vi.fn(),
  getOwnedAgentSessionInfo: vi.fn(),
  requireRendererWorkspaceScope: vi.fn(),
  getContextBySession: vi.fn(),
  restoreSessionAuthority: vi.fn(),
  getMission: vi.fn(),
  updateMission: vi.fn(),
  bindMissionRuntimeSquad: vi.fn(),
  commitPlanPromotionRevision: vi.fn(),
  blockMission: vi.fn(),
  removeMissionIfUnchanged: vi.fn(),
  listMissionPanes: vi.fn(),
  listHandoffs: vi.fn(),
  getHandoff: vi.fn(),
  listTasks: vi.fn(),
  forScope: vi.fn(),
  resolvePaneActivity: vi.fn(),
  validateAttachmentPaths: vi.fn(),
  snapshotAttachmentPaths: vi.fn(),
  resolveOrchestratorRuntime: vi.fn(),
}));

vi.mock("./pane-registry", () => ({
  findPaneOwnedBy: deps.findPaneOwnedBy,
  attachOrchMeta: deps.attachOrchMeta,
}));

vi.mock("../pty/pty-manager", () => ({
  getOwnedAgentSessionInfo: deps.getOwnedAgentSessionInfo,
}));

vi.mock("../persistence/renderer-workspace-scope", () => ({
  requireRendererWorkspaceScope: deps.requireRendererWorkspaceScope,
}));

vi.mock("./gate", () => ({
  getContextBySession: deps.getContextBySession,
  restoreSessionAuthority: deps.restoreSessionAuthority,
}));


vi.mock("./pane-activity-summary", () => ({
  resolveMissionPaneActivity: deps.resolvePaneActivity,
}));

import { RendererMissionAuthority } from "./renderer-mission-authority";
import { resetMissionPromptQueues } from "./mission-prompt-queue-registry";

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
  deps.resolvePaneActivity,
  deps.validateAttachmentPaths,
  () => savedSquad,
  deps.resolveOrchestratorRuntime,
  deps.snapshotAttachmentPaths,
  () => undefined,
  identityPin,
);


beforeEach(() => {
  vi.resetAllMocks();
  resetMissionPromptQueues();
  deps.getMission.mockReset();
  deps.updateMission.mockReset();
  deps.bindMissionRuntimeSquad.mockReset();
  deps.removeMissionIfUnchanged.mockReset();
  deps.blockMission.mockReset();
  deps.requireRendererWorkspaceScope.mockReturnValue(scope);
  deps.getMission.mockReturnValue(mission);
  deps.updateMission.mockReturnValue(mission);
  deps.bindMissionRuntimeSquad.mockImplementation(
    (missionId: string, expected: Mission, squadId: string) =>
      deps.updateMission(missionId, { ...expected, squadId }),
  );
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
      get: deps.getMission,
      update: deps.updateMission,
      bindMissionRuntimeSquad: deps.bindMissionRuntimeSquad,
      commitPlanPromotionRevision:
        deps.commitPlanPromotionRevision,
      block: deps.blockMission,
      removeIfUnchanged: deps.removeMissionIfUnchanged,
    },
    missionPanes: {
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

});
