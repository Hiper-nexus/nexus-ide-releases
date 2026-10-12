import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  DEAD_OWNER_WORKTREE_RELEASE_MARKER,
  OwnershipOverlapError,
  OwnershipViolationError,
  ProcessGitRunner,
  WorktreeManager,
  WorktreeWorkerConflictError,
  type GitRunOptions,
  type GitRunner,
  type GitResult,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "./worktree-manager";
import { rollbackIntegrationCheckout } from "./merge-integration-rollback";
import { AsyncProcessGitRunner } from "./git-command";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

class MemoryWorktreeStateStore implements WorktreeStateStore {
  readonly #states = new Map<string, WorktreeStateSnapshot>();

  read(scopeKey: string): WorktreeStateSnapshot {
    return this.#states.get(scopeKey) ?? { revision: 0, records: [] };
  }

  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean {
    const current = this.read(scopeKey);
    if (current.revision !== expectedRevision) return false;
    this.#states.set(scopeKey, {
      revision: current.revision + 1,
      records: structuredClone(records),
    });
    return true;
  }

  overwrite(scopeKey: string, records: readonly WorktreeRecord[]): void {
    const current = this.read(scopeKey);
    this.#states.set(scopeKey, {
      revision: current.revision + 1,
      records: structuredClone(records),
    });
  }
}

class RecordingGitRunner implements GitRunner {
  readonly calls: Array<{ cwd: string; args: readonly string[] }> = [];
  readonly #delegate = new ProcessGitRunner();

  run(
    cwd: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): GitResult {
    this.calls.push({ cwd, args: [...args] });
    return this.#delegate.run(cwd, args, options);
  }
}

let tempDir = "";
let root = "";
let runtimeRoot = "";
let stateStore: MemoryWorktreeStateStore;
let gitRunner: RecordingGitRunner;
let manager: WorktreeManager;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(
  relativePath: string,
  content: string,
  cwd: string = root,
): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function projectScope(
  rootRealPath: string = fs.realpathSync(root),
): ProjectExecutionScope {
  return {
    version: 1,
    installationId: "installation-test",
    projectId: PROJECT_ID,
    checkoutId: "checkout-worktree-test",
    rootRealPath,
    identitySource: "manifest",
  };
}

function makeManager(): WorktreeManager {
  return new WorktreeManager({
    runtimeRoot,
    stateStore,
    gitRunner,
    now: () => 1_700_000_000_000,
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-worktree-manager-"));
  root = path.join(tempDir, "repo");
  runtimeRoot = path.join(tempDir, "runtime");
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Nexus Test");
  git(root, "config", "user.email", "nexus@example.test");
  write("src/shared.ts", "export const base = 1;\n");
  write("README.md", "# Test\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  stateStore = new MemoryWorktreeStateStore();
  gitRunner = new RecordingGitRunner();
  manager = makeManager();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("WorktreeManager", () => {
  it("F-764: cria e reutiliza a worktree sem executar Git síncrono", async () => {
    const asyncGit = new AsyncProcessGitRunner();
    let heartbeatDuringAdd = false;
    const responsive = new WorktreeManager({
      runtimeRoot, stateStore,
      gitRunner: { run: () => { throw new Error("Git síncrono no Main"); } },
      asyncGitRunner: { run: async (cwd, args, options) => {
        if (args[0] === "worktree" && args[1] === "add") {
          await new Promise<void>((resolve) => setTimeout(() => {
            heartbeatDuringAdd = true;
            resolve();
          }, 25));
        }
        return asyncGit.run(cwd, args, options);
      } },
    });
    const input = {
      scope: projectScope(), missionId: "f764", taskId: "async", workerId: "worker",
      ownership: { files: ["src/async.ts"], symbols: [], domains: [] },
    };
    const record = await responsive.create(input);
    expect(record.status).toBe("ready");
    expect(heartbeatDuringAdd).toBe(true);
    expect(git(record.worktreePath, "rev-parse", "HEAD")).toBe(record.baseSha);
    expect((await responsive.create(input)).id).toBe(record.id);
  });

  it("F-764: reserva encerrada durante a materialização nunca volta a ready", async () => {
    const scope = projectScope();
    await expect(manager.create({
      scope, missionId: "f764", taskId: "closed", workerId: "worker",
      ownership: { files: ["src/closed.ts"], symbols: [], domains: [] },
      onMaterialized: () => { manager.markFailed(scope, "f764", "closed", "pane closed"); },
    })).rejects.toThrow(/reservation.*changed/i);
    const record = manager.get(scope, "f764", "closed");
    expect(record?.status).toBe("failed");
    expect(record?.failureReason).toBe("pane closed");
    expect(fs.existsSync(record!.worktreePath)).toBe(true);
  });

  it("F-764: reutilização não entrega reserva encerrada durante a prova Git", async () => {
    const scope = projectScope();
    const asyncGit = new AsyncProcessGitRunner();
    let reusing = false;
    const replayManager = new WorktreeManager({
      runtimeRoot, stateStore,
      asyncGitRunner: { run: async (cwd, args, options) => {
        const result = await asyncGit.run(cwd, args, options);
        if (reusing && cwd !== scope.rootRealPath && args[0] === "status") {
          reusing = false;
          replayManager.markFailed(scope, "f764", "replay", "pane closed during proof");
        }
        return result;
      } },
    });
    const input = {
      scope, missionId: "f764", taskId: "replay", workerId: "worker",
      ownership: { files: ["src/replay.ts"], symbols: [], domains: [] },
    };
    await replayManager.create(input);
    reusing = true;
    await expect(replayManager.create(input)).rejects.toThrow(/reservation.*changed/i);
    expect(replayManager.get(scope, "f764", "replay")?.status).toBe("failed");
  });

  it.each([false, true])("F-764: ended same-worker create cannot mutate a new reservation (late error=%s)", async (lateError) => {
    const scope = projectScope();
    const context = new AsyncLocalStorage<string>();
    const real = new AsyncProcessGitRunner();
    let second!: Promise<WorktreeRecord>;
    let secondReads = 0;
    let materialized = false;
    let reserved!: () => void;
    const secondReserved = new Promise<void>((resolve) => { reserved = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const racing = new WorktreeManager({ runtimeRoot, stateStore, now: () => 1_700_000_000_000,
      asyncGitRunner: { run: async (cwd, args, options) => {
        if (context.getStore() === "second" && cwd === scope.rootRealPath && args.includes("--show-toplevel")) {
          if (++secondReads === 2) { reserved(); await held; }
        }
        if (context.getStore() === "first" && materialized && cwd !== scope.rootRealPath) {
          await secondReserved;
          if (lateError) throw new Error("old attempt proof failed");
        }
        return real.run(cwd, args, options);
      } },
    });
    const input = { scope, missionId: "aba", taskId: "same", workerId: "same-worker",
      ownership: { files: ["src/aba.ts"], symbols: [], domains: [] } };
    const first = context.run("first", () => racing.create({ ...input, onMaterialized: () => {
      materialized = true;
      racing.markFailed(scope, "aba", "same", DEAD_OWNER_WORKTREE_RELEASE_MARKER + " ended");
      second = context.run("second", () => racing.create(input));
      void second.catch(() => {});
    } }));
    // Settle the old call before releasing the new attempt's proof.
    const result = await first.then((record) => ({ record, error: undefined }),
      (error: unknown) => ({ record: undefined, error }));
    const pending = racing.get(scope, "aba", "same");
    release();
    const successor = await second.then((record) => ({ record, error: undefined }),
      (error: unknown) => ({ record: undefined, error }));
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toMatch(lateError ? /old attempt proof failed/ : /reservation.*changed/i);
    expect(pending?.status).toBe("reserved");
    expect(successor.error).toBeUndefined();
    expect(successor.record?.status).toBe("ready");
    expect(fs.existsSync(pending!.worktreePath)).toBe(true);
  });

  it.each(["reclaim", "retry"])("F-764: same-worker ready reuse rejects an ended and reopened generation (%s)", async (reopen) => {
    const scope = projectScope();
    const real = new AsyncProcessGitRunner();
    let replay = false;
    const racing = new WorktreeManager({ runtimeRoot, stateStore, now: () => 1_700_000_000_000,
      asyncGitRunner: { run: async (cwd, args, options) => {
        const result = await real.run(cwd, args, options);
        if (replay && cwd !== scope.rootRealPath && args[0] === "status") {
          replay = false;
          racing.markFailed(scope, "aba", "reuse", DEAD_OWNER_WORKTREE_RELEASE_MARKER + " ended");
          if (reopen === "reclaim") await racing.create(input);
          else racing.reopenFailedForRetry(scope, "aba", "reuse", git(cwd, "rev-parse", "HEAD"));
        }
        return result;
      } },
    });
    const input = { scope, missionId: "aba", taskId: "reuse", workerId: "same-worker",
      ownership: { files: ["src/aba.ts"], symbols: [], domains: [] } };
    const initial = await racing.create(input);
    if (reopen === "retry") {
      write("src/aba.ts", "export const retry = true;\n", initial.worktreePath);
      git(initial.worktreePath, "add", "src/aba.ts");
      git(initial.worktreePath, "commit", "-qm", "retry output");
    }
    replay = true;
    await expect(racing.create(input)).rejects.toThrow(/reservation.*changed/i);
    expect(racing.get(scope, "aba", "reuse")?.status).toBe("ready");
  });

  it.each(["initial", "branch", "materialized"])("F-764: revoked authority at %s cannot reserve/materialize/promote", async (phase) => {
    const scope = projectScope();
    const real = new AsyncProcessGitRunner();
    let revoked = false;
    let added = false;
    const guarded = new WorktreeManager({ runtimeRoot, stateStore,
      asyncGitRunner: { run: async (cwd, args, options) => {
        const result = await real.run(cwd, args, options);
        if ((phase === "initial" && args.includes("--show-toplevel")) ||
            (phase === "branch" && args[0] === "show-ref")) revoked = true;
        if (args[0] === "worktree" && args[1] === "add") added = true;
        return result;
      } },
    });
    await expect(guarded.create({ scope, missionId: "authority", taskId: "revoked", workerId: "worker",
      ownership: { files: ["src/revoked.ts"], symbols: [], domains: [] },
      assertCurrentAuthority: () => { if (revoked) throw new Error("session_authority_revoked"); },
      onMaterialized: () => { if (phase === "materialized") revoked = true; },
    } as Parameters<WorktreeManager["create"]>[0])).rejects.toThrow("session_authority_revoked");
    const record = guarded.get(scope, "authority", "revoked");
    expect(record?.status).toBe(phase === "initial" ? undefined : "failed");
    expect(added).toBe(phase === "materialized");
    if (phase === "materialized") {
      expect(fs.existsSync(record!.worktreePath)).toBe(true);
      expect(git(record!.worktreePath, "rev-parse", "HEAD")).toBe(record!.baseSha);
    }
  });

  it("F-764: integration rollback invalidates pre-integration reuse but queued rollback remains idempotent", async () => {
    const scope = projectScope();
    const real = new AsyncProcessGitRunner();
    let replay = false;
    const racing = new WorktreeManager({ runtimeRoot, stateStore, gitRunner, now: () => 1_700_000_000_000,
      asyncGitRunner: { run: async (cwd, args, options) => {
        const result = await real.run(cwd, args, options);
        if (replay && cwd !== scope.rootRealPath && args[0] === "status") {
          replay = false;
          git(root, "merge", "--ff-only", queued.branchRef);
          racing.markIntegrated(scope, "rollback", "task", taskHead);
          rollbackIntegrationCheckout({ scope, missionId: "rollback", taskId: "task",
            taskHeadSha: taskHead, integrationBaseSha: initial.baseSha, candidateSha: taskHead,
            record: queued, git: gitRunner, worktrees: racing });
        }
        return result;
      } },
    });
    const input = { scope, missionId: "rollback", taskId: "task", workerId: "same-worker",
      ownership: { files: ["src/rollback.ts"], symbols: [], domains: [] } };
    const initial = await racing.create(input);
    write("src/rollback.ts", "export const output = 1;\n", initial.worktreePath);
    git(initial.worktreePath, "add", "src/rollback.ts");
    git(initial.worktreePath, "commit", "-qm", "task output");
    const taskHead = git(initial.worktreePath, "rev-parse", "HEAD");
    const queued = racing.markQueued(scope, "rollback", "task", taskHead);
    expect(racing.restoreQueuedAfterIntegrationRollback(scope, "rollback", "task", taskHead, taskHead)
      .reservationGeneration).toBe(queued.reservationGeneration);
    replay = true;
    await expect(racing.create(input)).rejects.toThrow(/reservation.*changed/i);
    const retried = await racing.create(input);
    expect(retried.status).toBe("queued");
    expect(retried.reservationGeneration).not.toBe(queued.reservationGeneration);
    expect(git(root, "rev-parse", "HEAD")).toBe(initial.baseSha);
    expect(git(initial.worktreePath, "rev-parse", "HEAD")).toBe(taskHead);
  });

  it("F-764: legacy generations migrate on reuse, persist across bindings, and rotate on reopen", async () => {
    const scope = projectScope();
    const input = { scope, missionId: "operator-hand", taskId: "pane-legacy", workerId: "legacy-worker",
      ownerKind: "pane" as const, ownership: { files: [], symbols: [], domains: ["legacy"] } };
    const created = await manager.create(input);
    const { reservationGeneration: _generation, ...legacy } = created;
    stateStore.overwrite(manager.scopeKey(scope), [legacy]);
    expect(makeManager().get(scope, input.missionId, input.taskId)?.reservationGeneration).toBeUndefined();
    const reused = await makeManager().create(input);
    expect(reused.reservationGeneration).toEqual(expect.any(String));
    const bound = manager.bindPaneWriter(scope, input.missionId, input.taskId, { paneId: "p", sessionId: "s" });
    expect(bound.reservationGeneration).toBe(reused.reservationGeneration);
    manager.markFailed(scope, input.missionId, input.taskId, "pane closed");
    const reopened = makeManager().reopenPaneWriter(scope, input.missionId, input.taskId);
    expect(reopened.reservationGeneration).not.toBe(reused.reservationGeneration);
    expect(reopened.paneIds).toEqual(["p"]);
    expect(reopened.sessionIds).toEqual(["s"]);
    expect(reopened.worktreePath).toBe(created.worktreePath);
    stateStore.overwrite(manager.scopeKey(scope), [{ ...reopened, reservationGeneration: "forged" }]);
    expect(() => manager.get(scope, input.missionId, input.taskId)).toThrow("invalid worktree state record");
  });

  it("F-764: abort during initial Git proof leaves no reservation", async () => {
    const scope = projectScope();
    const real = new AsyncProcessGitRunner();
    const controller = new AbortController();
    const guarded = new WorktreeManager({ runtimeRoot, stateStore,
      asyncGitRunner: { run: async (cwd, args, options) => {
        const result = await real.run(cwd, args, options);
        controller.abort(new Error("invocation cancelled"));
        return result;
      } },
    });
    await expect(guarded.create({ scope, missionId: "abort", taskId: "task", workerId: "w",
      ownership: { files: ["abort.ts"], symbols: [], domains: [] }, signal: controller.signal,
    })).rejects.toThrow("invocation cancelled");
    expect(guarded.get(scope, "abort", "task")).toBeNull();
  });

  it("creates concurrent pane-owned branches from HEAD even with coordination WIP, and recovers reservations", async () => {
    const scope = projectScope();
    const head = git(root, "rev-parse", "HEAD");
    write("README.md", "operator WIP\n");
    const records = await Promise.all(["worker one/../", "worker two:*"].map((workerId) => manager.create({
      scope, missionId: "mission /..:*", taskId: `pane-${workerId}`, workerId,
      ownerKind: "pane",
      ownership: { files: [], symbols: [], domains: [workerId] },
    })));
    expect(new Set(records.map((r) => r.branchRef)).size).toBe(2);
    for (const record of records) {
      expect(record.branchRef).toMatch(/^refs\/heads\/nexus\/[a-f0-9]{16}\/[a-f0-9]{24}$/);
      expect(record.baseSha).toBe(head);
      expect(git(record.worktreePath, "rev-parse", "HEAD")).toBe(head);
    }
    stateStore.overwrite(manager.scopeKey(scope), records.map((r) => ({ ...r, status: "reserved" })));
    expect(makeManager().reconcileInterruptedReservations(scope).every((r) => r.status === "ready")).toBe(true);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("operator WIP\n");
    expect(manager.purgeRecordsWithoutTask(scope, new Set())).toHaveLength(0);
  });

  it("F-1253: writer encerrado num ref antigo não impede o próximo depois da troca de branch do checkout", async () => {
    const scope = projectScope();
    const old = await manager.create({ scope, missionId: "operator-hand", taskId: "pane-old", workerId: "old",
      ownerKind: "pane", ownership: { files: [], symbols: [], domains: ["pane-old"] } });
    manager.markFailed(scope, "operator-hand", "pane-old", "pane writer interrupted by application restart");
    git(root, "checkout", "-q", "-b", "feat/outra");
    const next = await makeManager().create({ scope, missionId: "operator-hand", taskId: "pane-next", workerId: "next",
      ownerKind: "pane", ownership: { files: [], symbols: [], domains: ["pane-next"] } });
    expect(old.integrationRef).toBe("refs/heads/main");
    expect(next.integrationRef).toBe("refs/heads/feat/outra");
    expect(manager.get(scope, "operator-hand", "pane-old")?.status).toBe("failed");
  });

  describe("F-1422: writers isolados paralelos enquanto a integração anda", () => {
    /** Avança `refs/heads/integ` com um commit novo, sem mexer no checkout. */
    function advanceInteg(message: string): string {
      const parent = git(root, "rev-parse", "refs/heads/integ");
      const tree = git(root, "rev-parse", `${parent}^{tree}`);
      const next = execFileSync("git", ["-C", root, "commit-tree", tree, "-p", parent, "-m", message], {
        encoding: "utf8",
      }).trim();
      git(root, "update-ref", "refs/heads/integ", next, parent);
      return next;
    }
    function paneWriter(m: WorktreeManager, id: string) {
      return m.create({ scope: projectScope(), missionId: "mission-94d90f5b", taskId: `pane-${id}`, workerId: id,
        ownerKind: "pane", baseRef: "integ", ownership: { files: [], symbols: [], domains: [`pane-${id}`] } });
    }

    beforeEach(() => {
      git(root, "branch", "integ");
    });

    it("writer A ativo na base X, a integ avança, writer B nasce na base Y", async () => {
      const a = await paneWriter(manager, "devin");
      const y = advanceInteg("cherry-pick novo na integ");
      const b = await paneWriter(makeManager(), "codex");
      expect(a.baseSha).not.toBe(b.baseSha);
      expect(b.baseSha).toBe(y);
      expect(a.integrationRef).toBe(b.integrationRef);
      expect(manager.get(projectScope(), "mission-94d90f5b", "pane-devin")?.status).toBe("ready");
    });

    it("o checkout de coordenação troca de branch com A ativo: B ainda nasce (caso de produção)", async () => {
      const a = await paneWriter(manager, "devin");
      advanceInteg("cherry-pick novo na integ");
      // Ao vivo: o checkout principal foi de feat/orc-outbox… para t3/t31/t32.
      git(root, "checkout", "-q", "-b", "t32");
      const b = await paneWriter(makeManager(), "codex");
      expect(a.integrationRef).toBe("refs/heads/main");
      expect(b.integrationRef).toBe("refs/heads/t32");
      expect(b.baseSha).toBe(git(root, "rev-parse", "refs/heads/integ"));
      const active = [
        manager.get(projectScope(), "mission-94d90f5b", "pane-devin"),
        manager.get(projectScope(), "mission-94d90f5b", "pane-codex"),
      ];
      expect(active.map((record) => record?.status)).toEqual(["ready", "ready"]);
      // Cada um integra só no próprio ref: A recusa enquanto o checkout não estiver nele.
      expect(() => manager.inspectIntegration(active[0]!)).toThrow(/integration branch changed/);
      expect(manager.inspectIntegration(active[1]!).integrationRef).toBe("refs/heads/t32");
    });

    it("raiz de checkout divergente continua recusada e diz qual valor e de quem", async () => {
      const a = await paneWriter(manager, "devin");
      const b = await paneWriter(manager, "agy");
      const scopeKey = manager.scopeKey(projectScope());
      stateStore.overwrite(scopeKey, [a, { ...b, rootRealPath: path.join(tempDir, "outra-raiz") }]);
      expect(() => makeManager().get(projectScope(), "mission-94d90f5b", "pane-devin")).toThrow(
        new RegExp(`checkout root: writer devin .*${a.rootRealPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, writer agy .*outra-raiz`),
      );
    });
  });

  it("vincula panes/sessões ao writer de pane de forma durável; registros antigos seguem válidos", async () => {
    const scope = projectScope();
    const [pane, task] = await Promise.all([
      manager.create({ scope, missionId: "operator-hand", taskId: "pane-w1", workerId: "w1",
        ownerKind: "pane", ownership: { files: [], symbols: [], domains: ["pane-w1"] } }),
      manager.create({ scope, missionId: "mission-a", taskId: "task-a", workerId: "wa",
        ownership: { files: ["src/a.ts"], symbols: [], domains: [] } }),
    ]);
    // Registro antigo (sem vínculo) lê normalmente.
    expect(pane.paneIds).toBeUndefined();
    manager.bindPaneWriter(scope, "operator-hand", "pane-w1", { paneId: "pane-1" });
    manager.bindPaneWriter(scope, "operator-hand", "pane-w1", { paneId: "pane-1", sessionId: "s-1" });
    manager.bindPaneWriter(scope, "operator-hand", "pane-w1", { paneId: "pane-2" });
    // Outro manager sobre o mesmo store (reinício) enxerga o vínculo.
    expect(makeManager().get(scope, "operator-hand", "pane-w1"))
      .toMatchObject({ paneIds: ["pane-1", "pane-2"], sessionIds: ["s-1"] });
    expect(() => manager.bindPaneWriter(scope, "mission-a", "task-a", { paneId: "pane-3" }))
      .toThrow(/only pane writer/);
    // Vínculo forjado em task selada ou com ids repetidos é estado inválido.
    const key = manager.scopeKey(scope);
    const current = stateStore.read(key).records;
    stateStore.overwrite(key, current.map((r) => r.taskId === task.taskId ? { ...r, paneIds: ["pane-x"] } : r));
    expect(() => manager.get(scope, "mission-a", "task-a")).toThrow();
    stateStore.overwrite(key, current.map((r) => r.taskId === pane.taskId ? { ...r, paneIds: ["p", "p"] } : r));
    expect(() => manager.get(scope, "operator-hand", "pane-w1")).toThrow();
  });

  it("GC de writers de pane roda em Git assíncrono e não deixa reabrir o writer em remoção", async () => {
    const scope = projectScope();
    const create = (id: string) => manager.create({ scope, missionId: "operator-hand", taskId: `pane-${id}`,
      workerId: id, ownerKind: "pane", ownership: { files: [], symbols: [], domains: [`pane-${id}`] } });
    const [merged, unmerged, dirty] = [await create("m"), await create("u"), await create("d")];
    for (const [record, file] of [[merged, "m.txt"], [unmerged, "u.txt"], [dirty, "d.txt"]] as const) {
      write(file, file, record.worktreePath);
      git(record.worktreePath, "add", file);
      git(record.worktreePath, "commit", "-qm", file);
      manager.markFailed(scope, "operator-hand", record.taskId, "pane closed");
    }
    git(root, "merge", "-q", "--no-edit", merged.branchRef.slice("refs/heads/".length));
    git(root, "merge", "-q", "--no-edit", dirty.branchRef.slice("refs/heads/".length));
    write("scratch.txt", "só existe aqui", dirty.worktreePath);
    let holdRemove!: () => void;
    const removeHeld = new Promise<void>((resolve) => { holdRemove = resolve; });
    let removing!: () => void;
    const removeStarted = new Promise<void>((resolve) => { removing = resolve; });
    const real = new AsyncProcessGitRunner();
    const gc = new WorktreeManager({ runtimeRoot, stateStore, gitRunner, now: () => 1_700_000_000_000,
      asyncGitRunner: { run: async (cwd, args, options) => {
        if (args[0] === "worktree" && args[1] === "remove") { removing(); await removeHeld; }
        return real.run(cwd, args, options);
      } } });
    const syncCallsBefore = gitRunner.calls.length;
    const collected = gc.collectIntegratedPaneWorktrees(scope, "operator-hand", () => false);
    await removeStarted;
    expect(() => gc.reopenPaneWriter(scope, "operator-hand", merged.taskId)).toThrow(/being collected/);
    holdRemove();
    expect((await collected).map((r) => r.taskId)).toEqual([merged.taskId]);
    expect(gitRunner.calls.slice(syncCallsBefore)).toEqual([]);
    expect(fs.existsSync(merged.worktreePath)).toBe(false);
    expect(fs.existsSync(unmerged.worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(dirty.worktreePath, "scratch.txt"), "utf8")).toBe("só existe aqui");
    expect(gc.get(scope, "operator-hand", unmerged.taskId)).not.toBeNull();
    expect(gc.get(scope, "operator-hand", dirty.taskId)).not.toBeNull();
  });

  it("F-980: writer de pane nasce do HEAD da aba (sem o WIP dela) e a GC aceita a branch integrada na aba", async () => {
    const scope = projectScope();
    const canonical = new WorktreeManager({ runtimeRoot: path.join(fs.realpathSync(tempDir), "runtime"),
      stateStore, gitRunner, now: () => 1_700_000_000_000 });
    const pane = (id: string) => ({ scope, missionId: "operator-hand", taskId: `pane-${id}`, workerId: id,
      ownerKind: "pane" as const, ownership: { files: [], symbols: [], domains: [`pane-${id}`] } });
    const tab = await canonical.create({ scope, missionId: "space-f954", taskId: "tab", workerId: "space-f954",
      ownerKind: "pane", ownership: { files: [], symbols: [], domains: ["space-f954"] } });
    write("tab.txt", "commit da aba\n", tab.worktreePath);
    git(tab.worktreePath, "add", "tab.txt");
    git(tab.worktreePath, "commit", "-qm", "tab work");
    write("README.md", "WIP da aba\n", tab.worktreePath);
    const tabHead = git(tab.worktreePath, "rev-parse", "HEAD");
    expect(tabHead).not.toBe(git(root, "rev-parse", "HEAD"));

    const writer = await canonical.create({ ...pane("w"), baseRootRealPath: tab.worktreePath });
    expect(writer.baseSha).toBe(tabHead);
    expect(writer.rootRealPath).toBe(scope.rootRealPath);
    expect(git(writer.worktreePath, "rev-parse", "HEAD")).toBe(tabHead);
    expect(git(writer.worktreePath, "symbolic-ref", "HEAD")).toBe(writer.branchRef);
    expect(fs.readFileSync(path.join(writer.worktreePath, "tab.txt"), "utf8")).toBe("commit da aba\n");
    expect(fs.readFileSync(path.join(writer.worktreePath, "README.md"), "utf8")).toBe("# Test\n");

    const other = path.join(fs.realpathSync(tempDir), "other");
    fs.mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    git(other, "-c", "user.name=x", "-c", "user.email=x@example.test", "commit", "-q", "--allow-empty", "-m", "x");
    await expect(canonical.create({ ...pane("x"), baseRootRealPath: other })).rejects.toThrow(/not linked/);
    await expect(canonical.create({ ...pane("y"), ownerKind: undefined, baseRootRealPath: tab.worktreePath }))
      .rejects.toThrow(/only pane writers/);

    write("w.txt", "w", writer.worktreePath);
    git(writer.worktreePath, "add", "w.txt");
    git(writer.worktreePath, "commit", "-qm", "w");
    canonical.markFailed(scope, "operator-hand", writer.taskId, "pane closed");
    git(tab.worktreePath, "merge", "-q", "--ff-only", writer.branchRef.slice("refs/heads/".length));
    const removed = await canonical.collectIntegratedPaneWorktrees(scope, "operator-hand", () => false);
    expect(removed.map((record) => record.taskId)).toEqual([writer.taskId]);
    expect(fs.existsSync(writer.worktreePath)).toBe(false);
    expect(() => git(root, "rev-parse", "--verify", "--quiet", writer.branchRef)).toThrow();
    expect(fs.readFileSync(path.join(tab.worktreePath, "README.md"), "utf8")).toBe("WIP da aba\n");
  });

  describe("F-908: coleta de writers de pane", () => {
    const scope = () => projectScope();
    const writer = async (id: string, commit = true) => {
      const record = await manager.create({ scope: scope(), missionId: "operator-hand", taskId: `pane-${id}`,
        workerId: id, ownerKind: "pane", ownership: { files: [], symbols: [], domains: [`pane-${id}`] } });
      if (commit) {
        write(`${id}.txt`, id, record.worktreePath);
        git(record.worktreePath, "add", `${id}.txt`);
        git(record.worktreePath, "commit", "-qm", id);
      }
      manager.markFailed(scope(), "operator-hand", record.taskId, "pane closed");
      return record;
    };
    const merge = (record: WorktreeRecord) =>
      git(root, "merge", "-q", "--no-edit", record.branchRef.slice("refs/heads/".length));
    const aged = { owner: () => true, inUse: () => false, salvageDirty: async () => undefined };
    /** Manager sobre o mesmo store cujo Git roda `hook` antes do 1º comando `match`. */
    const hooked = (match: (args: readonly string[]) => boolean, hook: () => void) => {
      const real = new AsyncProcessGitRunner();
      let fired = false;
      return new WorktreeManager({ runtimeRoot, stateStore, gitRunner, now: () => 1_700_000_000_000,
        asyncGitRunner: { run: async (cwd, args, options) => {
          if (!fired && match(args)) { fired = true; hook(); }
          return real.run(cwd, args, options);
        } } });
    };

    it("dois coletores no mesmo writer: a marca é exclusiva e a retomada no meio é recusada", async () => {
      const target = await writer("double");
      merge(target);
      let bDone: Promise<unknown> = Promise.resolve();
      let reopened: unknown = "não tentou";
      // B entra no candidato antes da marca de A (hook no último comando da prova de A).
      const racing: WorktreeManager = hooked((args) => args[0] === "ls-files", () => {
        bDone = racing.collectReleasedPaneWorktrees(scope(),
          { owner: () => true, inUse: () => false, confirmUnused: async () => false });
      });
      const a = await racing.collectReleasedPaneWorktrees(scope(), {
        owner: () => true, inUse: () => false,
        confirmUnused: async () => {
          // A já tem a marca; B terminou. A retomada tem de ser recusada.
          await bDone;
          try {
            racing.reopenPaneWriter(scope(), "operator-hand", target.taskId);
            reopened = "aceita";
          } catch (error) {
            reopened = (error as Error).message;
          }
          return true;
        },
      });
      expect(await bDone).toMatchObject({ removed: [], kept: { collecting: 1 } });
      expect(reopened).toMatch(/being collected/);
      expect(a.removed.map((record) => record.taskId)).toEqual([target.taskId]);
    });

    it("revalida a ref da branch e o HEAD do checkout depois da prova; mudou, mantém tudo", async () => {
      // Branch ganha commit no fim da prova (coleta de paradas, branch não mesclada).
      const moved = await writer("moved");
      const racing = hooked((args) => args[0] === "ls-files", () => {
        write("late.txt", "late", moved.worktreePath);
        git(moved.worktreePath, "add", "late.txt");
        git(moved.worktreePath, "commit", "-qm", "late");
      });
      expect(await racing.collectReleasedPaneWorktrees(scope(), aged))
        .toMatchObject({ removed: [], kept: { changed: 1 } });
      expect(git(root, "show", `${moved.branchRef}:late.txt`)).toBe("late");
      manager.markFailed(scope(), "operator-hand", moved.taskId, "pane closed");
      // HEAD do checkout revertido logo depois da prova de mesclagem (regra estrita).
      const rolled = await writer("rolled");
      git(root, "merge", "-q", "--ff-only", rolled.branchRef.slice("refs/heads/".length));
      const rolling = hooked((args) => args[0] === "worktree" && args[1] === "list",
        () => git(root, "reset", "-q", "--hard", "HEAD~1"));
      expect(await rolling.collectIntegratedPaneWorktrees(scope(), "operator-hand",
        (worktreePath) => worktreePath === moved.worktreePath)).toEqual([]);
      expect(fs.existsSync(rolled.worktreePath)).toBe(true);
      expect(git(root, "rev-parse", rolled.branchRef)).toBe(git(rolled.worktreePath, "rev-parse", "HEAD"));
    });

    it("só remove com ignorados todos em cache regenerável; out/dist/.env/__pycache__/.next/pasta qualquer mantêm", async () => {
      fs.appendFileSync(path.join(root, ".git", "info", "exclude"),
        "node_modules/\n__pycache__/\n*.env\nscratch/\nout/\ndist/\n.vite/\n.turbo/\n.cache/\n.next/cache/\n.next/server/\n.pytest_cache/\n");
      const caches = await writer("caches");
      const kept = { secret: ".env", other: "scratch/dump.sql", out: "out/customer-export.zip", dist: "dist/app.js",
        pyc: "src/__pycache__/m.pyc", next: ".next/server/page.js" };
      const records: Record<string, WorktreeRecord> = Object.fromEntries(
        await Promise.all(Object.keys(kept).map(async (id) => [id, await writer(id)] as const)));
      for (const record of [caches, ...Object.values(records)]) merge(record);
      write("node_modules/pkg/index.js", "x", caches.worktreePath);
      write("src/node_modules/pkg/index.js", "x", caches.worktreePath);
      // Diretório não rastreado só com ignorados vira UMA entrada no status
      // (`pkg/`, `.next/`) e mantém a worktree (regra conservadora); aqui os
      // caches ficam onde o Git os reporta pelo nome.
      for (const cache of [".vite/deps/a.js", ".turbo/cache/b", ".cache/c", ".pytest_cache/v/e"]) {
        write(cache, "x", caches.worktreePath);
      }
      for (const [id, file] of Object.entries(kept)) write(file, `entregável ${id}`, records[id].worktreePath);
      const report = await manager.collectReleasedPaneWorktrees(scope(), { owner: () => true, inUse: () => false });
      expect(report.removed.map((r) => r.taskId)).toEqual([caches.taskId]);
      expect(report.kept).toEqual({ "ignored-kept": 6 });
      for (const [id, file] of Object.entries(kept)) {
        expect(fs.readFileSync(path.join(records[id].worktreePath, file), "utf8")).toBe(`entregável ${id}`);
      }
    });

    it("refaz o inventário depois da prova de uso: ignorado novo nesse meio mantém tudo", async () => {
      fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "*.env\n");
      const late = await writer("late");
      merge(late);
      const report = await manager.collectReleasedPaneWorktrees(scope(), {
        owner: () => true, inUse: () => false,
        confirmUnused: async (worktreePath) => {
          write(".env", "TOKEN=chegou-depois", worktreePath);
          return true;
        },
      });
      expect(report).toMatchObject({ removed: [], kept: { changed: 1 } });
      expect(fs.readFileSync(path.join(late.worktreePath, ".env"), "utf8")).toBe("TOKEN=chegou-depois");
    });

    it("mantém worktree com flag de índice que esconde edição e com gitlink", async () => {
      const flagged = await writer("flagged");
      merge(flagged);
      git(flagged.worktreePath, "update-index", "--assume-unchanged", "README.md");
      write("README.md", "edição escondida\n", flagged.worktreePath);
      expect(git(flagged.worktreePath, "status", "--porcelain")).toBe("");
      const linked = await writer("linked", false);
      // Repositório interno commitado e limpo: o status não acusa nada, só o índice (modo 160000).
      const nested = path.join(linked.worktreePath, "nested");
      fs.mkdirSync(nested);
      git(nested, "init", "-q");
      git(nested, "config", "user.name", "Nexus Test");
      git(nested, "config", "user.email", "nexus@example.test");
      write("only-here.txt", "commit só do repo interno", nested);
      git(nested, "add", "only-here.txt");
      git(nested, "commit", "-qm", "interno");
      git(linked.worktreePath, "add", "nested");
      git(linked.worktreePath, "commit", "-qm", "gitlink");
      expect(git(linked.worktreePath, "status", "--porcelain")).toBe("");
      merge(linked);
      const report = await manager.collectReleasedPaneWorktrees(scope(), aged);
      expect(report).toMatchObject({ removed: [], kept: { "index-flags": 1, gitlink: 1 } });
      expect(fs.readFileSync(path.join(flagged.worktreePath, "README.md"), "utf8")).toBe("edição escondida\n");
      expect(fs.readFileSync(path.join(nested, "only-here.txt"), "utf8")).toBe("commit só do repo interno");
    });

    it("worktree suja (inclusive staged distinto) ganha salvaguarda e fica; nunca --force", async () => {
      const dirty = await writer("dirty");
      write("README.md", "versão A\n", dirty.worktreePath);
      git(dirty.worktreePath, "add", "README.md");
      write("README.md", "versão B\n", dirty.worktreePath);
      const salvaged: string[] = [];
      const report = await manager.collectReleasedPaneWorktrees(scope(), {
        ...aged, salvageDirty: async (record) => { salvaged.push(record.taskId); },
      });
      expect(report).toMatchObject({ removed: [], kept: { "dirty-kept": 1 } });
      expect(salvaged).toEqual([dirty.taskId]);
      expect(git(dirty.worktreePath, "show", ":README.md")).toBe("versão A");
      expect(fs.readFileSync(path.join(dirty.worktreePath, "README.md"), "utf8")).toBe("versão B\n");
    });

    it("roda o teto: candidato mantido não bloqueia o removível na rodada seguinte", async () => {
      const dirty = await writer("first");
      write("wip.txt", "wip", dirty.worktreePath);
      const clean = await writer("second");
      const limited = { ...aged, maxCandidates: 1 };
      const removals: string[][] = [];
      const real = new AsyncProcessGitRunner();
      const gc = new WorktreeManager({ runtimeRoot, stateStore, gitRunner, now: () => 1_700_000_000_000,
        asyncGitRunner: { run: (cwd, args, options) => {
          if (args[0] === "worktree" && args[1] === "remove") removals.push([...args]);
          return real.run(cwd, args, options);
        } } });
      expect(await gc.collectReleasedPaneWorktrees(scope(), limited))
        .toMatchObject({ removed: [], kept: { "dirty-kept": 1 }, deferred: 1 });
      const second = await gc.collectReleasedPaneWorktrees(scope(), limited);
      expect(removals).toEqual([["worktree", "remove", clean.worktreePath]]);
      expect(second.removed.map((r) => r.taskId)).toEqual([clean.taskId]);
      expect(fs.existsSync(clean.worktreePath)).toBe(false);
      // Branch não mesclada fica.
      expect(git(root, "rev-parse", clean.branchRef)).toMatch(/^[0-9a-f]{40}$/);
      expect(fs.existsSync(path.join(dirty.worktreePath, "wip.txt"))).toBe(true);
    });
  });

  it("never delegates versioned context authority to executor worktrees", async () => {
    await expect(manager.create({
        scope: projectScope(),
        missionId: "mission-context",
        taskId: "task-context",
        workerId: "worker-context",
        ownership: {
          files: [".context/docs/business-model.md"],
          symbols: [],
          domains: [],
        },
      }),
    ).rejects.toThrow(/context authority/i);
  });

  it("freezes the canonical base SHA and gives every task a distinct hashed worktree", async () => {
    const initialHead = git(root, "rev-parse", "HEAD");
    const hostileMission = "mission/../../$(touch PWNED)";
    const first = await manager.create({
      scope: projectScope(),
      missionId: hostileMission,
      taskId: "task; touch PWNED-2",
      workerId: "worker-a",
      ownership: { files: ["src/a.ts"], symbols: ["A"], domains: ["billing"] },
    });
    const second = await manager.create({
      scope: projectScope(),
      missionId: hostileMission,
      taskId: "task-b",
      workerId: "worker-b",
      ownership: { files: ["src/b.ts"], symbols: ["B"], domains: ["catalog"] },
    });

    expect(first.baseSha).toBe(initialHead);
    expect(git(first.worktreePath, "rev-parse", "HEAD")).toBe(initialHead);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.branchRef).not.toBe(second.branchRef);
    expect(first.worktreePath.startsWith(fs.realpathSync(runtimeRoot))).toBe(
      true,
    );
    expect(first.worktreePath).not.toContain(hostileMission);
    expect(first.worktreePath).not.toContain("task; touch");
    expect(first.branchRef).toMatch(/^refs\/heads\/nexus\/[a-f0-9/]+$/);
    expect(fs.existsSync(path.join(root, "PWNED"))).toBe(false);
    expect(fs.existsSync(path.join(root, "PWNED-2"))).toBe(false);
    expect(
      gitRunner.calls
        .flatMap((call) => call.args)
        .some((arg) => arg.includes("touch PWNED")),
    ).toBe(false);
  });

  it("rejects a dirty primary checkout before reserving a task", async () => {
    write("dirty.txt", "not committed\n");

    await expect(manager.create({
        scope: projectScope(),
        missionId: "mission-a",
        taskId: "task-a",
        workerId: "worker-a",
        ownership: { files: ["dirty.txt"], symbols: [], domains: [] },
      }),
    ).rejects.toThrow(/clean/i);
    expect(stateStore.read(manager.scopeKey(projectScope())).records).toEqual(
      [],
    );
  });

  it("requires the scope root to be the canonical Git top-level", async () => {
    const nested = path.join(root, "src");

    await expect(manager.create({
        scope: projectScope(fs.realpathSync(nested)),
        missionId: "mission-a",
        taskId: "task-a",
        workerId: "worker-a",
        ownership: { files: ["src/a.ts"], symbols: [], domains: [] },
      }),
    ).rejects.toThrow(/Git top-level|canonical/i);
  });

  it("rejects a lexically non-canonical scope even when it resolves to the repository", async () => {
    const canonicalRoot = fs.realpathSync(root);
    const nonCanonical = `${canonicalRoot}${path.sep}src${path.sep}..`;
    expect(nonCanonical).not.toBe(canonicalRoot);
    expect(fs.realpathSync(nonCanonical)).toBe(canonicalRoot);

    await expect(manager.create({
        scope: projectScope(nonCanonical),
        missionId: "mission-a",
        taskId: "task-a",
        workerId: "worker-a",
        ownership: { files: ["src/a.ts"], symbols: [], domains: [] },
      }),
    ).rejects.toThrow(/canonical/i);
  });

  it.skipIf(process.platform === "win32")(
    "disables repository hooks while materializing a worker worktree",
    async () => {
      const marker = path.join(tempDir, "hook-executed");
      const hook = path.join(root, ".git", "hooks", "post-checkout");
      fs.writeFileSync(
        hook,
        `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
        "utf8",
      );
      fs.chmodSync(hook, 0o700);

      await manager.create({
        scope: projectScope(),
        missionId: "mission-hook",
        taskId: "task-hook",
        workerId: "worker-hook",
        ownership: { files: ["hook-safe.txt"], symbols: [], domains: [] },
      });

      expect(fs.existsSync(marker)).toBe(false);
    },
  );

  it("rejects repository-local filters or merge drivers that could execute commands", async () => {
    git(root, "config", "filter.evil.smudge", 'sh -c "touch escaped"');

    await expect(manager.create({
        scope: projectScope(),
        missionId: "mission-filter",
        taskId: "task-filter",
        workerId: "worker-filter",
        ownership: { files: ["filter-safe.txt"], symbols: [], domains: [] },
      }),
    ).rejects.toThrow(/executable Git config/i);
    expect(fs.existsSync(path.join(root, "escaped"))).toBe(false);
  });

  it("never assigns the same mission task worktree to another worker", async () => {
    const input = {
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "task-a",
      ownership: { files: ["src/a.ts"], symbols: [], domains: [] },
    } as const;
    await manager.create({ ...input, workerId: "worker-a" });

    await expect(manager.create({ ...input, workerId: "worker-b" })).rejects.toThrow(
      WorktreeWorkerConflictError,
    );
    await expect(manager.create({
        ...input,
        workerId: "worker-a",
        ownership: { files: ["src/redefined.ts"], symbols: [], domains: [] },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("blocks overlapping ownership unless the existing task is an explicit dependency", async () => {
    await manager.create({
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "task-a",
      workerId: "worker-a",
      ownership: {
        files: ["src/shared.ts"],
        symbols: ["SharedService"],
        domains: ["billing"],
      },
    });

    await expect(manager.create({
        scope: projectScope(),
        missionId: "mission-a",
        taskId: "task-b",
        workerId: "worker-b",
        ownership: {
          files: ["src/shared.ts"],
          symbols: ["AnotherSymbol"],
          domains: ["catalog"],
        },
      }),
    ).rejects.toThrow(OwnershipOverlapError);

    const dependent = await manager.create({
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "task-dependent",
      workerId: "worker-dependent",
      ownership: {
        files: ["src/other.ts"],
        symbols: ["SharedService"],
        domains: ["billing"],
      },
      dependsOn: [{ missionId: "mission-a", taskId: "task-a" }],
    });
    expect(dependent.dependencies).toHaveLength(1);
  });

  it("F-1277: purging an orphan also drops the survivors' dependency on it", async () => {
    const scope = projectScope();
    const orphan = await manager.create({
      scope, missionId: "mission-m2", taskId: "task-b", workerId: "worker-b",
      ownership: { files: ["src/b.ts"], symbols: [], domains: [] },
    });
    const survivor = await manager.create({
      scope, missionId: "mission-m1", taskId: "task-a", workerId: "worker-a",
      ownership: { files: ["src/a.ts"], symbols: [], domains: [] },
      dependsOn: [{ missionId: "mission-m2", taskId: "task-b" }],
    });
    expect(survivor.dependencies).toEqual([orphan.taskKey]);

    const purged = manager.purgeRecordsWithoutTask(scope, new Set([survivor.taskId]));

    expect(purged.map((record) => record.taskKey)).toEqual([orphan.taskKey]);
    expect(manager.get(scope, "mission-m2", "task-b")).toBeNull();
    expect(manager.get(scope, "mission-m1", "task-a")).toMatchObject({
      status: survivor.status,
      dependencies: [],
    });
  });

  it("blocks a directory claim from running with a nested file claim", async () => {
    await manager.create({
      scope: projectScope(),
      missionId: "mission-directory-overlap",
      taskId: "task-directory",
      workerId: "worker-directory",
      ownership: {
        files: ["src/feature"],
        symbols: [],
        domains: [],
      },
    });

    await expect(manager.create({
        scope: projectScope(),
        missionId: "mission-directory-overlap",
        taskId: "task-nested-file",
        workerId: "worker-nested-file",
        ownership: {
          files: ["src/feature/utils.ts"],
          symbols: [],
          domains: [],
        },
      }),
    ).rejects.toThrow(OwnershipOverlapError);
  });

  it("rejects committed files outside the declared ownership before integration", async () => {
    const assignment = await manager.create({
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "task-a",
      workerId: "worker-a",
      ownership: { files: ["src/owned.ts"], symbols: [], domains: [] },
    });
    write(
      "src/not-owned.ts",
      "export const escaped = true;\n",
      assignment.worktreePath,
    );
    git(assignment.worktreePath, "add", ".");
    git(assignment.worktreePath, "commit", "-m", "edit undeclared file");

    expect(() =>
      manager.prepareIntegration(projectScope(), "mission-a", "task-a"),
    ).toThrow(OwnershipViolationError);
  });

  it("receipts an unchanged validation worktree without weakening ordinary empty merges", async () => {
    const assignment = await manager.create({
      scope: projectScope(),
      missionId: "mission-guided",
      taskId: "guided-quality-gate",
      workerId: "qa-independent",
      ownership: {
        files: ["src"],
        symbols: [],
        domains: ["guided-quality-gate", "sequential-only"],
      },
    });

    expect(() =>
      manager.prepareIntegration(
        projectScope(),
        "mission-guided",
        "guided-quality-gate",
      ),
    ).toThrow(/no committed changes/i);

    const validation = manager.prepareNoChangeValidation(
      projectScope(),
      "mission-guided",
      "guided-quality-gate",
    );
    expect(validation).toMatchObject({
      taskHeadSha: assignment.baseSha,
      integrationHeadSha: assignment.baseSha,
      changedFiles: [],
    });
    const completed = manager.markValidatedNoChange(
      projectScope(),
      "mission-guided",
      "guided-quality-gate",
      validation!.taskHeadSha,
      validation!.integrationHeadSha,
    );
    expect(completed).toMatchObject({
      status: "integrated",
      taskHeadSha: assignment.baseSha,
      integratedSha: assignment.baseSha,
    });
    const replay = manager.prepareNoChangeValidation(
      projectScope(),
      "mission-guided",
      "guided-quality-gate",
    );
    expect(replay).toMatchObject({
      taskHeadSha: assignment.baseSha,
      integrationHeadSha: assignment.baseSha,
      changedFiles: [],
    });
    expect(
      manager.markValidatedNoChange(
        projectScope(),
        "mission-guided",
        "guided-quality-gate",
        replay!.taskHeadSha,
        replay!.integrationHeadSha,
      ),
    ).toEqual(completed);
  });

  it("discards a clean reviewer worktree even after Main advances", async () => {
    const assignment = await manager.create({
      scope: projectScope(),
      missionId: "mission-review",
      taskId: "review-read-only",
      workerId: "reviewer",
      ownership: {
        files: [],
        symbols: [],
        domains: ["review"],
      },
    });
    write("src/main-advance.ts", "export const advanced = true;\n");
    git(root, "add", "src/main-advance.ts");
    git(root, "commit", "-m", "test: advance main");
    const advancedHead = git(root, "rev-parse", "HEAD");

    expect(() =>
      manager.prepareNoChangeValidation(
        projectScope(),
        "mission-review",
        "review-read-only",
      ),
    ).toThrow(/primary checkout changed/i);

    const prepared = manager.prepareDiscardedNoChangeValidation(
      projectScope(),
      "mission-review",
      "review-read-only",
    );
    expect(prepared).toMatchObject({
      taskHeadSha: assignment.baseSha,
      integrationHeadSha: advancedHead,
      changedFiles: [],
    });
    expect(
      manager.markDiscardedNoChange(
        projectScope(),
        "mission-review",
        "review-read-only",
        prepared!.taskHeadSha,
        prepared!.integrationHeadSha,
      ),
    ).toMatchObject({
      status: "integrated",
      taskHeadSha: assignment.baseSha,
      integratedSha: advancedHead,
    });
  });

  // REGRESSÃO (gate run 6 da 0.27.0): a validação no-change do advisor reusa o
  // snapshot de integração, que exigia checkout primário LIMPO — mas no caminho
  // simples o escritor same_checkout suja o checkout DURANTE a missão, em
  // paralelo com os scouts. A validação é uma leitura: não pode exigir limpeza.
  it("valida no-change do advisor com o checkout primário sujo (escritor same_checkout ativo)", async () => {
    const assignment = await manager.create({
      scope: projectScope(),
      missionId: "mission-simple",
      taskId: "advisor-read-only",
      workerId: "advisor",
      ownership: {
        files: [],
        symbols: [],
        domains: ["review"],
      },
    });
    // Escrita legítima do serialized-writer no checkout primário, sem commit.
    write("resultado.txt", "trabalho em progresso\n");

    const prepared = manager.prepareDiscardedNoChangeValidation(
      projectScope(),
      "mission-simple",
      "advisor-read-only",
    );
    expect(prepared).toMatchObject({
      taskHeadSha: assignment.baseSha,
      integrationHeadSha: assignment.baseSha,
      changedFiles: [],
    });
    expect(
      manager.markDiscardedNoChange(
        projectScope(),
        "mission-simple",
        "advisor-read-only",
        prepared!.taskHeadSha,
        prepared!.integrationHeadSha,
      ),
    ).toMatchObject({
      status: "integrated",
      taskHeadSha: assignment.baseSha,
      integratedSha: assignment.baseSha,
    });
  });

  it("never reclassifies an isolated advisory commit as no-change", async () => {
    const assignment = await manager.create({
      scope: projectScope(),
      missionId: "mission-guided-advisory-mutation",
      taskId: "guided-advisory-opencode",
      workerId: "Advisor OpenCode",
      ownership: {
        files: ["src"],
        symbols: [],
        domains: ["guided-isolated-advisory", "sequential-only"],
      },
    });
    write(
      "src/advisory-mutation.ts",
      "export const forbidden = true;\n",
      assignment.worktreePath,
    );
    git(assignment.worktreePath, "add", "src/advisory-mutation.ts");
    git(
      assignment.worktreePath,
      "commit",
      "-m",
      "forbidden advisory mutation",
    );

    expect(
      manager.prepareNoChangeValidation(
        projectScope(),
        "mission-guided-advisory-mutation",
        "guided-advisory-opencode",
      ),
    ).toBeNull();
    const unchanged = manager.get(
      projectScope(),
      "mission-guided-advisory-mutation",
      "guided-advisory-opencode",
    );
    expect(unchanged).toMatchObject({ status: "ready" });
    expect(unchanged?.taskHeadSha).toBeUndefined();
    expect(unchanged?.integratedSha).toBeUndefined();
  });

  it("rejects an empty commit as fabricated no-change evidence", async () => {
    const assignment = await manager.create({
      scope: projectScope(),
      missionId: "mission-guided-empty-commit",
      taskId: "guided-quality-gate",
      workerId: "qa-independent",
      ownership: {
        files: ["src"],
        symbols: [],
        domains: ["guided-quality-gate", "sequential-only"],
      },
    });
    git(assignment.worktreePath, "commit", "--allow-empty", "-m", "fake QA");

    expect(() =>
      manager.prepareNoChangeValidation(
        projectScope(),
        "mission-guided-empty-commit",
        "guided-quality-gate",
      ),
    ).toThrow(/empty commit/i);
  });

  it("rejects dirty or untracked QA worktree state as no-change evidence", async () => {
    const assignment = await manager.create({
      scope: projectScope(),
      missionId: "mission-guided-dirty",
      taskId: "guided-quality-gate",
      workerId: "qa-independent",
      ownership: {
        files: ["src"],
        symbols: [],
        domains: ["guided-quality-gate", "sequential-only"],
      },
    });
    write(
      "src/untracked-validation-note.txt",
      "not physical evidence\n",
      assignment.worktreePath,
    );

    expect(() =>
      manager.prepareNoChangeValidation(
        projectScope(),
        "mission-guided-dirty",
        "guided-quality-gate",
      ),
    ).toThrow(/worktree must be clean/i);
    const unchanged = manager.get(
      projectScope(),
      "mission-guided-dirty",
      "guided-quality-gate",
    );
    expect(unchanged).toMatchObject({ status: "ready" });
    expect(unchanged?.taskHeadSha).toBeUndefined();
    expect(unchanged?.integratedSha).toBeUndefined();
  });

  it("fails closed when persisted state redirects a task to another path", async () => {
    const assignment = await manager.create({
      scope: projectScope(),
      missionId: "mission-state",
      taskId: "task-state",
      workerId: "worker-state",
      ownership: { files: ["state.txt"], symbols: [], domains: [] },
    });
    const scopeKey = manager.scopeKey(projectScope());
    stateStore.overwrite(scopeKey, [
      { ...assignment, worktreePath: fs.realpathSync(root) },
    ]);

    expect(() =>
      manager.get(projectScope(), "mission-state", "task-state"),
    ).toThrow(/invalid worktree state/i);
  });

  it("requires an injected persistence store instead of falling back silently", () => {
    expect(
      () =>
        new WorktreeManager({
          runtimeRoot,
          stateStore: undefined as unknown as WorktreeStateStore,
        }),
    ).toThrow(/state store/i);
  });
});


describe("WorktreeManager re-anchor of a stale read_only worktree", () => {
  const advisorInput = () => ({
    scope: projectScope(),
    missionId: "mission-advisory-reanchor",
    taskId: "advisor-read-only",
    workerId: "Advisor AGY",
    ownership: {
      files: [] as string[],
      symbols: [] as string[],
      domains: ["advisory"],
    },
  });

  function advanceIntegrationHead(label: string): string {
    write(`src/${label}.ts`, `export const ${label} = true;\n`);
    git(root, "add", `src/${label}.ts`);
    git(root, "commit", "-m", `test: integrate ${label}`);
    return git(root, "rev-parse", "HEAD");
  }

  it("re-anchors a claim-time worktree bound only after the executor integrated", async () => {
    // The kickoff wave claims the advisor and materializes its worktree at
    // the initial HEAD; the executor integrates before the advisor session
    // is (re)bound. The re-anchor moves the proven output-free worktree to
    // the integrated HEAD so the advisor validates the final tree.
    const assignment = await manager.create(advisorInput());
    const claimTimeBase = assignment.baseSha;
    expect(git(assignment.worktreePath, "rev-parse", "HEAD")).toBe(
      claimTimeBase,
    );
    const integratedHead = advanceIntegrationHead("integrated-result");

    const reanchored = manager.reanchorReadyWorktreeToIntegrationHead(
      projectScope(),
      "mission-advisory-reanchor",
      "advisor-read-only",
    );

    expect(reanchored).toMatchObject({
      id: assignment.id,
      status: "ready",
      baseSha: integratedHead,
      branchRef: assignment.branchRef,
      ownership: assignment.ownership,
    });
    // This is the exact read the physical handoff boundary performs
    // (committedPhysicalWorkerHead): a receipt issued now seals the final
    // HEAD with a post-integration issuedAt — the chronology the completion
    // invariant chainHeadIsExact demands from an advisor.
    expect(git(assignment.worktreePath, "rev-parse", "HEAD")).toBe(
      integratedHead,
    );
    expect(git(assignment.worktreePath, "symbolic-ref", "--quiet", "HEAD"))
      .toBe(assignment.branchRef);
    expect(
      fs.existsSync(
        path.join(assignment.worktreePath, "src/integrated-result.ts"),
      ),
    ).toBe(true);

    // A second (re)bind at the same HEAD is a no-op.
    const resetsBeforeReplay = gitRunner.calls.filter(
      (call) => call.args[0] === "reset",
    ).length;
    const replay = manager.reanchorReadyWorktreeToIntegrationHead(
      projectScope(),
      "mission-advisory-reanchor",
      "advisor-read-only",
    );
    expect(replay).toEqual(reanchored);
    expect(
      gitRunner.calls.filter((call) => call.args[0] === "reset"),
    ).toHaveLength(resetsBeforeReplay);
  });

  it("keeps the claim-time base while the integration HEAD is unchanged", async () => {
    const assignment = await manager.create(advisorInput());

    const record = manager.reanchorReadyWorktreeToIntegrationHead(
      projectScope(),
      "mission-advisory-reanchor",
      "advisor-read-only",
    );

    expect(record).toEqual(assignment);
    expect(
      gitRunner.calls.filter((call) => call.args[0] === "reset"),
    ).toEqual([]);
  });

  it("refuses to re-anchor once the worker produced commits", async () => {
    const assignment = await manager.create(advisorInput());
    write("src/advisor-note.ts", "export const note = true;\n", assignment.worktreePath);
    git(assignment.worktreePath, "add", "src/advisor-note.ts");
    git(assignment.worktreePath, "commit", "-m", "advisor output");
    const workerHead = git(assignment.worktreePath, "rev-parse", "HEAD");
    advanceIntegrationHead("integrated-result");

    expect(() =>
      manager.reanchorReadyWorktreeToIntegrationHead(
        projectScope(),
        "mission-advisory-reanchor",
        "advisor-read-only",
      ),
    ).toThrow(/diverged from its frozen base/i);
    // Fail-closed: the branch and the durable base are left untouched.
    expect(git(assignment.worktreePath, "rev-parse", "HEAD")).toBe(workerHead);
    expect(
      manager.get(
        projectScope(),
        "mission-advisory-reanchor",
        "advisor-read-only",
      ),
    ).toMatchObject({ status: "ready", baseSha: assignment.baseSha });
  });

  it("refuses to re-anchor a dirty worktree", async () => {
    const assignment = await manager.create(advisorInput());
    write("src/untracked-note.txt", "not committed\n", assignment.worktreePath);
    advanceIntegrationHead("integrated-result");

    expect(() =>
      manager.reanchorReadyWorktreeToIntegrationHead(
        projectScope(),
        "mission-advisory-reanchor",
        "advisor-read-only",
      ),
    ).toThrow(/worktree must be clean/i);
    expect(
      manager.get(
        projectScope(),
        "mission-advisory-reanchor",
        "advisor-read-only",
      ),
    ).toMatchObject({ status: "ready", baseSha: assignment.baseSha });
  });

  it("never re-anchors a queued record whose task head is the delivery", async () => {
    const assignment = await manager.create(advisorInput());
    write("src/executor-change.ts", "export const change = 1;\n", assignment.worktreePath);
    git(assignment.worktreePath, "add", "src/executor-change.ts");
    git(assignment.worktreePath, "commit", "-m", "task output");
    const taskHead = git(assignment.worktreePath, "rev-parse", "HEAD");
    manager.markQueued(
      projectScope(),
      "mission-advisory-reanchor",
      "advisor-read-only",
      taskHead,
    );
    advanceIntegrationHead("integrated-result");

    const record = manager.reanchorReadyWorktreeToIntegrationHead(
      projectScope(),
      "mission-advisory-reanchor",
      "advisor-read-only",
    );

    expect(record).toMatchObject({
      status: "queued",
      baseSha: assignment.baseSha,
      taskHeadSha: taskHead,
    });
    expect(git(assignment.worktreePath, "rev-parse", "HEAD")).toBe(taskHead);
  });

  it("returns null when the task has no worktree record", () => {
    expect(
      manager.reanchorReadyWorktreeToIntegrationHead(
        projectScope(),
        "mission-advisory-reanchor",
        "advisor-read-only",
      ),
    ).toBeNull();
  });
});
