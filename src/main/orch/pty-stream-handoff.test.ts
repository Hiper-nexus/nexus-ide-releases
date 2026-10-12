import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGateContext } from "./gate";
import { testProjectScope } from "./__tests__/scope-fixture";
import { visualTaskRequirement } from './visual-handoff-gate';

const mocks = vi.hoisted(() => ({
  getContextBySession: vi.fn(),
  markHandoffSubmitted: vi.fn(),
  onHandoffSubmitted: vi.fn(),
  getStores: vi.fn(),
  reviewMissionHandoff: vi.fn(),
  committedPhysicalWorkerHead: vi.fn(
    async (_ctx: unknown, requireHead: boolean) =>
      requireHead ? "a".repeat(40) : undefined,
  ),
  assertReadOnlyLaneObservationCurrent: vi.fn(),
  findPane: vi.fn(),
  requestPaneClose: vi.fn(),
}));

vi.mock("./gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gate")>()),
  getContextBySession: mocks.getContextBySession,
  markHandoffSubmitted: mocks.markHandoffSubmitted,
}));

const advisor = vi.hoisted(() => ({ scheduleReviewTriageAdvice: vi.fn(), scheduleCompletionCheck: vi.fn() }));
vi.mock("./jev-mission-advisor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jev-mission-advisor")>()),
  scheduleReviewTriageAdvice: advisor.scheduleReviewTriageAdvice,
  scheduleCompletionCheck: advisor.scheduleCompletionCheck,
}));
vi.mock("./idle-delivery", () => ({
  onHandoffSubmitted: mocks.onHandoffSubmitted,
}));

vi.mock("./project-domain-store-registry", () => ({
  getProjectDomainStores: mocks.getStores,
}));

vi.mock("./http-mcp-boundary", () => ({
  runInsidePtyStreamAgentTransport: (
    _sessionId: string,
    _ctx: unknown,
    operation: () => unknown,
  ) => operation(),
  mintAgentTransportPhysicalReceipt: () => ({}),
}));

vi.mock("./physical-handoff-git", () => ({
  committedPhysicalWorkerHead: mocks.committedPhysicalWorkerHead,
  assertReadOnlyLaneObservationCurrent:
    mocks.assertReadOnlyLaneObservationCurrent,
  STALE_READ_ONLY_OBSERVATION_REASON: "stale_read_only_observation",
  StaleReadOnlyObservationError: class StaleReadOnlyObservationError extends Error {
    override name = "StaleReadOnlyObservationError";
  },
}));

vi.mock("./mission-event-emit", () => ({
  getMissionEventRuntimeManager: () => null,
}));

vi.mock("./jev-handoff-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jev-handoff-review")>()),
  reviewMissionHandoff: mocks.reviewMissionHandoff,
}));

vi.mock("../jarvis/audit-log", () => ({
  auditIntent: vi.fn(),
  auditSuccess: vi.fn(),
  auditError: vi.fn(),
}));

vi.mock("./pane-registry", () => ({
  findPane: mocks.findPane,
  requestPaneClose: mocks.requestPaneClose,
}));

import {
  extractPromotablePtyHandoffs,
  submitPtyStreamHandoff,
} from "./pty-stream-handoff";
import {
  armAutoCloseOnHandoff,
  disarmAutoCloseOnHandoff,
} from "./pane-close-scopes";

const scope = testProjectScope();

const payload = {
  status: "success" as const,
  summary: "Interface implementada no pane sem tool MCP.",
  artifacts: [] as unknown[],
};

function workerCtx(): AgentGateContext {
  return {
    token: "worker-token",
    label: "agy-worker",
    role: "worker",
    missionId: "mission-a",
    sessionId: "agy-session",
    workerIncarnationId: "inc-a",
    agentName: "agy",
    contextRevision: "c".repeat(64),
    scope,
    allowedTools: [],
    allowedSkills: [],
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function approvedMission() {
  return {
    id: "mission-a",
    status: "running",
    intentState: "executing",
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: "Implementar interface",
      acceptanceCriteria: ["Done"],
      risk: "normal",
      executionMode: "assisted",
      contextPolicy: "on-demand",
      intentVersion: 1,
      approvedAt: 1,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 2,
      },
    },
  };
}

describe("extractPromotablePtyHandoffs", () => {
  it("promotes a bare NEXUS_HANDOFF snapshot and skips the kickoff placeholder", () => {
    const text =
      '### NEXUS_HANDOFF v1\n{"status":"success","summary":"<resumo objetivo do que fez>","artifacts":[]}\n' +
      'NEXUS_HANDOFF\n{"status":"success","summary":"Lista de missões renderiza cartões com scroll.","artifacts":[]}';
    expect(extractPromotablePtyHandoffs(text)).toEqual([
      {
        status: "success",
        summary: "Lista de missões renderiza cartões com scroll.",
        artifacts: [],
      },
    ]);
  });
});

describe("submitPtyStreamHandoff MCP parity", () => {
  beforeEach(() => {
    mocks.getContextBySession.mockReset();
    mocks.markHandoffSubmitted.mockReset();
    mocks.onHandoffSubmitted.mockReset();
    mocks.getStores.mockReset();
    mocks.assertReadOnlyLaneObservationCurrent.mockReset();
    mocks.reviewMissionHandoff.mockReset();
    mocks.reviewMissionHandoff.mockResolvedValue({
      kind: "skipped",
      reason: "test-default",
    });
    mocks.committedPhysicalWorkerHead.mockReset();
    mocks.committedPhysicalWorkerHead.mockImplementation(
      async (_ctx: unknown, requireHead: boolean) =>
        requireHead ? "a".repeat(40) : undefined,
    );
    mocks.findPane.mockReset();
    mocks.requestPaneClose.mockReset();
    mocks.requestPaneClose.mockResolvedValue(true);
    disarmAutoCloseOnHandoff("agy-session");
  });
  it("persists without a bound task_dispatch and wakes the Maestro (express / AGY)", async () => {
    const submitWithReplay = vi.fn(() => ({
      handoff: {
        id: "hoff-a",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      replayed: false,
    }));
    const submitAndTransition = vi.fn();
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch:
          submitAndTransition,
      },
    });

    const result = await submitPtyStreamHandoff("agy-session", payload);

    expect(result.handoffId).toBe("hoff-a");
    expect(submitAndTransition).not.toHaveBeenCalled();
    expect(submitWithReplay).toHaveBeenCalledOnce();
    expect(mocks.committedPhysicalWorkerHead).toHaveBeenCalledWith(
      expect.anything(),
      false,
    );
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'só rotulado read-only (Autopilot)', extra: { readOnly: true }, reviewed: true },
    { label: 'confinado pelo Hardened', extra: { readOnly: true, readOnlyEnforced: true }, reviewed: false },
  ])('F-1157: worker $label → revisão de evidência roda? $reviewed', async ({ extra, reviewed }) => {
    mocks.getContextBySession.mockReturnValue({ ...workerCtx(), ...extra });
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() }, tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] }, taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: vi.fn(() => ({
          handoff: { id: 'hoff-ro', evidenceTrust: 'nexus-trusted', deliveryState: 'queued' }, replayed: false,
        })),
        submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
      },
    });
    await submitPtyStreamHandoff('agy-session', { ...payload, status: 'success' });
    expect(mocks.reviewMissionHandoff.mock.calls.length > 0).toBe(reviewed);
  });

  it('F-1166: handoff PTY de código agenda a triagem consultiva da própria missão', async () => {
    advisor.scheduleReviewTriageAdvice.mockClear();
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() }, tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] }, taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: vi.fn(() => ({
          handoff: { id: 'hoff-code', evidenceTrust: 'nexus-trusted', deliveryState: 'queued' }, replayed: false,
        })),
        submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
      },
    });
    await submitPtyStreamHandoff('agy-session', { ...payload, artifacts: ['src/login.ts'] });
    expect(advisor.scheduleReviewTriageAdvice).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'mission-a', handoffId: 'hoff-code', declaredFiles: ['src/login.ts'], goal: 'Implementar interface',
    }));
    advisor.scheduleReviewTriageAdvice.mockClear();
    await submitPtyStreamHandoff('agy-session', payload);
    expect(advisor.scheduleReviewTriageAdvice).not.toHaveBeenCalled();
  });

  it('F-1166: handoff PTY de sucesso agenda a cobertura do objetivo; blocked não', async () => {
    advisor.scheduleCompletionCheck.mockClear();
    const list = vi.fn(() => [{ id: 'hoff-1', status: 'success', summary: 'feito' }]);
    const live: Record<string, unknown> = approvedMission();
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => live }, tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] }, taskDispatches: { list: () => [] },
      handoffs: {
        list,
        submitFromPhysicalAgentBoundaryWithReplay: vi.fn(() => ({
          handoff: { id: 'hoff-1', evidenceTrust: 'nexus-trusted', deliveryState: 'queued' }, replayed: false,
        })),
        submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
      },
    });
    await submitPtyStreamHandoff('agy-session', payload);
    expect(advisor.scheduleCompletionCheck).toHaveBeenCalledTimes(1);
    const [missionId, collect] = advisor.scheduleCompletionCheck.mock.calls[0]!;
    expect(missionId).toBe('mission-a');
    expect(collect()).toMatchObject({ missionId: 'mission-a', goal: 'Implementar interface', handoffs: [{ id: 'hoff-1' }] });
    // P3: worker atrasado não consulta missão já concluída.
    live.status = 'done';
    expect(collect()).toBeNull();
    live.status = 'running';
    advisor.scheduleCompletionCheck.mockClear();
    await submitPtyStreamHandoff('agy-session', { ...payload, status: 'blocked', summary: 'Bloqueado: falta credencial do banco.' });
    expect(advisor.scheduleCompletionCheck).not.toHaveBeenCalled();
  });

  it('keeps mechanical visual completion partial even when the worker claims a screenshot', async () => {
    const persist = vi.fn((_input: Record<string, unknown>) => ({
      handoff: { id: 'visual-handoff', evidenceTrust: 'nexus-trusted', deliveryState: 'queued' }, replayed: false,
    }));
    mocks.getContextBySession.mockReturnValue({ ...workerCtx(), visualTask: visualTaskRequirement('Corrija o botão que não funciona na interface do dashboard.') });
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() }, tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] }, taskDispatches: { list: () => [] },
      handoffs: { submitFromPhysicalAgentBoundaryWithReplay: persist },
    });
    await submitPtyStreamHandoff('agy-session', { ...payload, artifacts: [{ path: '/tmp/proof.png' }] });
    expect(persist.mock.calls[0]![0]).toMatchObject({ status: 'partial' });
    expect(persist.mock.calls[0]![0].artifacts).toContainEqual({ kind: 'nexus.visualVerification',
      payload: expect.objectContaining({ required: true, verified: false }) });
  });

  it("F-786: revisão fraca sem canal de retry registra partial, com texto integral preservado", async () => {
    // Campo 03/10: o fechamento mecânico nascia success sem a revisão de
    // evidência que o MCP aplica. Sem canal de devolução, a entrega fraca
    // vira partial — nunca success — e o texto integral fica nos artifacts.
    const reply = "Fechei a tarefa, mas não consegui abrir nem inspecionar o preview.";
    const submitWithReplay = vi.fn((_input: Record<string, unknown>) => ({
      handoff: {
        id: "hoff-weak",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      replayed: false,
    }));
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
      },
    });
    mocks.reviewMissionHandoff.mockResolvedValueOnce({
      kind: "weak",
      signals: ["sem evidência de verificação"],
      // O MCP devolveria este sinal ao worker; sem canal de devolução, partial.
      bounceSignals: ["sem evidência de verificação"],
      artifact: {
        kind: "nexus.jevReview",
        payload: {
          outcome: "weak",
          model: "jev-test",
          probabilities: { has_verification: 0.1 },
          signals: ["sem evidência de verificação"],
        },
      },
    });

    await submitPtyStreamHandoff("agy-session", {
      status: "success",
      summary: reply,
      artifacts: [{ auto: true, fullText: reply }],
    });

    const persisted = submitWithReplay.mock.calls[0]![0];
    expect(persisted.status).toBe("partial");
    expect(persisted.summary).toContain("[evidência fraca]");
    expect(JSON.stringify(persisted.artifacts)).toContain(
      "não consegui abrir nem inspecionar o preview",
    );
    expect(JSON.stringify(persisted.artifacts)).toContain("nexus.jevReview");
  });

  it("F-823: revisão fraca só por sinal que nem o MCP devolve fica success marcado, como no MCP", async () => {
    // Revisão adversarial M7: no MCP esse weak é success marcado; no PTY virava
    // partial, saía do portão de regressão e do done, e o CLI sem MCP entrava
    // em loop de redespacho.
    const reply = "Revisão somente leitura do parser: 1 MEDIUM (data sem fuso), 2 LOW.";
    const submitWithReplay = vi.fn((_input: Record<string, unknown>) => ({
      handoff: {
        id: "hoff-weak-review",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      replayed: false,
    }));
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
      },
    });
    mocks.reviewMissionHandoff.mockResolvedValueOnce({
      kind: "weak",
      signals: ["o texto admite pendências, mas o status é success"],
      bounceSignals: [],
      artifact: {
        kind: "nexus.jevReview",
        payload: {
          outcome: "weak",
          model: "jev-test",
          probabilities: { admits_incomplete: 0.9 },
          signals: ["o texto admite pendências, mas o status é success"],
        },
      },
    });

    await submitPtyStreamHandoff("agy-session", {
      status: "success",
      summary: reply,
      artifacts: [{ auto: true, fullText: reply }],
    });

    const persisted = submitWithReplay.mock.calls[0]![0];
    expect(persisted.status).toBe("success");
    expect(persisted.summary).toContain("[evidência fraca]");
    expect(JSON.stringify(persisted.artifacts)).toContain("nexus.jevReview");
  });

  it("F-786: revisão aprovada mantém success e anexa o artifact da revisão", async () => {
    const submitWithReplay = vi.fn((_input: Record<string, unknown>) => ({
      handoff: {
        id: "hoff-ok",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      replayed: false,
    }));
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
      },
    });
    mocks.reviewMissionHandoff.mockResolvedValueOnce({
      kind: "ok",
      artifact: {
        kind: "nexus.jevReview",
        payload: {
          outcome: "ok",
          model: "jev-test",
          probabilities: { is_specific: 0.9 },
          signals: [],
        },
      },
    });

    await submitPtyStreamHandoff("agy-session", payload);

    const persisted = submitWithReplay.mock.calls[0]![0];
    expect(persisted.status).toBe("success");
    expect(persisted.summary).not.toContain("[evidência fraca]");
    expect(JSON.stringify(persisted.artifacts)).toContain("nexus.jevReview");
  });

  it("still binds a matching dispatch and requires HEAD when ceremonial work exists", async () => {
    const submitAndTransition = vi.fn(() => ({
      handoff: {
        id: "hoff-b",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      taskDispatch: { state: "handoff_submitted" },
      replayed: false,
    }));
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      taskDispatches: {
        list: () => [
          {
            sessionId: "agy-session",
            workerIncarnationId: "inc-a",
            workerId: "agy",
            state: "running",
          },
        ],
      },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: vi.fn(),
        submitFromPhysicalAgentBoundaryAndTransitionDispatch:
          submitAndTransition,
      },
    });

    const result = await submitPtyStreamHandoff("agy-session", payload);

    expect(result.taskDispatchState).toBe("handoff_submitted");
    expect(submitAndTransition).toHaveBeenCalledOnce();
    expect(mocks.committedPhysicalWorkerHead).toHaveBeenCalledWith(
      expect.anything(),
      true,
    );
    expect(mocks.assertReadOnlyLaneObservationCurrent).toHaveBeenCalledOnce();
  });

  it("F-239: dispatch já com handoff (handoff_ready) segue pelo caminho de replay sem transição", async () => {
    const submitWithReplay = vi.fn(() => ({
      handoff: {
        id: "hoff-round-2",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      replayed: false,
    }));
    const submitAndTransition = vi.fn();
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: { get: () => approvedMission() },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      taskDispatches: {
        list: () => [
          {
            sessionId: "agy-session",
            workerIncarnationId: "inc-a",
            workerId: "agy",
            state: "handoff_ready",
            handoffId: "hoff-round-1",
          },
        ],
      },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch:
          submitAndTransition,
      },
    });

    const result = await submitPtyStreamHandoff("agy-session", payload);

    expect(result.handoffId).toBe("hoff-round-2");
    expect(submitAndTransition).not.toHaveBeenCalled();
    expect(submitWithReplay).toHaveBeenCalledOnce();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledOnce();
  });

  it("Via Rápida: missão VIVA sem contrato cerimonial aprovado aceita o fechamento mecânico", async () => {
    // Campo 22/08 ("nenhum pane entrega handoffs"): pane ad-hoc do
    // nexus_pane_spawn (meta-de-pane/revisor) não tem dispatch selado —
    // exigir contrato aprovado aqui matava a resposta curta C-194.1.
    const submitWithReplay = vi.fn(() => ({
      handoff: {
        id: "hoff-fastlane",
        evidenceTrust: "nexus-trusted",
        deliveryState: "queued",
      },
      replayed: false,
    }));
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: {
        get: () => ({
          id: "mission-a",
          status: "running",
          intentState: "executing",
          intentVersion: 3,
          // Sem contrato (ou com contrato de revisão antiga): a autoridade
          // vem do gate ctx físico, não de cerimônia que a Via Rápida
          // não tem.
          intentContract: null,
        }),
      },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
      },
    });

    const result = await submitPtyStreamHandoff("agy-session", payload);

    expect(result.handoffId).toBe("hoff-fastlane");
    expect(submitWithReplay).toHaveBeenCalledOnce();
  });

  it("missão encerrada sem autoridade cerimonial recusa o stream (nada entra depois do fim)", async () => {
    mocks.getContextBySession.mockReturnValue(workerCtx());
    mocks.getStores.mockReturnValue({
      missions: {
        get: () => ({
          id: "mission-a",
          status: "done",
          intentState: "executing",
          intentVersion: 3,
          intentContract: null,
        }),
      },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      taskDispatches: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundaryWithReplay: vi.fn(),
        submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
      },
    });

    await expect(submitPtyStreamHandoff("agy-session", payload)).rejects.toThrow(
      /handoff_origin: mission is not live/u,
    );
  });

  // F-1409: o caminho PTY (legacy block, fechamento mecânico, agy sem MCP)
  // registrava success no ledger mas nunca acionava o auto-close — o pane
  // ficava aberto até o operador fechar à mão. A entrega vive no ledger,
  // não no PTY do worker: success registrado fecha o worker armado,
  // independentemente de o Maestro já ter consumido (deliveryState queued).
  describe("F-1409 auto-close no caminho PTY", () => {
    function mockStoresWithSuccessHandoff(status: string, deliveryState = "queued") {
      const submitWithReplay = vi.fn(() => ({
        handoff: {
          id: "hoff-autoclose",
          status,
          evidenceTrust: "nexus-trusted",
          deliveryState,
        },
        replayed: false,
      }));
      mocks.getContextBySession.mockReturnValue(workerCtx());
      mocks.getStores.mockReturnValue({
        missions: { get: () => approvedMission() },
        tasks: { list: () => [], getPlannedTask: () => null },
        missionPanes: { list: () => [] },
        taskDispatches: { list: () => [] },
        handoffs: {
          submitFromPhysicalAgentBoundaryWithReplay: submitWithReplay,
          submitFromPhysicalAgentBoundaryAndTransitionDispatch: vi.fn(),
        },
      });
      return submitWithReplay;
    }

    it("worker armado + success com Maestro ocupado (deliveryState=queued) → pane fecha", async () => {
      armAutoCloseOnHandoff("agy-session", "pane-agy");
      mocks.findPane.mockReturnValue({ paneId: "pane-agy", sessionId: "agy-session" });
      mockStoresWithSuccessHandoff("success");

      await submitPtyStreamHandoff("agy-session", payload);

      await vi.waitFor(() => {
        expect(mocks.requestPaneClose).toHaveBeenCalledWith(
          "pane-agy",
          "agy-session",
        );
      });
    });

    it("partial mantém o pane aberto mesmo com o braço armado", async () => {
      armAutoCloseOnHandoff("agy-session", "pane-agy");
      mocks.findPane.mockReturnValue({ paneId: "pane-agy", sessionId: "agy-session" });
      mockStoresWithSuccessHandoff("partial");

      await submitPtyStreamHandoff("agy-session", {
        ...payload,
        status: "partial",
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(mocks.requestPaneClose).not.toHaveBeenCalled();
      // O braço permanece: um success posterior ainda pode fechar.
      expect(mocks.onHandoffSubmitted).toHaveBeenCalledOnce();
    });

    it("sem o braço (autoCloseOnHandoff:false / operador) success não fecha o pane", async () => {
      mocks.findPane.mockReturnValue({ paneId: "pane-agy", sessionId: "agy-session" });
      mockStoresWithSuccessHandoff("success");

      await submitPtyStreamHandoff("agy-session", payload);

      await new Promise((resolve) => setImmediate(resolve));
      expect(mocks.requestPaneClose).not.toHaveBeenCalled();
    });
  });
});
