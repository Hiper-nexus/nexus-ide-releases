import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O ACK também pede a memória da entrega (F-703); aqui só importa o ledger.
vi.mock("../memory/trusted-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../memory/trusted-memory")>()),
  retainAcknowledgedHandoffMemoryBestEffort: vi.fn(async () => null),
}));
import type { Mission } from "../../shared/orch-types";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from "../jarvis/audit-log";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import { bindTokenToSession, mintToken, resetGateForTests } from "./gate";
import { createScopedHandoffStore } from "./handoff-store";
import { runInsidePtyStreamAgentTransport } from "./http-mcp-boundary";
import { dispatchToolCall, type McpDispatchOptions } from "./mcp-dispatch";
import type { McpRegistry, McpToolDef } from "./mcp-protocol";
import { createScopedMissionStore } from "./mission-store";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
} from "./project-domain-store-registry";

/**
 * F-1006 — rajada de entregas ao Maestro: a entrega ociosa cola o handoff e
 * dá o CR; o Maestro lê e chama `nexus_handoff_ack` ANTES de o TUI pintar a
 * borda busy que aceitaria a tentativa colada. O ACK caía no caminho de pull
 * (segunda tentativa aceita, handoff fora de `queued`) e a borda busy, logo
 * depois, lançava "handoff submission lost delivery-attempt CAS" de dentro do
 * tap do PTY — a entrega em memória ficava presa ~13 s (prazo de aceite).
 */
const MISSION_ID = "mission-f1006";
const WORKER_SESSION_ID = "session-f1006-worker";
const ORCHESTRATOR_SESSION_ID = "session-f1006-maestro";

function runningMission(): Mission {
  return {
    id: MISSION_ID,
    title: "F-1006 rajada de entregas",
    description: "ACK antes da borda busy",
    status: "running",
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: "Entregar a rajada sem perder a vez",
      acceptanceCriteria: ["Cada handoff chega uma vez"],
      risk: "normal",
      executionMode: "assisted",
      contextPolicy: "on-demand",
      approvedAt: 1,
      intentVersion: 1,
      budgets: { planningTokens: 1_200, executionTokens: 8_000, maxWorkers: 6 },
    },
    orchestratorSessionId: ORCHESTRATOR_SESSION_ID,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("F-1006: ACK do Maestro x tentativa colada (store real)", () => {
  let baseDir = "";
  let manager: ProjectRuntimeManager;
  let handoffs: ReturnType<typeof createScopedHandoffStore>;
  let registry: McpRegistry;
  let orchestratorCtx: ReturnType<typeof mintToken>;
  let nextHandoffId = 0;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-f1006-ack-"));
    manager = new ProjectRuntimeManager({ baseDir, appVersion: "f1006-test" });
    configureProjectDomainStoreRegistry(manager);
    configureAuditLogRuntime(manager);
    const scope = testProjectScope();
    const missions = createScopedMissionStore(manager, scope, { idFactory: () => MISSION_ID });
    const mission = runningMission();
    missions.create({
      title: mission.title,
      intentVersion: mission.intentVersion,
      intentState: mission.intentState,
      intentContract: mission.intentContract,
    });
    missions.setStatus(MISSION_ID, "running");
    missions.setOrchestratorSession(MISSION_ID, ORCHESTRATOR_SESSION_ID);
    handoffs = createScopedHandoffStore(manager, scope, {
      idFactory: () => `handoff-f1006-${++nextHandoffId}`,
    });
    resetGateForTests();
    orchestratorCtx = mintToken({
      label: "Maestro F-1006",
      role: "orchestrator",
      providerId: "codex",
      missionId: MISSION_ID,
      contextRevision: "context-f1006",
      scope,
      allowedTools: null,
    });
    bindTokenToSession(orchestratorCtx.token, ORCHESTRATOR_SESSION_ID);
    const acknowledgeTool: McpToolDef = {
      name: "nexus_handoff_ack",
      description: "F-1006 ACK fixture (mesmo store do handler de produção)",
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
        const consumed = handoffs.markConsumedFromPhysicalAck(
          {
            handoffId: String(args.handoffId),
            missionId: toolCtx.missionId,
            orchestratorSessionId: toolCtx.sessionId,
          },
          receipt,
        );
        if (!consumed) throw new Error("handoff is not awaiting consumption");
        return { deliveryState: "consumed" };
      },
    };
    registry = { tools: [acknowledgeTool], serverName: "nexus-f1006", serverVersion: "1" };
  });

  afterEach(async () => {
    disposeAuditLogRuntime();
    await disposeProjectDomainStoreRegistry();
    resetGateForTests();
    manager?.closeAll();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const dispatchOptions: McpDispatchOptions = {
    resolveMissionForIntentGate: () => ({ mission: runningMission(), taskCount: 1, workerPaneCount: 6 }),
  };
  const ack = (handoffId: string) =>
    runInsidePtyStreamAgentTransport(ORCHESTRATOR_SESSION_ID, orchestratorCtx, () =>
      dispatchToolCall("pty-stream", registry, "nexus_handoff_ack", { handoffId }, orchestratorCtx, dispatchOptions),
    );
  const submitted = (label: string) =>
    handoffs.submit({
      missionId: MISSION_ID,
      sessionId: `${WORKER_SESSION_ID}-${label}`,
      fromAgent: `writer-${label}`,
      status: "success",
      summary: `Writer ${label} entregou.`,
    });
  const paste = (handoffId: string) => {
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId,
      missionId: MISSION_ID,
      orchestratorSessionId: ORCHESTRATOR_SESSION_ID,
      maxAttempts: 3,
    });
    return handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId,
      acceptDeadlineAt: Date.now() + 12_000,
    });
  };

  it("ACK antes da borda busy aceita a PRÓPRIA tentativa colada; a borda depois não lança", async () => {
    const handoff = submitted("w1");
    const pasted = paste(handoff.id);

    await expect(ack(handoff.id)).resolves.toMatchObject({ ok: true });

    // A borda busy do TUI chega depois do ACK: nada a aceitar, nada lança.
    expect(() =>
      handoffs.acceptDeliveryAttempt({ attemptId: pasted.id, handoffId: handoff.id }),
    ).not.toThrow();
    expect(handoffs.acceptDeliveryAttempt({ attemptId: pasted.id, handoffId: handoff.id })).toBe(false);
    // Exatamente-uma-vez: UMA tentativa, a colada, aceita; handoff consumido.
    expect(handoffs.listDeliveryAttempts(handoff.id).map((attempt) => [attempt.id, attempt.state]))
      .toEqual([[pasted.id, "accepted"]]);
    expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
  });

  it("rajada: cada ACK adota a sua colagem, sem tentativa duplicada nem CAS perdido", async () => {
    const burst = ["w1", "w2", "w3", "w4", "w5", "w6"].map(submitted);
    const attempts = burst.map((handoff) => paste(handoff.id));
    for (const handoff of burst) await expect(ack(handoff.id)).resolves.toMatchObject({ ok: true });
    burst.forEach((handoff, index) => {
      expect(() =>
        handoffs.acceptDeliveryAttempt({ attemptId: attempts[index]!.id, handoffId: handoff.id }),
      ).not.toThrow();
      expect(handoffs.listDeliveryAttempts(handoff.id).map((attempt) => attempt.state)).toEqual(["accepted"]);
      expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
    });
  });

  it("sem colagem (o Maestro leu pelo nexus_handoff_list), o ACK segue pelo pull", async () => {
    const handoff = submitted("pull");
    await expect(ack(handoff.id)).resolves.toMatchObject({ ok: true });
    expect(handoffs.listDeliveryAttempts(handoff.id).map((attempt) => attempt.state)).toEqual(["accepted"]);
    expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
  });

  it("a borda busy antes do ACK continua o caminho normal (aceite pela borda, ACK consome)", async () => {
    const handoff = submitted("edge");
    const pasted = paste(handoff.id);
    expect(handoffs.acceptDeliveryAttempt({ attemptId: pasted.id, handoffId: handoff.id })).toBe(true);
    await expect(ack(handoff.id)).resolves.toMatchObject({ ok: true });
    expect(handoffs.listDeliveryAttempts(handoff.id).map((attempt) => [attempt.id, attempt.state]))
      .toEqual([[pasted.id, "accepted"]]);
    expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
  });
});

/**
 * F-1263 — Maestro A recebe handoff partial/blocked/failed (fica submitted) e
 * morre antes do ACK; o rebind só re-enfileirava status='success'. O Maestro B
 * lia o relatório, mas o ACK físico exigia tentativa aceita da sessão B:
 * "handoff is not awaiting consumption in this mission".
 */
const REBIND_MISSION_ID = "mission-f1263";
const SESSION_A = "session-f1263-maestro-a";
const SESSION_B = "session-f1263-maestro-b";

describe("F-1263: rebind re-enfileira entregas não-success aceitas pelo líder anterior", () => {
  let baseDir = "";
  let manager: ProjectRuntimeManager;
  let handoffs: ReturnType<typeof createScopedHandoffStore>;
  let missions: ReturnType<typeof createScopedMissionStore>;
  let registry: McpRegistry;
  let ctxA: ReturnType<typeof mintToken>;
  let ctxB: ReturnType<typeof mintToken>;
  let nextHandoffId = 0;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-f1263-rebind-"));
    manager = new ProjectRuntimeManager({ baseDir, appVersion: "f1263-test" });
    configureProjectDomainStoreRegistry(manager);
    configureAuditLogRuntime(manager);
    const scope = testProjectScope();
    missions = createScopedMissionStore(manager, scope, { idFactory: () => REBIND_MISSION_ID });
    missions.create({ title: "F-1263 rebind não-success", orchestratorSessionId: SESSION_A });
    missions.setStatus(REBIND_MISSION_ID, "running");
    handoffs = createScopedHandoffStore(manager, scope, {
      idFactory: () => `handoff-f1263-${++nextHandoffId}`,
    });
    resetGateForTests();
    const maestro = (sessionId: string, label: string) => {
      const ctx = mintToken({
        label,
        role: "orchestrator",
        providerId: "codex",
        missionId: REBIND_MISSION_ID,
        contextRevision: "context-f1263",
        scope,
        allowedTools: null,
      });
      bindTokenToSession(ctx.token, sessionId);
      return ctx;
    };
    ctxA = maestro(SESSION_A, "Maestro A");
    ctxB = maestro(SESSION_B, "Maestro B");
    const acknowledgeTool: McpToolDef = {
      name: "nexus_handoff_ack",
      description: "F-1263 ACK fixture (mesmo store do handler de produção)",
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
        const consumed = handoffs.markConsumedFromPhysicalAck(
          {
            handoffId: String(args.handoffId),
            missionId: toolCtx.missionId,
            orchestratorSessionId: toolCtx.sessionId,
          },
          receipt,
        );
        if (!consumed) throw new Error("handoff is not awaiting consumption");
        return { deliveryState: "consumed" };
      },
    };
    registry = { tools: [acknowledgeTool], serverName: "nexus-f1263", serverVersion: "1" };
  });

  afterEach(async () => {
    disposeAuditLogRuntime();
    await disposeProjectDomainStoreRegistry();
    resetGateForTests();
    manager?.closeAll();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const dispatchOptions: McpDispatchOptions = {
    resolveMissionForIntentGate: () => ({
      mission: missions.get(REBIND_MISSION_ID) as unknown as Mission,
      taskCount: 1,
      workerPaneCount: 1,
    }),
  };
  const ackAs = (ctx: ReturnType<typeof mintToken>, sessionId: string, handoffId: string) =>
    runInsidePtyStreamAgentTransport(sessionId, ctx, () =>
      dispatchToolCall("pty-stream", registry, "nexus_handoff_ack", { handoffId }, ctx, dispatchOptions),
    );
  const submitted = (status: "partial" | "blocked" | "failed") =>
    handoffs.submit({
      missionId: REBIND_MISSION_ID,
      sessionId: "session-f1263-worker",
      fromAgent: "worker",
      status,
      summary: "Entrega não-success que ficava presa no líder antigo.",
    });
  /** Maestro A recebe: reserva, cola e a borda busy aceita a tentativa dele. */
  const receiveByA = (handoffId: string) => {
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId,
      missionId: REBIND_MISSION_ID,
      orchestratorSessionId: SESSION_A,
      maxAttempts: 3,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId,
      acceptDeadlineAt: Date.now() + 12_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({ attemptId: attempt.id, handoffId }),
    ).toBe(true);
    return attempt;
  };

  it.each(["partial", "blocked", "failed"] as const)(
    "status %s: rebind re-enfileira e o ACK físico de B consome preservando a tentativa de A",
    async (status) => {
      const handoff = submitted(status);
      const attemptA = receiveByA(handoff.id);
      expect(handoffs.get(handoff.id)).toMatchObject({
        delivered: true,
        deliveryState: "submitted",
      });

      // A morre sem ACK; o Main rebinda a missão para B.
      expect(
        missions.rebindOrchestratorSession(REBIND_MISSION_ID, SESSION_B),
      ).not.toBeNull();
      expect(handoffs.get(handoff.id)).toMatchObject({
        delivered: false,
        deliveryState: "queued",
      });

      // B lê o relatório e dá o ACK físico válido: consumido na tentativa de B.
      await expect(ackAs(ctxB, SESSION_B, handoff.id)).resolves.toMatchObject({
        ok: true,
      });
      const attempts = handoffs.listDeliveryAttempts(handoff.id);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        id: attemptA.id,
        state: "accepted",
        orchestratorSessionId: SESSION_A,
      });
      expect(attempts[1]).toMatchObject({
        state: "accepted",
        orchestratorSessionId: SESSION_B,
      });
      expect(handoffs.get(handoff.id)).toMatchObject({
        deliveryState: "consumed",
        consumedBySession: SESSION_B,
      });
    },
  );

  it("entrega não-success já consumida por A NÃO é re-enfileirada pelo rebind", async () => {
    const handoff = submitted("partial");
    receiveByA(handoff.id);
    await expect(ackAs(ctxA, SESSION_A, handoff.id)).resolves.toMatchObject({
      ok: true,
    });
    expect(handoffs.get(handoff.id)).toMatchObject({ deliveryState: "consumed" });

    expect(
      missions.rebindOrchestratorSession(REBIND_MISSION_ID, SESSION_B),
    ).not.toBeNull();
    expect(handoffs.get(handoff.id)).toMatchObject({
      deliveryState: "consumed",
      consumedBySession: SESSION_A,
    });
  });
});
