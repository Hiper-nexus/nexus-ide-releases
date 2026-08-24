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

  it("rejects missing, cross-mission and stale evidence IDs without persisting a claim", () => {
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

    expect(() => submit(["missing-evidence"])).toThrow(
      /trusted evidence.*not found/i,
    );
    expect(() => submit(["evidence-b"])).toThrow(/another mission/i);
    expect(() => submit(["evidence-stale"])).toThrow(
      /current workflow binding/i,
    );
    expect(() => submit(["evidence-old-context"])).toThrow(
      /current workflow binding/i,
    );
    expect(handoffs.list({ includeDelivered: true })).toEqual([]);
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

  it("SUCCESS real da sessão consome failure sintético do watchdog ainda na fila", () => {
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

    // Worker se recupera e entrega SUCCESS pela mesma sessão física.
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
    expect(states.get(ghost.id)).toBe("consumed");
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
});
