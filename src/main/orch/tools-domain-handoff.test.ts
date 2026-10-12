import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handoff } from "../../shared/orch-types";
import type { AgentGateContext } from "./gate";
import type { McpToolInvocation } from "./mcp-protocol";
import { encodeCursor } from "../../shared/cursor-pagination";
import { handoffListCursorSlice } from "./tools-handoff";
import { testProjectScope } from "./__tests__/scope-fixture";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  submitWithReplay: vi.fn(),
  submitAndTransition: vi.fn(),
  markHandoffSubmitted: vi.fn(),
  onHandoffSubmitted: vi.fn(),
  orchWriteSession: vi.fn(() => true),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock flexibility for per-test implementations
  getSessionState: vi.fn((): any => null),
  getStores: vi.fn(),
  listHandoffs: vi.fn((): Array<Record<string, unknown> & { id: string }> => []),
  heartbeat: vi.fn(),
  acceptHandoff: vi.fn(),
  markConsumedFromPhysicalAck: vi.fn(),
  getHandoff: vi.fn((): Record<string, unknown> | null => null),
  requireMissionLeaderSession: vi.fn(
    (_scope: unknown, missionId: string, ctx: { sessionId?: string | null }) => {
      try {
        const leaderSessionId = mocks.getStores().missions.get(missionId)
          ?.orchestratorSessionId;
        if (!leaderSessionId) return { ok: false, code: "no-leader", hint: "sem líder durável" };
        if (Object.hasOwn(ctx, "sessionId") && ctx.sessionId !== leaderSessionId) {
          return { ok: false, code: "stale-session", hint: "sessão obsoleta" };
        }
        return {
          ok: true,
          leader: { sessionId: leaderSessionId, paneId: null, source: "live", proven: true },
        };
      } catch {
        return { ok: false, code: "no-leader", hint: "store indisponível" };
      }
    },
  ),
}));

vi.mock("./gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gate")>()),
  markHandoffSubmitted: mocks.markHandoffSubmitted,
}));

const advisor = vi.hoisted(() => ({ scheduleReviewTriageAdvice: vi.fn(), scheduleCompletionCheck: vi.fn() }));
vi.mock("./jev-mission-advisor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jev-mission-advisor")>()),
  scheduleReviewTriageAdvice: advisor.scheduleReviewTriageAdvice,
  scheduleCompletionCheck: advisor.scheduleCompletionCheck,
}));
vi.mock("../jev/jev-decision-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev/jev-decision-log")>()),
  recordJevDecision: vi.fn(() => "id"),
}));
vi.mock("./idle-delivery", () => ({
  onHandoffSubmitted: mocks.onHandoffSubmitted,
}));

vi.mock("../pty/pty-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pty/pty-manager")>()),
  orchWriteSession: mocks.orchWriteSession,
  getSessionState: mocks.getSessionState,
}));

vi.mock("./project-domain-store-registry", () => ({
  getProjectDomainStores: mocks.getStores,
}));

vi.mock("./mission-leader-gate", () => ({
  requireMissionLeaderSession: mocks.requireMissionLeaderSession,
}));

// F-1319: transporte do writer ao qual o veredito "rework" volta.
const reworkMocks = vi.hoisted(() => ({
  spawn: vi.fn(async (): Promise<unknown> => ({ paneId: "pane-reopened", sessionId: "session-reopened" })),
  injectPrompt: vi.fn(async (_sessionId: string, _prompt: string) => undefined),
  isolatedWriterPaneOfSession: vi.fn((): string | undefined => undefined),
}));
vi.mock("./tools-panes", async (importOriginal) => {
  const original = await importOriginal<typeof import("./tools-panes")>();
  return {
    ...original,
    paneSpawnTool: { ...original.paneSpawnTool, handler: reworkMocks.spawn },
  };
});
vi.mock("./tool-util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tool-util")>()),
  injectPrompt: reworkMocks.injectPrompt,
}));
vi.mock("./isolated-writer-worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./isolated-writer-worktree")>()),
  isolatedWriterPaneOfSession: reworkMocks.isolatedWriterPaneOfSession,
}));

const jevReview = vi.hoisted(() => ({
  reviewMissionHandoff: vi.fn<
    () => Promise<import("./jev-handoff-review").JevReviewVerdict>
  >(async () => ({ kind: "skipped", reason: "mocked" })),
}));

vi.mock("./jev-handoff-review", () => jevReview);

const paneMocks = vi.hoisted(() => ({
  listPaneSnapshots: vi.fn(
    (): Array<{ paneId: string; sessionId: string | null; paneNumber?: number }> => [
      { paneId: "pane-live", sessionId: "session-live", paneNumber: 1 },
    ],
  ),
}));

vi.mock("./pane-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pane-registry")>()),
  listPaneSnapshots: () => paneMocks.listPaneSnapshots(),
}));

const regressionGate = vi.hoisted(() => ({
  evaluateHandoffRegressionGate: vi.fn<
    () => Promise<
      import("../regression-gate/regression-gate-handoff").RegressionHandoffVerdict
    >
  >(async () => ({ kind: "skipped", reason: "mocked" })),
}));

vi.mock("../regression-gate/regression-gate-handoff", () => ({
  ...regressionGate,
  REGRESSION_UNVERIFIED_PREFIX: "[testes impactados não verificados]",
}));

import { buildDomainTools } from "./tools-domain";
import { visualTaskRequirement } from './visual-handoff-gate';
import {
  armDeliveryContract,
  armedDeliveryContract,
  parseExpectArg,
  resetDeliveryContractsForTesting,
} from "./delivery-contract";

const scope = testProjectScope();
const tempDirectories: string[] = [];

function createCommittedWorktree(): { readonly root: string; readonly head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handoff-head-"));
  tempDirectories.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Nexus Test"]);
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@nexus.invalid",
  ]);
  fs.writeFileSync(path.join(root, "result.txt"), "physical\n");
  execFileSync("git", ["-C", root, "add", "--", "result.txt"]);
  execFileSync("git", [
    "-C",
    root,
    "commit",
    "--quiet",
    "-m",
    "worker result",
  ]);
  return {
    root,
    head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  };
}

function context(executionRoot?: string): AgentGateContext {
  return {
    token: "worker-token",
    label: "worker",
    role: "worker",
    missionId: "mission-a",
    sessionId: "worker-session",
    workerIncarnationId: "worker-incarnation-a",
    agentName: "worker-a",
    contextRevision: "c".repeat(64),
    scope,
    executionScope: executionRoot
      ? { ...scope, rootRealPath: executionRoot }
      : undefined,
    allowedTools: [],
    allowedSkills: [],
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function orchestratorContext(): AgentGateContext {
  return {
    ...context(),
    token: "orchestrator-token",
    label: "Maestro",
    role: "orchestrator",
    sessionId: "orchestrator-session",
    workerIncarnationId: undefined,
    agentName: "Maestro",
  };
}

function invocation(
  overrides: Partial<NonNullable<McpToolInvocation["effectIntent"]>> = {},
): McpToolInvocation {
  return {
    assertCurrentAuthority: vi.fn(),
    agentTransportPhysicalReceipt: Object.freeze({}) as NonNullable<
      McpToolInvocation["agentTransportPhysicalReceipt"]
    >,
    effectIntent: {
      toolCallId: "tool-call-a",
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      issuedAt: 1,
      ...overrides,
    },
  };
}

function handoff(evidenceTrust: Handoff["evidenceTrust"]): Handoff {
  return {
    id: "handoff-a",
    missionId: "mission-a",
    sessionId: "worker-session",
    fromAgent: "worker-a",
    status: "success",
    claimTrust: "untrusted",
    summary: "Worker reports that implementation is complete.",
    artifacts: [],
    evidenceIds: evidenceTrust === "nexus-trusted" ? ["evidence-a"] : [],
    evidenceTrust,
    delivered: false,
    deliveryState: "queued",
    createdAt: 1,
  };
}

function submitTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === "nexus_handoff_submit",
  );
  if (!tool) throw new Error("handoff submit tool is not registered");
  return tool;
}

function heartbeatTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === "nexus_worker_heartbeat",
  );
  if (!tool) throw new Error("worker heartbeat tool is not registered");
  return tool;
}

function listTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === "nexus_handoff_list",
  );
  if (!tool) throw new Error("handoff list tool is not registered");
  return tool;
}

function mockedHandoffRows(): Array<{ id: string; createdAt?: number }> {
  return mocks.listHandoffs() as Array<{ id: string; createdAt?: number }>;
}

function mockedListCursorPage(filter: {
  after?: { createdAt: number; id: string };
  limit: number;
}) {
  const rows = mockedHandoffRows();
  const after = filter.after;
  const start = after
    ? rows.findIndex((row) => {
        const createdAt = row.createdAt ?? 0;
        return (
          createdAt > after.createdAt ||
          (createdAt === after.createdAt && row.id > after.id)
        );
      })
    : 0;
  const from = start < 0 ? rows.length : start;
  return rows.slice(from, from + filter.limit);
}

function mockedListRecentIds(_filter: unknown, limit = 5): string[] {
  const rows = mocks.listHandoffs() as Array<{ id: string; createdAt?: number }>;
  const count = typeof limit === "number" ? limit : 5;
  return rows.slice(Math.max(0, rows.length - count)).map((row) => row.id);
}

function acknowledgeTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === "nexus_handoff_ack",
  );
  if (!tool) throw new Error("handoff acknowledge tool is not registered");
  return tool;
}

describe("handoff MCP stop receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionState.mockReturnValue(null);
    resetDeliveryContractsForTesting();
    mocks.getStores.mockReturnValue({
      missions: {
        get: () => ({
          id: "mission-a",
          title: "Mission",
          description: "Authorized work",
          status: "running",
          orchestratorSessionId: "orchestrator-session",
          milestones: [],
          learnings: "",
          intentState: "dispatched",
          intentVersion: 1,
          intentContract: {
            version: 1,
            source: "typed",
            goal: "Authorized work",
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
          createdAt: 1,
          updatedAt: 1,
        }),
      },
      tasks: { list: () => [], getPlannedTask: () => null },
      missionPanes: { list: () => [] },
      handoffs: {
        recoverPhysicalReplayTerminalTail: () => null,
        submitFromPhysicalAgentBoundary: mocks.submit,
        submitFromPhysicalAgentBoundaryWithReplay: mocks.submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch:
          mocks.submitAndTransition,
        list: mocks.listHandoffs,
        listCursorPage: mockedListCursorPage,
        listRecentIds: mockedListRecentIds,
        markConsumedFromPhysicalAck: mocks.markConsumedFromPhysicalAck,
        get: mocks.getHandoff,
      },
      taskDispatches: {
        list: () => [],
        heartbeat: mocks.heartbeat,
        acceptHandoff: mocks.acceptHandoff,
      },
    });
    mocks.submitWithReplay.mockImplementation(
      (input: unknown, receipt: unknown, options: unknown) => ({
        handoff: mocks.submit(input, receipt, options),
        replayed: false,
      }),
    );
  });

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when mission authority cannot be loaded", async () => {
    mocks.getStores.mockImplementationOnce(() => {
      throw new Error("database at /private/runtime.sqlite failed");
    });

    await expect(
      submitTool().handler(
        {
          status: "success",
          summary: "Worker reports that implementation is complete.",
        },
        context(),
        invocation(),
      ),
    ).rejects.toThrow("handoff_origin: mission authority unavailable");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('marks a visual assignment partial despite success prose and a claimed PNG', async () => {
    const ctx = { ...context(), visualTask: visualTaskRequirement('Corrija o bug no layout responsivo da tela de login.') };
    mocks.submit.mockReturnValue(handoff('nexus-trusted'));
    const result = await submitTool().handler({ status: 'success', summary: 'Interface pronta e validada.',
      artifacts: [{ path: '/tmp/claimed.png', kind: 'screenshot' }],
    }, ctx, invocation());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ status: 'partial' });
    expect(mocks.submit.mock.calls[0]![0].summary).toContain('verificação visual pendente');
    expect(result).toMatchObject({ status: 'partial', visualVerification: { required: true, verified: false } });
  });

  it("preserves a plan handoff above 4k exactly for physical promotion", async () => {
    const stores = mocks.getStores();
    const baseMission = stores.missions.get();
    stores.missions.get = () => ({
      ...baseMission,
      intentContract: {
        ...baseMission.intentContract,
        lane: "plan",
        dispatchedAt: 1,
      },
    });
    const exactPlan = [
      "# PRD físico",
      "Arquitetura, critérios e stories verificáveis.",
      "x".repeat(6_000),
    ].join("\n");
    mocks.submit.mockImplementation((input: { summary: string }) => ({
      ...handoff("unverified"),
      summary: input.summary,
    }));

    await submitTool().handler(
      { status: "success", summary: exactPlan },
      context(),
      invocation(),
    );

    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ summary: exactPlan }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("bounces a weak success handoff when the Jev review says retry", async () => {
    jevReview.reviewMissionHandoff.mockResolvedValueOnce({
      kind: "retry",
      signals: ["sem evidência de verificação"],
      attempt: 1,
      retries: 1,
      message:
        "revisão de evidência (Jev) — devolução 1/1: sem evidência de verificação. Reenvie o nexus_handoff_submit com a evidência real.",
    });

    await expect(
      submitTool().handler(
        {
          status: "success",
          summary: "Worker reports that implementation is complete.",
        },
        context(),
        invocation(),
      ),
    ).rejects.toThrow(/revisão de evidência \(Jev\) — devolução 1\/1/);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("portão de regressão: teste impactado falhando devolve o handoff ao worker", async () => {
    regressionGate.evaluateHandoffRegressionGate.mockResolvedValueOnce({
      kind: "retry",
      message:
        "handoff NÃO aceito pelo portão de regressão (devolução 1/2).\n- src/a.test.ts: soma",
    });

    await expect(
      submitTool().handler(
        {
          status: "success",
          summary: "Worker reports that implementation is complete.",
        },
        context(),
        invocation(),
      ),
    ).rejects.toThrow(/portão de regressão \(devolução 1\/2\)/);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(jevReview.reviewMissionHandoff).not.toHaveBeenCalled();
  });

  it("portão de regressão sem verificar: aceita, mas o resumo e o artifact dizem 'não verificado'", async () => {
    regressionGate.evaluateHandoffRegressionGate.mockResolvedValueOnce({
      kind: "accepted",
      unverified: true,
      artifact: {
        kind: "nexus.regressionGate",
        payload: {
          status: "unavailable",
          diffHash: "h",
          headSha: null,
          baseSha: null,
          runner: "vitest",
          testsRun: [],
          testsNotRun: ["src/a.test.ts"],
          failures: [],
          inheritedFailures: [],
          preexistingFailures: [],
          untestedFiles: [],
          invariantsTouched: [],
          warnings: ["vitest excedeu 100000ms"],
        },
      },
    });
    mocks.submit.mockReturnValue(handoff("unverified"));

    await submitTool().handler(
      {
        status: "success",
        summary: "Worker reports that implementation is complete.",
      },
      context(),
      invocation(),
    );

    const persisted = mocks.submit.mock.calls[0]?.[0] as {
      status?: string;
      summary?: string;
      artifacts?: Array<{ kind: string }>;
    };
    expect(persisted?.status).toBe("success");
    expect(persisted?.summary).toMatch(/^\[testes impactados não verificados\] /);
    expect(persisted?.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "nexus.regressionGate" })]),
    );
  });

  it("portão de regressão esgotado: persiste como blocked com as falhas em artifact", async () => {
    regressionGate.evaluateHandoffRegressionGate.mockResolvedValueOnce({
      kind: "exhausted",
      report: "Seu diff quebrou 1 arquivo(s)",
      artifact: {
        kind: "nexus.regressionGate",
        payload: {
          status: "failed",
          diffHash: "h",
          headSha: null,
          baseSha: null,
          runner: "vitest",
          testsRun: ["src/a.test.ts"],
          testsNotRun: [],
          failures: [{ file: "src/a.test.ts", message: "soma" }],
          inheritedFailures: [],
          preexistingFailures: [],
          untestedFiles: [],
          invariantsTouched: [],
          warnings: [],
        },
      },
    });
    mocks.submit.mockReturnValue({ ...handoff("unverified"), status: "blocked" });

    await submitTool().handler(
      {
        status: "success",
        summary: "Worker reports that implementation is complete.",
      },
      context(),
      invocation(),
    );

    const persisted = mocks.submit.mock.calls[0]?.[0] as {
      status?: string;
      summary?: string;
      artifacts?: Array<{ kind: string }>;
    };
    expect(persisted?.status).toBe("blocked");
    expect(persisted?.summary).toMatch(/^\[testes impactados falhando\] /);
    expect(persisted?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "nexus.regressionGate" }),
      ]),
    );
    expect(jevReview.reviewMissionHandoff).not.toHaveBeenCalled();
  });

  it("accepts a weak handoff flagged when the Jev budget is exhausted", async () => {
    jevReview.reviewMissionHandoff.mockResolvedValueOnce({
      kind: "weak",
      signals: ["sem evidência de verificação"],
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
    mocks.submit.mockImplementationOnce(
      (input: { summary: string; artifacts: unknown[] }) => ({
        ...handoff("unverified"),
        summary: input.summary,
        artifacts: input.artifacts,
      }),
    );

    const result = await submitTool().handler(
      {
        status: "success",
        summary: "Worker reports that implementation is complete.",
      },
      context(),
      invocation(),
    );

    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringMatching(/^\[evidência fraca\] /),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: "nexus.jevReview" }),
        ]),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(result).toMatchObject({ jevReview: "weak" });
  });

  it("F-1166: handoff de código de sucesso agenda a triagem consultiva (sem esperar); sem arquivos, não", async () => {
    advisor.scheduleReviewTriageAdvice.mockClear();
    await submitTool().handler(
      { status: "success", summary: "Implementei o formulário de login com testes.", filesModified: ["src/login.ts"] },
      context(), invocation(),
    );
    expect(advisor.scheduleReviewTriageAdvice).toHaveBeenCalledTimes(1);
    expect(advisor.scheduleReviewTriageAdvice).toHaveBeenCalledWith(expect.objectContaining({
      missionId: "mission-a", handoffId: "handoff-a", declaredFiles: ["src/login.ts"],
    }));
    advisor.scheduleReviewTriageAdvice.mockClear();
    await submitTool().handler(
      { status: "success", summary: "Respondi a pergunta do Maestro sem mexer em código." },
      context(), invocation(),
    );
    expect(advisor.scheduleReviewTriageAdvice).not.toHaveBeenCalled();
  });

  it("skips the Jev review for plan-lane handoffs", async () => {
    const stores = mocks.getStores();
    const baseMission = stores.missions.get();
    stores.missions.get = () => ({
      ...baseMission,
      intentContract: {
        ...baseMission.intentContract,
        lane: "plan",
        dispatchedAt: 1,
      },
    });
    mocks.submit.mockReturnValue(handoff("unverified"));

    const result = await submitTool().handler(
      {
        status: "success",
        summary:
          "# PRD físico\nArquitetura, critérios e stories verificáveis.",
      },
      context(),
      invocation(),
    );

    expect(jevReview.reviewMissionHandoff).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalled();
    expect(result).not.toMatchObject({ jevReview: expect.anything() });
    const persisted = mocks.submit.mock.calls[0]?.[0] as {
      artifacts?: Array<{ kind: string }>;
    };
    expect(
      persisted?.artifacts?.some((a) => a.kind === "nexus.jevReview"),
    ).not.toBe(true);
  });

  it("skips the Jev review for read-only sessions", async () => {
    mocks.submit.mockReturnValue(handoff("unverified"));

    const result = await submitTool().handler(
      {
        status: "success",
        summary:
          "Reviewed the worker output; findings recorded for the Maestro.",
      },
      { ...context(), readOnly: true },
      invocation(),
    );

    expect(jevReview.reviewMissionHandoff).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalled();
    expect(result).not.toMatchObject({ jevReview: expect.anything() });
  });

  it("skips the Jev review when the deterministic contract is exhausted", async () => {
    resetDeliveryContractsForTesting();
    armDeliveryContract(
      "worker-session",
      parseExpectArg({ schema: { type: "array", minItems: 1 }, retries: 0 })!,
    );
    mocks.submit.mockReturnValue({
      ...handoff("unverified"),
      status: "blocked",
    });

    const result = await submitTool().handler(
      {
        status: "success",
        summary: "Entreguei tudo conforme o contrato pedido no spawn.",
      },
      context(),
      invocation(),
    );

    expect(jevReview.reviewMissionHandoff).not.toHaveBeenCalled();
    const persisted = mocks.submit.mock.calls[0]?.[0] as {
      status?: string;
      artifacts?: Array<{ kind: string }>;
    };
    expect(persisted?.status).toBe("blocked");
    expect(
      persisted?.artifacts?.some((a) => a.kind === "nexus.jevReview"),
    ).not.toBe(true);
    expect(result).not.toMatchObject({ jevReview: expect.anything() });
  });

  it("accepts a physical PTY-stream final handoff from the current Maestro", async () => {
    const submitted = {
      ...handoff("unverified"),
      sessionId: "orchestrator-session",
      fromAgent: "Maestro",
    };
    mocks.submit.mockReturnValue(submitted);

    const result = await submitTool().handler(
      {
        status: "success",
        summary:
          "O Maestro concluiu a entrega e registrou as evidências operacionais.",
      },
      orchestratorContext(),
      invocation({ source: "pty-stream" }),
    );

    expect(result).toMatchObject({
      ok: true,
      handoffId: submitted.id,
    });
    expect(mocks.submitWithReplay).toHaveBeenCalledOnce();
  });

  it("rejects a plan handoff whose UTF-8 payload exceeds 32 KiB", async () => {
    const stores = mocks.getStores();
    const baseMission = stores.missions.get();
    stores.missions.get = () => ({
      ...baseMission,
      intentContract: {
        ...baseMission.intentContract,
        lane: "plan",
        dispatchedAt: 1,
      },
    });

    await expect(
      submitTool().handler(
        {
          status: "success",
          summary: `# PRD físico\n${"á".repeat(20_000)}`,
        },
        context(),
        invocation(),
      ),
    ).rejects.toThrow(/32 KiB/i);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps non-plan handoffs compact", async () => {
    const submitted = handoff("unverified");
    mocks.submit.mockReturnValue(submitted);

    await submitTool().handler(
      {
        status: "success",
        summary: `Resultado operacional\n${"x".repeat(6_000)}`,
      },
      context(),
      invocation(),
    );

    const persisted = mocks.submit.mock.calls[0]?.[0] as
      { summary?: string } | undefined;
    expect(persisted?.summary).toContain("[compacted]");
    expect(persisted?.summary?.length).toBeLessThanOrEqual(4_000);
  });

  it("summary acima de 400 é condensado em fronteira de frase e a íntegra vira overclock.fullText", async () => {
    resetDeliveryContractsForTesting();
    mocks.submit.mockReturnValue(handoff("unverified"));
    const sentence =
      "Implementei a validação do contrato de entrega com os testes verdes.";
    const long = Array(12).fill(sentence).join(" ");

    await submitTool().handler(
      { status: "success", summary: long },
      context(),
      invocation(),
    );

    const persisted = mocks.submit.mock.calls[0]?.[0] as {
      summary?: string;
      artifacts?: Array<{ kind: string; payload: unknown }>;
    };
    expect(persisted?.summary?.length).toBeLessThanOrEqual(420);
    expect(persisted?.summary).toMatch(/\. \[compacted\]$/);
    const fullText = persisted?.artifacts?.find(
      (artifact) => artifact.kind === "overclock.fullText",
    );
    expect(String(fullText?.payload)).toContain(sentence);
    expect(String(fullText?.payload).length).toBeGreaterThan(400);
  });

  it("contrato de entrega: a primeira divergência devolve ao worker o que falta, sem persistir", async () => {
    resetDeliveryContractsForTesting();
    armDeliveryContract(
      "worker-session",
      parseExpectArg({ schema: { type: "array", minItems: 1 } })!,
    );

    await expect(
      submitTool().handler(
        {
          status: "success",
          summary: "Entreguei tudo conforme o contrato pedido no spawn.",
        },
        context(),
        invocation(),
      ),
    ).rejects.toThrow(
      /contrato de entrega não cumprido \(devolução 1\/1\).*mínimo 1 itens/,
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(armedDeliveryContract("worker-session")).not.toBeNull();
  });

  it("contrato de entrega esgotado: persiste como blocked com as violações em artifacts e desarma", async () => {
    resetDeliveryContractsForTesting();
    armDeliveryContract(
      "worker-session",
      parseExpectArg({ schema: { type: "array", minItems: 1 }, retries: 0 })!,
    );
    mocks.submit.mockReturnValue({
      ...handoff("unverified"),
      status: "blocked",
    });

    await submitTool().handler(
      {
        status: "success",
        summary: "Entreguei tudo conforme o contrato pedido no spawn.",
      },
      context(),
      invocation(),
    );

    const persisted = mocks.submit.mock.calls[0]?.[0] as {
      status?: string;
      artifacts?: Array<{ kind: string; payload: unknown }>;
    };
    expect(persisted?.status).toBe("blocked");
    expect(persisted?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "nexus.deliveryContract",
          payload: expect.objectContaining({
            outcome: "unmet",
            attempts: 1,
            retries: 0,
          }),
        }),
      ]),
    );
    expect(armedDeliveryContract("worker-session")).toBeNull();
  });

  it("contrato de entrega cumprido desarma; blocked declarado não é cobrado", async () => {
    resetDeliveryContractsForTesting();
    armDeliveryContract(
      "worker-session",
      parseExpectArg({ schema: { type: "array", minItems: 1 } })!,
    );
    mocks.submit.mockReturnValue(handoff("unverified"));

    await submitTool().handler(
      {
        status: "success",
        summary: "Entreguei tudo conforme o contrato pedido no spawn.",
        artifacts: [{ kind: "file", path: "src/a.ts" }],
      },
      context(),
      invocation(),
    );
    expect(armedDeliveryContract("worker-session")).toBeNull();

    armDeliveryContract(
      "worker-session",
      parseExpectArg({ schema: { type: "array", minItems: 1 } })!,
    );
    await submitTool().handler(
      {
        status: "blocked",
        summary: "Não consegui produzir os artefatos exigidos pelo contrato.",
      },
      context(),
      invocation({ toolCallId: "tool-call-b" }),
    );
    const persisted = mocks.submit.mock.calls[1]?.[0] as { status?: string };
    expect(persisted?.status).toBe("blocked");
    expect(armedDeliveryContract("worker-session")).not.toBeNull();
  });

  it("binds replay identity to the full raw payload before compaction", async () => {
    const submitted = handoff("unverified");
    mocks.submit.mockImplementation((input: { summary: string }) => ({
      ...submitted,
      summary: input.summary,
    }));
    const sharedHead = "h".repeat(2_700);
    const sharedTail = "t".repeat(1_300);
    const first = `${sharedHead}${"x".repeat(1_000)}${sharedTail}`;
    const second = `${sharedHead}${"y".repeat(1_000)}${sharedTail}`;

    await submitTool().handler(
      { status: "success", summary: first },
      context(),
      invocation(),
    );
    await submitTool().handler(
      { status: "success", summary: second },
      context(),
      invocation({ toolCallId: "tool-call-b" }),
    );

    const firstInput = mocks.submit.mock.calls[0]?.[0] as {
      summary: string;
    };
    const secondInput = mocks.submit.mock.calls[1]?.[0] as {
      summary: string;
    };
    const firstOptions = mocks.submit.mock.calls[0]?.[2] as {
      rawPayloadSha256: string;
    };
    const secondOptions = mocks.submit.mock.calls[1]?.[2] as {
      rawPayloadSha256: string;
    };
    expect(firstInput.summary).toBe(secondInput.summary);
    expect(firstInput.summary).toContain("[compacted]");
    expect(firstOptions.rawPayloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondOptions.rawPayloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstOptions.rawPayloadSha256).not.toBe(
      secondOptions.rawPayloadSha256,
    );
  });

  it("acks only one handoff through the current physical orchestrator delivery", async () => {
    mocks.markConsumedFromPhysicalAck.mockReturnValue(true);
    const orchestrator = {
      ...context(),
      token: "orchestrator-token",
      label: "orchestrator",
      role: "orchestrator" as const,
      sessionId: "orchestrator-session",
      workerIncarnationId: undefined,
    };

    await expect(
      acknowledgeTool().handler(
        { handoffId: "handoff-a" },
        orchestrator,
        invocation({
          toolCallId: "ack-tool-call-a",
          toolName: "nexus_handoff_ack",
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      handoffId: "handoff-a",
      deliveryState: "consumed",
      verdict: "accepted",
    });
    expect(mocks.markConsumedFromPhysicalAck).toHaveBeenCalledWith(
      {
        handoffId: "handoff-a",
        missionId: "mission-a",
        orchestratorSessionId: "orchestrator-session",
        verdict: "accepted",
      },
      expect.any(Object),
    );
  });

  it('F-782: verdict "rework" chega ao store junto do ACK', async () => {
    mocks.markConsumedFromPhysicalAck.mockReturnValue(true);
    const orchestrator = {
      ...context(),
      role: "orchestrator" as const,
      sessionId: "orchestrator-session",
      workerIncarnationId: undefined,
    };

    await expect(
      acknowledgeTool().handler(
        { handoffId: "handoff-a", verdict: "rework" },
        orchestrator,
        invocation({ toolCallId: "ack-tool-call-rework", toolName: "nexus_handoff_ack" }),
      ),
    ).resolves.toMatchObject({ ok: true, verdict: "rework" });
    expect(mocks.markConsumedFromPhysicalAck).toHaveBeenCalledWith(
      expect.objectContaining({ handoffId: "handoff-a", verdict: "rework" }),
      expect.any(Object),
    );
  });

  it("F-782: veredito inválido é recusado ANTES de consumir o handoff", async () => {
    const orchestrator = {
      ...context(),
      role: "orchestrator" as const,
      sessionId: "orchestrator-session",
      workerIncarnationId: undefined,
    };

    await expect(
      acknowledgeTool().handler(
        { handoffId: "handoff-a", verdict: "rejeitado" },
        orchestrator,
        invocation({ toolCallId: "ack-tool-call-bad", toolName: "nexus_handoff_ack" }),
      ),
    ).rejects.toThrow(/verdict must be "accepted" or "rework"/);
    expect(mocks.markConsumedFromPhysicalAck).not.toHaveBeenCalled();
  });

  describe("F-1319: o veredito rework volta ao writer", () => {
    const orchestrator = () => ({
      ...context(),
      role: "orchestrator" as const,
      sessionId: "orchestrator-session",
      workerIncarnationId: undefined,
    });
    const ack = (args: Record<string, unknown>) =>
      acknowledgeTool().handler(
        { handoffId: "handoff-a", verdict: "rework", ...args },
        orchestrator(),
        invocation({ toolCallId: "ack-tool-call-rework", toolName: "nexus_handoff_ack" }),
      );
    beforeEach(() => {
      mocks.markConsumedFromPhysicalAck.mockReturnValue(true);
      mocks.getHandoff.mockReturnValue({ id: "handoff-a", missionId: "mission-a", sessionId: "writer-session" });
      reworkMocks.isolatedWriterPaneOfSession.mockReturnValue(undefined);
      reworkMocks.spawn.mockResolvedValue({ paneId: "pane-reopened", sessionId: "session-reopened" });
    });
    afterEach(() => {
      paneMocks.listPaneSnapshots.mockReturnValue([
        { paneId: "pane-live", sessionId: "session-live", paneNumber: 1 },
      ]);
    });

    it("writer já encerrado com worktree própria: reabre com resume e a nota vira o prompt", async () => {
      paneMocks.listPaneSnapshots.mockReturnValue([
        { paneId: "pane-writer", sessionId: "writer-session", paneNumber: 3, state: "exited" } as never,
      ]);
      reworkMocks.isolatedWriterPaneOfSession.mockReturnValue("pane-writer");
      await expect(ack({ note: "falta o teste do caso vazio" })).resolves.toMatchObject({
        ok: true,
        verdict: "rework",
        reworkDelivered: true,
        reworkVia: "resume",
        paneId: "pane-reopened",
      });
      expect(reworkMocks.spawn).toHaveBeenCalledTimes(1);
      const [spawnArgs, spawnCtx] = reworkMocks.spawn.mock.calls[0] as unknown as [Record<string, unknown>, { sessionId: string }];
      expect(spawnArgs).toMatchObject({ resume: "pane-writer", missionId: "mission-a" });
      expect(spawnArgs.prompt).toContain("falta o teste do caso vazio");
      expect(spawnArgs.prompt).toContain("handoff-a");
      expect(spawnCtx.sessionId).toBe("orchestrator-session");
      expect(reworkMocks.injectPrompt).not.toHaveBeenCalled();
    });

    it("writer ainda vivo: a nota entra no PTY dele, sem reabrir", async () => {
      paneMocks.listPaneSnapshots.mockReturnValue([
        { paneId: "pane-writer", sessionId: "writer-session", paneNumber: 3, state: "idle" } as never,
      ]);
      await expect(ack({ note: "renomeie a flag" })).resolves.toMatchObject({
        reworkDelivered: true,
        reworkVia: "pty",
        paneId: "pane-writer",
      });
      expect(reworkMocks.injectPrompt).toHaveBeenCalledTimes(1);
      expect(reworkMocks.injectPrompt.mock.calls[0][0]).toBe("writer-session");
      expect(String(reworkMocks.injectPrompt.mock.calls[0][1])).toContain("renomeie a flag");
      expect(reworkMocks.spawn).not.toHaveBeenCalled();
    });

    it("writer encerrado sem worktree própria: não finge — reworkDelivered:false com motivo", async () => {
      paneMocks.listPaneSnapshots.mockReturnValue([
        { paneId: "pane-writer", sessionId: "writer-session", paneNumber: 3, state: "exited", executionScope: scope } as never,
      ]);
      const result = (await ack({ note: "refaça" })) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: true, verdict: "rework", reworkDelivered: false });
      expect(String(result.reworkReason)).toMatch(/writer novo/);
      expect(reworkMocks.spawn).not.toHaveBeenCalled();
      expect(reworkMocks.injectPrompt).not.toHaveBeenCalled();
    });

    it("rework sem note: o ACK vale, mas nada é entregue e o recibo diz isso", async () => {
      const result = (await ack({})) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: true, verdict: "rework", reworkDelivered: false });
      expect(String(result.reworkReason)).toMatch(/note/);
      expect(mocks.markConsumedFromPhysicalAck).toHaveBeenCalledTimes(1);
    });

    it("falha no resume não desfaz o ACK: reworkDelivered:false com o erro", async () => {
      paneMocks.listPaneSnapshots.mockReturnValue([]);
      reworkMocks.isolatedWriterPaneOfSession.mockReturnValue("pane-writer");
      reworkMocks.spawn.mockRejectedValueOnce(new Error("resume: a worktree original sumiu"));
      const result = (await ack({ note: "x" })) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: true, deliveryState: "consumed", reworkDelivered: false });
      expect(String(result.reworkReason)).toContain("worktree original sumiu");
    });
  });

  it("denies ack from a stale orchestrator token even with the right role/mission", async () => {
    mocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: "stale-session", hint: "outra sessão assumiu a missão",
    });
    const orchestrator = {
      ...context(),
      role: "orchestrator" as const,
      sessionId: "orchestrator-session-old",
      workerIncarnationId: undefined,
    };

    await expect(
      acknowledgeTool().handler(
        { handoffId: "handoff-a" },
        orchestrator,
        invocation({ toolCallId: "ack-tool-call-b", toolName: "nexus_handoff_ack" }),
      ),
    ).rejects.toThrow(/stale-session/);
    expect(mocks.markConsumedFromPhysicalAck).not.toHaveBeenCalled();
  });

  it("denies ack on split-brain instead of picking a winner", async () => {
    mocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: "split-brain", hint: "duas sessões vivas",
    });
    const orchestrator = {
      ...context(),
      role: "orchestrator" as const,
      sessionId: "orchestrator-session",
      workerIncarnationId: undefined,
    };

    await expect(
      acknowledgeTool().handler(
        { handoffId: "handoff-a" },
        orchestrator,
        invocation({ toolCallId: "ack-tool-call-c", toolName: "nexus_handoff_ack" }),
      ),
    ).rejects.toThrow(/split-brain/);
    expect(mocks.markConsumedFromPhysicalAck).not.toHaveBeenCalled();
  });

  it("delivers an unverified report without satisfying the stop gate", async () => {
    const submitted = handoff("unverified");
    mocks.submit.mockReturnValue(submitted);
    const ctx = context();

    const result = await submitTool().handler(
      {
        status: "success",
        summary: submitted.summary,
        artifacts: [{ path: "src/a.ts" }],
      },
      ctx,
      invocation(),
    );

    expect(result).toMatchObject({
      ok: true,
      evidenceTrust: "unverified",
      stopGateSatisfied: false,
    });
    expect(mocks.markHandoffSubmitted).not.toHaveBeenCalled();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledWith(submitted, scope);
    expect(mocks.orchWriteSession).not.toHaveBeenCalled();
  });

  it("reconciles a queued generic replay after a lost post-commit callback", async () => {
    const queued = handoff("unverified");
    mocks.submitWithReplay.mockReturnValue({
      handoff: queued,
      replayed: true,
    });

    const result = await submitTool().handler(
      {
        status: "success",
        summary: queued.summary,
      },
      context(),
      invocation({ toolCallId: "tool-call-retry" }),
    );

    expect(result).toMatchObject({
      ok: true,
      handoffId: queued.id,
      replayed: true,
    });
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledOnce();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledWith(queued, scope);
  });

  it.each(["submitted", "consumed"] as const)(
    "does not repeat Pet Studio side effects for a %s generic replay",
    async (deliveryState) => {
      const delivered = {
        ...handoff("unverified"),
        delivered: true,
        deliveryState,
        submittedAt: 2,
        ...(deliveryState === "consumed"
          ? { acknowledgedAt: 3, consumedAt: 4 }
          : {}),
      };
      mocks.submitWithReplay.mockReturnValue({
        handoff: delivered,
        replayed: true,
      });

      const result = await submitTool().handler(
        {
          status: "success",
          summary: delivered.summary,
        },
        context(),
        invocation({ toolCallId: `tool-call-${deliveryState}` }),
      );

      expect(result).toMatchObject({
        ok: true,
        handoffId: delivered.id,
        replayed: true,
      });
      expect(mocks.onHandoffSubmitted).not.toHaveBeenCalled();
    },
  );

  it("satisfies the stop gate only after the store validates Nexus evidence", async () => {
    const submitted = handoff("nexus-trusted");
    mocks.submit.mockReturnValue(submitted);
    const ctx = context();

    const result = await submitTool().handler(
      {
        status: "success",
        summary: submitted.summary,
        evidenceIds: ["evidence-a"],
      },
      ctx,
      invocation(),
    );

    expect(result).toMatchObject({
      evidenceTrust: "nexus-trusted",
      stopGateSatisfied: true,
    });
    expect(mocks.markHandoffSubmitted).toHaveBeenCalledWith(ctx);
  });

  it("returns the dedicated Pet Studio package validation result to the maker", async () => {
    const submitted = handoff("unverified");
    mocks.submit.mockReturnValue(submitted);
    mocks.onHandoffSubmitted.mockReturnValue({
      handled: true,
      completed: false,
      error: "inclua o caminho absoluto de pet.json",
    });

    const result = await submitTool().handler(
      { status: "success", summary: submitted.summary },
      context(),
      invocation(),
    );

    expect(result).toMatchObject({
      petStudioCompletion: {
        handled: true,
        completed: false,
        error: "inclua o caminho absoluto de pet.json",
      },
    });
  });

  it("does not mark or deliver a rejected evidence claim", async () => {
    mocks.submit.mockImplementation(() => {
      throw new Error('trusted evidence "missing" not found');
    });

    await expect(
      submitTool().handler(
        {
          status: "success",
          summary: "Worker reports that implementation is complete.",
          evidenceIds: ["missing"],
        },
        context(),
        invocation(),
      ),
    ).rejects.toThrow(/trusted evidence.*not found/i);
    expect(mocks.markHandoffSubmitted).not.toHaveBeenCalled();
    expect(mocks.onHandoffSubmitted).not.toHaveBeenCalled();
  });

  it("rejects a late handoff from a previous worker incarnation before persistence", async () => {
    const stores = mocks.getStores();
    stores.taskDispatches.list = () => [
      {
        id: "dispatch-current",
        missionId: "mission-a",
        taskId: "task-a",
        sessionId: "worker-session",
        workerIncarnationId: "worker-incarnation-current",
        state: "running",
      },
    ];

    await expect(
      submitTool().handler(
        {
          status: "success",
          summary:
            "Resultado tardio da pane física anterior não deve concluir.",
        },
        context(),
        invocation(),
      ),
    ).rejects.toThrow(/incarnation|encarnação|gera[cç][aã]o/i);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("captures the committed worker HEAD before accepting the handoff", async () => {
    const worktree = createCommittedWorktree();
    const stores = mocks.getStores();
    stores.taskDispatches.list = () => [
      {
        id: "dispatch-current",
        missionId: "mission-a",
        taskId: "task-a",
        sessionId: "worker-session",
        workerIncarnationId: "worker-incarnation-a",
        state: "running",
      },
    ];
    const submitted = {
      ...handoff("unverified"),
      workerIncarnationId: "worker-incarnation-a",
    };
    mocks.submitAndTransition.mockReturnValue({
      handoff: submitted,
      taskDispatch: { state: "handoff_ready" },
    });
    const toolInvocation = invocation();

    await submitTool().handler(
      {
        status: "success",
        summary: submitted.summary,
      },
      context(worktree.root),
      toolInvocation,
    );

    expect(mocks.submitAndTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "worker-session",
        workerIncarnationId: "worker-incarnation-a",
      }),
      toolInvocation.agentTransportPhysicalReceipt,
      expect.objectContaining({
        worktreeHeadSha: worktree.head,
      }),
      {
        sessionId: "worker-session",
        workerIncarnationId: "worker-incarnation-a",
        detail: `success: ${submitted.summary}`,
      },
      undefined,
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.acceptHandoff).not.toHaveBeenCalled();
  });

  it("returns an exact committed replay and reconciles its durable delivery", async () => {
    const worktree = createCommittedWorktree();
    const stores = mocks.getStores();
    stores.taskDispatches.list = () => [
      {
        id: "dispatch-current",
        missionId: "mission-a",
        taskId: "task-a",
        sessionId: "worker-session",
        workerIncarnationId: "worker-incarnation-a",
        handoffId: "handoff-a",
        state: "handoff_ready",
      },
    ];
    const submitted = {
      ...handoff("unverified"),
      workerIncarnationId: "worker-incarnation-a",
    };
    // F-239: dispatch fora de "running" já tem handoff — replay/follow-up vai
    // pelo caminho sem transição.
    mocks.submitWithReplay.mockReturnValue({
      handoff: submitted,
      replayed: true,
    });

    const result = await submitTool().handler(
      {
        status: "success",
        summary: submitted.summary,
      },
      context(worktree.root),
      invocation(),
    );

    expect(result).toMatchObject({
      ok: true,
      handoffId: submitted.id,
      replayed: true,
    });
    expect(result).not.toHaveProperty("taskDispatchState");
    expect(mocks.submitWithReplay).toHaveBeenCalledOnce();
    expect(mocks.submitAndTransition).not.toHaveBeenCalled();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledOnce();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledWith(submitted, scope);
  });

  it("recovers an exact replay immediately after the post-commit callback throws", async () => {
    const worktree = createCommittedWorktree();
    const stores = mocks.getStores();
    stores.taskDispatches.list = () => [
      {
        id: "dispatch-current",
        missionId: "mission-a",
        taskId: "task-a",
        sessionId: "worker-session",
        workerIncarnationId: "worker-incarnation-a",
        handoffId: "handoff-a",
        state: "handoff_ready",
      },
    ];
    const submitted = {
      ...handoff("unverified"),
      workerIncarnationId: "worker-incarnation-a",
    };
    // F-239: dispatch handoff_ready → caminho de replay puro nas duas chamadas.
    mocks.submitWithReplay
      .mockReturnValueOnce({
        handoff: submitted,
        replayed: false,
      })
      .mockReturnValueOnce({
        handoff: submitted,
        replayed: true,
      });
    mocks.onHandoffSubmitted.mockImplementationOnce(() => {
      throw new Error("synthetic post-commit delivery crash");
    });
    const args = {
      status: "success",
      summary: submitted.summary,
    } as const;

    await expect(
      submitTool().handler(
        args,
        context(worktree.root),
        invocation({ toolCallId: "tool-call-first" }),
      ),
    ).rejects.toThrow(/post-commit delivery crash/i);
    await expect(
      submitTool().handler(
        args,
        context(worktree.root),
        invocation({ toolCallId: "tool-call-retry" }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      handoffId: submitted.id,
      replayed: true,
    });
    expect(mocks.submitWithReplay).toHaveBeenCalledTimes(2);
    expect(mocks.submitAndTransition).not.toHaveBeenCalled();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledTimes(2);
    expect(mocks.onHandoffSubmitted).toHaveBeenLastCalledWith(
      submitted,
      scope,
    );
  });

  it("reconciles delivery after an exact committed blocker replay", async () => {
    const worktree = createCommittedWorktree();
    const stores = mocks.getStores();
    const runningMission = stores.missions.get();
    stores.missions.get = () => ({
      ...runningMission,
      status: "blocked",
    });
    stores.taskDispatches.list = () => [
      {
        id: "dispatch-current",
        missionId: "mission-a",
        taskId: "task-a",
        sessionId: "worker-session",
        workerIncarnationId: "worker-incarnation-a",
        handoffId: "handoff-a",
        state: "blocked",
      },
    ];
    const submitted = {
      ...handoff("unverified"),
      status: "blocked" as const,
      workerIncarnationId: "worker-incarnation-a",
    };
    // F-239: dispatch "blocked" já carrega handoff — a reconciliação do replay
    // vai pelo caminho sem transição.
    mocks.submitWithReplay.mockReturnValue({
      handoff: submitted,
      replayed: true,
    });

    const result = await submitTool().handler(
      {
        status: "blocked",
        summary: submitted.summary,
      },
      context(worktree.root),
      invocation(),
    );

    expect(result).toMatchObject({
      ok: true,
      handoffId: submitted.id,
      replayed: true,
    });
    expect(result).not.toHaveProperty("taskDispatchState");
    expect(mocks.submitWithReplay).toHaveBeenCalledOnce();
    expect(mocks.submitAndTransition).not.toHaveBeenCalled();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledOnce();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledWith(submitted, scope);
  });

  it("F-239: worker com dispatch handoff_ready submete follow-up pelo caminho sem transição", async () => {
    const worktree = createCommittedWorktree();
    const stores = mocks.getStores();
    const dispatch = {
      id: "dispatch-current",
      missionId: "mission-a",
      taskId: "task-a",
      sessionId: "worker-session",
      workerIncarnationId: "worker-incarnation-a",
      handoffId: "handoff-round-1",
      state: "handoff_ready",
    };
    stores.taskDispatches.list = () => [dispatch];
    const followUp = {
      ...handoff("unverified"),
      id: "handoff-round-2",
      summary: "Segunda rodada: correções dos achados da revisão.",
      workerIncarnationId: "worker-incarnation-a",
    };
    mocks.submitWithReplay.mockReturnValue({
      handoff: followUp,
      replayed: false,
    });

    const result = await submitTool().handler(
      {
        status: "success",
        summary: followUp.summary,
      },
      context(worktree.root),
      invocation(),
    );

    expect(result).toMatchObject({ ok: true, handoffId: "handoff-round-2" });
    expect(result).not.toHaveProperty("taskDispatchState");
    expect(mocks.submitWithReplay).toHaveBeenCalledOnce();
    expect(mocks.submitAndTransition).not.toHaveBeenCalled();
    // O dispatch NÃO transita: segue handoff_ready apontando para a rodada 1.
    expect(dispatch.state).toBe("handoff_ready");
    expect(dispatch.handoffId).toBe("handoff-round-1");
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledWith(followUp, scope);
  });

  it("refuses direct/internal handler calls without the central HTTP MCP receipt", async () => {
    await expect(
      submitTool().handler(
        {
          status: "success",
          summary: "A direct main call cannot mint physical MCP provenance.",
        },
        context(),
      ),
    ).rejects.toThrow(/exact physical agent tool-call receipt/i);
    await expect(
      submitTool().handler(
        {
          status: "success",
          summary: "An IPC dispatch cannot mint physical MCP provenance.",
        },
        context(),
        invocation({ source: "ipc-renderer" }),
      ),
    ).rejects.toThrow(/exact physical agent tool-call receipt/i);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("renews lifecycle authority only for the worker exact session", async () => {
    mocks.heartbeat.mockReturnValue({
      id: "dispatch-a",
      taskId: "task-a",
      missionId: "mission-a",
      state: "running",
      sessionId: "worker-session",
      leaseExpiresAt: 601_000,
    });

    await expect(heartbeatTool().handler({}, context())).resolves.toMatchObject(
      {
        ok: true,
        dispatchId: "dispatch-a",
        taskId: "task-a",
        leaseExpiresAt: 601_000,
      },
    );
    expect(mocks.heartbeat).toHaveBeenCalledWith({
      sessionId: "worker-session",
      missionId: "mission-a",
      workerIncarnationId: "worker-incarnation-a",
      leaseMs: 10 * 60_000,
    });

    await expect(
      heartbeatTool().handler(
        {},
        {
          ...context(),
          sessionId: undefined,
        },
      ),
    ).rejects.toThrow(/sess[aã]o/i);
  });

  it("F-1166: handoff de sucesso agenda a cobertura do objetivo com os handoffs da própria missão", async () => {
    advisor.scheduleCompletionCheck.mockClear();
    mocks.submit.mockImplementationOnce(() => handoff("unverified")).mockImplementationOnce(() => ({ ...handoff("unverified"), status: "blocked" }));
    await submitTool().handler({ status: "success", summary: "Implementei o formulário de login com testes." }, context(), invocation());
    expect(advisor.scheduleCompletionCheck).toHaveBeenCalledTimes(1);
    const [missionId, collect] = advisor.scheduleCompletionCheck.mock.calls[0]!;
    expect(missionId).toBe("mission-a");
    mocks.listHandoffs.mockReturnValueOnce([{ id: "h-1", status: "success", summary: "feito" }]);
    expect(collect()).toMatchObject({ missionId: "mission-a", handoffs: [{ id: "h-1", status: "success", summary: "feito" }] });
    advisor.scheduleCompletionCheck.mockClear();
    await submitTool().handler({ status: "blocked", summary: "Não consegui: falta a credencial do banco de dados." }, context(), invocation());
    expect(advisor.scheduleCompletionCheck).not.toHaveBeenCalled();
  });

  it("P3 F-1166: worker atrasado não consulta a cobertura de missão já concluída", async () => {
    advisor.scheduleCompletionCheck.mockClear();
    const stores = mocks.getStores();
    const live = { ...stores.missions.get("mission-a") };
    mocks.getStores.mockReturnValue({ ...stores, missions: { ...stores.missions, get: () => live } });
    mocks.submit.mockImplementationOnce(() => handoff("unverified"));
    await submitTool().handler({ status: "success", summary: "Implementei o formulário de login com testes." }, context(), invocation());
    const [, collect] = advisor.scheduleCompletionCheck.mock.calls[0]!;
    mocks.listHandoffs.mockReturnValue([{ id: "h-1", status: "success", summary: "feito" }]);
    expect(collect()).toMatchObject({ missionId: "mission-a" });
    live.status = "done";
    expect(collect()).toBeNull();
  });

  it("P3 F-1166: o detectLimit real não casa na saída serializada do nexus_handoff_list com missionDecisionHint", async () => {
    const { detectLimit } = await import("./limit-detector");
    const advisorReal = await import("./jev-mission-advisor");
    const hints = await import("./mission-decision-hints");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "list-limit-"));
    hints.configureMissionDecisionHints(dir);
    const LIMIT_TEXT = "Error: 429 Too Many Requests";
    expect(detectLimit(LIMIT_TEXT)).not.toBeNull();
    const deps = { enabled: () => true, hasKey: () => true };
    const answer = (answers: Record<string, unknown>) => async () => ({ model: "jev-1", answers, usage: { input_tokens: 10, output_tokens: 0 } }) as never;
    try {
      await advisorReal.adviseCompletionCheck({ missionId: "mission-a", goal: LIMIT_TEXT, acceptanceCriteria: [LIMIT_TEXT], handoffs: [] },
        { ...deps, judge: answer({ covers_goal: { type: "noul", noul: 0.2 }, missing: { type: "choice", choice: "c1", probabilities: {}, confidence: 0.9 } }) });
      await advisorReal.adviseReviewTriage({ missionId: "mission-a", handoffId: "h-2", summary: LIMIT_TEXT, declaredFiles: ["src/a.ts"] },
        { ...deps, judge: answer({ regression_risk: { type: "noul", noul: 0.9 } }) });
      expect(hints.getMissionDecisionHints("mission-a")?.completion?.missing).toBeDefined();
      mocks.listHandoffs.mockReturnValue([{ id: "h-1", delivered: true }, { id: "h-2", delivered: true }]);
      const rows = (await listTool().handler({}, orchestratorContext())) as Array<Record<string, unknown>>;
      expect(rows.at(-1)!.missionDecisionHint).toContain("parece faltar");
      const page = (await listTool().handler({ limit: 10 }, orchestratorContext())) as Record<string, unknown>;
      expect(page.missionDecisionHint).toContain("parece faltar");
      for (const serialized of [JSON.stringify(rows), JSON.stringify(page), JSON.stringify(rows, null, 2), JSON.stringify(page, null, 2)]) {
        expect(detectLimit(serialized)).toBeNull();
        for (const line of serialized.split("\n")) expect(detectLimit(line)).toBeNull();
      }
      await hints.flushMissionDecisionHints();
    } finally {
      hints.configureMissionDecisionHints(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F-1166: o Maestro listando a própria missão vê a linha de cobertura; worker e outra missão não", async () => {
    const hints = await import("./mission-decision-hints");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "list-coverage-"));
    hints.configureMissionDecisionHints(dir);
    try {
      hints.recordCompletionHint("mission-a", { at: 1, model: "jev", usd: null, probabilities: {}, coverage: 0.35, warning: true,
        handoffCount: 2, signature: "s", consultations: 1, missing: "testes passam" });
      mocks.listHandoffs.mockReturnValue([{ id: "h-1", delivered: true }, { id: "h-2", delivered: true }]);
      const rows = (await listTool().handler({}, orchestratorContext())) as Array<Record<string, unknown>>;
      expect(rows[1]!.missionDecisionHint).toBe("[motor de decisão] cobertura do objetivo 35%: parece faltar: testes passam");
      expect(rows[0]!.missionDecisionHint).toBeUndefined();
      const page = (await listTool().handler({ limit: 10 }, orchestratorContext())) as Record<string, unknown>;
      expect(page.missionDecisionHint).toContain("cobertura do objetivo 35%");
      const asWorker = (await listTool().handler({}, context())) as Array<Record<string, unknown>>;
      expect(asWorker.some((row) => "missionDecisionHint" in row)).toBe(false);
      const otherMission = (await listTool().handler({ missionId: "mission-b" }, orchestratorContext())) as Array<Record<string, unknown>>;
      expect(otherMission.some((row) => "missionDecisionHint" in row)).toBe(false);
      await hints.flushMissionDecisionHints();
    } finally {
      hints.configureMissionDecisionHints(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists the Maestro audit trail by default, including delivered rows", async () => {
    const rows = [{ id: "handoff-consumed", delivered: true }];
    mocks.listHandoffs.mockReturnValue(rows);

    await expect(
      listTool().handler({}, orchestratorContext()),
    ).resolves.toEqual(rows);
    expect(mocks.listHandoffs).toHaveBeenCalledWith({
      missionId: "mission-a",
      includeDelivered: true,
    });
  });

  it("honors full:true as the complete trail advertised to the Maestro", async () => {
    mocks.listHandoffs.mockReturnValue([{ id: "handoff-a" }]);

    await listTool().handler({ full: true }, orchestratorContext());
    expect(mocks.listHandoffs).toHaveBeenCalledWith({
      missionId: "mission-a",
      includeDelivered: true,
    });
  });

  it("keeps includeDelivered:false as the pending-only inbox", async () => {
    mocks.listHandoffs.mockReturnValue([]);

    await listTool().handler(
      { includeDelivered: false },
      orchestratorContext(),
    );
    expect(mocks.listHandoffs).toHaveBeenCalledWith({
      missionId: "mission-a",
      includeDelivered: false,
    });
  });

  it("compacts old delivered rows; the 5 most recent and undelivered stay whole", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `h-${i + 1}`,
      delivered: true,
      artifacts: [{ file: `f${i + 1}` }],
    }));
    rows[1]!.delivered = false;
    mocks.listHandoffs.mockReturnValue(rows);

    const result = (await listTool().handler(
      {},
      orchestratorContext(),
    )) as Array<Record<string, unknown>>;

    expect(result[0]).toMatchObject({
      artifacts: [],
      artifactsOmitted: 1,
      detailHint: 'passe ids:["h-1"] para o conteúdo completo',
    });
    expect(result[1]!.artifacts).toEqual([{ file: "f2" }]);
    expect(result[1]!.artifactsOmitted).toBeUndefined();
    expect(result[2]).toMatchObject({ artifacts: [], artifactsOmitted: 1 });
    // As 5 mais recentes (índices 3..7) ficam inteiras.
    expect(result[3]!.artifacts).toEqual([{ file: "f4" }]);
    expect(result[7]!.artifacts).toEqual([{ file: "f8" }]);
  });

  it("rows pedidas por ids ficam completas mesmo antigas e entregues", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `h-${i + 1}`,
      delivered: true,
      artifacts: [{ file: `f${i + 1}` }],
    }));
    mocks.listHandoffs.mockReturnValue(rows);

    const result = (await listTool().handler(
      { ids: ["h-1"] },
      orchestratorContext(),
    )) as Array<Record<string, unknown>>;

    expect(result[0]!.artifacts).toEqual([{ file: "f1" }]);
    expect(result[0]!.artifactsOmitted).toBeUndefined();
    expect(result[2]!.artifactsOmitted).toBe(1);
  });

  it("detail:'full' devolve a trilha byte-identical, sem compactação", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `h-${i + 1}`,
      delivered: true,
      artifacts: [{ file: `f${i + 1}` }],
    }));
    mocks.listHandoffs.mockReturnValue(rows);

    await expect(
      listTool().handler({ detail: "full" }, orchestratorContext()),
    ).resolves.toEqual(rows);
  });

  it("confines a worker to its own mission even when another id is guessed", async () => {
    mocks.listHandoffs.mockReturnValue([]);

    await listTool().handler(
      { missionId: "mission-other", full: true },
      context(),
    );
    expect(mocks.listHandoffs).toHaveBeenCalledWith({
      missionId: "mission-a",
      includeDelivered: true,
    });
  });

  it("lets the proven current orchestrator enumerate another mission's handoffs", async () => {
    mocks.listHandoffs.mockReturnValue([]);

    await listTool().handler(
      { missionId: "mission-other", full: true },
      orchestratorContext(),
    );
    expect(mocks.listHandoffs).toHaveBeenCalledWith({
      missionId: "mission-other",
      includeDelivered: true,
    });
  });

  it("confines a stale orchestrator token to its own mission — role bit alone is not enough", async () => {
    mocks.listHandoffs.mockReturnValue([]);
    mocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: "stale-session", hint: "outra sessão assumiu a missão",
    });

    await listTool().handler(
      { missionId: "mission-other", full: true },
      orchestratorContext(),
    );
    expect(mocks.listHandoffs).toHaveBeenCalledWith({
      missionId: "mission-a",
      includeDelivered: true,
    });
  });

  it("does not credit list-ack to a split-brain orchestrator", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn();
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: { ...stores.handoffs, acknowledgeSeenByOrchestratorList: ackSpy },
    });
    mocks.listHandoffs.mockReturnValue([{ id: "handoff-a" }]);
    mocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: "split-brain", hint: "duas sessões vivas",
    });

    await listTool().handler({}, orchestratorContext());
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it.each(["invalid-json", ""])("F-1049: invalid cursor %j must not acknowledge any handoff", async (cursor) => {
    const stores = mocks.getStores();
    const ack = vi.fn(() => 2);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: { ...stores.handoffs, acknowledgeSeenByOrchestratorList: ack },
    });
    mocks.listHandoffs.mockReturnValue([
      { id: "h-a", createdAt: 1, deliveryState: "submitted", delivered: true },
      { id: "h-b", createdAt: 2, deliveryState: "submitted", delivered: true },
    ]);
    await expect(
      listTool().handler({ limit: 1, cursor }, orchestratorContext()),
    ).rejects.toThrow(/cursor inválido/);
    expect(ack).not.toHaveBeenCalled();
  });

  it("F-1049: first and subsequent pages acknowledge only their returned ids", async () => {
    const stores = mocks.getStores();
    const ack = vi.fn(() => 1);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: { ...stores.handoffs, acknowledgeSeenByOrchestratorList: ack },
    });
    mocks.listHandoffs.mockReturnValue([
      { id: "h-a", createdAt: 1, deliveryState: "submitted", delivered: true },
      { id: "h-b", createdAt: 2, deliveryState: "submitted", delivered: true },
    ]);
    const first = await listTool().handler({ limit: 1 }, orchestratorContext()) as {
      items: Array<{ id: string }>; nextCursor: string; hasMoreHistory: boolean;
    };
    expect(first.items.map((row) => row.id)).toEqual(["h-a"]);
    expect(first.hasMoreHistory).toBe(true);
    expect(ack).toHaveBeenNthCalledWith(1, "mission-a", ["h-a"]);
    const second = await listTool().handler(
      { limit: 1, cursor: first.nextCursor }, orchestratorContext(),
    ) as typeof first;
    expect(second.items.map((row) => row.id)).toEqual(["h-b"]);
    expect(second).toMatchObject({ nextCursor: null, hasMoreHistory: false });
    expect(ack).toHaveBeenNthCalledWith(2, "mission-a", ["h-b"]);
  });

  it("F-1049: filtered legacy lists still return arrays and acknowledge only returned ids", async () => {
    const stores = mocks.getStores();
    const ack = vi.fn(() => 1);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: { ...stores.handoffs, acknowledgeSeenByOrchestratorList: ack },
    });
    mocks.listHandoffs.mockReturnValue([{ id: "h-b", delivered: true, deliveryState: "submitted" }]);
    const result = await listTool().handler({ ids: ["h-b"] }, orchestratorContext());
    expect(Array.isArray(result)).toBe(true);
    expect(ack).toHaveBeenCalledWith("mission-a", ["h-b"]);
  });

  it("F-1049: a paged cross-mission read never acknowledges rows", async () => {
    const stores = mocks.getStores();
    const ack = vi.fn();
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: { ...stores.handoffs, acknowledgeSeenByOrchestratorList: ack },
    });
    mocks.listHandoffs.mockReturnValue([{ id: "h-other", createdAt: 1 }]);
    const result = await listTool().handler(
      { missionId: "mission-other", limit: 1 }, orchestratorContext(),
    );
    expect(result).toMatchObject({ items: [{ id: "h-other" }], nextCursor: null });
    expect(ack).not.toHaveBeenCalled();
  });

  it("acknowledges only the submitted rows on the returned cursor page", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn(() => 1);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: ackSpy,
        listDeliveryAttempts: () => [],
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-page",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 1,
        missionId: "mission-a",
      },
      {
        id: "h-next",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 2,
        missionId: "mission-a",
      },
      {
        id: "h-queued",
        delivered: false,
        deliveryState: "queued",
        createdAt: 3,
        missionId: "mission-a",
      },
    ]);

    const page = (await listTool().handler(
      { limit: 1 },
      orchestratorContext(),
    )) as { items: Array<{ id: string }> };
    expect(page.items.map((row) => row.id)).toEqual(["h-page"]);
    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(ackSpy).toHaveBeenCalledWith("mission-a", ["h-page"]);
  });

  it("does not acknowledge anything when the cursor cannot be decoded", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn(() => 1);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: ackSpy,
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-page",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 1,
        missionId: "mission-a",
      },
    ]);

    await expect(
      listTool().handler(
        { limit: 1, cursor: "!!!not-a-cursor!!!" },
        orchestratorContext(),
      ),
    ).rejects.toThrow(/cursor inválido/);
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("resumes after a cursor whose row is gone and acknowledges only that page", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn((_mission: string, ids: readonly string[]) => ids.length);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: ackSpy,
        listDeliveryAttempts: () => [],
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-next",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 2,
        missionId: "mission-a",
        artifacts: [{ file: "kept-off-page" }],
      },
      {
        id: "h-later",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 3,
        missionId: "mission-a",
      },
    ]);

    const page = (await listTool().handler(
      {
        limit: 1,
        cursor: encodeCursor({
          key: 1,
          id: "h-gone",
          slice: handoffListCursorSlice({
            missionId: "mission-a",
            includeDelivered: true,
            ids: [],
            panes: [],
          }),
        }),
      },
      orchestratorContext(),
    )) as { items: Array<{ id: string; stuckDiagnosis?: { reason: string } }> };
    expect(page.items.map((row) => row.id)).toEqual(["h-next"]);
    expect(page.items[0]?.stuckDiagnosis?.reason).not.toBe("accepted-not-consumed");
    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(ackSpy).toHaveBeenCalledWith("mission-a", ["h-next"]);
  });

  it("refuses a cursor from another list slice and acknowledges nothing", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn((_mission: string, ids: readonly string[]) => ids.length);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: ackSpy,
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-page",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 1,
        missionId: "mission-a",
      },
      {
        id: "h-next",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 2,
        missionId: "mission-a",
      },
    ]);

    await expect(
      listTool().handler(
        {
          limit: 1,
          cursor: encodeCursor({
            key: 1,
            id: "h-page",
            slice: handoffListCursorSlice({
              missionId: "mission-b",
              includeDelivered: true,
              ids: [],
              panes: [],
            }),
          }),
        },
        orchestratorContext(),
      ),
    ).rejects.toThrow(/cursor inválido/);
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it.each(['respawn','closed'] as const)("F-1089: old pane session cursor rejects %s before list or ACK", async (change) => {
    const stores=mocks.getStores();
    const ack=vi.fn((_mission:string,ids:readonly string[])=>ids.length);
    const query=vi.fn(stores.handoffs.listCursorPage);
    mocks.getStores.mockReturnValue({...stores,handoffs:{...stores.handoffs,listCursorPage:query,acknowledgeSeenByOrchestratorList:ack}});
    mocks.listHandoffs.mockReturnValue([
      {id:'h-page',delivered:true,deliveryState:'submitted',createdAt:1,missionId:'mission-a'},
      {id:'h-next',delivered:true,deliveryState:'submitted',createdAt:2,missionId:'mission-a'},
    ]);
    paneMocks.listPaneSnapshots.mockReturnValue([{paneId:'pane-live',sessionId:'session-a',paneNumber:1}]);
    try {
      const first=await listTool().handler({panes:['pane-live'],limit:1},orchestratorContext()) as {items:Array<{id:string}>;nextCursor:string};
      expect(first.items.map(row=>row.id)).toEqual(['h-page']);expect(first.nextCursor).toEqual(expect.any(String));
      const continued=await listTool().handler({panes:['pane-live'],limit:1,cursor:first.nextCursor},orchestratorContext()) as typeof first;
      expect(continued.items.map(row=>row.id)).toEqual(['h-next']);
      expect(query).toHaveBeenLastCalledWith(expect.objectContaining({sessionIds:['session-a']}));
      paneMocks.listPaneSnapshots.mockReturnValue(change==='closed'?[]:[{paneId:'pane-live',sessionId:'session-b',paneNumber:1}]);
      query.mockClear();ack.mockClear();mocks.listHandoffs.mockClear();
      await expect(listTool().handler({panes:['pane-live'],limit:1,cursor:first.nextCursor},orchestratorContext())).rejects.toThrow(/cursor inválido/);
      expect(query).not.toHaveBeenCalled();expect(mocks.listHandoffs).not.toHaveBeenCalled();expect(ack).not.toHaveBeenCalled();
    } finally {
      paneMocks.listPaneSnapshots.mockImplementation(()=>[{paneId:'pane-live',sessionId:'session-live',paneNumber:1}]);
    }
  });

  it('F-1089: cursor session identity is sorted and preserves the unfiltered optional shape',()=>{
    const base={missionId:'mission-a',includeDelivered:true,ids:[],panes:['pane-live']};
    expect(handoffListCursorSlice({...base,paneSessionIds:['session-a']})).not.toBe(handoffListCursorSlice({...base,paneSessionIds:['session-b']}));
    expect(handoffListCursorSlice({...base,paneSessionIds:['a','b']})).toBe(handoffListCursorSlice({...base,paneSessionIds:['b','a']}));
    expect(handoffListCursorSlice({...base,panes:[]})).toBe(handoffListCursorSlice({...base,panes:[],paneSessionIds:[]}));
  });

  it("returns a cursor envelope when the pane filter matches nothing", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn(() => 1);
    const listCursorPage = vi.fn(() => []);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        listCursorPage,
        acknowledgeSeenByOrchestratorList: ackSpy,
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-hidden",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 1,
        missionId: "mission-a",
      },
    ]);

    const page = await listTool().handler(
      { panes: ["missing-pane"], limit: 10 },
      orchestratorContext(),
    );
    expect(page).toEqual({
      items: [],
      nextCursor: null,
      hasMoreHistory: false,
    });
    expect(listCursorPage).not.toHaveBeenCalled();
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("rejects a bad cursor when the pane filter matches nothing and acks nothing", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn(() => 1);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: ackSpy,
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-hidden",
        delivered: true,
        deliveryState: "submitted",
        createdAt: 1,
        missionId: "mission-a",
      },
    ]);

    await expect(
      listTool().handler(
        { panes: ["missing-pane"], limit: 10, cursor: "!!!not-a-cursor!!!" },
        orchestratorContext(),
      ),
    ).rejects.toThrow(/cursor inválido/);
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("counts delivery attempts for the mission's current Maestro after a rebind", async () => {
    const stores = mocks.getStores();
    const oldOnly = Array.from({ length: 9 }, (_, index) => ({
      orchestratorSessionId: "old-maestro",
      startedAt: index + 1,
      attemptNo: index + 1,
    }));
    mocks.getSessionState.mockImplementation((id?: string) =>
      id === "orchestrator-session" ? "idle" : "exited",
    );
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        listDeliveryAttempts: () => oldOnly,
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-rebound",
        delivered: false,
        deliveryState: "queued",
        createdAt: Date.now(),
        missionId: "mission-a",
      },
    ]);

    const rebound = (await listTool().handler(
      { detail: "full" },
      orchestratorContext(),
    )) as Array<{ stuckDiagnosis?: { reason: string } }>;
    expect(rebound[0]?.stuckDiagnosis?.reason).not.toBe("session-dead");
    expect(rebound[0]?.stuckDiagnosis?.reason).not.toBe("parked-needs-operator");
    expect(rebound[0]?.stuckDiagnosis?.reason).not.toBe("retry-backoff");

    const mixed = [
      ...Array.from({ length: 2 }, (_, index) => ({
        orchestratorSessionId: "orchestrator-session",
        startedAt: 100 + index,
        attemptNo: index + 1,
        state: "failed" as const,
        failureCode: "accept_timeout",
      })),
      ...oldOnly,
    ];
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        listDeliveryAttempts: () => mixed,
      },
    });
    const currentRound = (await listTool().handler(
      { detail: "full" },
      orchestratorContext(),
    )) as Array<{ stuckDiagnosis?: { reason: string; summary: string } }>;
    expect(currentRound[0]?.stuckDiagnosis?.reason).toBe("retry-backoff");
    expect(currentRound[0]?.stuckDiagnosis?.summary).toContain("rodada 1");
  });

  it("keeps an in-flight delivery inside the acceptance window", async () => {
    const stores = mocks.getStores();
    const now = Date.now();
    mocks.getSessionState.mockReturnValue("idle");
    for (const state of ["reserved", "pasted"] as const) {
      mocks.getStores.mockReturnValue({
        ...stores,
        handoffs: {
          ...stores.handoffs,
          list: mocks.listHandoffs,
          listDeliveryAttempts: () => [
            {
              orchestratorSessionId: "orchestrator-session",
              startedAt: now,
              attemptNo: 1,
              state,
            },
          ],
        },
      });
      mocks.listHandoffs.mockReturnValue([
        {
          id: "h-inflight",
          delivered: false,
          deliveryState: "queued",
          createdAt: now - 30_000,
          missionId: "mission-a",
        },
      ]);
      const rows = (await listTool().handler(
        { detail: "full" },
        orchestratorContext(),
      )) as Array<{ stuckDiagnosis?: { reason: string } }>;
      expect(rows[0]?.stuckDiagnosis?.reason).not.toBe("retry-backoff");
      expect(rows[0]?.stuckDiagnosis).toBeUndefined();
    }
  });

  it.each(["reserved", "pasted"] as const)(
    "F-1064: current %s attempt does not expire by reservation age", async (state) => {
      const stores = mocks.getStores();
      const now = Date.now();
      mocks.getSessionState.mockReturnValue("idle");
      mocks.getStores.mockReturnValue({ ...stores, handoffs: { ...stores.handoffs,
        listDeliveryAttempts: () => [{ orchestratorSessionId: "orchestrator-session",
          startedAt: now - 13_000, state, attemptNo: 1,
          ...(state === "pasted" ? { acceptDeadlineAt: now + 20_000 } : {}),
        }],
      } });
      mocks.listHandoffs.mockReturnValue([{ id: "h-still-ingesting", delivered: false,
        deliveryState: "queued", createdAt: now - 60_000, missionId: "mission-a" }]);
      const rows = await listTool().handler({ detail: "full" }, orchestratorContext()) as
        Array<{ stuckDiagnosis?: unknown }>;
      expect(rows[0]?.stuckDiagnosis).toBeUndefined();
    },
  );

  it("passes real delivery attempts and proven Maestro liveness into stuck diagnosis", async () => {
    const stores = mocks.getStores();
    const attempts = [
      {
        orchestratorSessionId: "orchestrator-session",
        startedAt: 1,
        attemptNo: 1,
        state: "failed" as const,
        failureCode: "accept_timeout",
      },
      {
        orchestratorSessionId: "orchestrator-session",
        startedAt: 2,
        attemptNo: 2,
        state: "failed" as const,
        failureCode: "accept_timeout",
      },
    ];
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        listDeliveryAttempts: () => attempts,
      },
    });
    mocks.getSessionState.mockReturnValue("idle");
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-retry",
        delivered: false,
        deliveryState: "queued",
        createdAt: 1,
        missionId: "mission-a",
      },
    ]);

    const retry = (await listTool().handler(
      { detail: "full" },
      orchestratorContext(),
    )) as Array<{ stuckDiagnosis?: { reason: string; summary: string } }>;
    expect(retry[0]?.stuckDiagnosis?.reason).toBe("retry-backoff");
    expect(retry[0]?.stuckDiagnosis?.summary).toContain("rodada 1");

    const sixRounds = Array.from({ length: 6 }, (_, index) => ({
      orchestratorSessionId: "orchestrator-session",
      startedAt: index + 1,
      attemptNo: index + 1,
      failureCode: index < 3 ? "released:accept_timeout" : "accept_timeout",
    }));
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        listDeliveryAttempts: () => sixRounds,
      },
    });
    const stillRetrying = (await listTool().handler(
      { detail: "full" },
      orchestratorContext(),
    )) as Array<{ stuckDiagnosis?: { reason: string; summary: string } }>;
    expect(stillRetrying[0]?.stuckDiagnosis?.reason).toBe("retry-backoff");
    expect(stillRetrying[0]?.stuckDiagnosis?.summary).toContain("rodada 2");

    const parked = Array.from({ length: 9 }, (_, index) => ({
      orchestratorSessionId: "orchestrator-session",
      startedAt: index + 1,
      attemptNo: index + 1,
      state: "failed" as const,
      failureCode: "accept_timeout",
    }));
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        listDeliveryAttempts: () => parked,
      },
    });
    const parkedRows = (await listTool().handler(
      { detail: "full" },
      orchestratorContext(),
    )) as Array<{ stuckDiagnosis?: { reason: string } }>;
    expect(parkedRows[0]?.stuckDiagnosis?.reason).toBe("parked-needs-operator");

    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        listDeliveryAttempts: () => [],
      },
    });
    mocks.getSessionState.mockReturnValue("exited");
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-dead",
        delivered: false,
        deliveryState: "queued",
        createdAt: 1,
        missionId: "mission-a",
      },
    ]);
    const dead = (await listTool().handler(
      { detail: "full" },
      orchestratorContext(),
    )) as Array<{ stuckDiagnosis?: { reason: string } }>;
    expect(dead[0]?.stuckDiagnosis?.reason).toBe("session-dead");
  });

  it("reports accepted-not-consumed for an old submitted row without detail:full", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: `h-${index + 1}`,
      delivered: true,
      deliveryState: index === 0 ? "submitted" : "consumed",
      artifacts: [{ file: `f${index + 1}` }],
      createdAt: index + 1,
      missionId: "mission-a",
    }));
    mocks.listHandoffs.mockReturnValue(rows);

    const result = (await listTool().handler(
      {},
      context(),
    )) as Array<{
      stuckDiagnosis?: { reason: string };
      artifacts: unknown[];
      artifactsOmitted?: number;
    }>;
    expect(result[0]?.stuckDiagnosis?.reason).toBe("accepted-not-consumed");
    expect(result[0]?.artifacts).toEqual([]);
    expect(result[0]?.artifactsOmitted).toBe(1);
    expect(result[7]?.stuckDiagnosis).toBeUndefined();
    expect(result[7]?.artifacts).toEqual([{ file: "f8" }]);
  });

  it("does not call an acked submitted row accepted-not-consumed", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn((_mission: string, ids: readonly string[]) => ids.length);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: ackSpy,
        listDeliveryAttempts: () => [],
      },
    });
    mocks.listHandoffs.mockReturnValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `h-${index + 1}`,
        delivered: true,
        deliveryState: "submitted",
        artifacts: [{ file: `f${index + 1}` }],
        createdAt: index + 1,
        missionId: "mission-a",
      })),
    );

    const result = (await listTool().handler(
      {},
      orchestratorContext(),
    )) as Array<{
      id: string;
      deliveryState?: string;
      stuckDiagnosis?: { reason: string };
      artifactsOmitted?: number;
    }>;
    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(result[0]?.deliveryState).toBe("acknowledged");
    expect(result[0]?.stuckDiagnosis?.reason).not.toBe("accepted-not-consumed");
    expect(result[0]?.artifactsOmitted).toBe(1);
    expect(result.every((row) => row.stuckDiagnosis?.reason !== "accepted-not-consumed")).toBe(true);
  });

  it("compacts an acknowledged row that was stored with delivered false", async () => {
    const stores = mocks.getStores();
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: (_mission: string, ids: readonly string[]) =>
          ids.length,
        listDeliveryAttempts: () => [],
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-old",
        delivered: false,
        deliveryState: "submitted",
        artifacts: [{ file: "old" }],
        createdAt: 1,
        missionId: "mission-a",
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `h-new-${index}`,
        delivered: true,
        deliveryState: "consumed",
        artifacts: [{ file: `n${index}` }],
        createdAt: index + 2,
        missionId: "mission-a",
      })),
    ]);

    const result = (await listTool().handler(
      {},
      orchestratorContext(),
    )) as Array<{
      id: string;
      deliveryState?: string;
      delivered?: boolean;
      artifacts: unknown[];
      artifactsOmitted?: number;
    }>;
    expect(result[0]?.id).toBe("h-old");
    expect(result[0]?.deliveryState).toBe("acknowledged");
    expect(result[0]?.artifacts).toEqual([]);
    expect(result[0]?.artifactsOmitted).toBe(1);
  });

  it("keeps accepted-not-consumed when list-ack fails", async () => {
    const stores = mocks.getStores();
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: () => {
          throw new Error("sqlite busy");
        },
        listDeliveryAttempts: () => [],
      },
    });
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-old",
        delivered: true,
        deliveryState: "submitted",
        artifacts: [{ file: "old" }],
        createdAt: 1,
        missionId: "mission-a",
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `h-new-${index}`,
        delivered: true,
        deliveryState: "consumed",
        artifacts: [],
        createdAt: index + 2,
        missionId: "mission-a",
      })),
    ]);

    const result = (await listTool().handler(
      {},
      orchestratorContext(),
    )) as Array<{ stuckDiagnosis?: { reason: string } }>;
    expect(result[0]?.stuckDiagnosis?.reason).toBe("accepted-not-consumed");
  });

  it("F-1232: o operador sem missão não vê seus helpers entregues como presos", async () => {
    const stores = mocks.getStores();
    const ackSpy = vi.fn(() => 0);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list: mocks.listHandoffs,
        acknowledgeSeenByOrchestratorList: ackSpy,
        listDeliveryAttempts: () => [],
      },
    });
    const threeWeeksAgo = Date.now() - 21 * 24 * 3_600_000;
    mocks.listHandoffs.mockReturnValue([
      {
        id: "h-operator-helper",
        delivered: true,
        deliveryState: "submitted",
        submittedAt: threeWeeksAgo,
        createdAt: threeWeeksAgo,
        artifacts: [],
      },
    ]);

    const result = (await listTool().handler({}, {
      ...context(),
      token: "operator-token",
      label: "operador",
      role: "user",
      missionId: undefined,
      sessionId: "operator-session",
      workerIncarnationId: undefined,
      contextRevision: undefined,
      agentName: undefined,
    })) as Array<{ id: string; stuckDiagnosis?: { reason: string } }>;
    expect(result.map((row) => row.id)).toEqual(["h-operator-helper"]);
    expect(result[0]?.stuckDiagnosis).toBeUndefined();
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("compacts a cursor page using global recency, not the page length", async () => {
    mocks.listHandoffs.mockReturnValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `h-${index + 1}`,
        delivered: true,
        deliveryState: "consumed",
        artifacts: [{ file: `f${index + 1}` }],
        createdAt: index + 1,
        missionId: "mission-a",
      })),
    );

    const page = (await listTool().handler(
      { limit: 2 },
      orchestratorContext(),
    )) as {
      items: Array<{ id: string; artifacts: unknown[]; artifactsOmitted?: number }>;
    };
    expect(page.items.map((row) => row.id)).toEqual(["h-1", "h-2"]);
    expect(page.items[0]?.artifacts).toEqual([]);
    expect(page.items[0]?.artifactsOmitted).toBe(1);
    expect(page.items[1]?.artifactsOmitted).toBe(1);
  });

  it("cursor mode pages in the store and does not materialize the whole trail", async () => {
    const stores = mocks.getStores();
    const list = vi.fn(() => {
      throw new Error("full list");
    });
    const listCursorPage = vi.fn((_filter: { limit: number }) => [

      {
        id: "h-1",
        delivered: true,
        deliveryState: "consumed",
        artifacts: [],
        createdAt: 1,
        missionId: "mission-a",
      },
      {
        id: "h-2",
        delivered: true,
        deliveryState: "consumed",
        artifacts: [],
        createdAt: 2,
        missionId: "mission-a",
      },
    ]);
    const listRecentIds = vi.fn(() => ["h-8", "h-7", "h-6", "h-5", "h-4"]);
    mocks.getStores.mockReturnValue({
      ...stores,
      handoffs: {
        ...stores.handoffs,
        list,
        listCursorPage,
        listRecentIds,
        listDeliveryAttempts: () => [],
      },
    });

    const page = (await listTool().handler(
      { limit: 1 },
      orchestratorContext(),
    )) as { items: Array<{ id: string }>; hasMoreHistory: boolean };
    expect(list).not.toHaveBeenCalled();
    expect(listCursorPage).toHaveBeenCalledTimes(1);
    expect(listCursorPage.mock.calls[0]?.[0]).toMatchObject({ limit: 2 });
    expect(listRecentIds).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "mission-a" }),
      5,
    );
    expect(page.items.map((row) => row.id)).toEqual(["h-1"]);
    expect(page.hasMoreHistory).toBe(true);
  });
});
