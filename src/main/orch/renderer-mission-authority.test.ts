import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { Squad } from "../../shared/orch-types";
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
  listHandoffs: vi.fn(),
  listTasks: vi.fn(),
  forScope: vi.fn(),
  orientationEnsure: vi.fn(),
  resolvePaneActivity: vi.fn(),
  validateAttachmentPaths: vi.fn(),
  snapshotAttachmentPaths: vi.fn(),
  requestMissionOrchestratorBootstrap: vi.fn(),
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
);

beforeEach(() => {
  vi.resetAllMocks();
  resetMissionPromptQueues();
  deps.getMission.mockReset();
  deps.setMissionOrchestratorSession.mockReset();
  deps.rebindMissionOrchestratorSession.mockReset();
  deps.updateMission.mockReset();
  deps.removeMission.mockReset();
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
  deps.removeMission.mockReturnValue(true);
  deps.listMissionPanes.mockReturnValue([]);
  deps.listHandoffs.mockReturnValue([]);
  deps.listTasks.mockReturnValue([]);
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
  deps.resolveOrchestratorRuntime.mockReturnValue(approvedRuntime);
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
    handoffs: { list: deps.listHandoffs },
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

    expect(authority.missionRemovalCandidateFromRenderer(owner, "mission-a"))
      .toEqual({ missionId: "mission-a", title: "Review" });
    expect(authority.removeMissionFromRenderer(owner, "mission-a")).toBe(true);
    expect(deps.removeMission).toHaveBeenCalledWith("mission-a");
  });

  it.each([
    ["running", [], [], []],
    ["done", [], [], []],
    ["blocked", [{ role: "worker" }], [], []],
    ["blocked", [], [{ id: "handoff-a" }], []],
    ["blocked", [], [], [{ id: "task-a" }]],
    ["pending", [{ role: "worker" }], [], []],
    ["pending", [], [{ id: "handoff-a" }], []],
    ["pending", [], [], [{ id: "task-a" }]],
  ] as const)(
    "preserva missão/receipts quando status=%s ou há atividade durável",
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

      expect(() =>
        authority.removeMissionFromRenderer(owner, "mission-a"),
      ).toThrow(/preservada|receipts|atividade/i);
      expect(deps.removeMission).not.toHaveBeenCalled();
    },
  );

  it("permite remover missão bloqueada sem runtime nem atividade durável (wedge do bootstrap)", () => {
    // Bootstrap falhou antes de materializar qualquer coisa: sem sessão, sem
    // panes, sem handoffs, sem tasks. Não há receipt a preservar — recusar a
    // remoção deixava a missão presa sem nenhuma saída.
    deps.getMission.mockReturnValue({
      ...mission,
      status: "blocked",
      orchestratorSessionId: undefined,
      intentState: "blocked_technical",
    });
    deps.listMissionPanes.mockReturnValue([]);
    deps.listHandoffs.mockReturnValue([]);
    deps.listTasks.mockReturnValue([]);

    expect(authority.removeMissionFromRenderer(owner, "mission-a")).toBe(true);
    expect(deps.removeMission).toHaveBeenCalledWith("mission-a");
  });

  it("preserva missão bloqueada que ainda tem sessão de orquestrador", () => {
    deps.getMission.mockReturnValue({
      ...mission,
      status: "blocked",
      orchestratorSessionId: "pty-live",
      intentState: "blocked_user",
    });
    deps.listMissionPanes.mockReturnValue([]);
    deps.listHandoffs.mockReturnValue([]);
    deps.listTasks.mockReturnValue([]);

    expect(() =>
      authority.removeMissionFromRenderer(owner, "mission-a"),
    ).toThrow(/preservada/i);
    expect(deps.removeMission).not.toHaveBeenCalled();
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
        orchestratorRuntime: approvedRuntime,
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
    const candidate = authority.missionApprovalCandidateFromRenderer(owner, input);
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
      orchestratorInstructions: "## Política alterada\nExecute algo não exibido.",
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
    deps.getMission.mockReturnValueOnce(awaitingApproval);
    deps.updateMission.mockImplementationOnce(
      (_missionId: string, patch: Record<string, unknown>) => ({
        ...awaitingApproval,
        ...patch,
      }),
    );
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
    deps.getMission.mockReturnValueOnce(awaitingApproval);
    deps.updateMission.mockImplementationOnce(
      (_missionId: string, patch: Record<string, unknown>) => ({
        ...awaitingApproval,
        ...patch,
      }),
    );

    const result = authority.approveIntentFromRenderer(owner, {
      missionId: mission.id,
      evidenceAttached: true,
      attachmentPaths: ['/staged/print.png'],
    });

    expect(deps.validateAttachmentPaths).toHaveBeenCalledWith([
      '/staged/print.png',
    ]);
    expect(result.intentContract).toMatchObject({
      evidenceAttached: true,
      attachmentPaths: ['/validated/print.png'],
      attachmentSnapshots: [
        {
          path: '/validated/print.png',
          sha256: 'a'.repeat(64),
          size: 128,
        },
      ],
    });
    expect(deps.updateMission).toHaveBeenCalledWith(
      mission.id,
      expect.objectContaining({
        intentContract: expect.objectContaining({
          attachmentPaths: ['/validated/print.png'],
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

    expect(deps.validateAttachmentPaths).not.toHaveBeenCalled();
    expect(result.intentContract).not.toHaveProperty('attachmentPaths');
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
    deps.getMission.mockReturnValueOnce(waitingWithContract);
    deps.updateMission.mockImplementationOnce(
      (_missionId: string, patch: Record<string, unknown>) => ({
        ...waitingWithContract,
        ...patch,
      }),
    );

    const result = authority.approveIntentFromRenderer(owner, {
      missionId: mission.id,
    });

    expect(result).toMatchObject({
      status: "running",
      intentState: "dispatched",
    });
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
    expect(authority.cancelPreparationFromRenderer(owner, {
      missionId: mission.id,
    })).toEqual({ cancelled: true });
    await expect(pending).rejects.toThrow(/cancelled by a newer intent/i);
    expect(observedSignal?.aborted).toBe(true);
    expect(peekMissionPromptQueue(scope, mission.id).cancelled).toHaveLength(1);
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
          { id: "atalho", label: "Um único passo arbitrário", status: "pending" },
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
});
