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
  getStores: vi.fn(),
  heartbeat: vi.fn(),
  acceptHandoff: vi.fn(),
  markConsumedFromPhysicalAck: vi.fn(),
}));

vi.mock("./gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gate")>()),
  markHandoffSubmitted: mocks.markHandoffSubmitted,
}));

vi.mock("./idle-delivery", () => ({
  onHandoffSubmitted: mocks.onHandoffSubmitted,
}));

vi.mock("./project-domain-store-registry", () => ({
  getProjectDomainStores: mocks.getStores,
}));

import { buildDomainTools } from "./tools-domain";

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
    mocks.getStores.mockReturnValue({
      missions: {
        get: () => ({
          id: "mission-a",
          title: "Mission",
          description: "Authorized work",
          status: "running",
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
      tasks: { list: () => [] },
      missionPanes: { list: () => [] },
      handoffs: {
        submitFromPhysicalAgentBoundary: mocks.submit,
        submitFromPhysicalAgentBoundaryWithReplay: mocks.submitWithReplay,
        submitFromPhysicalAgentBoundaryAndTransitionDispatch:
          mocks.submitAndTransition,
        list: vi.fn(),
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
    });
    expect(mocks.markConsumedFromPhysicalAck).toHaveBeenCalledWith(
      {
        handoffId: "handoff-a",
        missionId: "mission-a",
        orchestratorSessionId: "orchestrator-session",
      },
      expect.any(Object),
    );
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
    mocks.submitAndTransition.mockReturnValue({
      handoff: submitted,
      taskDispatch: {
        state: "handoff_ready",
        handoffId: submitted.id,
      },
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
      taskDispatchState: "handoff_ready",
    });
    expect(mocks.submitAndTransition).toHaveBeenCalledOnce();
    expect(mocks.submit).not.toHaveBeenCalled();
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
    mocks.submitAndTransition
      .mockReturnValueOnce({
        handoff: submitted,
        taskDispatch: {
          state: "handoff_ready",
          handoffId: submitted.id,
        },
        replayed: false,
      })
      .mockReturnValueOnce({
        handoff: submitted,
        taskDispatch: {
          state: "handoff_ready",
          handoffId: submitted.id,
        },
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
      taskDispatchState: "handoff_ready",
    });
    expect(mocks.submitAndTransition).toHaveBeenCalledTimes(2);
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
    mocks.submitAndTransition.mockReturnValue({
      handoff: submitted,
      taskDispatch: {
        state: "blocked",
        handoffId: submitted.id,
      },
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
      taskDispatchState: "blocked",
    });
    expect(mocks.submitAndTransition).toHaveBeenCalledOnce();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledOnce();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledWith(submitted, scope);
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
});
