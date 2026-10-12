import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { Mission } from "../../shared/orch-types";
import { testProjectScope } from "./__tests__/scope-fixture";

const deps = vi.hoisted(() => ({
  findPaneOwnedBy: vi.fn(),
  attachOrchMeta: vi.fn(),
  getOwnedAgentSessionInfo: vi.fn(),
  requireRendererWorkspaceScope: vi.fn(),
  getContextBySession: vi.fn(),
  restoreSessionAuthority: vi.fn(),
  rollbackMissionSessionAuthorities: vi.fn(),
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
  rollbackMissionSessionAuthorities: deps.rollbackMissionSessionAuthorities,
}));


const traceEvents = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../observability/main-trace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability/main-trace")>()),
  trace: (event: Record<string, unknown>) => traceEvents.push(event),
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
const approvedRuntime = Object.freeze({
  adapterId: "codex",
  model: "gpt-5.6-sol",
  accountId: "account-a",
  effort: "high",
  readOnly: false as const,
  nativeReadOnly: true as const,
});


const authority = new RendererMissionAuthority(
  { forScope: deps.forScope } as never,
  () => "context-revision-a",
  deps.resolvePaneActivity,
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
      // F-1358: a remoção deixa registro auditável no histórico de ciclo de vida.
      expect(traceEvents.filter((event) => event.kind === "mission-removed").at(-1)).toEqual({
        kind: "mission-removed",
        missionId: "mission-a",
        status,
        phase: status === "pending" ? "awaiting_goal" : "executing",
        origin: "renderer-remove",
      });
    },
  );

  it("revoga a recuperação automática antes de permitir o delete", () => {
    const automatic = {
      ...approvedMission,
      status: "blocked" as const,
      orchestratorSessionId: undefined,
      intentState: "blocked_technical" as const,
      // Recovery viva é dona-deste-processo: updatedAt fresco, senão a linha
      // é leftover de boot anterior e ninguém está recuperando coisa alguma.
      updatedAt: Date.now(),
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

  it("devolve a autoridade das sessões presas à missão removida", () => {
    // Campo 09/09: o pane que criava uma missão virava `orchestrator` e, ao
    // descartar a missão, ficava estéril — nunca mais criava outra. Remover a
    // missão sem soltar as sessões dela deixava o vínculo pendurado.
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
    authority.removeMissionFromRenderer(owner, "mission-a", candidate!.fence);

    expect(deps.rollbackMissionSessionAuthorities).toHaveBeenCalledWith(
      "mission-a",
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
