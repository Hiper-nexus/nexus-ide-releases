import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import { ProjectRuntimeManager } from "./project-runtime-manager";
import { WorktreeRuntimeRegistry } from "./worktree-runtime-registry";

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-registry-git-")),
  );
  const runtime = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-registry-runtime-")),
  );
  roots.push(root, runtime);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Nexus Test");
  git(root, "config", "user.email", "nexus@example.test");
  fs.writeFileSync(path.join(root, "owned.txt"), "base\n");
  git(root, "add", "owned.txt");
  git(root, "commit", "-qm", "base");
  const scope: ProjectExecutionScope = {
    version: 1,
    installationId: "install-a",
    projectId: "project-a",
    checkoutId: "checkout-a",
    rootRealPath: root,
    identitySource: "manifest",
  };
  const manager = new ProjectRuntimeManager({
    baseDir: runtime,
    appVersion: "test",
  });
  managers.push(manager);
  return { root, scope, manager };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("project worktree runtime registry", () => {
  it("resolves a physically validated no-change QA task without inventing a merge entry", () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, "rev-parse", "HEAD");
    const record = registry.create({
      scope,
      missionId: "mission-guided-no-change",
      taskId: "guided-quality-gate",
      workerId: "qa-independent",
      ownership: {
        files: ["owned.txt"],
        symbols: [],
        domains: ["guided-quality-gate", "sequential-only"],
      },
    });
    const prepared = registry.prepareNoChangeValidation(
      scope,
      record.missionId,
      record.taskId,
    );
    expect(prepared).toMatchObject({
      taskHeadSha: baseSha,
      integrationHeadSha: baseSha,
      changedFiles: [],
    });

    registry.markValidatedNoChange(
      scope,
      record.missionId,
      record.taskId,
      prepared!.taskHeadSha,
      prepared!.integrationHeadSha,
    );

    expect(registry.mergeSnapshot(scope).entries).toEqual([]);
    expect(
      registry.resolveIntegratedMission(scope, record.missionId, baseSha),
    ).toMatchObject({
      baseSha,
      headSha: baseSha,
    });

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    expect(
      reopened.resolveIntegratedMission(scope, record.missionId, baseSha),
    ).toMatchObject({
      baseSha,
      headSha: baseSha,
    });
  });

  it("persists, validates, merges and resolves an exact integrated mission", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, "rev-parse", "HEAD");
    const record = registry.create({
      scope,
      missionId: "mission-a",
      taskId: "task-a",
      workerId: "worker-a",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    fs.writeFileSync(path.join(record.worktreePath, "owned.txt"), "changed\n");
    git(record.worktreePath, "add", "owned.txt");
    git(record.worktreePath, "commit", "-qm", "task");

    const merged = await registry.enqueue({
      scope,
      missionId: "mission-a",
      taskId: "task-a",
      validate: () => ({
        sensorsPassed: true,
        reviewPassed: true,
        evidenceIds: ["evidence-a"],
      }),
    });
    expect(merged.integratedSha).toBe(git(root, "rev-parse", "HEAD"));
    expect(
      registry.resolveIntegratedMission(scope, "mission-a", baseSha),
    ).toMatchObject({
      baseSha,
      headSha: merged.integratedSha,
    });

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    expect(reopened.get(scope, "mission-a", "task-a")?.status).toBe(
      "integrated",
    );
    expect(
      reopened
        .forScope(scope)
        .queue.snapshot(scope)
        .events.map((event) => event.type),
    ).toEqual(["integrated"]);
    expect(
      reopened.resolveIntegratedMission(scope, "mission-a", baseSha)?.diffHash,
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("automatically reconciles an interrupted active merge after reopening", () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = registry.create({
      scope,
      missionId: "mission-restart",
      taskId: "task-restart",
      workerId: "worker-restart",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    fs.writeFileSync(path.join(record.worktreePath, "owned.txt"), "restart\n");
    git(record.worktreePath, "add", "owned.txt");
    git(record.worktreePath, "commit", "-qm", "restart task");
    const runtime = registry.forScope(scope);
    const prepared = runtime.worktrees.prepareIntegration(
      scope,
      record.missionId,
      record.taskId,
    );
    runtime.worktrees.markQueued(
      scope,
      record.missionId,
      record.taskId,
      prepared.taskHeadSha,
    );
    const key = runtime.worktrees.scopeKey(scope);
    expect(
      runtime.mergeState.compareAndSwap(key, 0, {
        activeTaskKey: record.taskKey,
        blocked: null,
        events: [],
        entries: [
          {
            id: `merge-${record.taskKey}`,
            taskKey: record.taskKey,
            missionId: record.missionId,
            taskId: record.taskId,
            attempt: 1,
            status: "candidate-validating",
            taskHeadSha: prepared.taskHeadSha,
            integrationBaseSha: git(root, "rev-parse", "HEAD"),
            diffHash: prepared.diffHash,
            evidenceIds: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    ).toBe(true);

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    const recovered = reopened.forScope(scope);

    expect(recovered.mergeState.read(key)).toMatchObject({
      activeTaskKey: null,
      blocked: { taskKey: record.taskKey },
    });
    expect(recovered.mergeState.read(key).events.at(-1)?.type).toBe(
      "restart-reconciled",
    );
    expect(
      recovered.worktrees.get(scope, record.missionId, record.taskId)?.status,
    ).toBe("failed");
  });

  it("recovers an exact materialized reserved worktree after process restart", () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = registry.create({
      scope,
      missionId: "mission-reserved-ready",
      taskId: "task-reserved-ready",
      workerId: "worker-reserved-ready",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    const runtime = registry.forScope(scope);
    const key = runtime.worktrees.scopeKey(scope);
    const snapshot = runtime.worktreeState.read(key);
    expect(
      runtime.worktreeState.compareAndSwap(
        key,
        snapshot.revision,
        snapshot.records.map((candidate) =>
          candidate.taskKey === record.taskKey
            ? { ...candidate, status: "reserved" as const }
            : candidate,
        ),
      ),
    ).toBe(true);

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    expect(reopened.get(scope, record.missionId, record.taskId)).toMatchObject({
      status: "ready",
      baseSha: record.baseSha,
      branchRef: record.branchRef,
      worktreePath: record.worktreePath,
    });
  });

  it("fails an ambiguous reserved worktree after restart without deleting it and stays idempotent", () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = registry.create({
      scope,
      missionId: "mission-reserved-ambiguous",
      taskId: "task-reserved-ambiguous",
      workerId: "worker-reserved-ambiguous",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    const runtime = registry.forScope(scope);
    const key = runtime.worktrees.scopeKey(scope);
    const snapshot = runtime.worktreeState.read(key);
    expect(
      runtime.worktreeState.compareAndSwap(
        key,
        snapshot.revision,
        snapshot.records.map((candidate) =>
          candidate.taskKey === record.taskKey
            ? { ...candidate, status: "reserved" as const }
            : candidate,
        ),
      ),
    ).toBe(true);
    fs.writeFileSync(
      path.join(record.worktreePath, "unproven-after-crash.txt"),
      "must not be trusted or deleted\n",
    );

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    const failed = reopened.get(scope, record.missionId, record.taskId);
    expect(failed).toMatchObject({
      status: "failed",
      failureReason: expect.stringMatching(/reserved|clean|reconcil/i),
    });
    expect(fs.existsSync(record.worktreePath)).toBe(true);
    expect(
      fs.existsSync(path.join(record.worktreePath, "unproven-after-crash.txt")),
    ).toBe(true);
    const revisionAfterRecovery = reopened
      .forScope(scope)
      .worktreeState.read(key).revision;

    manager.close(scope);
    const replay = new WorktreeRuntimeRegistry(manager);
    expect(replay.get(scope, record.missionId, record.taskId)?.status).toBe(
      "failed",
    );
    expect(replay.forScope(scope).worktreeState.read(key).revision).toBe(
      revisionAfterRecovery,
    );
  });

  it("fails a reservation interrupted before materialization without recreating artifacts", () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = registry.create({
      scope,
      missionId: "mission-reserved-empty",
      taskId: "task-reserved-empty",
      workerId: "worker-reserved-empty",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    const runtime = registry.forScope(scope);
    const key = runtime.worktrees.scopeKey(scope);
    const snapshot = runtime.worktreeState.read(key);
    expect(
      runtime.worktreeState.compareAndSwap(
        key,
        snapshot.revision,
        snapshot.records.map((candidate) =>
          candidate.taskKey === record.taskKey
            ? { ...candidate, status: "reserved" as const }
            : candidate,
        ),
      ),
    ).toBe(true);
    git(root, "worktree", "remove", record.worktreePath);
    git(root, "update-ref", "-d", record.branchRef);

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    expect(reopened.get(scope, record.missionId, record.taskId)).toMatchObject({
      status: "failed",
      failureReason: expect.stringMatching(/reserved|reconcil/i),
    });
    expect(fs.existsSync(record.worktreePath)).toBe(false);
    expect(() =>
      git(root, "show-ref", "--verify", "--quiet", record.branchRef),
    ).toThrow();
  });

  it("never promotes a reserved worktree after the integration base advances", () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = registry.create({
      scope,
      missionId: "mission-reserved-stale-base",
      taskId: "task-reserved-stale-base",
      workerId: "worker-reserved-stale-base",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    const runtime = registry.forScope(scope);
    const key = runtime.worktrees.scopeKey(scope);
    const snapshot = runtime.worktreeState.read(key);
    expect(
      runtime.worktreeState.compareAndSwap(
        key,
        snapshot.revision,
        snapshot.records.map((candidate) =>
          candidate.taskKey === record.taskKey
            ? { ...candidate, status: "reserved" as const }
            : candidate,
        ),
      ),
    ).toBe(true);
    fs.writeFileSync(path.join(root, "advanced.txt"), "new integration head\n");
    git(root, "add", "advanced.txt");
    git(root, "commit", "-qm", "advance integration base");

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    expect(reopened.get(scope, record.missionId, record.taskId)).toMatchObject({
      status: "failed",
      failureReason: expect.stringMatching(/primary checkout changed|frozen/i),
    });
    expect(fs.existsSync(record.worktreePath)).toBe(true);
    expect(git(record.worktreePath, "rev-parse", "HEAD")).toBe(record.baseSha);
  });

  it("quarantines a copied runtime binding before startup reconciliation", () => {
    const { scope, manager } = fixture();
    const original = new WorktreeRuntimeRegistry(manager);
    const record = original.create({
      scope,
      missionId: "mission-copied-runtime",
      taskId: "task-copied-runtime",
      workerId: "worker-copied-runtime",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    const runtimeDirectory = manager.locationFor(scope).directory;
    const copiedRuntime = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nexus-registry-copied-")),
    );
    roots.push(copiedRuntime);
    const copiedWorktree = path.join(
      copiedRuntime,
      "worktrees",
      path.relative(path.join(runtimeDirectory, "worktrees"), record.worktreePath),
    );
    fs.mkdirSync(copiedWorktree, { recursive: true });
    const userArtifact = path.join(copiedWorktree, "uncommitted.txt");
    fs.writeFileSync(userArtifact, "must survive quarantine\n");

    const db = manager.open(scope).db;
    const row = db
      .prepare(
        "SELECT scope_key, records_json FROM worktree_state WHERE scope_key = ?",
      )
      .get(record.scopeKey) as {
      scope_key: string;
      records_json: string;
    };
    const copiedRecords = (
      JSON.parse(row.records_json) as Array<Record<string, unknown>>
    ).map((candidate) => ({
      ...candidate,
      worktreePath: copiedWorktree,
    }));
    db.prepare(
      `UPDATE worktree_state
       SET records_json = ?, updated_at = updated_at + 1
       WHERE scope_key = ?`,
    ).run(JSON.stringify(copiedRecords), record.scopeKey);
    original.dispose();
    manager.close(scope);

    const reopened = new WorktreeRuntimeRegistry(manager);
    expect(
      reopened.listMission(scope, record.missionId),
    ).toEqual([]);
    expect(fs.readFileSync(userArtifact, "utf8")).toBe(
      "must survive quarantine\n",
    );
    expect(
      manager
        .open(scope)
        .db.prepare(
          `SELECT reason FROM worktree_state_quarantine
           WHERE scope_key = ?`,
        )
        .get(record.scopeKey),
    ).toEqual({ reason: "relocated-runtime-binding" });
  });
});
