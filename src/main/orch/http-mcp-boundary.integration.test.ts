import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Mission } from "../../shared/orch-types";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
  readAuditLog,
} from "../jarvis/audit-log";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  dispatchToolCall,
  type CommittedPhysicalHandoffReplayCandidateResolver,
  type McpDispatchOptions,
} from "./mcp-dispatch";
import {
  INACTIVE_GUIDED_PREVC_MCP_FENCE,
  type GuidedPrevcMcpFenceSnapshot,
} from "./guided-prevc-mcp-fence";
import {
  bindTokenToSession,
  getContext,
  mintToken,
  resetGateForTests,
  type AgentGateContext,
} from "./gate";
import { createScopedHandoffStore } from "./handoff-store";
import { handoffRawPayloadSha256 } from "./handoff-payload-identity";
import {
  handoffReceiptChainEntry,
  verifyChain,
} from "../../shared/receipt-chain";
import {
  consumeAgentTransportPhysicalReceipt,
  mintAgentTransportPhysicalReceipt,
  runInsideHttpMcpTransport,
  runInsidePtyStreamAgentTransport,
} from "./http-mcp-boundary";
import { createScopedMissionStore } from "./mission-store";
import type { McpRegistry, McpToolDef } from "./mcp-protocol";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
} from "./project-domain-store-registry";
import { compactText } from "./session-compaction";
import { createScopedTaskStore } from "./task-store";
import { createTaskDispatchStore } from "./task-dispatch-store";

const MISSION_ID = "mission-http-physical";
const SESSION_ID = "session-http-physical";
const ORCHESTRATOR_SESSION_ID = "session-http-maestro";
const INCARNATION_ID = "incarnation-http-physical";
const CONTEXT_REVISION = "context-http-physical";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function approvedMission(): Mission {
  return {
    id: MISSION_ID,
    title: "Physical HTTP MCP receipt",
    description: "Exercise the authenticated handoff boundary",
    status: "running",
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: "Persist one physical handoff receipt",
      acceptanceCriteria: ["Receipt is bound to the HTTP request"],
      risk: "normal",
      executionMode: "assisted",
      contextPolicy: "on-demand",
      approvedAt: 1,
      intentVersion: 1,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 1,
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function dispatchOptions(
  resolveMission: () => Mission = approvedMission,
  resolveCommittedReplayCandidate?: CommittedPhysicalHandoffReplayCandidateResolver,
  resolveGuidedPrevcMcpFence: () => GuidedPrevcMcpFenceSnapshot = () =>
    INACTIVE_GUIDED_PREVC_MCP_FENCE,
): McpDispatchOptions {
  return {
    resolveMissionForIntentGate: () => ({
      mission: resolveMission(),
      taskCount: 1,
      workerPaneCount: 1,
    }),
    resolveCommittedPhysicalHandoffReplayCandidate:
      resolveCommittedReplayCandidate,
    resolveGuidedPrevcMcpFence: () => resolveGuidedPrevcMcpFence(),
  };
}

function countRows(
  manager: ProjectRuntimeManager,
  table: "handoffs" | "handoff_mcp_receipts",
): number {
  return (
    manager
      .open(testProjectScope())
      .db.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number }
  ).count;
}

function spentHandoffSteps(
  missions: ReturnType<typeof createScopedMissionStore>,
): number {
  return missions.get(MISSION_ID)?.intentContract?.spentSteps ?? 0;
}

function captureError(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("physical HTTP MCP handoff boundary", () => {
  let baseDir = "";
  let manager: ProjectRuntimeManager;
  let ctx: AgentGateContext;
  let registry: McpRegistry;
  let server: http.Server;
  let endpoint = "";
  let nextHandoffId = 0;
  let handlerCalls = 0;
  let currentMission: Mission;
  let currentGuidedFence: GuidedPrevcMcpFenceSnapshot;
  let missions: ReturnType<typeof createScopedMissionStore>;
  let tasks: ReturnType<typeof createScopedTaskStore>;
  let dispatches: ReturnType<typeof createTaskDispatchStore>;
  let handoffs: ReturnType<typeof createScopedHandoffStore>;
  let orchestratorCtx: AgentGateContext;

  beforeEach(async () => {
    handlerCalls = 0;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-http-mcp-proof-"));
    manager = new ProjectRuntimeManager({
      baseDir,
      appVersion: "http-mcp-proof-test",
    });
    configureProjectDomainStoreRegistry(manager);
    configureAuditLogRuntime(manager);
    const scope = testProjectScope();
    missions = createScopedMissionStore(manager, scope, {
      idFactory: () => MISSION_ID,
    });
    const approved = approvedMission();
    missions.create({
      title: "Physical receipt",
      intentVersion: approved.intentVersion,
      intentState: approved.intentState,
      intentContract: approved.intentContract,
    });
    missions.setStatus(MISSION_ID, "running");
    missions.setOrchestratorSession(MISSION_ID, ORCHESTRATOR_SESSION_ID);
    tasks = createScopedTaskStore(manager, scope);
    let nextDispatchId = 0;
    dispatches = createTaskDispatchStore(manager, scope, {
      idFactory: (prefix) =>
        prefix === "worker-incarnation"
          ? INCARNATION_ID
          : `${prefix}-http-${++nextDispatchId}`,
    });
    handoffs = createScopedHandoffStore(manager, scope, {
      idFactory: () => `handoff-http-${++nextHandoffId}`,
    });
    const resolveCommittedReplayCandidate: CommittedPhysicalHandoffReplayCandidateResolver =
      (_candidateScope, candidate) => {
        const durableMission = missions.get(candidate.missionId);
        if (!durableMission || durableMission.status !== candidate.missionStatus) {
          return false;
        }
        const matchingHandoffs = handoffs
          .list({ missionId: candidate.missionId, includeDelivered: true })
          .filter(
            (handoff) =>
              handoff.sessionId === candidate.sessionId &&
              handoff.workerIncarnationId === candidate.workerIncarnationId &&
              (candidate.missionStatus === "done"
                ? handoff.status === "success"
                : handoff.status !== "success") &&
              handoff.mcpProvenance?.rawPayloadSha256 ===
                candidate.rawPayloadSha256,
          );
        if (matchingHandoffs.length !== 1) return false;
        const matchingDispatches = dispatches
          .list(candidate.missionId)
          .filter(
            (dispatch) =>
              dispatch.sessionId === candidate.sessionId &&
              dispatch.workerIncarnationId === candidate.workerIncarnationId,
          );
        if (matchingDispatches.length === 0) return true;
        if (matchingDispatches.length !== 1) return false;
        const dispatch = matchingDispatches[0]!;
        const stateMatches =
          candidate.missionStatus === "done"
            ? dispatch.state === "handoff_ready" ||
              dispatch.state === "merging" ||
              dispatch.state === "completed"
            : dispatch.state === "blocked";
        return (
          stateMatches && dispatch.handoffId === matchingHandoffs[0]!.id
        );
      };
    currentMission = {
      ...approved,
      orchestratorSessionId: ORCHESTRATOR_SESSION_ID,
    };
    currentGuidedFence = INACTIVE_GUIDED_PREVC_MCP_FENCE;

    resetGateForTests();
    ctx = mintToken({
      label: "physical worker",
      role: "worker",
      providerId: "grok",
      missionId: MISSION_ID,
      contextRevision: CONTEXT_REVISION,
      workerIncarnationId: INCARNATION_ID,
      scope,
      allowedTools: ["nexus_handoff_submit"],
    });
    bindTokenToSession(ctx.token, SESSION_ID);
    orchestratorCtx = mintToken({
      label: "physical Maestro",
      role: "orchestrator",
      providerId: "codex",
      missionId: MISSION_ID,
      contextRevision: CONTEXT_REVISION,
      scope,
      allowedTools: null,
    });
    bindTokenToSession(orchestratorCtx.token, ORCHESTRATOR_SESSION_ID);

    const handoffTool: McpToolDef = {
      name: "nexus_handoff_submit",
      description: "physical handoff integration fixture",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          summary: { type: "string" },
        },
        required: ["status", "summary"],
      },
      handler: async (args, toolCtx, invocation) => {
        handlerCalls += 1;
        const receipt = invocation?.agentTransportPhysicalReceipt;
        if (!receipt) throw new Error("physical receipt missing");
        const rawPayloadSha256 = handoffRawPayloadSha256(args);
        const summary = String(args.summary);
        if (summary.includes("missing-audit")) {
          manager
            .open(scope)
            .db.prepare(
              `DELETE FROM audit_events
               WHERE mission_id = ? AND outcome = 'intent'`,
            )
            .run(MISSION_ID);
        }
        const mismatch = summary.includes("mismatch");
        const useSecondHead = summary.includes("second-head");
        const persistedSummary = compactText(summary.trim(), {
          maxChars: 4_000,
        }).text;
        const status = String(args.status) as
          "success" | "partial" | "blocked" | "failed";
        const input = {
          missionId: toolCtx.missionId,
          sessionId: mismatch ? "session-mismatch" : toolCtx.sessionId,
          workerIncarnationId: toolCtx.workerIncarnationId,
          fromAgent: toolCtx.agentName ?? toolCtx.label,
          status,
          summary: persistedSummary,
        };
        const committed = summary.includes("atomic-dispatch")
          ? handoffs.submitFromPhysicalAgentBoundaryAndTransitionDispatch(
              input,
              receipt,
              {
                worktreeHeadSha: useSecondHead ? HEAD_B : HEAD_A,
                rawPayloadSha256,
              },
              {
                sessionId: toolCtx.sessionId!,
                workerIncarnationId: toolCtx.workerIncarnationId!,
                detail: `${status}: ${persistedSummary}`,
              },
            )
          : null;
        const saved =
          committed?.handoff ??
          handoffs.submitFromPhysicalAgentBoundary(input, receipt, {
            worktreeHeadSha: useSecondHead ? HEAD_B : HEAD_A,
            rawPayloadSha256,
          });
        const replayReceiptReuseError =
          committed?.replayed && summary.includes("one-shot-retry")
            ? captureError(() =>
                handoffs.submitFromPhysicalAgentBoundary(input, receipt, {
                  worktreeHeadSha: useSecondHead ? HEAD_B : HEAD_A,
                  rawPayloadSha256,
                }),
              )
            : undefined;
        if (summary.includes("self-revoking-blocked")) {
          currentMission = {
            ...currentMission,
            status: "blocked",
            updatedAt: currentMission.updatedAt + 1,
          };
        }
        if (summary.includes("replay")) {
          handoffs.submitFromPhysicalAgentBoundary(input, receipt, {
            worktreeHeadSha: HEAD_A,
            rawPayloadSha256,
          });
        }
        return {
          handoffId: saved.id,
          ...(committed?.replayed ? { replayed: true } : {}),
          ...(replayReceiptReuseError
            ? { replayReceiptReuseError }
            : {}),
        };
      },
    };
    const acknowledgeTool: McpToolDef = {
      name: "nexus_handoff_ack",
      description: "physical Maestro ACK integration fixture",
      inputSchema: {
        type: "object",
        properties: { handoffId: { type: "string" } },
        required: ["handoffId"],
      },
      handler: async (args, toolCtx, invocation) => {
        const receipt = invocation?.agentTransportPhysicalReceipt;
        if (!receipt || !toolCtx.missionId || !toolCtx.sessionId) {
          throw new Error("physical ACK receipt missing");
        }
        const handoffId = String(args.handoffId);
        const consumed = handoffs.markConsumedFromPhysicalAck(
          {
            handoffId,
            missionId: toolCtx.missionId,
            orchestratorSessionId: toolCtx.sessionId,
          },
          receipt,
        );
        if (!consumed) throw new Error("handoff is not awaiting consumption");
        return { handoffId, deliveryState: "consumed" };
      },
    };
    registry = {
      tools: [handoffTool, acknowledgeTool],
      serverName: "nexus-http-proof",
      serverVersion: "1",
    };

    server = http.createServer((request, response) => {
      void (async () => {
        const authorization = request.headers.authorization;
        const token = authorization?.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : "";
        const requestCtx = getContext(token);
        if (!requestCtx) {
          response.writeHead(401).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          args: Record<string, unknown>;
        };
        if (
          String(body.args.summary).includes(
            "settlement-reaction-http-lifetime",
          )
        ) {
          let reactionAttempt!: Promise<{
            reactionMintError: string | undefined;
            reactionConsumeError: string | undefined;
          }>;
          const result = await runInsideHttpMcpTransport(
            request,
            requestCtx,
            () => {
              const receipt = mintAgentTransportPhysicalReceipt({
                ctx: requestCtx,
                toolCallId: "tool-call-before-http-settle-reaction",
                toolName: "nexus_handoff_submit",
              });
              const settledResult = Promise.resolve({ ok: true });
              // Registered before the boundary's fallback `.finally`; this is
              // the adversarial microtask order the settlement fence protects.
              reactionAttempt = settledResult.then(() => ({
                reactionMintError: captureError(() =>
                  mintAgentTransportPhysicalReceipt({
                    ctx: requestCtx,
                    toolCallId: "tool-call-in-http-settlement-reaction",
                    toolName: "nexus_handoff_submit",
                  }),
                ),
                reactionConsumeError: captureError(() =>
                  consumeAgentTransportPhysicalReceipt(receipt, {
                    projectId: requestCtx.scope.projectId,
                    checkoutId: requestCtx.scope.checkoutId,
                    missionId: requestCtx.missionId!,
                    sessionId: requestCtx.sessionId!,
                    workerIncarnationId: requestCtx.workerIncarnationId,
                  }),
                ),
              }));
              return settledResult;
            },
          );
          const reactionErrors = await reactionAttempt;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ...result, ...reactionErrors }));
          return;
        }
        if (String(body.args.summary).includes("detached-http-lifetime")) {
          let releaseDetached!: () => void;
          const detachedGate = new Promise<void>((resolve) => {
            releaseDetached = resolve;
          });
          let detachedAttempt!: Promise<{
            detachedMintError: string | undefined;
            detachedConsumeError: string | undefined;
          }>;
          const result = await runInsideHttpMcpTransport(
            request,
            requestCtx,
            async () => {
              const receipt = mintAgentTransportPhysicalReceipt({
                ctx: requestCtx,
                toolCallId: "tool-call-before-http-settle",
                toolName: "nexus_handoff_submit",
              });
              // The callback is registered inside ALS, but released only after
              // the async HTTP boundary promise has settled.
              detachedAttempt = detachedGate.then(() => ({
                detachedMintError: captureError(() =>
                  mintAgentTransportPhysicalReceipt({
                    ctx: requestCtx,
                    toolCallId: "tool-call-after-http-settle",
                    toolName: "nexus_handoff_submit",
                  }),
                ),
                detachedConsumeError: captureError(() =>
                  consumeAgentTransportPhysicalReceipt(receipt, {
                    projectId: requestCtx.scope.projectId,
                    checkoutId: requestCtx.scope.checkoutId,
                    missionId: requestCtx.missionId!,
                    sessionId: requestCtx.sessionId!,
                    workerIncarnationId: requestCtx.workerIncarnationId,
                  }),
                ),
              }));
              await Promise.resolve();
              return { ok: true };
            },
          );
          releaseDetached();
          const detachedErrors = await detachedAttempt;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ...result, ...detachedErrors }));
          return;
        }
        const result = await runInsideHttpMcpTransport(
          request,
          requestCtx,
          () =>
            dispatchToolCall(
              "http-mcp",
              registry,
              "nexus_handoff_submit",
              body.args,
              requestCtx,
              dispatchOptions(
                () => currentMission,
                resolveCommittedReplayCandidate,
                () => currentGuidedFence,
              ),
            ),
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      })().catch((error) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    resetGateForTests();
    disposeProjectDomainStoreRegistry();
    disposeAuditLogRuntime();
    manager?.closeAll();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function seedRunningDispatch(): string {
    const task = tasks.create({
      missionId: MISSION_ID,
      title: "Physical HTTP worker",
    });
    const route = missions.reserveRouteDecision(MISSION_ID, task.title, {
      tier: "hard",
      adapterId: "grok",
      reason: "physical HTTP integration route",
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: MISSION_ID,
      taskId: task.id,
      intentVersion: 1,
      workerId: "physical worker",
      leaseOwner: "main",
      leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: "grok",
    });
    dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId: "pane-http-physical",
      sessionId: SESSION_ID,
      workerIncarnationId: claim.workerIncarnationId,
    });
    expect(claim.workerIncarnationId).toBe(INCARNATION_ID);
    return task.id;
  }

  async function post(
    summary: string,
    status: "success" | "partial" | "blocked" | "failed" = "success",
  ) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        args: { status, summary },
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        ok?: boolean;
        error?: string;
        effectMayHaveCommitted?: boolean;
        result?: {
          handoffId?: string;
          replayed?: boolean;
          replayReceiptReuseError?: string;
        };
        detachedMintError?: string;
        detachedConsumeError?: string;
        reactionMintError?: string;
        reactionConsumeError?: string;
      },
    };
  }

  it("keeps transport minting imports confined to production owners", () => {
    const directory = __dirname;
    const importers = fs
      .readdirSync(directory)
      .filter(
        (name) =>
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts") &&
          name !== "http-mcp-boundary.ts",
      )
      .filter((name) =>
        fs
          .readFileSync(path.join(directory, name), "utf8")
          .includes('from "./http-mcp-boundary"'),
      )
      .sort();
    expect(importers).toEqual([
      "fanout-consolidation-receipt-authority.ts",
      "handoff-physical-ack-authority.ts",
      "handoff-store.ts",
      "mcp-dispatch.ts",
      "mcp-protocol.ts",
      "mcp-server.ts",
      "pty-stream-handoff.ts",
      "task-dispatch-mission-completion-authority.ts",
    ]);
  });

  it("rejects direct dispatch even when main labels it http-mcp", async () => {
    const result = await dispatchToolCall(
      "http-mcp",
      {
        tools: [
          {
            name: "nexus_handoff_submit",
            description: "must not execute",
            inputSchema: { type: "object", properties: {} },
            handler: async () => {
              handlerCalls += 1;
              return {};
            },
          },
        ],
        serverName: "direct-main",
        serverVersion: "1",
      },
      "nexus_handoff_submit",
      {
        status: "success",
        summary: "Direct dispatch cannot manufacture physical provenance.",
      },
      ctx,
      dispatchOptions(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/physical agent transport boundary/i),
    });
    expect(result.effectMayHaveCommitted).toBeUndefined();
    expect(handlerCalls).toBe(0);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(0);
  });

  it("dispatches a handoff through the authenticated PTY-stream source", async () => {
    const result = await runInsidePtyStreamAgentTransport(
      SESSION_ID,
      ctx,
      () =>
        dispatchToolCall(
          "pty-stream",
          registry,
          "nexus_handoff_submit",
          {
            status: "success",
            summary:
              "Physical PTY-stream dispatch completed with durable provenance.",
          },
          ctx,
          dispatchOptions(() => currentMission),
        ),
    );

    expect(result).toMatchObject({ ok: true });
    expect(handlerCalls).toBe(1);
    expect(
      manager
        .open(testProjectScope())
        .db.prepare(
          "SELECT source FROM handoff_mcp_receipts LIMIT 1",
        )
        .get(),
    ).toEqual({ source: "pty-stream" });
    expect(
      readAuditLog(
        { scope: testProjectScope(), missionId: MISSION_ID },
        20,
      ).filter((entry) => entry.source === "pty-stream"),
    ).toEqual([
      expect.objectContaining({ result: "intent" }),
      expect.objectContaining({ result: "ok" }),
    ]);
  });

  it("persists and replays only the exact physical Maestro ACK", async () => {
    const handoff = handoffs.submit({
      missionId: MISSION_ID,
      sessionId: SESSION_ID,
      fromAgent: "worker",
      status: "success",
      summary: "Durable result awaiting the exact physical Maestro ACK.",
    });
    const dispatchAck = (context = orchestratorCtx) =>
      runInsidePtyStreamAgentTransport(context.sessionId!, context, () =>
        dispatchToolCall(
          "pty-stream",
          registry,
          "nexus_handoff_ack",
          { handoffId: handoff.id },
          context,
          dispatchOptions(() => currentMission),
        ),
      );

    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: MISSION_ID,
      orchestratorSessionId: ORCHESTRATOR_SESSION_ID,
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);

    await expect(dispatchAck()).resolves.toMatchObject({
      ok: true,
      result: {
        handoffId: handoff.id,
        deliveryState: "consumed",
      },
    });
    expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
    expect(
      manager
        .open(testProjectScope())
        .db.prepare(
          `SELECT handoff_id, delivery_attempt_id, orchestrator_session_id
           FROM handoff_ack_receipts`,
        )
        .all(),
    ).toEqual([
      {
        handoff_id: handoff.id,
        delivery_attempt_id: attempt.id,
        orchestrator_session_id: ORCHESTRATOR_SESSION_ID,
      },
    ]);

    manager.close(testProjectScope());
    await expect(dispatchAck()).resolves.toMatchObject({ ok: true });
    expect(
      manager
        .open(testProjectScope())
        .db.prepare(`SELECT COUNT(*) AS count FROM handoff_ack_receipts`)
        .get(),
    ).toEqual({ count: 1 });

    const stale = mintToken({
      label: "stale Maestro",
      role: "orchestrator",
      providerId: "codex",
      missionId: MISSION_ID,
      contextRevision: CONTEXT_REVISION,
      scope: testProjectScope(),
      allowedTools: null,
    });
    bindTokenToSession(stale.token, "session-http-maestro-stale");
    await expect(dispatchAck(stale)).resolves.toMatchObject({ ok: false });
    expect(
      manager
        .open(testProjectScope())
        .db.prepare(`SELECT COUNT(*) AS count FROM handoff_ack_receipts`)
        .get(),
    ).toEqual({ count: 1 });

    const reboundSessionId = "session-http-maestro-rebound";
    expect(
      missions.rebindOrchestratorSession(MISSION_ID, reboundSessionId),
    ).toMatchObject({
      orchestratorSessionId: reboundSessionId,
      status: "running",
    });
    currentMission = {
      ...currentMission,
      orchestratorSessionId: reboundSessionId,
    };
    expect(handoffs.get(handoff.id)).toMatchObject({
      delivered: false,
      deliveryState: "queued",
    });

    const reboundCtx = mintToken({
      label: "replacement physical Maestro",
      role: "orchestrator",
      providerId: "codex",
      missionId: MISSION_ID,
      contextRevision: CONTEXT_REVISION,
      scope: testProjectScope(),
      allowedTools: null,
    });
    bindTokenToSession(reboundCtx.token, reboundSessionId);
    const reboundAttempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: MISSION_ID,
      orchestratorSessionId: reboundSessionId,
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: reboundAttempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: reboundAttempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);

    await expect(dispatchAck(reboundCtx)).resolves.toMatchObject({
      ok: true,
      result: {
        handoffId: handoff.id,
        deliveryState: "consumed",
      },
    });
    expect(
      manager
        .open(testProjectScope())
        .db.prepare(
          `SELECT delivery_attempt_id, orchestrator_session_id
           FROM handoff_ack_receipts
           WHERE handoff_id = ?
           ORDER BY acknowledged_at, receipt_id`,
        )
        .all(handoff.id),
    ).toEqual([
      {
        delivery_attempt_id: attempt.id,
        orchestrator_session_id: ORCHESTRATOR_SESSION_ID,
      },
      {
        delivery_attempt_id: reboundAttempt.id,
        orchestrator_session_id: reboundSessionId,
      },
    ]);

    manager.close(testProjectScope());
    await expect(dispatchAck(reboundCtx)).resolves.toMatchObject({ ok: true });
    expect(
      manager
        .open(testProjectScope())
        .db.prepare(`SELECT COUNT(*) AS count FROM handoff_ack_receipts`)
        .get(),
    ).toEqual({ count: 2 });
  });

  it("consumes a queued handoff the orchestrator read instead of one pasted", async () => {
    // Push delivery only pastes into an idle PTY, so an orchestrator that polls
    // for results never receives one — it stays `working` for its whole turn.
    // Requiring a pasted attempt before the ACK deadlocked the mission.
    const handoff = handoffs.submit({
      missionId: MISSION_ID,
      sessionId: SESSION_ID,
      fromAgent: "worker",
      status: "success",
      summary: "Durable result the Maestro read via nexus_handoff_list.",
    });
    expect(handoffs.get(handoff.id)?.deliveryState).toBe("queued");

    const dispatchAck = () =>
      runInsidePtyStreamAgentTransport(
        orchestratorCtx.sessionId!,
        orchestratorCtx,
        () =>
          dispatchToolCall(
            "pty-stream",
            registry,
            "nexus_handoff_ack",
            { handoffId: handoff.id },
            orchestratorCtx,
            dispatchOptions(() => currentMission),
          ),
      );

    await expect(dispatchAck()).resolves.toMatchObject({
      ok: true,
      result: { handoffId: handoff.id, deliveryState: "consumed" },
    });
    expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");

    // The synthesized attempt keeps the ACK receipt chain intact.
    expect(
      manager
        .open(testProjectScope())
        .db.prepare(
          `SELECT state, orchestrator_session_id
           FROM handoff_delivery_attempts WHERE handoff_id = ?`,
        )
        .all(handoff.id),
    ).toEqual([
      {
        state: "accepted",
        orchestrator_session_id: ORCHESTRATOR_SESSION_ID,
      },
    ]);

    manager.close(testProjectScope());
    await expect(dispatchAck()).resolves.toMatchObject({ ok: true });
    expect(
      manager
        .open(testProjectScope())
        .db.prepare(
          `SELECT COUNT(*) AS count FROM handoff_ack_receipts
           WHERE handoff_id = ?`,
        )
        .get(handoff.id),
    ).toEqual({ count: 1 });
  });

  it("revokes detached HTTP async resources after the request operation settles", async () => {
    const result = await post(
      "Physical detached-http-lifetime must lose authority after settle.",
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: true,
        detachedMintError: expect.stringMatching(
          /physical agent transport boundary/i,
        ),
        detachedConsumeError: expect.stringMatching(
          /invalid, stale or out-of-scope/i,
        ),
      },
    });
    expect(countRows(manager, "handoffs")).toBe(0);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(0);
    expect(spentHandoffSteps(missions)).toBe(0);
  });

  it("revokes authority before an earlier reaction of a real HTTP operation promise", async () => {
    const result = await post(
      "Physical settlement-reaction-http-lifetime must close at logical settle.",
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: true,
        reactionMintError: expect.stringMatching(
          /physical agent transport boundary/i,
        ),
        reactionConsumeError: expect.stringMatching(
          /invalid, stale or out-of-scope/i,
        ),
      },
    });
    expect(countRows(manager, "handoffs")).toBe(0);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(0);
  });

  it("persists an immutable receipt from a real authenticated loopback request", async () => {
    const result = await post(
      "Physical loopback worker handoff completed successfully.",
    );

    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(handlerCalls).toBe(1);
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(spentHandoffSteps(missions)).toBe(1);

    const receipt = manager
      .open(testProjectScope())
      .db.prepare(
        `SELECT handoff_id, tool_call_id, mission_id, session_id,
                worker_incarnation_id, authority_sha256, worktree_head_sha,
                raw_payload_sha256, logical_operation_key
         FROM handoff_mcp_receipts`,
      )
      .get() as Record<string, string>;
    expect(receipt).toMatchObject({
      mission_id: MISSION_ID,
      session_id: SESSION_ID,
      worker_incarnation_id: INCARNATION_ID,
      authority_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      worktree_head_sha: HEAD_A,
      raw_payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      logical_operation_key: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(receipt.tool_call_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(
      readAuditLog({ scope: testProjectScope(), missionId: MISSION_ID }).map(
        (entry) => [entry.result, entry.invocation_id],
      ),
    ).toEqual([
      ["intent", receipt.tool_call_id],
      ["ok", receipt.tool_call_id],
    ]);
    expect(() =>
      manager
        .open(testProjectScope())
        .db.prepare(
          `UPDATE handoff_mcp_receipts
           SET session_id = 'forged' WHERE handoff_id = ?`,
        )
        .run(receipt.handoff_id),
    ).toThrow(/immutable/i);
  });

  it("chains physical receipts per mission into a verifiable hash chain", async () => {
    const first = await post(
      "Physical loopback worker handoff completed successfully.",
    );
    expect(first).toMatchObject({ status: 200, body: { ok: true } });

    const secondSession = "session-http-physical-2";
    const workerCtx2 = mintToken({
      label: "physical worker 2",
      role: "worker",
      providerId: "grok",
      missionId: MISSION_ID,
      contextRevision: CONTEXT_REVISION,
      workerIncarnationId: "incarnation-http-physical-2",
      scope: testProjectScope(),
      allowedTools: ["nexus_handoff_submit"],
    });
    bindTokenToSession(workerCtx2.token, secondSession);
    const second = await runInsidePtyStreamAgentTransport(
      secondSession,
      workerCtx2,
      () =>
        dispatchToolCall(
          "pty-stream",
          registry,
          "nexus_handoff_submit",
          {
            status: "success",
            summary:
              "Physical second worker handoff extends the mission receipt chain.",
          },
          workerCtx2,
          dispatchOptions(() => currentMission),
        ),
    );
    expect(second).toMatchObject({ ok: true });
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(2);

    interface ChainRow {
      readonly receipt_id: string;
      readonly handoff_id: string;
      readonly tool_call_id: string;
      readonly tool_name: string;
      readonly source: string;
      readonly mission_id: string;
      readonly session_id: string;
      readonly worker_incarnation_id: string | null;
      readonly authority_sha256: string;
      readonly worktree_head_sha: string | null;
      readonly raw_payload_sha256: string | null;
      readonly logical_operation_key: string | null;
      readonly issued_at: number;
      readonly chain_seq: number;
      readonly prev_receipt_hash: string | null;
      readonly chain_hash: string;
    }
    const rows = manager
      .open(testProjectScope())
      .db.prepare(
        `SELECT receipt_id, handoff_id, tool_call_id, tool_name, source,
                mission_id, session_id, worker_incarnation_id,
                authority_sha256, worktree_head_sha, raw_payload_sha256,
                logical_operation_key, issued_at,
                chain_seq, prev_receipt_hash, chain_hash
           FROM handoff_mcp_receipts
          ORDER BY chain_seq ASC`,
      )
      .all() as readonly ChainRow[];

    // The persisted link: genesis has NULL prev; receipt 2 carries receipt 1.
    expect(rows.map((row) => row.chain_seq)).toEqual([1, 2]);
    expect(rows[0].prev_receipt_hash).toBeNull();
    expect(rows[0].chain_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(rows[1].prev_receipt_hash).toBe(rows[0].chain_hash);
    expect(rows.map((row) => row.session_id)).toEqual([
      SESSION_ID,
      secondSession,
    ]);

    // The whole mission trail re-verifies from the stored rows alone.
    const chainMaterial = (row: ChainRow) => ({
      missionId: row.mission_id,
      seq: row.chain_seq,
      issuedAt: row.issued_at,
      receiptId: row.receipt_id,
      handoffId: row.handoff_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      source: row.source,
      sessionId: row.session_id,
      workerIncarnationId: row.worker_incarnation_id,
      authoritySha256: row.authority_sha256,
      worktreeHeadSha: row.worktree_head_sha,
      rawPayloadSha256: row.raw_payload_sha256,
      logicalOperationKey: row.logical_operation_key,
    });
    const chain = rows.map((row) => ({
      ...handoffReceiptChainEntry(chainMaterial(row)),
      chainHash: row.chain_hash,
      prevReceiptHash: row.prev_receipt_hash,
    }));
    expect(verifyChain(chain)).toEqual({ status: "valid", length: 2 });

    // A forged column stops verifying from that link onward.
    const forged = {
      ...handoffReceiptChainEntry({
        ...chainMaterial(rows[1]),
        sessionId: "session-forged",
      }),
      chainHash: rows[1].chain_hash,
      prevReceiptHash: rows[1].prev_receipt_hash,
    };
    expect(verifyChain([chain[0], forged])).toEqual({
      status: "hash-mismatch",
      seq: 2,
    });
  });

  it("accepts a physical worker handoff over HTTP while guided PREVC prepares", async () => {
    currentGuidedFence = Object.freeze({
      required: true,
      active: true,
      hasContract: false,
      stage: null,
      risk: null,
      contractHash: null,
      workflowRevision: null,
    });

    const result = await post(
      "Physical guided worker handoff remains live while PREVC prepares.",
    );

    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(handlerCalls).toBe(1);
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
  });

  it("returns one generic handoff after response loss without a dispatch row or second charge", async () => {
    const summary =
      "Physical generic commit is exactly-once after a lost HTTP response.";

    const first = await post(summary);
    const retry = await post(summary);

    expect(first).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: { handoffId: expect.stringMatching(/^handoff-http-/) },
      },
    });
    expect(retry).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: { handoffId: first.body.result?.handoffId },
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(dispatches.list(MISSION_ID)).toHaveLength(0);
    expect(spentHandoffSteps(missions)).toBe(1);
  });

  it("serializes simultaneous generic retries into one handoff and one budget step", async () => {
    const summary =
      "Physical concurrent generic submissions share one logical operation.";

    const [left, right] = await Promise.all([post(summary), post(summary)]);

    expect(left).toMatchObject({ status: 200, body: { ok: true } });
    expect(right).toMatchObject({ status: 200, body: { ok: true } });
    expect(left.body.result?.handoffId).toBe(right.body.result?.handoffId);
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(spentHandoffSteps(missions)).toBe(1);
    expect(handlerCalls).toBe(2);
  });

  it("rejects a divergent generic retry and preserves its original budget ledger", async () => {
    const first = await post(
      "Physical generic commit keeps one immutable operation payload.",
    );
    const divergent = await post(
      "Physical generic commit tries a different operation payload.",
    );

    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(divergent).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/replay recusado.*diverge/i),
        effectMayHaveCommitted: true,
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(spentHandoffSteps(missions)).toBe(1);
  });

  it("rejects different raw payloads hidden behind the same compact summary", async () => {
    const sharedHead = "h".repeat(2_700);
    const sharedTail = "t".repeat(1_300);
    const firstSummary = `${sharedHead}${"x".repeat(1_000)}${sharedTail}`;
    const secondSummary = `${sharedHead}${"y".repeat(1_000)}${sharedTail}`;
    expect(
      compactText(firstSummary, { maxChars: 4_000 }).text,
    ).toBe(compactText(secondSummary, { maxChars: 4_000 }).text);

    const first = await post(firstSummary);
    const divergent = await post(secondSummary);

    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(divergent).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/payload raw.*diverge/i),
        effectMayHaveCommitted: true,
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(spentHandoffSteps(missions)).toBe(1);
  });

  it("fails closed when a legacy receipt has no canonical replay identity", async () => {
    const summary =
      "Physical legacy identity cannot be retried after schema upgrade.";
    const first = await post(summary);
    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    const db = manager.open(testProjectScope()).db;
    db.exec("DROP TRIGGER handoff_mcp_receipt_immutable");
    db.prepare(
      `UPDATE handoff_mcp_receipts
       SET raw_payload_sha256 = NULL, logical_operation_key = NULL`,
    ).run();

    const retry = await post(summary);

    expect(retry).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/receipt legado.*identidade canônica/i),
        effectMayHaveCommitted: true,
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(spentHandoffSteps(missions)).toBe(1);
  });

  it("rolls back physical submit and receipt when dispatch CAS faults, then retries cleanly", async () => {
    const taskId = seedRunningDispatch();
    const db = manager.open(testProjectScope()).db;
    db.exec(`
      CREATE TRIGGER inject_physical_dispatch_crash
      BEFORE UPDATE OF handoff_id ON task_dispatch_queue
      WHEN NEW.handoff_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected crash between receipt and dispatch');
      END
    `);

    const failed = await post(
      "Physical atomic-dispatch success must roll every durable row back on fault.",
    );

    expect(failed).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/injected crash/i),
        effectMayHaveCommitted: true,
      },
    });
    expect(countRows(manager, "handoffs")).toBe(0);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(0);
    expect(spentHandoffSteps(missions)).toBe(0);
    expect(dispatches.get(taskId)).toMatchObject({
      state: "running",
      handoffId: undefined,
    });

    db.exec("DROP TRIGGER inject_physical_dispatch_crash");
    const retried = await post(
      "Physical atomic-dispatch success must retry from one clean SQLite state.",
    );

    expect(retried).toMatchObject({ status: 200, body: { ok: true } });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(spentHandoffSteps(missions)).toBe(1);
    expect(dispatches.get(taskId)).toMatchObject({
      state: "handoff_ready",
      handoffId: expect.stringMatching(/^handoff-http-/),
    });
  });

  it("returns the committed success handoff on lost-response replay without another row", async () => {
    const taskId = seedRunningDispatch();
    const summary =
      "Physical atomic-dispatch success is exactly-once across a lost response.";

    const first = await post(summary);
    const committed = dispatches.get(taskId);
    const replay = await post(summary);

    expect(first).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          handoffId: committed?.handoffId,
        },
      },
    });
    expect(replay).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          handoffId: committed?.handoffId,
          replayed: true,
        },
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(spentHandoffSteps(missions)).toBe(1);
    expect(dispatches.get(taskId)).toMatchObject({
      state: "handoff_ready",
      handoffId: committed?.handoffId,
    });
    expect(
      readAuditLog({ scope: testProjectScope(), missionId: MISSION_ID }).map(
        (entry) => entry.result,
      ),
    ).toEqual(["intent", "ok", "intent", "ok"]);
  });

  it("consumes the retry receipt before returning an idempotent handoff", async () => {
    const taskId = seedRunningDispatch();
    const summary =
      "Physical atomic-dispatch one-shot-retry cannot authorize another handoff.";

    const first = await post(summary);
    const committed = dispatches.get(taskId);
    const replay = await post(summary);

    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(replay).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          handoffId: committed?.handoffId,
          replayed: true,
          replayReceiptReuseError: expect.stringMatching(
            /invalid, stale or out-of-scope/i,
          ),
        },
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(dispatches.get(taskId)).toMatchObject({
      state: "handoff_ready",
      handoffId: committed?.handoffId,
    });
  });

  it("rejects divergent lost-response replay without another handoff or dispatch mutation", async () => {
    const taskId = seedRunningDispatch();
    const first = await post(
      "Physical atomic-dispatch success has one immutable retry payload.",
    );
    const committed = dispatches.get(taskId);

    const divergent = await post(
      "Physical atomic-dispatch success tries a divergent retry payload.",
    );

    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(divergent).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/replay recusado.*diverge/i),
        effectMayHaveCommitted: true,
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(dispatches.get(taskId)).toMatchObject({
      state: "handoff_ready",
      handoffId: committed?.handoffId,
    });
  });

  it("commits a physical non-success handoff and terminal block without a false transport error", async () => {
    const taskId = seedRunningDispatch();

    const result = await post(
      "Physical atomic-dispatch blocker is terminal and fully receipted.",
      "blocked",
    );

    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(dispatches.get(taskId)).toMatchObject({
      state: "blocked",
      handoffId: expect.stringMatching(/^handoff-http-/),
      lastError: expect.stringContaining("blocked:"),
    });
    expect(
      tasks.list(MISSION_ID).find((task) => task.id === taskId),
    ).toMatchObject({
      status: "failed",
    });
    expect(missions.get(MISSION_ID)).toMatchObject({ status: "blocked" });
    expect(
      readAuditLog({ scope: testProjectScope(), missionId: MISSION_ID }).map(
        (entry) => entry.result,
      ),
    ).toEqual(["intent", "ok"]);
  });

  it("returns the committed non-success handoff after its own mission block", async () => {
    const taskId = seedRunningDispatch();
    const summary =
      "Physical atomic-dispatch blocker remains exactly-once after response loss.";

    const first = await post(summary, "blocked");
    const committed = dispatches.get(taskId);
    currentMission = missions.get(MISSION_ID)!;
    const replay = await post(summary, "blocked");

    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(currentMission).toMatchObject({ status: "blocked" });
    expect(replay).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          handoffId: committed?.handoffId,
          replayed: true,
        },
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(dispatches.get(taskId)).toMatchObject({
      state: "blocked",
      handoffId: committed?.handoffId,
    });
    expect(
      readAuditLog({ scope: testProjectScope(), missionId: MISSION_ID }).map(
        (entry) => entry.result,
      ),
    ).toEqual(["intent", "ok", "intent", "ok"]);
  });

  it("rejects a divergent blocker replay after the mission is already blocked", async () => {
    const taskId = seedRunningDispatch();
    const first = await post(
      "Physical atomic-dispatch blocker has one immutable retry payload.",
      "blocked",
    );
    const committed = dispatches.get(taskId);
    currentMission = missions.get(MISSION_ID)!;

    const divergent = await post(
      "Physical atomic-dispatch blocker tries a divergent retry payload.",
      "blocked",
    );

    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(divergent).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/dispatch_required/i),
      },
    });
    expect(divergent.body.effectMayHaveCommitted).toBeUndefined();
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(spentHandoffSteps(missions)).toBe(1);
    expect(dispatches.get(taskId)).toMatchObject({
      state: "blocked",
      handoffId: committed?.handoffId,
      lastError: expect.stringContaining("one immutable retry payload"),
    });
  });

  it("reports success when a blocked handoff self-revokes mission dispatch", async () => {
    const result = await post(
      "Physical self-revoking-blocked handoff records the worker blocker.",
    );

    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(handlerCalls).toBe(1);
    expect(currentMission.status).toBe("blocked");
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
    expect(
      readAuditLog({ scope: testProjectScope(), missionId: MISSION_ID }).map(
        (entry) => entry.result,
      ),
    ).toEqual(["intent", "ok"]);
  });

  it("still denies a handoff whose mission authority is stale before commit", async () => {
    currentMission = {
      ...currentMission,
      status: "blocked",
      updatedAt: currentMission.updatedAt + 1,
    };

    const result = await post(
      "Physical stale-before-commit handoff must never reach persistence.",
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/dispatch_required/i),
      },
    });
    expect(handlerCalls).toBe(0);
    expect(countRows(manager, "handoffs")).toBe(0);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(0);
  });

  it("consumes the capability once and rolls back replayed writes", async () => {
    const result = await post(
      "Physical loopback handoff deliberately attempts capability replay.",
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/invalid, stale or out-of-scope/i),
        effectMayHaveCommitted: true,
      },
    });
    expect(countRows(manager, "handoffs")).toBe(1);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(1);
  });

  it("rejects a session mismatch before either row can commit", async () => {
    const result = await post(
      "Physical loopback mismatch must not cross its session authority.",
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/invalid, stale or out-of-scope/i),
      },
    });
    expect(countRows(manager, "handoffs")).toBe(0);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(0);
  });

  it("requires the correlated durable audit intent in the atomic write", async () => {
    const result = await post(
      "Physical loopback missing-audit must fail closed before persistence.",
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: false,
        error: expect.stringMatching(/durable physical agent audit intent/i),
      },
    });
    expect(countRows(manager, "handoffs")).toBe(0);
    expect(countRows(manager, "handoff_mcp_receipts")).toBe(0);
  });

});
