import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
  readAuditLog,
} from "../jarvis/audit-log";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  bindTokenToSession,
  mintToken,
  releaseSession,
  resetGateForTests,
} from "./gate";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from "./project-domain-store-registry";
import { issueAgentIdentityRequired } from "./agent-identity-spawn";
import { setAgentKeyringVaultForTests } from "./agent-keyring-persistence";
import { configureMissionEventEmit } from "./mission-event-emit";
import { StaleReadOnlyObservationError } from "./physical-handoff-git";

const settingsHarness = vi.hoisted(() => ({
  agentAttestationGate: "off" as "off" | "required",
}));

vi.mock("../persistence/settings-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../persistence/settings-store")>();
  return {
    ...actual,
    getOrchSettings: () => ({
      ...actual.getOrchSettings(),
      agentAttestationGate: settingsHarness.agentAttestationGate,
    }),
  };
});

vi.mock("./idle-delivery", () => ({
  onHandoffSubmitted: vi.fn(() => null),
}));

import {
  isStaleReadOnlyObservationHandoffResult,
  isStaleReadOnlyObservationHandoffError,
  submitPtyStreamHandoff,
  terminateStaleReadOnlyMcpSession,
  terminateStaleReadOnlyPtyStreamSession,
} from "./pty-stream-handoff";

const SESSION_ID = "session-pty-stream";
const WORKER_ID = "agy-worker";
const VALID_PAYLOAD = Object.freeze({
  status: "success" as const,
  summary:
    "Implementei a correção solicitada, fiz commit e validei o resultado no worktree.",
  artifacts: [],
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("PTY stream physical handoff", () => {
  let baseDir = "";
  let worktree = "";
  let manager: ProjectRuntimeManager;
  const vault = new Map<string, string>();

  beforeEach(() => {
    settingsHarness.agentAttestationGate = "off";
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pty-handoff-"));
    worktree = path.join(baseDir, "worktree");
    fs.mkdirSync(worktree);
    git(worktree, "init");
    git(worktree, "config", "user.email", "nexus@test.invalid");
    git(worktree, "config", "user.name", "Nexus Test");
    fs.writeFileSync(path.join(worktree, "README.md"), "# fixture\n");
    git(worktree, "add", "README.md");
    git(worktree, "commit", "-m", "test: seed");
    manager = new ProjectRuntimeManager({
      baseDir: path.join(baseDir, "runtime"),
      appVersion: "pty-stream-handoff-test",
    });
    setAgentKeyringVaultForTests({
      getSecret: (key) => vault.get(key) ?? null,
      setSecret: (key, value) => {
        vault.set(key, value);
        return { ok: true };
      },
      deleteSecret: (key) => {
        vault.delete(key);
        return { ok: true };
      },
    });
    configureMissionEventEmit(manager);
    configureProjectDomainStoreRegistry(manager);
    configureAuditLogRuntime(manager);
    resetGateForTests();
  });

  afterEach(() => {
    settingsHarness.agentAttestationGate = "off";
    resetGateForTests();
    disposeProjectDomainStoreRegistry();
    disposeAuditLogRuntime();
    configureMissionEventEmit(null);
    setAgentKeyringVaultForTests(null);
    vault.clear();
    manager?.closeAll();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function fixture() {
    const scope = testProjectScope({ rootRealPath: worktree });
    const suite = getProjectDomainStores(scope);
    const contract = {
      ...compileIntentContract({
        goal: "Permitir que um worker AGY conclua a tarefa pelo PTY",
        intentVersion: 1,
      }),
      approvedAt: 1,
      dispatchedAt: 1,
    };
    const mission = suite.missions.create({
      title: "PTY stream mission",
      intentVersion: 1,
      intentState: "executing",
      intentContract: contract,
    });
    suite.missions.setStatus(mission.id, "running");
    const task = suite.tasks.create({
      missionId: mission.id,
      title: "Implementar correção com AGY",
    });
    const route = suite.missions.reserveRouteDecision(
      mission.id,
      task.title,
      {
        tier: "hard",
        adapterId: "agy",
        reason: "provider-independent PTY handoff",
        alternatives: [],
      },
    );
    const claim = suite.taskDispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: WORKER_ID,
      leaseOwner: "main",
      leaseMs: 30_000,
    });
    const routed = suite.taskDispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: "agy",
    });
    suite.taskDispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId: "pane-pty-stream",
      sessionId: SESSION_ID,
      workerIncarnationId: claim.workerIncarnationId,
    });
    issueAgentIdentityRequired({
      missionId: mission.id,
      scope,
      agentId: WORKER_ID,
    });
    const ctx = mintToken({
      label: WORKER_ID,
      agentName: WORKER_ID,
      providerId: "agy",
      role: "worker",
      missionId: mission.id,
      workerIncarnationId: claim.workerIncarnationId,
      scope,
      executionScope: scope,
      allowedTools: [],
    });
    bindTokenToSession(ctx.token, SESSION_ID);
    return { scope, suite, mission, task, claim };
  }

  async function submitAndReadReceipt() {
    const { scope, suite, mission, task, claim } = fixture();
    const head = git(worktree, "rev-parse", "HEAD");

    const result = await submitPtyStreamHandoff(SESSION_ID, VALID_PAYLOAD);

    expect(result).toMatchObject({
      taskDispatchState: "handoff_ready",
      replayed: false,
    });
    const dispatch = suite.taskDispatches.get(task.id);
    expect(dispatch).toMatchObject({
      state: "handoff_ready",
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: result.handoffId,
    });
    const handoff = suite.handoffs.get(result.handoffId);
    expect(handoff).toMatchObject({
      missionId: mission.id,
      sessionId: SESSION_ID,
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: WORKER_ID,
      status: "success",
      mcpProvenance: {
        source: "pty-stream",
        worktreeHeadSha: head,
        rawPayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const receipt = manager
      .open(scope)
      .db.prepare(
        `SELECT source, mission_id, session_id, worker_incarnation_id,
                worktree_head_sha, agent_pubkey, owner_pubkey, attestation_json
         FROM handoff_mcp_receipts WHERE handoff_id = ?`,
      )
      .get(result.handoffId);
    return { claim, head, mission, receipt, result, scope, suite, task };
  }

  it("persists pty-stream provenance without crypto in Autopilot and atomically advances the exact dispatch", async () => {
    const { claim, head, mission, receipt, result, scope } =
      await submitAndReadReceipt();

    expect(receipt).toEqual({
      source: "pty-stream",
      mission_id: mission.id,
      session_id: SESSION_ID,
      worker_incarnation_id: claim.workerIncarnationId,
      worktree_head_sha: head,
      agent_pubkey: null,
      owner_pubkey: null,
      attestation_json: null,
    });
    expect(
      readAuditLog({ scope, missionId: mission.id }, 20).filter(
        (entry) =>
          entry.source === "pty-stream" &&
          entry.tool === "nexus_handoff_submit",
      ),
    ).toEqual([
      expect.objectContaining({ result: "intent" }),
      expect.objectContaining({ result: "ok" }),
    ]);

    const replay = await submitPtyStreamHandoff(SESSION_ID, VALID_PAYLOAD);
    expect(replay).toEqual({
      handoffId: result.handoffId,
      taskDispatchState: "handoff_ready",
      replayed: true,
    });
    expect(
      manager
        .open(scope)
        .db.prepare(
          "SELECT COUNT(*) AS count FROM handoff_mcp_receipts",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("persists the required agent attestation in Hardened", async () => {
    settingsHarness.agentAttestationGate = "required";

    const { claim, head, mission, receipt } = await submitAndReadReceipt();

    expect(receipt).toEqual({
      source: "pty-stream",
      mission_id: mission.id,
      session_id: SESSION_ID,
      worker_incarnation_id: claim.workerIncarnationId,
      worktree_head_sha: head,
      agent_pubkey: expect.stringMatching(/^[a-f0-9]{64}$/),
      owner_pubkey: expect.stringMatching(/^[a-f0-9]{64}$/),
      attestation_json: expect.stringContaining('["auth"'),
    });
  });

  it("accepts a terminal repaint whose summary differs only in horizontal spacing", async () => {
    const { scope, suite } = fixture();
    const first = await submitPtyStreamHandoff(SESSION_ID, {
      ...VALID_PAYLOAD,
      summary:
        "Implementei   a correção solicitada,\t fiz commit e validei o resultado no worktree.",
    });
    const replay = await submitPtyStreamHandoff(SESSION_ID, VALID_PAYLOAD);

    expect(replay).toEqual({
      handoffId: first.handoffId,
      taskDispatchState: "handoff_ready",
      replayed: true,
    });
    expect(suite.handoffs.get(first.handoffId)?.summary).toBe(
      VALID_PAYLOAD.summary,
    );
    expect(
      manager
        .open(scope)
        .db.prepare("SELECT COUNT(*) AS count FROM handoff_mcp_receipts")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rejects an unbound or stale session/incarnation without a handoff row", async () => {
    const { scope, claim } = fixture();

    await expect(
      submitPtyStreamHandoff("session-spoofed", VALID_PAYLOAD),
    ).rejects.toThrow(/not bound to a current mission worker/i);

    releaseSession(SESSION_ID);
    const stale = mintToken({
      label: WORKER_ID,
      agentName: WORKER_ID,
      providerId: "agy",
      role: "worker",
      missionId: getProjectDomainStores(scope).missions.list()[0]!.id,
      workerIncarnationId: `${claim.workerIncarnationId}-stale`,
      scope,
      executionScope: scope,
      allowedTools: [],
    });
    bindTokenToSession(stale.token, SESSION_ID);
    await expect(
      submitPtyStreamHandoff(SESSION_ID, VALID_PAYLOAD),
    ).rejects.toThrow(/incarnation obsoleta/i);

    expect(
      manager
        .open(scope)
        .db.prepare("SELECT COUNT(*) AS count FROM handoffs")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back handoff and receipt when the dispatch CAS cannot commit", async () => {
    const { scope, suite, task } = fixture();
    const db = manager.open(scope).db;
    db.exec(`
      CREATE TRIGGER test_reject_pty_handoff_dispatch
      BEFORE UPDATE ON task_dispatch_queue
      WHEN NEW.state = 'handoff_ready'
      BEGIN
        SELECT RAISE(ABORT, 'forced dispatch failure');
      END;
    `);

    await expect(
      submitPtyStreamHandoff(SESSION_ID, VALID_PAYLOAD),
    ).rejects.toThrow(/forced dispatch failure/i);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM handoffs").get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM handoff_mcp_receipts")
        .get(),
    ).toEqual({ count: 0 });
    expect(suite.taskDispatches.get(task.id)).toMatchObject({
      state: "running",
      handoffId: undefined,
    });
  });

  it("terminates a stale read-only PTY so scheduler recovery can re-anchor it", async () => {
    const terminate = vi.fn(async () => true);
    const stale = new StaleReadOnlyObservationError();

    expect(isStaleReadOnlyObservationHandoffError(stale)).toBe(true);
    await expect(
      terminateStaleReadOnlyPtyStreamSession(
        SESSION_ID,
        stale,
        terminate,
      ),
    ).resolves.toBe(true);
    expect(terminate).toHaveBeenCalledWith(SESSION_ID);

    expect(
      isStaleReadOnlyObservationHandoffError(new Error("other failure")),
    ).toBe(false);
    await expect(
      terminateStaleReadOnlyPtyStreamSession(
        SESSION_ID,
        new Error("other failure"),
        terminate,
      ),
    ).resolves.toBe(false);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates only the stale HTTP/ACP handoff result after MCP reports it", async () => {
    const terminate = vi.fn(async () => true);
    const stale = new StaleReadOnlyObservationError();
    const staleResult = {
      ok: false,
      tool: "nexus_handoff_submit",
      error: stale.message,
      effectMayHaveCommitted: true,
    } as const;

    expect(isStaleReadOnlyObservationHandoffResult(staleResult)).toBe(true);
    await expect(
      terminateStaleReadOnlyMcpSession(
        SESSION_ID,
        staleResult,
        terminate,
      ),
    ).resolves.toBe(true);
    expect(terminate).toHaveBeenCalledWith(SESSION_ID);

    const unrelated = {
      ...staleResult,
      tool: "nexus_worker_heartbeat",
    } as const;
    expect(isStaleReadOnlyObservationHandoffResult(unrelated)).toBe(false);
    await expect(
      terminateStaleReadOnlyMcpSession(SESSION_ID, unrelated, terminate),
    ).resolves.toBe(false);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
