import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { Handoff } from "../../shared/orch-types";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from "../jarvis/audit-log";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import { bindTokenToSession, mintToken, resetGateForTests } from "./gate";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from "./project-domain-store-registry";
import {
  __resetTurnEndHandoffForTests,
  buildMechanicalHandoffPayload,
  getHandoffAttachments,
  handleTurnEndMechanicalHandoff,
} from "./turn-end-handoff";
import { submitPtyStreamHandoff } from "./pty-stream-handoff";

const physicalRead = vi.hoisted(() => ({ afterRead: vi.fn() }));

// Keep gate, physical receipt, audit, dispatch CAS and SQLite persistence real.
// PTY/UI delivery and git are outside this handoff acceptance regression.
vi.mock("../pty/pty-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pty/pty-manager")>()),
  getLastSessionInputOrigin: () => "system",
}));
vi.mock("./idle-delivery", () => ({ onHandoffSubmitted: vi.fn() }));
vi.mock("./physical-handoff-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./physical-handoff-git")>()),
  committedPhysicalWorkerHead: async (_ctx: unknown, requireHead: boolean) => {
    physicalRead.afterRead();
    return requireHead ? "a".repeat(40) : undefined;
  },
}));
vi.mock("./mission-story-plan", () => ({
  advanceFastLaneStoryTaskFromHandoff: vi.fn(),
}));
vi.mock("./worker-delivery-board", () => ({
  recordWorkerDeliveryIfDelivered: vi.fn(),
  markSessionSealedBoardCredited: vi.fn(),
  initWorkerDeliveryBoard: vi.fn(),
  shutdownWorkerDeliveryBoard: vi.fn(),
}));

// O portão de regressão roda no handoff: um repositório vazio de verdade é
// "limpo" (sem commits, sem arquivos); uma raiz inexistente seria "NÃO
// verificado" e mudaria o summary — git segue fora do que este arquivo prova.
const repoRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-late-handoff-repo-")));
execFileSync("git", ["-C", repoRoot, "init", "-q"], { stdio: "pipe" });
const scope = testProjectScope({ rootRealPath: repoRoot });
afterAll(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
const SESSION_ID = "late-worker-session";
const INCARNATION_ID = "late-worker-incarnation";
const REPLY = "A resposta real do worker chegou após o diagnóstico.";
let baseDir: string;
let manager: ProjectRuntimeManager;
let missionId: string;
let suite: ReturnType<typeof getProjectDomainStores>;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-late-handoff-"));
  manager = new ProjectRuntimeManager({
    baseDir,
    appVersion: "late-handoff-test",
  });
  configureProjectDomainStoreRegistry(manager);
  configureAuditLogRuntime(manager);
  resetGateForTests();
  __resetTurnEndHandoffForTests();
  physicalRead.afterRead.mockReset();
  suite = getProjectDomainStores(scope);
  const mission = suite.missions.create({
    title: "Resposta tardia",
    intentVersion: 1,
    intentState: "executing",
    intentContract: {
      ...compileIntentContract({
        goal: "Receber a resposta real do worker",
        intentVersion: 1,
      }),
      approvedAt: 1,
    },
  });
  missionId = mission.id;
  suite.missions.setStatus(missionId, "running");
  const ctx = mintToken({
    label: "Worker real",
    role: "worker",
    providerId: "codex",
    missionId,
    workerIncarnationId: INCARNATION_ID,
    contextRevision: "c".repeat(64),
    scope,
    allowedTools: ["nexus_handoff_submit"],
  });
  bindTokenToSession(ctx.token, SESSION_ID);
});

afterEach(() => {
  disposeProjectDomainStoreRegistry();
  disposeAuditLogRuntime();
  resetGateForTests();
  __resetTurnEndHandoffForTests();
  manager?.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function diagnostic(overrides: Partial<Handoff> = {}) {
  return suite.handoffs.submit({
    missionId,
    sessionId: SESSION_ID,
    workerIncarnationId: INCARNATION_ID,
    fromAgent: "nexus-handoff-enforcement",
    status: "blocked",
    summary: "Worker encerrou sem entregar handoff no tempo esperado.",
    ...overrides,
  });
}

function seedRunningDispatch(
  workerIncarnationId = INCARNATION_ID,
  state = "running",
) {
  const db = manager.open(scope).db;
  db.prepare(
    `INSERT INTO tasks
      (id, mission_id, title, detail, status, priority, created_at, updated_at)
     VALUES ('late-task', ?, 'Responder', '', 'running', 0, 1, 1)`,
  ).run(missionId);
  db.prepare(
    `INSERT INTO task_dispatch_queue
      (id, task_id, mission_id, intent_version, state, lease_token_hash,
       lease_owner, lease_expires_at, worker_id, pane_id, session_id,
       worker_incarnation_id, created_at, updated_at)
     VALUES ('late-dispatch', 'late-task', ?, 1, ?, ?, 'main', ?,
       'Worker real', 'dispatched-pane', ?, ?, 1, 1)`,
  ).run(
    missionId,
    state,
    "c".repeat(64),
    Date.now() + 60_000,
    SESSION_ID,
    workerIncarnationId,
  );
}

function receiptRows() {
  return manager
    .open(scope)
    .db.prepare("SELECT * FROM handoff_mcp_receipts")
    .all();
}

describe("late physical Stop after provisional handoff", () => {
  it.each([false, true])(
    "accepts the real answer once and retires its diagnostic (dispatch=%s)",
    async (withDispatch) => {
      if (withDispatch) seedRunningDispatch();
      const provisional = diagnostic();

      await handleTurnEndMechanicalHandoff({
        sessionId: SESSION_ID,
        body: { last_agent_message: REPLY },
      });

      const handoffs = suite.handoffs.list({
        missionId,
        includeDelivered: true,
      });
      const real = handoffs.find((handoff) => handoff.id !== provisional.id);
      expect(real).toMatchObject({
        status: "success",
        summary: "[auto] A resposta real do worker chegou após o diagnóstico.",
        sessionId: SESSION_ID,
        workerIncarnationId: INCARNATION_ID,
        mcpProvenance: { source: "pty-stream" },
      });
      expect(suite.handoffs.get(provisional.id)).toMatchObject({
        status: "blocked",
        summary: provisional.summary,
        deliveryState: "consumed",
      });
      expect(getHandoffAttachments(provisional.id)).toEqual([]);
      const receipts = receiptRows();
      expect(receipts).toHaveLength(1);
      if (withDispatch)
        expect(suite.taskDispatches.get("late-task")).toMatchObject({
          state: "handoff_ready",
          handoffId: real!.id,
        });

      // Both Stop dedup and durable physical replay survive re-delivery/restart.
      await handleTurnEndMechanicalHandoff({
        sessionId: SESSION_ID,
        body: { last_agent_message: REPLY },
      });
      const replay = await submitPtyStreamHandoff(
        SESSION_ID,
        buildMechanicalHandoffPayload({
          replyText: REPLY,
          sessionId: SESSION_ID,
        }),
      );
      expect(replay).toMatchObject({ handoffId: real!.id, replayed: true });
      expect(
        suite.handoffs.list({ missionId, includeDelivered: true }),
      ).toHaveLength(2);
      expect(receiptRows()).toEqual(receipts);
    },
  );

  it.each([
    ["old incarnation", "replacement-incarnation", "running"],
    ["replaced dispatch", INCARNATION_ID, "superseded"],
  ])(
    "rejects a late answer from an %s and preserves its diagnostic",
    async (_label, incarnation, state) => {
      seedRunningDispatch(incarnation, state);
      const provisional = diagnostic();

      await handleTurnEndMechanicalHandoff({
        sessionId: SESSION_ID,
        body: { last_agent_message: REPLY },
      });

      expect(
        suite.handoffs.list({ missionId, includeDelivered: true }),
      ).toEqual([provisional]);
      expect(receiptRows()).toEqual([]);
      expect(getHandoffAttachments(provisional.id)).toEqual([]);
      expect(suite.taskDispatches.get("late-task")).toMatchObject({
        state,
        workerIncarnationId: incarnation,
      });
    },
  );

  it("preserves a real worker block as the delivered outcome", async () => {
    const realBlock = diagnostic({ fromAgent: "Worker real" });

    await handleTurnEndMechanicalHandoff({
      sessionId: SESSION_ID,
      body: { last_agent_message: REPLY },
    });

    expect(
      suite.handoffs.list({ missionId, includeDelivered: true }),
    ).toHaveLength(1);
    expect(suite.handoffs.get(realBlock.id)?.status).toBe("blocked");
    expect(receiptRows()).toEqual([]);
  });

  it.each([INCARNATION_ID, "replacement-incarnation"])(
    "does not treat a replaced dispatch session as ad-hoc (incarnation=%s)",
    async (replacementIncarnation) => {
      seedRunningDispatch();
      manager
        .open(scope)
        .db.prepare(
          `UPDATE task_dispatch_queue
       SET session_id = 'replacement-session', worker_incarnation_id = ?
       WHERE task_id = 'late-task'`,
        )
        .run(replacementIncarnation);
      const provisional = diagnostic();

      await handleTurnEndMechanicalHandoff({
        sessionId: SESSION_ID,
        body: { last_agent_message: REPLY },
      });

      expect(
        suite.handoffs.list({ missionId, includeDelivered: true }),
      ).toEqual([provisional]);
      expect(receiptRows()).toEqual([]);
    },
  );

  it.each(["dispatched-pane", "replacement-pane"])(
    "preserves ambiguous diagnostics even when a previous pane is persisted (current pane=%s)",
    async (paneId) => {
      seedRunningDispatch("replacement-incarnation");
      manager
        .open(scope)
        .db.prepare(
          `UPDATE task_dispatch_queue SET session_id = 'replacement-session', pane_id = ? WHERE task_id = 'late-task'`,
        )
        .run(paneId);
      suite.missionPanes.record({
        missionId,
        adapterId: "codex",
        role: "worker",
        paneId: "dispatched-pane",
        workerIncarnationId: INCARNATION_ID,
        agentName: "Worker real",
      });
      const provisional = diagnostic();

      await handleTurnEndMechanicalHandoff({
        sessionId: SESSION_ID,
        body: { last_agent_message: REPLY },
      });

      expect(receiptRows()).toEqual([]);
      expect(suite.handoffs.get(provisional.id)?.deliveryState).toBe("queued");
      expect(suite.taskDispatches.get("late-task")).toMatchObject({
        state: "running",
        sessionId: "replacement-session",
        workerIncarnationId: "replacement-incarnation",
      });
    },
  );

  it("keeps ordinary ad-hoc submission available alongside unrelated dispatches", async () => {
    seedRunningDispatch("other-incarnation");
    manager
      .open(scope)
      .db.prepare(
        `UPDATE task_dispatch_queue SET session_id = 'other-session' WHERE task_id = 'late-task'`,
      )
      .run();

    await handleTurnEndMechanicalHandoff({
      sessionId: SESSION_ID,
      body: { last_agent_message: REPLY },
    });

    expect(receiptRows()).toHaveLength(1);
    expect(suite.handoffs.list({ missionId })).toEqual([
      expect.objectContaining({ status: "success", sessionId: SESSION_ID }),
    ]);
    expect(suite.taskDispatches.get("late-task")?.state).toBe("running");
  });

  it("does not use a missing diagnostic incarnation to bypass the replacement fence", async () => {
    seedRunningDispatch("replacement-incarnation");
    manager
      .open(scope)
      .db.prepare(
        `UPDATE task_dispatch_queue SET session_id = 'replacement-session' WHERE task_id = 'late-task'`,
      )
      .run();
    const provisional = diagnostic({ workerIncarnationId: undefined });

    await handleTurnEndMechanicalHandoff({
      sessionId: SESSION_ID,
      body: { last_agent_message: REPLY },
    });

    expect(receiptRows()).toEqual([]);
    expect(suite.handoffs.get(provisional.id)?.deliveryState).toBe("queued");
  });

  it("rechecks the dispatch binding after asynchronous handoff preparation", async () => {
    const provisional = diagnostic();
    physicalRead.afterRead.mockImplementationOnce(() => seedRunningDispatch());

    await handleTurnEndMechanicalHandoff({
      sessionId: SESSION_ID,
      body: { last_agent_message: REPLY },
    });

    expect(receiptRows()).toEqual([]);
    expect(suite.handoffs.get(provisional.id)?.deliveryState).toBe("queued");
    expect(suite.taskDispatches.get("late-task")?.state).toBe("running");
  });

  it("retires only unreceipted diagnostics from the exact session and incarnation", async () => {
    const retired = [
      diagnostic(),
      diagnostic({ fromAgent: "nexus-watchdog", status: "failed" }),
    ];
    const preserved = [
      diagnostic({ sessionId: "other-session" }),
      diagnostic({ workerIncarnationId: "other-incarnation" }),
      diagnostic({ workerIncarnationId: undefined }),
      diagnostic({ fromAgent: "Worker real" }),
      diagnostic({ fromAgent: "nexus-other-driver" }),
    ];
    const confirmed = suite.handoffs.submitOperatorConfirmed({
      missionId,
      sessionId: SESSION_ID,
      workerIncarnationId: INCARNATION_ID,
      fromAgent: "nexus-handoff-enforcement",
      status: "blocked",
      summary: "O operador confirmou este bloqueio real.",
    });

    await submitPtyStreamHandoff(
      SESSION_ID,
      buildMechanicalHandoffPayload({
        replyText: REPLY,
        sessionId: SESSION_ID,
      }),
    );

    for (const handoff of retired)
      expect(suite.handoffs.get(handoff.id)?.deliveryState).toBe("consumed");
    for (const handoff of [...preserved, confirmed])
      expect(suite.handoffs.get(handoff.id)?.deliveryState).toBe("queued");
    expect(receiptRows()).toHaveLength(1);
  });
});
