import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import { createScopedHandoffStore } from "./handoff-store";
import { createScopedMissionStore } from "./mission-store";
import { createTaskDispatchStore } from "./task-dispatch-store";
import { createScopedTaskStore } from "./task-store";

let baseDir = "";
const managers: ProjectRuntimeManager[] = [];

function createRunningFixture() {
  const runtime = new ProjectRuntimeManager({
    baseDir: path.join(baseDir, `fixture-${managers.length + 1}`),
    appVersion: "task-dispatch-handoff-authority-test",
  });
  managers.push(runtime);
  const scope = testProjectScope();
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const handoffs = createScopedHandoffStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const contract = {
    ...compileIntentContract({
      goal: "Provar autoridade física também no bloqueio",
      intentVersion: 1,
    }),
    approvedAt: 1,
    dispatchedAt: 1,
  };
  const mission = missions.create({
    title: "Physical block authority",
    intentVersion: 1,
    intentState: "executing",
    intentContract: contract,
  });
  missions.setStatus(mission.id, "running");
  const task = tasks.create({
    missionId: mission.id,
    title: "Worker with terminal handoff",
  });
  const route = missions.reserveRouteDecision(mission.id, task.title, {
    tier: "hard",
    adapterId: "codex",
    reason: "sealed physical authority fixture",
    alternatives: [],
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task.id,
    intentVersion: 1,
    workerId: "physical-worker",
    leaseOwner: "main",
    leaseMs: 30_000,
  });
  const routed = dispatches.attachRoute({
    taskId: task.id,
    revision: claim.revision,
    leaseToken: claim.leaseToken,
    routeReservationId: route.id,
    adapterId: "codex",
  });
  dispatches.bindSpawn({
    taskId: task.id,
    revision: routed.revision,
    leaseToken: claim.leaseToken,
    paneId: "pane-physical-block",
    sessionId: "session-physical-block",
    workerIncarnationId: claim.workerIncarnationId,
  });
  return {
    runtime,
    scope,
    missions,
    tasks,
    handoffs,
    dispatches,
    mission,
    task,
    claim,
  };
}

function insertLegacyPhysicalReceipt(
  fixture: ReturnType<typeof createRunningFixture>,
  handoffId: string,
  options: {
    readonly withAudit: boolean;
    readonly source?: "http-mcp" | "omp-rpc-stdio";
  },
): void {
  const db = fixture.runtime.open(fixture.scope).db;
  const source = options.source ?? "http-mcp";
  const handoff = db
    .prepare(`SELECT created_at FROM handoffs WHERE id = ?`)
    .get(handoffId) as { created_at: number };
  const receiptId = `legacy-${handoffId}`;
  if (options.withAudit) {
    db.prepare(
      `INSERT INTO audit_events
         (id, mission_id, actor, action, outcome, payload_json, occurred_at)
       VALUES (?, ?, ?, 'nexus_handoff_submit', 'intent', ?, ?)`,
    ).run(
      `audit-${receiptId}`,
      fixture.mission.id,
      "session-physical-block",
      JSON.stringify({
        schema: "nexus.mcp-audit/v1",
        project_id: fixture.scope.projectId,
        checkout_id: fixture.scope.checkoutId,
        source,
        invocation_id: receiptId,
      }),
      handoff.created_at,
    );
  }
  db.prepare(
    `INSERT INTO handoff_mcp_receipts
       (receipt_id, handoff_id, tool_call_id, tool_name, source,
        mission_id, session_id, worker_incarnation_id,
        authority_sha256, worktree_head_sha, issued_at)
     VALUES (?, ?, ?, 'nexus_handoff_submit', ?,
             ?, 'session-physical-block', ?, ?, NULL, ?)`,
  ).run(
    receiptId,
    handoffId,
    receiptId,
    source,
    fixture.mission.id,
    fixture.claim.workerIncarnationId,
    createHash("sha256").update(receiptId).digest("hex"),
    handoff.created_at,
  );
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-task-handoff-authority-"),
  );
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("task dispatch physical handoff authority", () => {
  it("rejects a main-only non-success handoff without a physical receipt", () => {
    const fixture = createRunningFixture();
    const handoff = fixture.handoffs.submit({
      missionId: fixture.mission.id,
      sessionId: "session-physical-block",
      workerIncarnationId: fixture.claim.workerIncarnationId,
      fromAgent: "physical-worker",
      status: "blocked",
      summary: "Main-only metadata cannot terminally block this dispatch.",
    });

    expect(() =>
      fixture.dispatches.blockFromHandoff({
        sessionId: "session-physical-block",
        workerIncarnationId: fixture.claim.workerIncarnationId,
        handoffId: handoff.id,
        detail: "blocked: missing physical transport authority",
      }),
    ).toThrow(/physical nexus_handoff_submit receipt/i);
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: "running",
      handoffId: undefined,
    });
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: "running",
    });
  });

  it("rejects a legacy receipt without its exact correlated physical audit", () => {
    const fixture = createRunningFixture();
    const handoff = fixture.handoffs.submit({
      missionId: fixture.mission.id,
      sessionId: "session-physical-block",
      workerIncarnationId: fixture.claim.workerIncarnationId,
      fromAgent: "physical-worker",
      status: "failed",
      summary: "A legacy receipt without audit cannot block the dispatch.",
    });
    insertLegacyPhysicalReceipt(fixture, handoff.id, { withAudit: false });

    expect(() =>
      fixture.dispatches.blockFromHandoff({
        sessionId: "session-physical-block",
        workerIncarnationId: fixture.claim.workerIncarnationId,
        handoffId: handoff.id,
        detail: "failed: legacy receipt has no correlated audit",
      }),
    ).toThrow(/correlated physical audit intent/i);
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: "running",
    });
  });

  it("rejects retired OMP provenance even when its legacy audit is exact", () => {
    const fixture = createRunningFixture();
    const handoff = fixture.handoffs.submit({
      missionId: fixture.mission.id,
      sessionId: "session-physical-block",
      workerIncarnationId: fixture.claim.workerIncarnationId,
      fromAgent: "physical-worker",
      status: "success",
      summary: "Retired transports cannot authorize a current dispatch.",
    });
    insertLegacyPhysicalReceipt(fixture, handoff.id, {
      withAudit: true,
      source: "omp-rpc-stdio",
    });

    expect(() =>
      fixture.dispatches.acceptHandoff({
        sessionId: "session-physical-block",
        workerIncarnationId: fixture.claim.workerIncarnationId,
        handoffId: handoff.id,
      }),
    ).toThrow(/omp-rpc-stdio.*retired/i);
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: "running",
      handoffId: undefined,
    });
  });

  it("requires success for accept and non-success for block", () => {
    const successFixture = createRunningFixture();
    const success = successFixture.handoffs.submit({
      missionId: successFixture.mission.id,
      sessionId: "session-physical-block",
      workerIncarnationId: successFixture.claim.workerIncarnationId,
      fromAgent: "physical-worker",
      status: "success",
      summary: "A success handoff cannot be interpreted as a terminal block.",
    });
    insertLegacyPhysicalReceipt(successFixture, success.id, {
      withAudit: true,
    });
    expect(() =>
      successFixture.dispatches.blockFromHandoff({
        sessionId: "session-physical-block",
        workerIncarnationId: successFixture.claim.workerIncarnationId,
        handoffId: success.id,
        detail: "blocked: status mismatch",
      }),
    ).toThrow(/non-success status/i);

    const failedFixture = createRunningFixture();
    const failed = failedFixture.handoffs.submit({
      missionId: failedFixture.mission.id,
      sessionId: "session-physical-block",
      workerIncarnationId: failedFixture.claim.workerIncarnationId,
      fromAgent: "physical-worker",
      status: "failed",
      summary: "A failed handoff cannot be accepted as successful delivery.",
    });
    insertLegacyPhysicalReceipt(failedFixture, failed.id, {
      withAudit: true,
    });
    expect(() =>
      failedFixture.dispatches.acceptHandoff({
        sessionId: "session-physical-block",
        workerIncarnationId: failedFixture.claim.workerIncarnationId,
        handoffId: failed.id,
      }),
    ).toThrow(/requires status success/i);
  });
});
