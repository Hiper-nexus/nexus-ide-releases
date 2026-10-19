import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { INITIAL_PROJECT_MIGRATIONS } from "../runtime/project-runtime-schema";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  createWorkflowState,
  type EvidenceBinding,
} from "../context/prevc-engine";
import { ReviewCouncil } from "../context/review-council";
import type { TrustedEvidence } from "../context/sensor-broker";
import { testProjectScope } from "./__tests__/scope-fixture";
import { createScopedHandoffStore } from "./handoff-store";
import { createScopedMissionStore } from "./mission-store";
import { attachToExistingHandoff } from "./handoff-attachments";

let baseDir = "";
const managers: ProjectRuntimeManager[] = [];

function manager(
  migrations = INITIAL_PROJECT_MIGRATIONS,
): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: "0.12.0-test",
    migrations,
  });
  managers.push(value);
  return value;
}

const CONTRACT_HASH = "c".repeat(64);
const CONTEXT_REVISION = "d".repeat(64);
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const DIFF_HASH = "e".repeat(64);

function binding(
  scope: ProjectExecutionScope,
  missionId: string,
  overrides: Partial<EvidenceBinding> = {},
): EvidenceBinding {
  return {
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    missionId,
    contractHash: CONTRACT_HASH,
    contextHash: CONTEXT_REVISION,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    diffHash: DIFF_HASH,
    ...overrides,
  };
}

function seedWorkflowAndEvidence(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  missionId: string,
  evidenceId = "evidence-a",
  bindingOverrides: Partial<EvidenceBinding> = {},
  overrides: Partial<TrustedEvidence> = {},
): EvidenceBinding {
  const currentBinding = binding(scope, missionId, bindingOverrides);
  const workflow = createWorkflowState("low", currentBinding);
  const db = runtimeManager.open(scope).db;
  db.prepare(
    `INSERT INTO mission_contracts
       (mission_id, revision, contract_hash, context_revision, contract_json,
        author_id, author_session_id, author_provider, frozen_at)
     VALUES (?, 1, ?, ?, '{}', 'author', 'author-session', 'codex', 1)`,
  ).run(missionId, currentBinding.contractHash, currentBinding.contextHash);
  db.prepare(
    `INSERT INTO workflow_states
       (mission_id, revision, stage, workflow_json, updated_at)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(missionId, workflow.revision, workflow.stage, JSON.stringify(workflow));
  const evidence: TrustedEvidence = {
    id: evidenceId,
    producer: "nexus",
    ...currentBinding,
    contextHash: currentBinding.contextHash,
    sensorId: "unit",
    sensorConfigHash: "f".repeat(64),
    command: ["npm", "test"],
    exitCode: 0,
    stdoutHash: "1".repeat(64),
    stderrHash: "2".repeat(64),
    timedOut: false,
    truncated: false,
    startedAt: "2026-07-10T00:00:00.000Z",
    finishedAt: "2026-07-10T00:00:01.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO sensor_evidence
       (id, mission_id, sensor_id, head_sha, diff_hash, passed,
        evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evidence.id,
    evidence.missionId,
    evidence.sensorId,
    evidence.headSha,
    evidence.diffHash,
    evidence.exitCode === 0 && !evidence.timedOut ? 1 : 0,
    JSON.stringify(evidence),
    Date.parse(evidence.finishedAt),
  );
  return currentBinding;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handoff-store-"));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("scoped handoff store", () => {
  it("cannot mint MCP provenance from a direct store call or raw payload", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let nextId = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-mcp",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => Date.now() + 10_000,
      idFactory: () => `handoff-${++nextId}`,
    });
    missions.create({ title: "MCP provenance" });

    const direct = handoffs.submit({
      missionId: "mission-mcp",
      sessionId: "session-direct",
      workerIncarnationId: "incarnation-direct",
      status: "success",
      summary: "Direct main-process delivery metadata has no MCP receipt.",
    });
    expect(direct.mcpProvenance).toBeUndefined();

    expect(() =>
      handoffs.submit({
        missionId: "mission-mcp",
        sessionId: "session-forged",
        status: "success",
        summary: "A payload cannot select its own MCP provenance.",
        mcpProvenance: {
          receiptId: "forged",
        },
      } as never),
    ).toThrow();

    expect(() =>
      handoffs.submitFromPhysicalAgentBoundary(
        {
          missionId: "mission-mcp",
          sessionId: "session-worker",
          workerIncarnationId: "incarnation-worker",
          fromAgent: "worker",
          status: "success",
          summary: "A direct store call cannot claim an HTTP MCP receipt.",
        },
        Object.freeze({}) as never,
        {
          worktreeHeadSha: "e".repeat(40),
          rawPayloadSha256: "f".repeat(64),
        },
      ),
    ).toThrow(/invalid, stale or out-of-scope/i);

    const db = runtimeManager.open(scope).db;
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM handoff_mcp_receipts")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(handoffs.list({ includeDelivered: true })).toHaveLength(1);
  });

  it("persists unverified delivery metadata without satisfying the trusted stop receipt", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-a",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => 55,
      idFactory: () => "handoff-a",
    });
    missions.create({ title: "Mission A" });

    const submitted = handoffs.submit({
      missionId: "mission-a",
      sessionId: "session-a",
      workerIncarnationId: "worker-incarnation-a",
      fromAgent: "reviewer",
      status: "success",
      summary: "Reviewed the complete implementation.",
      artifacts: [{ path: "src/a.ts" }],
    });

    expect(submitted).toMatchObject({
      id: "handoff-a",
      delivered: false,
      deliveryState: "queued",
      claimTrust: "untrusted",
      evidenceTrust: "unverified",
      evidenceIds: [],
      workerIncarnationId: "worker-incarnation-a",
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    });
    submitted.artifacts.push("outside mutation");
    expect(handoffs.hasTrustedFromSession("session-a")).toBe(false);
    expect(
      handoffs.hasTrustedFromSession("session-a", "worker-incarnation-stale"),
    ).toBe(false);
    expect(handoffs.list()).toHaveLength(1);
    expect(handoffs.list()[0].artifacts).toEqual([{ path: "src/a.ts" }]);
    expect(handoffs.markDelivered("handoff-a")).toBe(true);
    expect(handoffs.markDelivered("handoff-a")).toBe(false);
    expect(handoffs.list()).toEqual([]);
    expect(handoffs.list({ includeDelivered: true })[0]).toMatchObject({
      delivered: true,
      deliveryState: "submitted",
      submittedAt: 55,
    });
    expect(handoffs.acknowledgeMission("mission-a")).toBe(1);
    expect(handoffs.list({ includeDelivered: true })[0].deliveryState).toBe(
      "acknowledged",
    );
    expect(handoffs.markConsumed("handoff-a", "mission-a")).toBe(true);
    expect(handoffs.markConsumed("handoff-a", "mission-a")).toBe(false);
    expect(handoffs.list({ includeDelivered: true })[0].deliveryState).toBe(
      "consumed",
    );

    runtimeManager.close(scope);
    expect(
      createScopedHandoffStore(runtimeManager, scope).list({
        missionId: "mission-a",
        includeDelivered: true,
      }),
    ).toHaveLength(1);
  });

  it("replaces only the matching pending background regression artifact", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      idFactory: () => "handoff-regression-background",
    });
    const handoff = handoffs.submit({
      status: "success",
      summary: "Entrega persistida enquanto a verificação de regressão termina.",
      artifacts: [{
        kind: "nexus.regressionGate",
        payload: { status: "running", runId: "gate-1" },
      }],
    });

    expect(handoffs.replaceBackgroundRegressionArtifact(handoff.id, "other", {
      kind: "nexus.regressionGate", payload: { status: "passed", runId: "other" },
    })).toBe(false);
    expect(handoffs.replaceBackgroundRegressionArtifact(handoff.id, "gate-1", {
      kind: "nexus.regressionGate", payload: { status: "passed", runId: "gate-1", testsRun: ["src/a.test.ts"] },
    })).toBe(true);
    expect(handoffs.list({ includeDelivered: true })[0]?.artifacts).toEqual([
      { kind: "nexus.regressionGate", payload: { status: "passed", runId: "gate-1", testsRun: ["src/a.test.ts"] } },
    ]);
    expect(handoffs.replaceBackgroundRegressionArtifact(handoff.id, "gate-1", {
      kind: "nexus.regressionGate", payload: { status: "failed", runId: "gate-1" },
    })).toBe(false);
  });

  it("list-ack does not steal queued handoffs from idle-delivery", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-list-ack",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      idFactory: (prefix) => `${prefix}-list-ack`,
    });
    missions.create({ title: "List ack" });
    const queued = handoffs.submit({
      missionId: "mission-list-ack",
      sessionId: "worker-session",
      fromAgent: "worker",
      status: "success",
      summary: "2x2 = 4",
    });
    expect(queued.deliveryState).toBe("queued");
    expect(handoffs.acknowledgeSeenByOrchestratorList("mission-list-ack")).toBe(
      0,
    );
    expect(handoffs.get(queued.id)?.deliveryState).toBe("queued");

    expect(handoffs.markDelivered(queued.id)).toBe(true);
    expect(handoffs.get(queued.id)?.deliveryState).toBe("submitted");
    expect(handoffs.acknowledgeSeenByOrchestratorList("mission-list-ack")).toBe(
      1,
    );
    expect(handoffs.get(queued.id)?.deliveryState).toBe("acknowledged");
  });


  it("F-1049: acknowledges selected submitted ids within the mission only", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => `mission-${++id}`,
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      idFactory: () => `handoff-${++id}`,
    });
    const own = missions.create({ title: "Own" });
    const other = missions.create({ title: "Other" });
    const seed = (missionId: string) => handoffs.submit({
      missionId, sessionId: "worker", fromAgent: "worker", status: "success", summary: "Result",
    });
    const selected = seed(own.id);
    const unseen = seed(own.id);
    const queued = seed(own.id);
    const foreign = seed(other.id);
    for (const row of [selected, unseen, foreign]) handoffs.markDelivered(row.id);
    expect(handoffs.acknowledgeSeenByOrchestratorList(own.id, [])).toBe(0);
    expect(handoffs.get(selected.id)?.deliveryState).toBe("submitted");
    expect(handoffs.acknowledgeSeenByOrchestratorList(
      own.id, [selected.id, selected.id, queued.id, foreign.id, "missing"],
    )).toBe(1);
    expect(handoffs.get(selected.id)?.deliveryState).toBe("acknowledged");
    expect(handoffs.get(unseen.id)?.deliveryState).toBe("submitted");
    expect(handoffs.get(queued.id)?.deliveryState).toBe("queued");
    expect(handoffs.get(foreign.id)?.deliveryState).toBe("submitted");
    expect(handoffs.acknowledgeSeenByOrchestratorList(own.id, [selected.id])).toBe(0);
    // Existing callers without ids retain whole-mission acknowledgement.
    expect(handoffs.acknowledgeSeenByOrchestratorList(own.id)).toBe(1);
    expect(handoffs.get(unseen.id)?.deliveryState).toBe("acknowledged");
    expect(handoffs.get(foreign.id)?.deliveryState).toBe("submitted");
  });

  it("F-1049: validates every selected id before any write", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, { idFactory: () => "mission-validation" });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, { idFactory: () => "handoff-valid" });
    missions.create({ title: "Validation" });
    const row = handoffs.submit({
      missionId: "mission-validation", sessionId: "worker", fromAgent: "worker", status: "success", summary: "Result",
    });
    handoffs.markDelivered(row.id);
    expect(() => handoffs.acknowledgeSeenByOrchestratorList(
      "mission-validation", [row.id, "invalid'id"],
    )).toThrow();
    expect(handoffs.get(row.id)?.deliveryState).toBe("submitted");
  });

  it("F-1049: selected lists larger than a SQLite bind chunk remain complete", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, { idFactory: () => "mission-many" });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, { idFactory: () => `handoff-${++id}` });
    missions.create({ title: "Many" });
    const rows = Array.from({ length: 1_001 }, () => {
      const row = handoffs.submit({
        missionId: "mission-many", sessionId: "worker", fromAgent: "worker", status: "success", summary: "Result",
      });
      handoffs.markDelivered(row.id);
      return row;
    });
    const unseen = rows.pop()!;
    expect(handoffs.acknowledgeSeenByOrchestratorList("mission-many", rows.map((row) => row.id))).toBe(1_000);
    expect(handoffs.get(rows[0]!.id)?.deliveryState).toBe("acknowledged");
    expect(handoffs.get(rows[999]!.id)?.deliveryState).toBe("acknowledged");
    expect(handoffs.get(unseen.id)?.deliveryState).toBe("submitted");
  });

  it("list-ack with ids leaves submitted rows the caller did not receive", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-list-page",
    });
    let seq = 0;
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      idFactory: () => `handoff-page-${++seq}`,
    });
    missions.create({ title: "Paged ack" });
    const seen = handoffs.submit({
      missionId: "mission-list-page",
      sessionId: "worker-session",
      fromAgent: "worker",
      status: "success",
      summary: "primeira página",
    });
    const unseen = handoffs.submit({
      missionId: "mission-list-page",
      sessionId: "worker-session",
      fromAgent: "worker",
      status: "success",
      summary: "fora da página",
    });
    expect(handoffs.markDelivered(seen.id)).toBe(true);
    expect(handoffs.markDelivered(unseen.id)).toBe(true);
    expect(
      handoffs.acknowledgeSeenByOrchestratorList("mission-list-page", [seen.id]),
    ).toBe(1);
    expect(handoffs.get(seen.id)?.deliveryState).toBe("acknowledged");
    expect(handoffs.get(unseen.id)?.deliveryState).toBe("submitted");
    expect(
      handoffs.acknowledgeSeenByOrchestratorList("mission-list-page", []),
    ).toBe(0);
    expect(handoffs.get(unseen.id)?.deliveryState).toBe("submitted");
  });

  it("F-1065: queued session exclusion is mission-scoped and retains unknown senders", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let sequence = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, { idFactory: () => `mission-${++sequence}` });
    const own = missions.create({ title: "Own" });
    const other = missions.create({ title: "Other" });
    const handoffs = createScopedHandoffStore(runtimeManager, scope);
    const maestro = handoffs.submit({ missionId: own.id, sessionId: "maestro-session", fromAgent: "Maestro", status: "success", summary: "Own" });
    const unknown = handoffs.submit({ missionId: own.id, fromAgent: "Worker", status: "success", summary: "Unknown sender" });
    const foreign = handoffs.submit({ missionId: other.id, sessionId: "worker-session", fromAgent: "Worker", status: "success", summary: "Other" });
    expect(handoffs.listQueuedDeliveries(own.id, { excludeSessionId: "maestro-session" }))
      .toEqual([{ id: unknown.id, missionId: own.id, sessionId: null }]);
    expect(handoffs.listQueuedDeliveries(own.id).map((row) => row.id)).toContain(maestro.id);
    expect(handoffs.listQueuedDeliveries(other.id).map((row) => row.id)).toEqual([foreign.id]);
    expect(() => handoffs.listQueuedDeliveries(own.id, { excludeSessionId: "invalid'id" })).toThrow();
  });

  it("persists bounded delivery attempts and accepts the exact attempt atomically", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let now = 100;
    let id = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-delivery",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    missions.create({
      title: "Delivery",
      orchestratorSessionId: "orchestrator-session",
    });
    const handoff = handoffs.submit({
      missionId: "mission-delivery",
      sessionId: "worker-session",
      fromAgent: "worker",
      status: "success",
      summary: "Entrega durável para o orquestrador.",
    });

    expect(() =>
      handoffs.reserveDeliveryAttempt({
        handoffId: handoff.id,
        missionId: "mission-delivery",
        orchestratorSessionId: "orchestrator-session-stale",
        maxAttempts: 2,
      }),
    ).toThrow(/orchestrator session is stale/i);

    const first = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: "mission-delivery",
      orchestratorSessionId: "orchestrator-session",
      maxAttempts: 2,
    });
    expect(first).toMatchObject({ attemptNo: 1, state: "reserved" });
    now = 120;
    missions.setOrchestratorSession(
      "mission-delivery",
      "orchestrator-session-rebound",
    );
    expect(() =>
      handoffs.markDeliveryAttemptPasted({
        attemptId: first.id,
        handoffId: handoff.id,
        acceptDeadlineAt: 1_120,
      }),
    ).toThrow(/lost CAS/i);
    missions.setOrchestratorSession("mission-delivery", "orchestrator-session");
    const pasted = handoffs.markDeliveryAttemptPasted({
      attemptId: first.id,
      handoffId: handoff.id,
      acceptDeadlineAt: 1_120,
    });
    expect(pasted.state).toBe("pasted");
    now = 130;
    handoffs.failDeliveryAttempt({
      attemptId: first.id,
      handoffId: handoff.id,
      failureCode: "accept_timeout",
    });

    runtimeManager.close(scope);
    const reopened = createScopedHandoffStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const second = reopened.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: "mission-delivery",
      orchestratorSessionId: "orchestrator-session",
      maxAttempts: 2,
    });
    expect(second).toMatchObject({ attemptNo: 2, state: "reserved" });
    reopened.markDeliveryAttemptPasted({
      attemptId: second.id,
      handoffId: handoff.id,
      acceptDeadlineAt: 2_000,
    });
    now = 150;
    missions.setOrchestratorSession(
      "mission-delivery",
      "orchestrator-session-rebound",
    );
    expect(
      reopened.acceptDeliveryAttempt({
        attemptId: second.id,
        handoffId: handoff.id,
      }),
    ).toBe(false);
    expect(reopened.listDeliveryAttempts(handoff.id)[1]).toMatchObject({
      attemptNo: 2,
      state: "pasted",
    });
    missions.setOrchestratorSession("mission-delivery", "orchestrator-session");
    expect(
      reopened.acceptDeliveryAttempt({
        attemptId: second.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    expect(reopened.get(handoff.id)).toMatchObject({
      delivered: true,
      deliveryState: "submitted",
      submittedAt: 150,
    });
    expect(reopened.listDeliveryAttempts(handoff.id)).toMatchObject([
      { attemptNo: 1, state: "failed", failureCode: "accept_timeout" },
      { attemptNo: 2, state: "accepted", acceptedAt: 150 },
    ]);

    const rebound = missions.rebindOrchestratorSession(
      "mission-delivery",
      "orchestrator-session-rebound",
    );
    expect(rebound).toMatchObject({
      orchestratorSessionId: "orchestrator-session-rebound",
    });
    expect(rebound?.status).not.toBe("blocked");
    const repeated = missions.rebindOrchestratorSession(
      "mission-delivery",
      "orchestrator-session-rebound",
    );
    expect(repeated?.status).not.toBe("blocked");
    expect(reopened.listDeliveryAttempts(handoff.id)).toHaveLength(2);
    expect(reopened.get(handoff.id)).toMatchObject({
      delivered: false,
      deliveryState: "queued",
    });
    const third = reopened.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: "mission-delivery",
      orchestratorSessionId: "orchestrator-session-rebound",
      maxAttempts: 2,
    });
    expect(third).toMatchObject({
      attemptNo: 3,
      orchestratorSessionId: "orchestrator-session-rebound",
      state: "reserved",
    });
  });

  it("F-925: falhas contra o MESMO Maestro vivo liberam o orçamento sem apagar a auditoria", () => {
    // Campo 05/10: Maestro ocioso no prompt (modal de TUI) recusou 3 pastes
    // por accept_timeout e o orçamento durável por sessão virou wedge
    // terminal — 119 min parado, workers mortos, operador teve de intervir.
    const runtimeManager = manager();
    const scope = testProjectScope();
    let now = 100;
    let id = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-release",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    missions.create({
      title: "Release",
      orchestratorSessionId: "orchestrator-session",
    });
    const handoff = handoffs.submit({
      missionId: "mission-release",
      sessionId: "worker-session",
      fromAgent: "worker",
      status: "success",
      summary: "Entrega que nunca chegava ao Maestro idle.",
    });
    const reserve = () =>
      handoffs.reserveDeliveryAttempt({
        handoffId: handoff.id,
        missionId: "mission-release",
        orchestratorSessionId: "orchestrator-session",
        maxAttempts: 2,
      });
    const fail = (attemptId: string) =>
      handoffs.failDeliveryAttempt({
        attemptId,
        handoffId: handoff.id,
        failureCode: "accept_timeout",
      });

    fail(reserve().id);
    fail(reserve().id);
    expect(() => reserve()).toThrow(/budget exhausted/i);
    // Sem release, queued para sempre — exatamente o wedge do incidente.
    expect(handoffs.get(handoff.id)).toMatchObject({
      delivered: false,
      deliveryState: "queued",
    });

    expect(
      handoffs.releaseFailedDeliveryAttempts({
        handoffId: handoff.id,
        orchestratorSessionId: "orchestrator-session",
      }),
    ).toBe(2);
    const third = reserve();
    expect(third).toMatchObject({ attemptNo: 3, state: "reserved" });

    // A causa original continua auditável sob o marcador de liberação.
    expect(handoffs.listDeliveryAttempts(handoff.id)).toMatchObject([
      { attemptNo: 1, state: "failed", failureCode: "released:accept_timeout" },
      { attemptNo: 2, state: "failed", failureCode: "released:accept_timeout" },
      { attemptNo: 3, state: "reserved" },
    ]);
    // Idempotente e com escopo da sessão: nada mais a liberar.
    expect(
      handoffs.releaseFailedDeliveryAttempts({
        handoffId: handoff.id,
        orchestratorSessionId: "orchestrator-session",
      }),
    ).toBe(0);
    expect(
      handoffs.releaseFailedDeliveryAttempts({
        handoffId: handoff.id,
        orchestratorSessionId: "orchestrator-session-outro",
      }),
    ).toBe(0);
  });

  it("rebind NUNCA bloqueia a missão por projeção de entrega inconsistente — re-enfileira para a nova sessão (doutrina Overclock)", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let now = 100;
    let id = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-rebind-hold",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    missions.create({
      title: "Rebind honesto",
      orchestratorSessionId: "orchestrator-session",
    });
    const handoff = handoffs.submit({
      missionId: "mission-rebind-hold",
      sessionId: "worker-session",
      fromAgent: "worker",
      status: "success",
      summary: "Entrega aceita pela sessão antiga.",
    });
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: "mission-rebind-hold",
      orchestratorSessionId: "orchestrator-session",
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: now + 2_000,
    });
    now = 150;
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);

    // Corrupção do estado de transporte que o branch antigo tratava como
    // bloqueio de missão: delivered=1 com submitted_at NULL (escrita parcial
    // de crash/timeout legacy — o CHECK do schema impede estados fora do
    // conjunto, mas não impede o par inconsistente).
    const db = runtimeManager.open(scope).db;
    db.prepare(
      `UPDATE handoffs SET submitted_at = NULL WHERE id = ?`,
    ).run(handoff.id);

    const rebound = missions.rebindOrchestratorSession(
      "mission-rebind-hold",
      "orchestrator-session-rebound",
    );
    expect(rebound?.status).not.toBe("blocked");
    expect(rebound?.description).not.toMatch(/NEXUS_HANDOFF_REBIND_BLOCKED/);
    expect(handoffs.get(handoff.id)).toMatchObject({
      delivered: false,
      deliveryState: "queued",
    });
  });

  it("binds explicit consumption to the exact accepted delivery and current orchestrator", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let now = 100;
    let id = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-consumption",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    missions.create({
      title: "Consumption",
      orchestratorSessionId: "orchestrator-current",
    });
    const handoff = handoffs.submit({
      missionId: "mission-consumption",
      sessionId: "worker-session",
      fromAgent: "worker",
      status: "success",
      summary: "Resultado que precisa ser consumido explicitamente.",
    });

    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        handoff.id,
        "mission-consumption",
        "orchestrator-current",
      ),
    ).toBe(false);

    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: "mission-consumption",
      orchestratorSessionId: "orchestrator-current",
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: 1_000,
    });
    now = 120;
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        handoff.id,
        "mission-consumption",
        "orchestrator-stale",
      ),
    ).toBe(false);
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        handoff.id,
        "mission-consumption",
        "orchestrator-current",
      ),
    ).toBe(true);
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        handoff.id,
        "mission-consumption",
        "orchestrator-current",
      ),
    ).toBe(true);
    expect(handoffs.get(handoff.id)).toMatchObject({
      delivered: true,
      deliveryState: "consumed",
      consumedAt: 120,
      consumedBySession: "orchestrator-current",
      consumedDeliveryAttemptId: attempt.id,
    });
    expect(
      runtimeManager
        .open(scope)
        .db.prepare(
          `SELECT consumed_by_session, consumed_delivery_attempt_id
           FROM handoffs WHERE id = ?`,
        )
        .get(handoff.id),
    ).toEqual({
      consumed_by_session: "orchestrator-current",
      consumed_delivery_attempt_id: attempt.id,
    });
  });

  it("accepts only persisted Nexus evidence bound to the current mission revision and diff", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-a",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      idFactory: () => "handoff-trusted",
    });
    missions.create({ title: "Mission A" });
    const expectedBinding = seedWorkflowAndEvidence(
      runtimeManager,
      scope,
      "mission-a",
    );
    const review = new ReviewCouncil("low", expectedBinding).submit({
      reviewId: "review-a",
      reviewerId: "reviewer-a",
      reviewerSessionId: "reviewer-session",
      reviewerProvider: "claude",
      authorId: "author-a",
      authorSessionId: "author-session",
      authorProvider: "codex",
      binding: expectedBinding,
      findings: [],
    });
    runtimeManager
      .open(scope)
      .db.prepare(
        `INSERT INTO review_reports
         (review_id, mission_id, diff_hash, report_json, created_at)
       VALUES (?, ?, ?, ?, 2)`,
      )
      .run(
        review.reviewId,
        expectedBinding.missionId,
        expectedBinding.diffHash,
        JSON.stringify(review),
      );

    const submitted = handoffs.submit({
      missionId: "mission-a",
      sessionId: "session-a",
      fromAgent: "worker-a",
      status: "success",
      summary: "Worker reports that implementation is complete.",
      evidenceIds: ["evidence-a", "review:review-a"],
    });

    expect(submitted).toMatchObject({
      claimTrust: "untrusted",
      evidenceTrust: "nexus-trusted",
      evidenceIds: ["evidence-a", "review:review-a"],
      evidenceBinding: {
        missionId: "mission-a",
        contextRevision: expectedBinding.contextHash,
        contractHash: expectedBinding.contractHash,
        baseSha: expectedBinding.baseSha,
        headSha: expectedBinding.headSha,
        diffHash: expectedBinding.diffHash,
        workflowRevision: 1,
      },
    });
    expect(handoffs.hasTrustedFromSession("session-a")).toBe(true);
  });

  it("invalidates previously trusted evidence when the workflow diff changes", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-a",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      idFactory: () => "handoff-trusted",
    });
    missions.create({ title: "Mission A" });
    seedWorkflowAndEvidence(runtimeManager, scope, "mission-a");
    handoffs.submit({
      missionId: "mission-a",
      sessionId: "session-a",
      status: "success",
      summary: "Worker reports that implementation is complete.",
      evidenceIds: ["evidence-a"],
    });
    const changedWorkflow = createWorkflowState(
      "low",
      binding(scope, "mission-a", { diffHash: "9".repeat(64) }),
    );
    runtimeManager
      .open(scope)
      .db.prepare(
        `UPDATE workflow_states
       SET revision = ?, stage = ?, workflow_json = ?, updated_at = 2
       WHERE mission_id = 'mission-a'`,
      )
      .run(
        changedWorkflow.revision,
        changedWorkflow.stage,
        JSON.stringify(changedWorkflow),
      );

    expect(handoffs.get("handoff-trusted")).toMatchObject({
      evidenceTrust: "stale",
      claimTrust: "untrusted",
    });
    expect(handoffs.hasTrustedFromSession("session-a")).toBe(false);
  });

  it("keeps missing, cross-mission and stale evidence IDs as unverified claims", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const handoffs = createScopedHandoffStore(runtimeManager, scope);
    const missionA = missions.create({ title: "Mission A" });
    const missionB = missions.create({ title: "Mission B" });
    seedWorkflowAndEvidence(runtimeManager, scope, missionA.id, "evidence-a");
    seedWorkflowAndEvidence(runtimeManager, scope, missionB.id, "evidence-b", {
      contractHash: "8".repeat(64),
    });
    const db = runtimeManager.open(scope).db;
    const stale = JSON.parse(
      (
        db
          .prepare("SELECT evidence_json FROM sensor_evidence WHERE id = ?")
          .get("evidence-a") as { evidence_json: string }
      ).evidence_json,
    ) as TrustedEvidence;
    db.prepare(
      `INSERT INTO sensor_evidence
         (id, mission_id, sensor_id, head_sha, diff_hash, passed,
          evidence_json, created_at)
       VALUES ('evidence-stale', ?, 'unit', ?, ?, 1, ?, 3)`,
    ).run(
      missionA.id,
      stale.headSha,
      "9".repeat(64),
      JSON.stringify({
        ...stale,
        id: "evidence-stale",
        diffHash: "9".repeat(64),
      }),
    );
    db.prepare(
      `INSERT INTO sensor_evidence
         (id, mission_id, sensor_id, head_sha, diff_hash, passed,
          evidence_json, created_at)
       VALUES ('evidence-old-context', ?, 'unit', ?, ?, 1, ?, 4)`,
    ).run(
      missionA.id,
      stale.headSha,
      stale.diffHash,
      JSON.stringify({
        ...stale,
        id: "evidence-old-context",
        contextHash: "7".repeat(64),
      }),
    );

    const submit = (evidenceIds: string[]) =>
      handoffs.submit({
        missionId: missionA.id,
        sessionId: "session-a",
        status: "success",
        summary: "Worker reports that implementation is complete.",
        evidenceIds,
      });

    for (const ids of [
      ["missing-evidence"],
      ["evidence-b"],
      ["evidence-stale"],
      ["evidence-old-context"],
      ["evidence-a", "browser-capture-1"],
    ]) {
      const handoff = submit(ids);
      expect(handoff).toMatchObject({
        evidenceIds: ids,
        evidenceTrust: "unverified",
        evidenceBinding: undefined,
      });
      expect(handoffs.get(handoff.id)).toMatchObject({
        evidenceIds: ids,
        evidenceTrust: "unverified",
      });
    }
    expect(submit(["evidence-a"]).evidenceTrust).toBe("nexus-trusted");
    expect(
      handoffs
        .list({ includeDelivered: true })
        .filter((handoff) => handoff.evidenceTrust === "unverified"),
    ).toHaveLength(5);
  });

  it("keeps evidence IDs as unverified without missionId or a frozen workflow", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const handoffs = createScopedHandoffStore(runtimeManager, scope);
    const viaRapida = missions.create({ title: "Via Rapida" });

    const loose = handoffs.submit({
      status: "success",
      summary: "Workspace helper cites its browser capture IDs.",
      evidenceIds: ["capture-1"],
    });
    const unfrozen = handoffs.submit({
      missionId: viaRapida.id,
      sessionId: "session-a",
      status: "success",
      summary: "Worker cites capture IDs in a mission without PREVC.",
      evidenceIds: ["capture-2", "capture-3"],
    });

    for (const [handoff, ids] of [
      [loose, ["capture-1"]],
      [unfrozen, ["capture-2", "capture-3"]],
    ] as const) {
      expect(handoffs.get(handoff.id)).toMatchObject({
        evidenceIds: ids,
        evidenceTrust: "unverified",
        evidenceBinding: undefined,
      });
    }
    expect(handoffs.hasTrustedFromSession("session-a")).toBe(false);
  });

  it("migrates legacy handoffs as unverified and makes evidence bindings immutable", () => {
    const scope = testProjectScope();
    // Pre-008 schema (no trusted evidence columns, no learnings). Insert mission
    // via raw SQL so the modern ScopedMissionStore (which expects learnings) is
    // not used against the legacy shape.
    const legacyManager = manager(INITIAL_PROJECT_MIGRATIONS.slice(0, 7));
    const legacyDb = legacyManager.open(scope).db;
    legacyDb
      .prepare(
        `INSERT INTO missions
           (id, title, description, status, milestones_json, created_at, updated_at)
         VALUES ('mission-a', 'Mission A', '', 'pending', '[]', 1, 1)`,
      )
      .run();
    legacyDb
      .prepare(
        `INSERT INTO handoffs
           (id, mission_id, session_id, status, summary, artifacts_json,
            delivered, created_at)
         VALUES ('legacy-handoff', 'mission-a', 'legacy-session', 'success',
                 'legacy report', '[]', 0, 1)`,
      )
      .run();
    legacyManager.closeAll();

    const upgradedManager = manager();
    const handoffs = createScopedHandoffStore(upgradedManager, scope);
    expect(handoffs.list({ includeDelivered: true })[0]).toMatchObject({
      id: "legacy-handoff",
      claimTrust: "untrusted",
      evidenceTrust: "unverified",
      evidenceIds: [],
    });
    expect(handoffs.hasTrustedFromSession("legacy-session")).toBe(false);

    const db = upgradedManager.open(scope).db;
    expect(() =>
      db
        .prepare(
          "UPDATE handoffs SET diff_hash = ? WHERE id = 'legacy-handoff'",
        )
        .run("f".repeat(64)),
    ).toThrow(/immutable/i);
  });

  it("isolates handoffs and observers by checkout", () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: "checkout-a" });
    const scopeB = testProjectScope({ checkoutId: "checkout-b" });
    const storeA = createScopedHandoffStore(runtimeManager, scopeA);
    const storeB = createScopedHandoffStore(runtimeManager, scopeB);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    storeA.onChange(listenerA);
    storeB.onChange(listenerB);

    storeA.submit({ status: "partial", summary: "Only checkout A changed." });

    expect(storeA.list()).toHaveLength(1);
    expect(storeB.list()).toEqual([]);
    expect(listenerA).toHaveBeenCalledWith({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
    });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it("SUCCESS sem receipt físico não consome diagnóstico do watchdog", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let nextId = 0;
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-ghost",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => Date.now() + 10_000,
      idFactory: () => `handoff-${++nextId}`,
    });
    missions.create({ title: "Fantasma do watchdog" });

    // Watchdog sintetiza FAILED (queued) para o worker que "travou no MCP".
    const ghost = handoffs.submit({
      missionId: "mission-ghost",
      sessionId: "session-codex",
      status: "failed",
      fromAgent: "nexus-watchdog",
      summary:
        'watchdog: o worker "Implementar interface" travou no bootstrap de MCP.',
    });
    expect(ghost.deliveryState).toBe("queued");

    // Apenas rotular um submit genérico como SUCCESS não prova resposta física.
    handoffs.submit({
      missionId: "mission-ghost",
      sessionId: "session-codex",
      status: "success",
      fromAgent: "Implementar interface",
      summary: "Resposta: 2.",
    });

    const states = new Map(
      handoffs
        .list({ missionId: "mission-ghost", includeDelivered: true })
        .map((handoff) => [handoff.id, handoff.deliveryState]),
    );
    expect(states.get(ghost.id)).toBe("queued");
  });

  it("failure de OUTRA sessão não é consumido pelo sucesso alheio", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let nextId = 10;
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-scoped-ghost",
    });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => Date.now() + 10_000,
      idFactory: () => `handoff-${++nextId}`,
    });
    missions.create({ title: "Fantasma de outro worker" });

    const otherWorkerGhost = handoffs.submit({
      missionId: "mission-scoped-ghost",
      sessionId: "session-outro-worker",
      status: "failed",
      fromAgent: "nexus-watchdog",
      summary: 'watchdog: o worker "Outro" travou no bootstrap de MCP.',
    });

    handoffs.submit({
      missionId: "mission-scoped-ghost",
      sessionId: "session-primario",
      status: "success",
      fromAgent: "Primário",
      summary: "Entrega do primário.",
    });

    const stillQueued = handoffs
      .list({ missionId: "mission-scoped-ghost", includeDelivered: true })
      .find((handoff) => handoff.id === otherWorkerGhost.id);
    expect(stillQueued?.deliveryState).toBe("queued");
  });

  it("get e list mesclam artefatos anexados via modo attach sem violar a trigger imutável", () => {
    const scope = testProjectScope();
    const runtimeManager = manager();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-append",
    });
    missions.create({ title: "Append test" });
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => 1_000,
      idFactory: () => "handoff-append-1",
    });

    const initial = handoffs.submit({
      missionId: "mission-append",
      sessionId: "session-append",
      status: "success",
      fromAgent: "Worker",
      summary: "Primeiro turno",
      artifacts: [{ turn: 1, done: true }],
    });

    expect(initial.artifacts).toHaveLength(1);

    attachToExistingHandoff("handoff-append-1", {
      auto: true,
      closedBy: "turn-end-attach",
      fullText: "output delta anexado no mesmo turno",
    });

    const reloaded = handoffs.get("handoff-append-1");
    expect(reloaded).not.toBeNull();
    expect(reloaded?.artifacts).toHaveLength(2);
    expect(reloaded?.artifacts[1]).toMatchObject({
      closedBy: "turn-end-attach",
      fullText: "output delta anexado no mesmo turno",
    });
  });
});

describe("handoff list cursor page", () => {
  it("applies the keyset and limit in SQL and does not parse artifacts outside the page", () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-page",
    });
    let clock = 10;
    let seq = 0;
    const handoffs = createScopedHandoffStore(runtimeManager, scope, {
      now: () => ++clock,
      idFactory: () => `handoff-page-${++seq}`,
    });
    missions.create({ title: "Paged trail" });
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const row = handoffs.submit({
        missionId: "mission-page",
        sessionId: "session-page",
        fromAgent: "worker",
        status: "success",
        summary: `Turno ${index + 1} com trilha longa.`,
        artifacts: [{ blob: "x".repeat(8_000), index }],
      });
      ids.push(row.id);
    }
    const db = runtimeManager.open(scope).db;
    // O trigger bloqueia UPDATE de artifacts. A linha ruim entra por INSERT,
    // como um registro já gravado, para provar que a página não a parseia.
    db.prepare(
      `INSERT INTO handoffs (
         id, mission_id, session_id, worker_incarnation_id, from_agent,
         authority_origin, status, summary,
         artifacts_json, evidence_ids_json, evidence_trusted,
         context_revision, contract_hash, base_sha, head_sha, diff_hash,
         workflow_revision, delivered, delivery_state, created_at,
         adapter_id, model, author_read_only
       )
       SELECT
         'handoff-page-bad', mission_id, session_id, worker_incarnation_id, from_agent,
         authority_origin, status, summary,
         '{', evidence_ids_json, evidence_trusted,
         context_revision, contract_hash, base_sha, head_sha, diff_hash,
         workflow_revision, delivered, delivery_state, created_at + 10,
         adapter_id, model, author_read_only
       FROM handoffs WHERE id = ?`,
    ).run(ids[3]);
    ids.push("handoff-page-bad");

    expect(() => handoffs.list()).toThrow(/handoff artifacts/);
    const first = handoffs.listCursorPage({ limit: 2 });
    expect(first.map((row) => row.id)).toEqual([ids[0], ids[1]]);
    expect(first[0]?.artifacts).toEqual([{ blob: "x".repeat(8_000), index: 0 }]);

    db.prepare("DELETE FROM handoffs WHERE id = ?").run(ids[1]);
    const continued = handoffs.listCursorPage({
      after: { createdAt: first[0]!.createdAt ?? 0, id: ids[0]! },
      limit: 1,
    });
    expect(continued.map((row) => row.id)).toEqual([ids[2]]);

    const recent = handoffs.listRecentIds({}, 5);
    expect(recent).toContain("handoff-page-bad");
    expect(recent).not.toContain(ids[1]);
  });
});
