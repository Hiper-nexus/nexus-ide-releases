import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O ACK também dispara a memória da entrega (F-703); o Jev é remoto, então
// aqui só importa o rótulo da revisão.
vi.mock("../memory/trusted-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../memory/trusted-memory")>()),
  retainAcknowledgedHandoffMemoryBestEffort: vi.fn(async () => null),
}));
import type { Mission } from "../../shared/orch-types";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from "../jarvis/audit-log";
import {
  configureJevDecisionLog,
  listJevDecisions,
} from "../jev/jev-decision-log";
import type { JevResult } from "../jev/jev-client";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import { bindTokenToSession, mintToken, resetGateForTests } from "./gate";
import {
  createScopedHandoffStore,
  setHandoffRouteAttributionResolver,
} from "./handoff-store";
import { runInsidePtyStreamAgentTransport } from "./http-mcp-boundary";
import {
  resetJevReviewBudgetsForTesting,
  reviewMissionHandoff,
  type JevReviewArtifact,
} from "./jev-handoff-review";
import { dispatchToolCall, type McpDispatchOptions } from "./mcp-dispatch";
import type { McpRegistry, McpToolDef } from "./mcp-protocol";
import { createScopedMissionStore } from "./mission-store";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
} from "./project-domain-store-registry";

/**
 * F-782 — ciclo real: revisão do Jev → handoff gravado → ACK físico do
 * Maestro (com ou sem `verdict:"rework"`) → rótulo Certo/Errado na linha
 * exata do diário. Antes, 0 rótulos em 760 decisões.
 */
const MISSION_ID = "mission-f782";
const WORKER_SESSION_ID = "session-f782-worker";
const ORCHESTRATOR_SESSION_ID = "session-f782-maestro";
const CONTEXT_REVISION = "context-f782";

function approvedMission(): Mission {
  return {
    id: MISSION_ID,
    title: "F-782 ACK rotula a revisão",
    description: "Ciclo do rótulo Certo/Errado",
    status: "running",
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: "Rotular a revisão do Jev pelo ACK do Maestro",
      acceptanceCriteria: ["O ACK grava o rótulo na decisão certa"],
      risk: "normal",
      executionMode: "assisted",
      contextPolicy: "on-demand",
      approvedAt: 1,
      intentVersion: 1,
      budgets: { planningTokens: 1_200, executionTokens: 8_000, maxWorkers: 1 },
    },
    orchestratorSessionId: ORCHESTRATOR_SESSION_ID,
    createdAt: 1,
    updatedAt: 1,
  };
}

function judgeResult(nouls: Record<string, number>): JevResult {
  const answers: JevResult["answers"] = {};
  for (const [id, noul] of Object.entries(nouls)) {
    answers[id] = { type: "noul", noul };
  }
  return { model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 1 } };
}

describe("F-782: ACK do Maestro → rótulo da revisão do Jev (store real)", () => {
  let baseDir = "";
  let logDir = "";
  let manager: ProjectRuntimeManager;
  let handoffs: ReturnType<typeof createScopedHandoffStore>;
  let registry: McpRegistry;
  let orchestratorCtx: ReturnType<typeof mintToken>;
  let nextHandoffId = 0;

  beforeEach(() => {
    resetJevReviewBudgetsForTesting();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-f782-ack-"));
    logDir = path.join(baseDir, "jev");
    configureJevDecisionLog(logDir);
    manager = new ProjectRuntimeManager({ baseDir, appVersion: "f782-ack-test" });
    configureProjectDomainStoreRegistry(manager);
    configureAuditLogRuntime(manager);
    const scope = testProjectScope();
    const missions = createScopedMissionStore(manager, scope, {
      idFactory: () => MISSION_ID,
    });
    const approved = approvedMission();
    missions.create({
      title: approved.title,
      intentVersion: approved.intentVersion,
      intentState: approved.intentState,
      intentContract: approved.intentContract,
    });
    missions.setStatus(MISSION_ID, "running");
    missions.setOrchestratorSession(MISSION_ID, ORCHESTRATOR_SESSION_ID);
    handoffs = createScopedHandoffStore(manager, scope, {
      idFactory: () => `handoff-f782-${++nextHandoffId}`,
    });
    resetGateForTests();
    orchestratorCtx = mintToken({
      label: "Maestro F-782",
      role: "orchestrator",
      providerId: "codex",
      missionId: MISSION_ID,
      contextRevision: CONTEXT_REVISION,
      scope,
      allowedTools: null,
    });
    bindTokenToSession(orchestratorCtx.token, ORCHESTRATOR_SESSION_ID);
    // Fixture fina do nexus_handoff_ack: repassa o veredito ao store real,
    // como o handler de produção (tools-handoff) faz.
    const acknowledgeTool: McpToolDef = {
      name: "nexus_handoff_ack",
      description: "F-782 ACK fixture",
      inputSchema: {
        type: "object",
        properties: { handoffId: { type: "string" }, verdict: { type: "string" } },
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
            ...(args.verdict === "rework" || args.verdict === "accepted"
              ? { verdict: args.verdict }
              : {}),
          },
          receipt,
        );
        if (!consumed) throw new Error("handoff is not awaiting consumption");
        return { deliveryState: "consumed" };
      },
    };
    registry = {
      tools: [acknowledgeTool],
      serverName: "nexus-f782",
      serverVersion: "1",
    };
  });

  afterEach(() => {
    setHandoffRouteAttributionResolver(null);
    configureJevDecisionLog(undefined);
    disposeAuditLogRuntime();
    disposeProjectDomainStoreRegistry();
    resetGateForTests();
    manager?.closeAll();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const dispatchOptions: McpDispatchOptions = {
    resolveMissionForIntentGate: () => ({
      mission: approvedMission(),
      taskCount: 1,
      workerPaneCount: 1,
    }),
  };

  const ack = (handoffId: string, verdict?: "accepted" | "rework") =>
    runInsidePtyStreamAgentTransport(ORCHESTRATOR_SESSION_ID, orchestratorCtx, () =>
      dispatchToolCall(
        "pty-stream",
        registry,
        "nexus_handoff_ack",
        { handoffId, ...(verdict ? { verdict } : {}) },
        orchestratorCtx,
        dispatchOptions,
      ),
    );

  async function reviewedHandoff(kind: "ok" | "weak", sessionId = WORKER_SESSION_ID) {
    const verdict = await reviewMissionHandoff(
      {
        sessionId,
        missionId: MISSION_ID,
        declaredStatus: "success",
        summary:
          kind === "ok"
            ? "Implementei o formulário de login. npm test (42 passando). Commit a1b2c3d."
            : "Revisão somente leitura: 1 MEDIUM, 2 LOW. Nenhum arquivo alterado.",
        declaredFiles: kind === "ok" ? ["src/login.ts"] : [],
        artifactKinds: [],
        evidenceIdsCount: 0,
        hasObservedCommit: false,
      },
      {
        judge: vi.fn(async () =>
          kind === "ok"
            ? judgeResult({ is_specific: 0.9, has_verification: 0.9, admits_incomplete: 0.1 })
            : judgeResult({
                is_specific: 0.9,
                has_verification: 0.2,
                admits_incomplete: 0.9,
                changed_code: 0.05,
                names_changes: 0.9,
              }),
        ) as never,
        enabled: () => true,
        hasKey: () => true,
      },
    );
    if (verdict.kind !== kind) throw new Error(`esperava ${kind}, veio ${verdict.kind}`);
    const artifact: JevReviewArtifact = verdict.artifact;
    const handoff = handoffs.submit({
      missionId: MISSION_ID,
      sessionId,
      fromAgent: "worker",
      status: "success",
      summary: kind === "ok" ? "Entrega com evidência." : "[evidência fraca] Entrega.",
      artifacts: [artifact],
    });
    return { handoff, decisionId: artifact.payload.decisionId };
  }

  const feedbackOf = (decisionId: string | undefined) =>
    listJevDecisions({ surface: "handoffReview", dir: logDir }).find(
      (entry) => entry.id === decisionId,
    )?.feedback;

  it("ACK sem veredito (aceito) rotula certo a revisão ok que liberou o handoff", async () => {
    const { handoff, decisionId } = await reviewedHandoff("ok");
    expect(feedbackOf(decisionId)).toBeUndefined();

    await expect(ack(handoff.id)).resolves.toMatchObject({ ok: true });

    expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
    expect(feedbackOf(decisionId)).toBe("right");
  });

  it('ACK com verdict:"rework" consome o handoff e rotula errado a revisão ok', async () => {
    const { handoff, decisionId } = await reviewedHandoff("ok");

    await expect(ack(handoff.id, "rework")).resolves.toMatchObject({ ok: true });

    expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
    expect(feedbackOf(decisionId)).toBe("wrong");
  });

  it("revisão fraca: devolvida é certo, aceita como veio é errado (limiar rígido)", async () => {
    const reworked = await reviewedHandoff("weak", "session-f782-fraca-1");
    await ack(reworked.handoff.id, "rework");
    expect(feedbackOf(reworked.decisionId)).toBe("right");

    const accepted = await reviewedHandoff("weak", "session-f782-fraca-2");
    await ack(accepted.handoff.id);
    expect(feedbackOf(accepted.decisionId)).toBe("wrong");
  });

  it("replay do mesmo ACK não regrava o rótulo", async () => {
    const { handoff, decisionId } = await reviewedHandoff("ok");
    await ack(handoff.id, "rework");
    expect(feedbackOf(decisionId)).toBe("wrong");

    manager.close(testProjectScope());
    await expect(ack(handoff.id, "accepted")).resolves.toMatchObject({ ok: true });
    expect(feedbackOf(decisionId)).toBe("wrong");
  });

  it("handoff sem revisão do Jev é consumido normalmente e não rotula nada", async () => {
    const handoff = handoffs.submit({
      missionId: MISSION_ID,
      sessionId: WORKER_SESSION_ID,
      fromAgent: "worker",
      status: "success",
      summary: "Entrega sem revisão (Jev desligado).",
    });
    await expect(ack(handoff.id, "rework")).resolves.toMatchObject({ ok: true });
    expect(handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
    expect(listJevDecisions({ dir: logDir })).toEqual([]);
  });

  it("F-773: o veredito do ACK fica no handoff e a devolução derruba a taxa da CLI", async () => {
    setHandoffRouteAttributionResolver((sessionId) =>
      sessionId.startsWith("session-f782-") ? { adapterId: "kimi", model: "kimi-code/k3" } : null,
    );
    const reworked = await reviewedHandoff("ok", "session-f782-taxa-1");
    const accepted = await reviewedHandoff("ok", "session-f782-taxa-2");
    expect(handoffs.routeOutcomeCountsSince(0)).toEqual([
      { adapterId: "kimi", model: "kimi-code/k3", successes: 2, total: 2 },
    ]);

    await ack(reworked.handoff.id, "rework");
    await ack(accepted.handoff.id);

    const verdicts = manager
      .open(testProjectScope())
      .db.prepare(`SELECT id, ack_verdict FROM handoffs ORDER BY rowid`)
      .all();
    expect(verdicts).toEqual([
      { id: reworked.handoff.id, ack_verdict: "rework" },
      { id: accepted.handoff.id, ack_verdict: "accepted" },
    ]);
    // O worker disse success nas duas; o Maestro devolveu uma: 1 de 2.
    expect(handoffs.routeOutcomeCountsSince(0)).toEqual([
      { adapterId: "kimi", model: "kimi-code/k3", successes: 1, total: 2 },
    ]);
  });
});
