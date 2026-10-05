import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import { ProjectRuntimeManager } from "./project-runtime-manager";
import { AGED_PANE_WORKTREE_GC, WorktreeRuntimeRegistry } from "./worktree-runtime-registry";
import {
  DEAD_OWNER_WORKTREE_RELEASE_MARKER,
  OwnershipOverlapError,
  worktreeTaskKey,
} from "./worktree-manager";
import { ScopedStoreBinding } from "../orch/scoped-store";
import { WorktreeManager } from './worktree-manager';
import { SqliteWorktreeStateStore } from './sqlite-workflow-state-stores';

const sweep = vi.hoisted(() => vi.fn());
const liveSession = vi.hoisted(() => vi.fn((_worktreePath: string) => false));
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

vi.mock('./worktree-pty-sweep', () => ({
  sweepPtysInsideWorktree: sweep,
  worktreeHasLiveSession: liveSession,
}));

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

/** Seeds a live mission row so scope reconstruction sees an owned block. */
function seedMission(
  manager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  missionId: string,
): void {
  new ScopedStoreBinding(manager, scope)
    .writeDatabase()
    .prepare(
      "INSERT OR IGNORE INTO missions " +
        "(id, title, status, created_at, updated_at) " +
        "VALUES (?, ?, 'running', 1, 1)",
    )
    .run(missionId, missionId);
}

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

async function createTrackedWorktree(
  registry: WorktreeRuntimeRegistry,
  manager: ProjectRuntimeManager,
  input: Parameters<WorktreeRuntimeRegistry["create"]>[0],
) {
  const now = Date.now();
  manager
    .open(input.scope)
    .db.prepare(
      `INSERT INTO tasks
         (id, mission_id, title, detail, status, created_at, updated_at)
       VALUES (?, NULL, ?, '', 'pending', ?, ?)`,
    )
    .run(input.taskId, input.taskId, now, now);
  return registry.create(input);
}

/**
 * Seeds the mission/task rows the dead-owner release sweep reads, mirroring
 * exactly what the dispatch store persists: a schedulable task under a
 * non-terminal mission keeps its worktree record active; terminal states
 * make the record eligible for release.
 */
function seedWorkState(
  manager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  input: {
    missionId: string;
    taskId: string;
    missionStatus: string;
    taskStatus: string;
  },
) {
  const now = Date.now();
  const db = manager.open(scope).db;
  db.prepare(
    `INSERT INTO missions (id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE
       SET status = excluded.status, updated_at = excluded.updated_at`,
  ).run(input.missionId, input.missionId, input.missionStatus, now, now);
  db.prepare(
    `INSERT INTO tasks
       (id, mission_id, title, detail, status, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE
       SET status = excluded.status, updated_at = excluded.updated_at`,
  ).run(input.taskId, input.missionId, input.taskId, input.taskStatus, now, now);
}

afterEach(() => {
  sweep.mockClear();
  liveSession.mockReset();
  liveSession.mockReturnValue(false);
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("project worktree runtime registry", () => {
  it.runIf(process.platform === 'darwin')('creates noindex worktrees while preserving a legacy dirty worktree across restart', async () => {
    const { scope, manager } = fixture();
    const runtimeRoot = manager.locationFor(scope).directory;
    seedWorkState(manager, scope, { missionId: 'legacy-mission', taskId: 'legacy-task', missionStatus: 'running', taskStatus: 'pending' });
    const legacy = new WorktreeManager({ runtimeRoot, worktreesRoot: path.join(runtimeRoot, 'worktrees'),
      stateStore: new SqliteWorktreeStateStore(manager, scope) });
    const original = await legacy.create({ scope, missionId: 'legacy-mission', taskId: 'legacy-task', workerId: 'legacy-worker',
      ownership: { files: ['legacy.txt'], symbols: [], domains: [] } });
    fs.writeFileSync(path.join(original.worktreePath, 'legacy.txt'), 'uncommitted operator work');
    const registry = new WorktreeRuntimeRegistry(manager);
    const restored = registry.get(scope, 'legacy-mission', 'legacy-task');
    expect(restored?.worktreePath).toBe(original.worktreePath);
    expect(fs.readFileSync(path.join(original.worktreePath, 'legacy.txt'), 'utf8')).toBe('uncommitted operator work');
    const fresh = await createTrackedWorktree(registry, manager, { scope, missionId: 'new-mission', taskId: 'new-task', workerId: 'new-worker',
      ownership: { files: ['new.txt'], symbols: [], domains: [] } });
    expect(fresh.worktreePath).toContain(`${path.sep}worktrees.noindex${path.sep}`);
    expect(fs.existsSync(path.join(original.worktreePath, 'legacy.txt'))).toBe(true);
    registry.dispose();
    const restarted = new WorktreeRuntimeRegistry(manager);
    expect(restarted.get(scope, 'legacy-mission', 'legacy-task')?.worktreePath).toBe(original.worktreePath);
    expect(fs.readFileSync(path.join(original.worktreePath, 'legacy.txt'), 'utf8')).toBe('uncommitted operator work');
    restarted.dispose();
  });
  it("keeps pane writers through task sweeps and releases their claims after restart without deleting output", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    seedMission(manager, scope, "quick-mission");
    const createPane = (workerId: string) => registry.create({
      scope, missionId: "quick-mission", taskId: `pane-${workerId}`, workerId,
      ownerKind: "pane",
      ownership: { files: [], symbols: [], domains: [workerId] },
    });
    const first = await createPane("worker-a");
    await createPane("worker-b");
    expect(registry.listMission(scope, "quick-mission")).toHaveLength(2);
    expect(registry.get(scope, "quick-mission", first.taskId)?.status).toBe("ready");
    fs.writeFileSync(path.join(first.worktreePath, "untracked.txt"), "keep me");
    registry.dispose();
    const restarted = new WorktreeRuntimeRegistry(manager);
    expect(restarted.listMission(scope, "quick-mission").every((r) => r.status === "failed")).toBe(true);
    expect(fs.readFileSync(path.join(first.worktreePath, "untracked.txt"), "utf8")).toBe("keep me");
    expect(git(root, "rev-parse", first.branchRef)).toBe(first.baseSha);
    restarted.dispose();
  });

  it("resolves a physically validated no-change QA task without inventing a merge entry", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, "rev-parse", "HEAD");
    const record = await createTrackedWorktree(registry, manager, {
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

  it("re-anchors a claim-time advisory worktree to the integrated HEAD on (re)bind", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const advisor = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: "mission-advisory-reanchor",
      taskId: "advisor-read-only",
      workerId: "advisor",
      ownership: {
        files: [],
        symbols: [],
        domains: ["review-only"],
      },
    });
    expect(advisor.baseSha).toBe(git(root, "rev-parse", "HEAD"));
    // A sibling executor integrates before the advisor session is (re)bound.
    fs.writeFileSync(path.join(root, "owned.txt"), "integrated\n");
    git(root, "add", "owned.txt");
    git(root, "commit", "-qm", "integrated result");
    const integratedHead = git(root, "rev-parse", "HEAD");

    const reanchored = registry.reanchorReadyWorktreeToIntegrationHead(
      scope,
      advisor.missionId,
      advisor.taskId,
    );

    expect(reanchored).toMatchObject({
      id: advisor.id,
      status: "ready",
      baseSha: integratedHead,
    });
    // The physical handoff boundary reads exactly this HEAD for the receipt.
    expect(git(advisor.worktreePath, "rev-parse", "HEAD")).toBe(
      integratedHead,
    );
    expect(
      registry.get(scope, advisor.missionId, advisor.taskId),
    ).toMatchObject({ status: "ready", baseSha: integratedHead });
  });

  it("resolves a disposable no-change task validated after an executor merge across restart", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, "rev-parse", "HEAD");
    const disposable = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: "mission-disposable-after-merge",
      taskId: "review-read-only",
      workerId: "reviewer",
      ownership: {
        files: [],
        symbols: [],
        domains: ["review-only"],
      },
    });
    const executor = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: disposable.missionId,
      taskId: "executor",
      workerId: "executor",
      ownership: {
        files: ["owned.txt"],
        symbols: [],
        domains: ["implementation"],
      },
    });
    fs.writeFileSync(path.join(executor.worktreePath, "owned.txt"), "changed\n");
    git(executor.worktreePath, "add", "owned.txt");
    git(executor.worktreePath, "commit", "-qm", "executor change");
    const merged = await registry.enqueue({
      scope,
      missionId: executor.missionId,
      taskId: executor.taskId,
      validate: () => ({
        sensorsPassed: true,
        reviewPassed: true,
        evidenceIds: ["executor-evidence"],
      }),
    });
    const prepared = registry.prepareDiscardedNoChangeValidation(
      scope,
      disposable.missionId,
      disposable.taskId,
    );
    expect(prepared).toMatchObject({
      taskHeadSha: baseSha,
      integrationHeadSha: merged.integratedSha,
      changedFiles: [],
    });
    registry.markDiscardedNoChange(
      scope,
      disposable.missionId,
      disposable.taskId,
      prepared!.taskHeadSha,
      prepared!.integrationHeadSha,
    );

    expect(
      registry.resolveIntegratedMission(scope, disposable.missionId, baseSha),
    ).toMatchObject({
      baseSha,
      headSha: merged.integratedSha,
    });

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    expect(
      reopened.resolveIntegratedMission(scope, disposable.missionId, baseSha),
    ).toMatchObject({
      baseSha,
      headSha: merged.integratedSha,
    });
  });

  it("revalidates multiple disposable records against their current integration ancestry", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, "rev-parse", "HEAD");
    const firstDisposable = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: "mission-multiple-disposable",
      taskId: "review-first",
      workerId: "reviewer-first",
      ownership: {
        files: [],
        symbols: [],
        domains: ["review-first"],
      },
    });
    const secondDisposable = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: firstDisposable.missionId,
      taskId: "review-second",
      workerId: "reviewer-second",
      ownership: {
        files: [],
        symbols: [],
        domains: ["review-second"],
      },
    });
    const firstExecutor = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: firstDisposable.missionId,
      taskId: "executor-first",
      workerId: "executor-first",
      ownership: {
        files: ["owned.txt"],
        symbols: [],
        domains: ["implementation-first"],
      },
    });
    fs.writeFileSync(
      path.join(firstExecutor.worktreePath, "owned.txt"),
      "first\n",
    );
    git(firstExecutor.worktreePath, "add", "owned.txt");
    git(firstExecutor.worktreePath, "commit", "-qm", "first executor");
    const firstMerge = await registry.enqueue({
      scope,
      missionId: firstExecutor.missionId,
      taskId: firstExecutor.taskId,
      validate: () => ({
        sensorsPassed: true,
        reviewPassed: true,
        evidenceIds: ["first-executor-evidence"],
      }),
    });
    const firstPrepared = registry.prepareDiscardedNoChangeValidation(
      scope,
      firstDisposable.missionId,
      firstDisposable.taskId,
    );
    registry.markDiscardedNoChange(
      scope,
      firstDisposable.missionId,
      firstDisposable.taskId,
      firstPrepared!.taskHeadSha,
      firstPrepared!.integrationHeadSha,
    );

    const secondExecutor = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: firstDisposable.missionId,
      taskId: "executor-second",
      workerId: "executor-second",
      ownership: {
        files: ["second.txt"],
        symbols: [],
        domains: ["implementation-second"],
      },
    });
    fs.writeFileSync(
      path.join(secondExecutor.worktreePath, "second.txt"),
      "second\n",
    );
    git(secondExecutor.worktreePath, "add", "second.txt");
    git(secondExecutor.worktreePath, "commit", "-qm", "second executor");
    const secondMerge = await registry.enqueue({
      scope,
      missionId: secondExecutor.missionId,
      taskId: secondExecutor.taskId,
      validate: () => ({
        sensorsPassed: true,
        reviewPassed: true,
        evidenceIds: ["second-executor-evidence"],
      }),
    });
    const secondPrepared = registry.prepareDiscardedNoChangeValidation(
      scope,
      secondDisposable.missionId,
      secondDisposable.taskId,
    );
    registry.markDiscardedNoChange(
      scope,
      secondDisposable.missionId,
      secondDisposable.taskId,
      secondPrepared!.taskHeadSha,
      secondPrepared!.integrationHeadSha,
    );

    expect(firstPrepared?.integrationHeadSha).toBe(firstMerge.integratedSha);
    expect(secondPrepared?.integrationHeadSha).toBe(secondMerge.integratedSha);
    expect(
      registry.resolveIntegratedMission(
        scope,
        firstDisposable.missionId,
        baseSha,
      ),
    ).toMatchObject({
      baseSha,
      headSha: secondMerge.integratedSha,
    });
  });

  it("does not resolve a queue-less no-change record whose physical worktree changed", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, "rev-parse", "HEAD");
    const record = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: "mission-dirty-no-change",
      taskId: "review-dirty",
      workerId: "reviewer",
      ownership: {
        files: [],
        symbols: [],
        domains: ["review-only"],
      },
    });
    const prepared = registry.prepareNoChangeValidation(
      scope,
      record.missionId,
      record.taskId,
    );
    registry.markValidatedNoChange(
      scope,
      record.missionId,
      record.taskId,
      prepared!.taskHeadSha,
      prepared!.integrationHeadSha,
    );
    fs.writeFileSync(
      path.join(record.worktreePath, "untrusted-after-validation.txt"),
      "not part of the validated receipt\n",
    );

    expect(
      registry.resolveIntegratedMission(scope, record.missionId, baseSha),
    ).toBeNull();
  });

  it("does not resolve a queue-less no-change record with unrelated persisted integration ancestry", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, "rev-parse", "HEAD");
    const record = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: "mission-corrupt-no-change",
      taskId: "review-corrupt",
      workerId: "reviewer",
      ownership: {
        files: [],
        symbols: [],
        domains: ["review-only"],
      },
    });
    const prepared = registry.prepareNoChangeValidation(
      scope,
      record.missionId,
      record.taskId,
    );
    registry.markValidatedNoChange(
      scope,
      record.missionId,
      record.taskId,
      prepared!.taskHeadSha,
      prepared!.integrationHeadSha,
    );
    const treeSha = git(root, "rev-parse", "HEAD^{tree}");
    const unrelatedSha = git(root, "commit-tree", treeSha, "-m", "unrelated");
    const runtime = registry.forScope(scope);
    const key = runtime.worktrees.scopeKey(scope);
    let snapshot = runtime.worktreeState.read(key);
    expect(
      runtime.worktreeState.compareAndSwap(
        key,
        snapshot.revision,
        snapshot.records.map((candidate) =>
          candidate.taskKey === record.taskKey
            ? { ...candidate, integratedSha: unrelatedSha }
            : candidate,
        ),
      ),
    ).toBe(true);

    expect(
      registry.resolveIntegratedMission(scope, record.missionId, baseSha),
    ).toBeNull();

    const divergentDescendantSha = git(
      root,
      "commit-tree",
      treeSha,
      "-p",
      baseSha,
      "-m",
      "divergent descendant",
    );
    snapshot = runtime.worktreeState.read(key);
    expect(
      runtime.worktreeState.compareAndSwap(
        key,
        snapshot.revision,
        snapshot.records.map((candidate) =>
          candidate.taskKey === record.taskKey
            ? { ...candidate, integratedSha: divergentDescendantSha }
            : candidate,
        ),
      ),
    ).toBe(true);
    expect(
      registry.resolveIntegratedMission(scope, record.missionId, baseSha),
    ).toBeNull();
  });

  it("persists, validates, merges and resolves an exact integrated mission", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, "rev-parse", "HEAD");
    const record = await createTrackedWorktree(registry, manager, {
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

  it("automatically reconciles an interrupted active merge after reopening", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    // The interrupted merge belongs to a LIVE mission: reconstruction must
    // keep the reconciled block instead of retiring it as orphaned.
    seedMission(manager, scope, "mission-restart");
    const record = await createTrackedWorktree(registry, manager, {
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
      blocked: {
        taskKey: record.taskKey,
        disposition: "retryable",
      },
    });
    expect(recovered.mergeState.read(key).events.at(-1)?.type).toBe(
      "restart-reconciled",
    );
    expect(
      recovered.worktrees.get(scope, record.missionId, record.taskId)?.status,
    ).toBe("queued");
  });

  it("recovers an exact materialized reserved worktree after process restart", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = await createTrackedWorktree(registry, manager, {
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

  it("fails an ambiguous reserved worktree after restart without deleting it and stays idempotent", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = await createTrackedWorktree(registry, manager, {
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

  it("fails a reservation interrupted before materialization without recreating artifacts", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = await createTrackedWorktree(registry, manager, {
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

  it("never promotes a reserved worktree after the integration base advances", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = await createTrackedWorktree(registry, manager, {
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

  it("quarantines a copied runtime binding before startup reconciliation", async () => {
    const { scope, manager } = fixture();
    const original = new WorktreeRuntimeRegistry(manager);
    const record = await createTrackedWorktree(original, manager, {
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

  it("self-heals an ownership-overlap block left by a deleted mission's task, without a fresh registry", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const orphan = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: "mission-deleted",
      taskId: "task-deleted-owner",
      workerId: "worker-deleted-owner",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    // Simulate the owning mission being deleted after its worktree record
    // was already created: only the `tasks` row disappears, the same
    // long-lived registry instance still holds the stale worktree_state
    // record in memory (no new WorktreeRuntimeRegistry is constructed).
    manager
      .open(scope)
      .db.prepare("DELETE FROM tasks WHERE id = ?")
      .run(orphan.taskId);

    const successor = await createTrackedWorktree(registry, manager, {
      scope,
      missionId: "mission-successor",
      taskId: "task-successor-owner",
      workerId: "worker-successor-owner",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });

    expect(successor.taskId).toBe("task-successor-owner");
    expect(registry.listMission(scope, "mission-deleted")).toEqual([]);
  });

  it("releases ownership of a blocked mission's leftover worktree so a new overlapping dispatch proceeds", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    seedWorkState(manager, scope, {
      missionId: "mission-wedged",
      taskId: "task-wedged",
      missionStatus: "running",
      taskStatus: "running",
    });
    const wedged = await registry.create({
      scope,
      missionId: "mission-wedged",
      taskId: "task-wedged",
      workerId: "worker-wedged",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    expect(wedged.status).toBe("ready");
    // The exact persisted wedge: the merge terminally blocked the dispatch
    // (task failed) and the mission went blocked, but the worktree record
    // stayed `ready` with no active dispatch row.
    seedWorkState(manager, scope, {
      missionId: "mission-wedged",
      taskId: "task-wedged",
      missionStatus: "blocked",
      taskStatus: "failed",
    });

    seedWorkState(manager, scope, {
      missionId: "mission-new",
      taskId: "task-new",
      missionStatus: "running",
      taskStatus: "pending",
    });
    const successor = await registry.create({
      scope,
      missionId: "mission-new",
      taskId: "task-new",
      workerId: "worker-new",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });

    expect(successor.status).toBe("ready");
    // The leftover stays on disk — released with the marker so a later
    // resume can provably resurrect it — but no longer exerts ownership.
    expect(registry.listMission(scope, "mission-wedged")).toMatchObject([
      {
        taskId: "task-wedged",
        status: "failed",
        failureReason: expect.stringContaining(
          DEAD_OWNER_WORKTREE_RELEASE_MARKER,
        ),
      },
    ]);
    expect(fs.existsSync(wedged.worktreePath)).toBe(true);
    // A new tab/dispatch may retire an old task: never reap the operator's
    // processes in the coordination checkout while releasing that task.
    expect(sweep).toHaveBeenCalledWith(wedged.worktreePath);
    expect(sweep).not.toHaveBeenCalledWith(scope.rootRealPath);
  });

  it("keeps blocking an overlapping dispatch while the owning mission is active", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    seedWorkState(manager, scope, {
      missionId: "mission-active",
      taskId: "task-active",
      missionStatus: "running",
      taskStatus: "running",
    });
    const active = await registry.create({
      scope,
      missionId: "mission-active",
      taskId: "task-active",
      workerId: "worker-active",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    seedWorkState(manager, scope, {
      missionId: "mission-contender",
      taskId: "task-contender",
      missionStatus: "running",
      taskStatus: "pending",
    });

    await expect(
      registry.create({
        scope,
        missionId: "mission-contender",
        taskId: "task-contender",
        workerId: "worker-contender",
        ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
      }),
    ).rejects.toBeInstanceOf(OwnershipOverlapError);
    await expect(
      registry.create({
        scope,
        missionId: "mission-contender",
        taskId: "task-contender",
        workerId: "worker-contender",
        ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
      }),
    ).rejects.toMatchObject({
      conflictingTaskKey: worktreeTaskKey("mission-active", "task-active"),
    });
    expect(active.status).toBe("ready");
  });

  it("keeps the worktree reusable for the same mission's retry while it is blocked", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    seedWorkState(manager, scope, {
      missionId: "mission-retry",
      taskId: "task-retry",
      missionStatus: "running",
      taskStatus: "running",
    });
    const input = {
      scope,
      missionId: "mission-retry",
      taskId: "task-retry",
      workerId: "worker-retry",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    } as const;
    const original = await registry.create(input);
    // Technical bootstrap failure lane: the dispatch store blocks the task
    // and the mission while deliberately keeping the physical worktree. The
    // same-task retry sweeps the claim and provably resurrects the record.
    seedWorkState(manager, scope, {
      missionId: "mission-retry",
      taskId: "task-retry",
      missionStatus: "blocked",
      taskStatus: "failed",
    });

    const retained = await registry.create(input);
    expect(retained).toMatchObject({
      id: original.id,
      status: "ready",
      worktreePath: original.worktreePath,
      branchRef: original.branchRef,
    });
    expect(retained.failureReason).toBeUndefined();

    // requeueTechnicalBootstrapFailure persists task pending + mission
    // running again; the retry still reuses the exact same record.
    seedWorkState(manager, scope, {
      missionId: "mission-retry",
      taskId: "task-retry",
      missionStatus: "running",
      taskStatus: "pending",
    });
    const retried = await registry.create(input);
    expect(retried).toMatchObject({ id: original.id, status: "ready" });
  });

  it("lets the reroute substitute reclaim the dead owner's reservation", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    seedWorkState(manager, scope, {
      missionId: "mission-reroute",
      taskId: "task-reroute",
      missionStatus: "running",
      taskStatus: "running",
    });
    const original = await registry.create({
      scope,
      missionId: "mission-reroute",
      taskId: "task-reroute",
      workerId: "E2E Advisor Claude",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    // O caminho do reroute libera a reserva da encarnação morta com o
    // marcador de dono-morto (releaseRerouteWorktreeClaim).
    registry.markFailed(
      scope,
      "mission-reroute",
      "task-reroute",
      `${DEAD_OWNER_WORKTREE_RELEASE_MARKER} provider claude morto; reserva ` +
        "liberada para E2E Advisor Grok reclamar via reroute do roster selado",
    );

    // O agente SUBSTITUTO reclama a mesma reserva — antes disto o claim
    // re-roteado morria para sempre em WorktreeWorkerConflictError.
    const reclaimed = await registry.create({
      scope,
      missionId: "mission-reroute",
      taskId: "task-reroute",
      workerId: "E2E Advisor Grok",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    expect(reclaimed).toMatchObject({
      id: original.id,
      status: "ready",
      worktreePath: original.worktreePath,
    });
  });

  it("still refuses a different worker when the release lacks the dead-owner marker", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    seedWorkState(manager, scope, {
      missionId: "mission-guarded",
      taskId: "task-guarded",
      missionStatus: "running",
      taskStatus: "running",
    });
    await registry.create({
      scope,
      missionId: "mission-guarded",
      taskId: "task-guarded",
      workerId: "worker-vivo",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });
    registry.markFailed(
      scope,
      "mission-guarded",
      "task-guarded",
      "falha comum sem marcador de dono-morto",
    );

    await expect(
      registry.create({
        scope,
        missionId: "mission-guarded",
        taskId: "task-guarded",
        workerId: "worker-intruso",
        ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
      }),
    ).rejects.toThrow(/already owned by another worker/i);
  });

  it("stays fail-closed when a resumed mission's kept record now overlaps a live claim", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    seedWorkState(manager, scope, {
      missionId: "mission-resumed",
      taskId: "task-resumed",
      missionStatus: "running",
      taskStatus: "running",
    });
    const input = {
      scope,
      missionId: "mission-resumed",
      taskId: "task-resumed",
      workerId: "worker-resumed",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    } as const;
    await registry.create(input);
    seedWorkState(manager, scope, {
      missionId: "mission-resumed",
      taskId: "task-resumed",
      missionStatus: "blocked",
      taskStatus: "failed",
    });
    // While the mission was blocked, another mission legitimately claimed
    // the overlapping surface.
    seedWorkState(manager, scope, {
      missionId: "mission-claimer",
      taskId: "task-claimer",
      missionStatus: "running",
      taskStatus: "running",
    });
    await registry.create({
      scope,
      missionId: "mission-claimer",
      taskId: "task-claimer",
      workerId: "worker-claimer",
      ownership: { files: ["owned.txt"], symbols: [], domains: ["core"] },
    });

    // Resuming must not silently resurrect the stale claim over the live one.
    seedWorkState(manager, scope, {
      missionId: "mission-resumed",
      taskId: "task-resumed",
      missionStatus: "running",
      taskStatus: "pending",
    });
    await expect(registry.create(input)).rejects.toMatchObject({
      name: "OwnershipOverlapError",
      conflictingTaskKey: worktreeTaskKey("mission-claimer", "task-claimer"),
    });
    // The stale claim stays released on disk; nothing was resurrected.
    expect(registry.listMission(scope, "mission-resumed")).toMatchObject([
      {
        taskId: "task-resumed",
        status: "failed",
        failureReason: expect.stringContaining(
          DEAD_OWNER_WORKTREE_RELEASE_MARKER,
        ),
      },
    ]);
  });
});

describe("F-908: coleta de worktrees de writers paradas", () => {
  const NOW = { minIdleMs: 0 };

  async function paneWriter(
    registry: WorktreeRuntimeRegistry,
    scope: ProjectExecutionScope,
    missionId: string,
    id: string,
    commit?: string,
  ) {
    const record = await registry.create({
      scope, missionId, taskId: `pane-${id}`, workerId: id, ownerKind: "pane",
      ownership: { files: [], symbols: [], domains: [`pane-${id}`] },
    });
    if (commit) {
      fs.writeFileSync(path.join(record.worktreePath, commit), `${commit}\n`);
      git(record.worktreePath, "add", commit);
      git(record.worktreePath, "commit", "-qm", commit);
    }
    registry.markFailed(scope, missionId, record.taskId, "pane closed");
    return record;
  }

  function setMission(manager: ProjectRuntimeManager, scope: ProjectExecutionScope, id: string, status: string) {
    manager.open(scope).db.prepare(
      `INSERT INTO missions (id, title, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
    ).run(id, id, status);
  }

  const branchExists = (root: string, ref: string) => {
    try { git(root, "rev-parse", "--verify", "--quiet", ref); return true; } catch { return false; }
  };
  const salvageRefs = (root: string) =>
    git(root, "for-each-ref", "--format=%(refname)", "refs/nexus-salvage/").split("\n").filter(Boolean);

  it("remove o writer de missão integrado e limpo: pasta, branch e registro", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    setMission(manager, scope, "mission-done", "done");
    const record = await paneWriter(registry, scope, "mission-done", "a", "a.txt");
    git(root, "merge", "-q", "--no-edit", record.branchRef.slice("refs/heads/".length));
    const report = await registry.collectAgedPaneWriterWorktrees(scope, NOW);
    expect(report.removed.map((r) => r.taskId)).toEqual([record.taskId]);
    expect(fs.existsSync(record.worktreePath)).toBe(false);
    expect(branchExists(root, record.branchRef)).toBe(false);
    expect(registry.listMission(scope, "mission-done")).toEqual([]);
    expect(salvageRefs(root)).toEqual([]);
    registry.dispose();
  });

  it("worktree suja ganha a salvaguarda F-794 e FICA; limpa não mesclada sai e a branch fica", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    setMission(manager, scope, "mission-failed", "failed");
    const dirty = await paneWriter(registry, scope, "mission-failed", "d", "d.txt");
    fs.writeFileSync(path.join(dirty.worktreePath, "owned.txt"), "wip tracked\n");
    fs.writeFileSync(path.join(dirty.worktreePath, "novo.txt"), "só existe aqui\n");
    const clean = await paneWriter(registry, scope, "mission-failed", "c", "c.txt");
    const report = await registry.collectAgedPaneWriterWorktrees(scope, NOW);
    expect(report.removed.map((r) => r.taskId)).toEqual([clean.taskId]);
    expect(report.kept).toEqual({ "dirty-kept": 1 });
    expect(fs.readFileSync(path.join(dirty.worktreePath, "novo.txt"), "utf8")).toBe("só existe aqui\n");
    const [ref] = salvageRefs(root);
    expect(ref).toMatch(/^refs\/nexus-salvage\/nexus\//);
    expect(git(root, "show", `${ref}:novo.txt`)).toBe("só existe aqui");
    expect(git(root, "show", `${ref}:owned.txt`)).toBe("wip tracked");
    expect(fs.existsSync(clean.worktreePath)).toBe(false);
    expect(git(root, "show", `${clean.branchRef}:c.txt`)).toBe("c.txt");
    registry.dispose();
  });

  it("missão viva, sessão viva dentro ou liberação recente mantêm a worktree", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    setMission(manager, scope, "mission-live", "running");
    setMission(manager, scope, "mission-done", "done");
    const live = await paneWriter(registry, scope, "mission-live", "live");
    const busy = await paneWriter(registry, scope, "mission-done", "busy");
    liveSession.mockImplementation((worktreePath) => worktreePath === busy.worktreePath);
    expect((await registry.collectAgedPaneWriterWorktrees(scope, NOW)).removed).toEqual([]);
    liveSession.mockReturnValue(false);
    // Processo real que fez `cd` para dentro (cwd ATUAL, provado por lsof/procfs).
    if (process.platform !== "win32") {
      fs.mkdirSync(path.join(busy.worktreePath, "sub"));
      const shell = spawn("sleep", ["30"], { cwd: path.join(busy.worktreePath, "sub"), stdio: "ignore" });
      try {
        await new Promise((resolve) => shell.once("spawn", resolve));
        expect((await registry.collectAgedPaneWriterWorktrees(scope, NOW)).removed).toEqual([]);
      } finally {
        shell.kill("SIGKILL");
        await new Promise((resolve) => shell.once("exit", resolve));
      }
      fs.rmdirSync(path.join(busy.worktreePath, "sub"));
      expect((await registry.collectAgedPaneWriterWorktrees(scope, NOW)).removed.map((r) => r.taskId))
        .toEqual([busy.taskId]);
    }
    // Idade mínima padrão (24 h): acabou de ser liberada, não é candidata.
    expect((await registry.collectAgedPaneWriterWorktrees(scope)).removed).toEqual([]);
    expect(fs.existsSync(live.worktreePath)).toBe(true);
    expect(registry.listMission(scope, "mission-live")).toHaveLength(1);
    registry.dispose();
  });

  it("respeita o teto de candidatos por rodada", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const records = [];
    for (const id of ["c1", "c2", "c3"]) records.push(await paneWriter(registry, scope, "operator-hand", id));
    const first = await registry.collectAgedPaneWriterWorktrees(scope, { ...NOW, maxCandidates: 2 });
    expect(first.removed).toHaveLength(2);
    expect(first.deferred).toBe(1);
    expect(records.filter((r) => fs.existsSync(r.worktreePath))).toHaveLength(1);
    const expired = await registry.collectAgedPaneWriterWorktrees(scope, { ...NOW, budgetMs: 0 });
    expect(expired).toMatchObject({ removed: [], deferred: 1 });
    registry.dispose();
  });

  it("recusa symlink no lugar da worktree e caminho que sai da raiz gerenciada", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const swapped = await paneWriter(registry, scope, "operator-hand", "link");
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gc-outside-")));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, "alvo.txt"), "não pode sumir");
    fs.renameSync(swapped.worktreePath, `${swapped.worktreePath}.moved`);
    fs.symlinkSync(outside, swapped.worktreePath);
    const report = await registry.collectAgedPaneWriterWorktrees(scope, NOW);
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual({ "not-a-directory": 1 });
    expect(fs.readFileSync(path.join(outside, "alvo.txt"), "utf8")).toBe("não pode sumir");
    // Diretório pai trocado por symlink: o caminho real sai da raiz gerenciada.
    fs.unlinkSync(swapped.worktreePath);
    const parent = path.dirname(swapped.worktreePath);
    fs.renameSync(parent, `${parent}.moved`);
    fs.mkdirSync(path.join(outside, "checkout"));
    fs.renameSync(`${parent}.moved/${path.basename(swapped.worktreePath)}.moved`,
      path.join(outside, "checkout", path.basename(swapped.worktreePath)));
    fs.symlinkSync(path.join(outside, "checkout"), parent);
    expect((await registry.collectAgedPaneWriterWorktrees(scope, NOW)).kept).toEqual({ "path-mismatch": 1 });
    expect(fs.existsSync(path.join(outside, "checkout", path.basename(swapped.worktreePath), "owned.txt"))).toBe(true);
    registry.dispose();
  });

  it("faz prune só quando todo prunable é registro Nexus atual", async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    setMission(manager, scope, "mission-live", "running");
    const gone = await paneWriter(registry, scope, "mission-live", "gone");
    fs.rmSync(gone.worktreePath, { recursive: true, force: true });
    expect(git(root, "worktree", "list", "--porcelain")).toContain("prunable");
    const report = await registry.collectAgedPaneWriterWorktrees(scope, NOW);
    expect(report.prune).toEqual({ pruned: 1 });
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("prunable");
    // Worktree do operador fora da raiz gerenciada: o prune tudo-ou-nada não roda.
    const foreign = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gc-foreign-"))), "wt");
    roots.push(path.dirname(foreign));
    git(root, "worktree", "add", "-q", "-b", "operator-own", foreign);
    fs.rmSync(foreign, { recursive: true, force: true });
    expect((await registry.collectAgedPaneWriterWorktrees(scope, NOW)).prune)
      .toEqual({ skipped: "prunable-not-nexus" });
    expect(git(root, "worktree", "list", "--porcelain")).toContain("prunable");
    git(root, "worktree", "prune");
    // Worktree manual DENTRO da raiz gerenciada, com caminho no formato exato
    // do Nexus mas sem registro: formato não é proveniência, não é esquecida.
    const manual = path.join(path.dirname(path.dirname(path.dirname(gone.worktreePath))),
      `project-${"a".repeat(64)}`, `checkout-${"b".repeat(64)}`, `task-${"c".repeat(64)}`);
    git(root, "worktree", "add", "-q", "-b", "operator-manual", manual);
    fs.rmSync(manual, { recursive: true, force: true });
    expect((await registry.collectAgedPaneWriterWorktrees(scope, NOW)).prune)
      .toEqual({ skipped: "prunable-not-nexus" });
    expect(git(root, "worktree", "list", "--porcelain")).toContain(manual);
    registry.dispose();
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "GC estrito do fim do pane também exige a prova de cwd real do SO",
    async () => {
      const { root, scope, manager } = fixture();
      const registry = new WorktreeRuntimeRegistry(manager);
      setMission(manager, scope, "mission-live", "running");
      const record = await paneWriter(registry, scope, "mission-live", "s", "s.txt");
      git(root, "merge", "-q", "--no-edit", record.branchRef.slice("refs/heads/".length));
      const shell = spawn("sleep", ["30"], { cwd: record.worktreePath, stdio: "ignore" });
      try {
        await new Promise((resolve) => shell.once("spawn", resolve));
        expect(await registry.collectIntegratedPaneWorktrees(scope, "mission-live", () => false)).toEqual([]);
        expect(fs.existsSync(record.worktreePath)).toBe(true);
      } finally {
        shell.kill("SIGKILL");
        await new Promise((resolve) => shell.once("exit", resolve));
      }
      expect((await registry.collectIntegratedPaneWorktrees(scope, "mission-live", () => false))
        .map((r) => r.taskId)).toEqual([record.taskId]);
      registry.dispose();
    },
  );

  it("rodada que bateu no teto agenda continuação limitada, sem esperar o re-arme", async () => {
    const { scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    vi.useFakeTimers();
    try {
      const deferred = { removed: [], kept: {}, deferred: 3, prune: { pruned: 0 } };
      const collect = vi.spyOn(registry, "collectAgedPaneWriterWorktrees").mockResolvedValue(deferred);
      registry.scheduleAgedPaneWriterGc(scope);
      await vi.advanceTimersByTimeAsync(AGED_PANE_WORKTREE_GC.delayMs);
      expect(collect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(AGED_PANE_WORKTREE_GC.continuationDelayMs);
      expect(collect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(
        AGED_PANE_WORKTREE_GC.continuationDelayMs * (AGED_PANE_WORKTREE_GC.maxContinuations + 3));
      expect(collect).toHaveBeenCalledTimes(1 + AGED_PANE_WORKTREE_GC.maxContinuations);
      // Sem adiados, não há continuação.
      collect.mockClear();
      collect.mockResolvedValue({ ...deferred, deferred: 0 });
      vi.setSystemTime(Date.now() + AGED_PANE_WORKTREE_GC.rearmMs);
      registry.scheduleAgedPaneWriterGc(scope);
      await vi.advanceTimersByTimeAsync(AGED_PANE_WORKTREE_GC.delayMs + AGED_PANE_WORKTREE_GC.continuationDelayMs * 3);
      expect(collect).toHaveBeenCalledTimes(1);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });
});
