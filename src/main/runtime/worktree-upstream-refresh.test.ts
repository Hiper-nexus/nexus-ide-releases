import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  AsyncProcessGitRunner,
  GitCommandError,
  type AsyncGitRunner,
  type GitResult,
  type GitRunOptions,
} from "./git-command";
import { refreshUpstreamDriftAsync } from "./worktree-manager-git";
import {
  ProcessGitRunner,
  WorktreeManager,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "./worktree-manager";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const ok = (stdout = ""): GitResult => ({ status: 0, stdout, stderr: "" });
const failed = (status = 1): GitResult => ({ status, stdout: "", stderr: "stubbed failure" });

/** Runner de argv roteado: cada subcomando tem uma resposta roteirizada. */
class ScriptedRunner implements AsyncGitRunner {
  readonly calls: string[][] = [];
  constructor(
    private readonly script: (args: readonly string[]) => GitResult | null,
  ) {}
  run(
    _cwd: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<GitResult> {
    this.calls.push([...args]);
    const result = this.script(args);
    if (result !== null) return Promise.resolve(result);
    if (options?.allowFailure) return Promise.resolve(failed());
    return Promise.reject(new GitCommandError("unexpected argv", args));
  }
  called(subcommand: string): boolean {
    return this.calls.some((args) => args[0] === subcommand);
  }
}

describe("refreshUpstreamDriftAsync", () => {
  it("sem upstream configurado: não busca e reporta upstream null", async () => {
    const runner = new ScriptedRunner(() => null);
    const drift = await refreshUpstreamDriftAsync(runner, "/repo");
    expect(drift).toEqual({
      upstream: null,
      behind: 0,
      ahead: 0,
      fetched: false,
      fastForwarded: false,
    });
    expect(runner.called("fetch")).toBe(false);
  });

  it("upstream fora do origin: não busca", async () => {
    const runner = new ScriptedRunner((args) =>
      args[0] === "rev-parse" ? ok("upstream/main\n") : null,
    );
    const drift = await refreshUpstreamDriftAsync(runner, "/repo");
    expect(drift.upstream).toBeNull();
    expect(drift.fetched).toBe(false);
    expect(runner.called("fetch")).toBe(false);
  });

  it("fetch recusado (offline): fail-open, sem lançar e sem medir", async () => {
    const runner = new ScriptedRunner((args) => {
      if (args[0] === "rev-parse") return ok("origin/main\n");
      if (args[0] === "fetch") return failed(128);
      return null;
    });
    const drift = await refreshUpstreamDriftAsync(runner, "/repo");
    expect(drift).toEqual({
      upstream: "origin/main",
      behind: 0,
      ahead: 0,
      fetched: false,
      fastForwarded: false,
    });
    expect(runner.called("rev-list")).toBe(false);
  });

  it("fetch que lança (timeout de processo): fail-open", async () => {
    const runner: AsyncGitRunner = {
      run: (_cwd, args, options) => {
        if (args[0] === "fetch") {
          return Promise.reject(new GitCommandError("Git process could not complete", args));
        }
        if (options?.allowFailure) return Promise.resolve(failed());
        return Promise.reject(new GitCommandError("unexpected argv", args));
      },
    };
    // rev-parse do upstream precisa responder origin/main
    const scripted: AsyncGitRunner = {
      run: (cwd, args, options) => {
        if (args[0] === "rev-parse") return Promise.resolve(ok("origin/main\n"));
        return runner.run(cwd, args, options);
      },
    };
    const drift = await refreshUpstreamDriftAsync(scripted, "/repo");
    expect(drift.fetched).toBe(false);
    expect(drift.upstream).toBe("origin/main");
  });

  it("em dia (behind 0): não faz ff", async () => {
    const runner = new ScriptedRunner((args) => {
      if (args[0] === "rev-parse") return ok("origin/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("0\t0\n");
      return null;
    });
    const drift = await refreshUpstreamDriftAsync(runner, "/repo");
    expect(drift).toEqual({
      upstream: "origin/main",
      behind: 0,
      ahead: 0,
      fetched: true,
      fastForwarded: false,
    });
    expect(runner.called("merge")).toBe(false);
  });

  it("divergente (ahead > 0): nunca faz ff", async () => {
    const runner = new ScriptedRunner((args) => {
      if (args[0] === "rev-parse") return ok("origin/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("2\t3\n");
      return null;
    });
    const drift = await refreshUpstreamDriftAsync(runner, "/repo");
    expect(drift.ahead).toBe(2);
    expect(drift.behind).toBe(3);
    expect(drift.fastForwarded).toBe(false);
    expect(runner.called("merge")).toBe(false);
  });

  it("atrás com árvore suja (tracked): não faz ff e reporta o atraso", async () => {
    const runner = new ScriptedRunner((args) => {
      if (args[0] === "rev-parse") return ok("origin/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("0\t3\n");
      if (args[0] === "status") return ok(" M src/a.ts\n");
      return null;
    });
    const drift = await refreshUpstreamDriftAsync(runner, "/repo");
    expect(drift.behind).toBe(3);
    expect(drift.fastForwarded).toBe(false);
    expect(runner.called("merge")).toBe(false);
  });

  it("atrás com árvore limpa: faz merge --ff-only e zera o atraso", async () => {
    const runner = new ScriptedRunner((args) => {
      if (args[0] === "rev-parse") return ok("origin/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("0\t3\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "merge") return ok();
      return null;
    });
    const drift = await refreshUpstreamDriftAsync(runner, "/repo");
    expect(drift).toEqual({
      upstream: "origin/main",
      behind: 0,
      ahead: 0,
      fetched: true,
      fastForwarded: true,
    });
    const merge = runner.calls.find((args) => args[0] === "merge");
    expect(merge).toEqual(["merge", "--ff-only", "@{upstream}"]);
  });

  it("ff recusado pelo Git: preserva o atraso reportado, sem lançar", async () => {
    const runner = new ScriptedRunner((args) => {
      if (args[0] === "rev-parse") return ok("origin/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("0\t3\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "merge") return failed();
      return null;
    });
    const drift = await refreshUpstreamDriftAsync(runner, "/repo");
    expect(drift.fastForwarded).toBe(false);
    expect(drift.behind).toBe(3);
  });
});

describe("WorktreeManager.create — refresh do upstream antes de congelar a base", () => {
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
    overwrite(scopeKey: string, records: WorktreeRecord[]): void {
      const current = this.read(scopeKey);
      this.#states.set(scopeKey, {
        revision: current.revision + 1,
        records: structuredClone(records),
      });
    }
  }

  /** Git real para tudo, menos o fetch (stub de rede) — contado para a prova. */
  class FetchStubRunner implements AsyncGitRunner {
    fetchCalls = 0;
    readonly #delegate = new AsyncProcessGitRunner();
    constructor(private readonly fetchStatus = 0) {}
    run(
      cwd: string,
      args: readonly string[],
      options?: GitRunOptions,
    ): Promise<GitResult> {
      if (args[0] === "fetch") {
        this.fetchCalls += 1;
        return Promise.resolve(
          this.fetchStatus === 0 ? ok() : failed(this.fetchStatus),
        );
      }
      return this.#delegate.run(cwd, args, options);
    }
  }

  let tempDir = "";
  let root = "";
  let runtimeRoot = "";

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function write(relativePath: string, content: string): void {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  function scope(): ProjectExecutionScope {
    return {
      version: 1,
      installationId: "installation-test",
      projectId: PROJECT_ID,
      checkoutId: "checkout-upstream-test",
      rootRealPath: fs.realpathSync(root),
      identitySource: "manifest",
    };
  }

  /** HEAD local em A; refs/remotes/origin/main em B (filho de A), upstream configurado. */
  function parkBehindOrigin(): { shaA: string; shaB: string } {
    const shaA = git(root, "rev-parse", "HEAD");
    write("src/b.ts", "export const b = 2;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "B");
    const shaB = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", "refs/remotes/origin/main", shaB);
    // @{upstream} só resolve com o remote configurado: sem o refspec de fetch o
    // Git recusa "upstream branch not stored as a remote-tracking branch".
    git(root, "config", "remote.origin.url", path.join(tempDir, "origin-stub.git"));
    git(root, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(root, "config", "branch.main.remote", "origin");
    git(root, "config", "branch.main.merge", "refs/heads/main");
    git(root, "reset", "--hard", shaA);
    return { shaA, shaB };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-upstream-refresh-"));
    root = path.join(tempDir, "repo");
    runtimeRoot = path.join(tempDir, "runtime");
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Nexus Test");
    git(root, "config", "user.email", "nexus@example.test");
    write("src/shared.ts", "export const base = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "A");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function managerWith(asyncGit: AsyncGitRunner): WorktreeManager {
    return new WorktreeManager({
      runtimeRoot,
      stateStore: new MemoryWorktreeStateStore(),
      gitRunner: new ProcessGitRunner(),
      asyncGitRunner: asyncGit,
      now: () => 1_700_000_000_000,
    });
  }

  it("raiz limpa e estritamente atrás: faz fetch, ff-only e a base nasce na ponta do origin", async () => {
    const { shaB } = parkBehindOrigin();
    const asyncGit = new FetchStubRunner();
    const record = await managerWith(asyncGit).create({
      scope: scope(),
      missionId: "upstream",
      taskId: "clean",
      workerId: "worker",
      ownership: { files: ["src/clean.ts"], symbols: [], domains: [] },
    });
    expect(asyncGit.fetchCalls).toBe(1);
    expect(record.baseSha).toBe(shaB);
    expect(git(root, "rev-parse", "HEAD")).toBe(shaB);
  });

  it("raiz com WIP (writer de pane): fetch acontece, mas nunca ff — base fica no HEAD local", async () => {
    const { shaA } = parkBehindOrigin();
    write("src/shared.ts", "export const base = 99; // WIP\n");
    const asyncGit = new FetchStubRunner();
    const record = await managerWith(asyncGit).create({
      scope: scope(),
      missionId: "upstream",
      taskId: "dirty",
      workerId: "worker",
      ownerKind: "pane",
      ownership: { files: [], symbols: [], domains: ["dirty"] },
    });
    expect(asyncGit.fetchCalls).toBe(1);
    expect(record.baseSha).toBe(shaA);
    expect(git(root, "rev-parse", "HEAD")).toBe(shaA);
    // WIP intacto
    expect(fs.readFileSync(path.join(root, "src/shared.ts"), "utf8")).toContain("99");
  });

  it("fetch falha (offline): create segue com o HEAD local, sem lançar", async () => {
    const { shaA } = parkBehindOrigin();
    const asyncGit = new FetchStubRunner(128);
    const record = await managerWith(asyncGit).create({
      scope: scope(),
      missionId: "upstream",
      taskId: "offline",
      workerId: "worker",
      ownership: { files: ["src/offline.ts"], symbols: [], domains: [] },
    });
    expect(asyncGit.fetchCalls).toBe(1);
    expect(record.baseSha).toBe(shaA);
  });

  it("sem upstream configurado: nenhum fetch e base no HEAD local", async () => {
    const shaA = git(root, "rev-parse", "HEAD");
    const asyncGit = new FetchStubRunner();
    const record = await managerWith(asyncGit).create({
      scope: scope(),
      missionId: "upstream",
      taskId: "local-only",
      workerId: "worker",
      ownership: { files: ["src/local.ts"], symbols: [], domains: [] },
    });
    expect(asyncGit.fetchCalls).toBe(0);
    expect(record.baseSha).toBe(shaA);
  });
});
