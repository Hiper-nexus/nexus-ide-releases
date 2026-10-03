import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handoff } from "../../shared/orch-types";
import type { AgentGateContext } from "./gate";
import type { McpToolInvocation } from "./mcp-protocol";
import { testProjectScope } from "./__tests__/scope-fixture";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  submitWithReplay: vi.fn(),
  submitAndTransition: vi.fn(),
  markHandoffSubmitted: vi.fn(),
  onHandoffSubmitted: vi.fn(),
  orchWriteSession: vi.fn(() => true),
  getStores: vi.fn(),
  listHandoffs: vi.fn(
    (): Array<{ id: string; delivered?: boolean }> => [],
  ),
  heartbeat: vi.fn(),
  acceptHandoff: vi.fn(),
  markConsumedFromPhysicalAck: vi.fn(),
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

vi.mock("./idle-delivery", () => ({
  onHandoffSubmitted: mocks.onHandoffSubmitted,
}));

vi.mock("../pty/pty-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pty/pty-manager")>()),
  orchWriteSession: mocks.orchWriteSession,
}));

vi.mock("./project-domain-store-registry", () => ({
  getProjectDomainStores: mocks.getStores,
}));

vi.mock("./mission-leader-gate", () => ({
  requireMissionLeaderSession: mocks.requireMissionLeaderSession,
}));

const jevReview = vi.hoisted(() => ({
  reviewMissionHandoff: vi.fn<
    () => Promise<import("./jev-handoff-review").JevReviewVerdict>
  >(async () => ({ kind: "skipped", reason: "mocked" })),
}));

vi.mock("./jev-handoff-review", () => jevReview);

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
        submitFromPhysicalAgentBoundary: mocks.submit,
        submitFromPhysicalAgentBoundaryWithReplay: mocks.submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch:
          mocks.submitAndTransition,
        list: mocks.listHandoffs,
        markConsumedFromPhysicalAck: mocks.markConsumedFromPhysicalAck,
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
    const ctx = { ...context(), visualTask: { since: Date.now() } };
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
});
