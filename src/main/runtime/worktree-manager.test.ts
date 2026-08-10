import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import { ensureGuidedGitBaseline } from "./guided-greenfield-baseline";
import {
  OwnershipOverlapError,
  OwnershipViolationError,
  ProcessGitRunner,
  WorktreeManager,
  WorktreeWorkerConflictError,
  worktreeTaskKey,
  type GitRunOptions,
  type GitRunner,
  type GitResult,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "./worktree-manager";

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
  it.each([
    ["physically empty folder", false, "initialized-empty"],
    ["git init without HEAD", true, "committed-unborn"],
  ] as const)(
    "creates and proves a real worktree from a %s",
    async (_label, initializeGit, expectedKind) => {
      const greenfieldRoot = path.join(
        tempDir,
        initializeGit ? "greenfield-unborn" : "greenfield-empty",
      );
      fs.mkdirSync(greenfieldRoot);
      if (initializeGit) {
        git(greenfieldRoot, "init", "--quiet");
      }
      const canonicalGreenfieldRoot = fs.realpathSync(greenfieldRoot);
      const greenfieldScope = projectScope(canonicalGreenfieldRoot);
      const baseline = ensureGuidedGitBaseline(greenfieldScope);

      expect(baseline).toMatchObject({
        kind: expectedKind,
        rootRealPath: canonicalGreenfieldRoot,
        headSha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      });
      expect(git(greenfieldRoot, "status", "--porcelain=v1")).toBe("");

      const greenfieldManager = new WorktreeManager({
        runtimeRoot: path.join(tempDir, `runtime-${expectedKind}`),
        stateStore: new MemoryWorktreeStateStore(),
        now: () => 1_700_000_000_000,
      });
      const advisory = await greenfieldManager.create({
        scope: greenfieldScope,
        missionId: `mission-${expectedKind}`,
        taskId: "guided-advisory-opencode",
        workerId: "Advisor OpenCode",
        ownership: {
          files: ["src"],
          symbols: [],
          domains: ["guided-isolated-advisory", "sequential-only"],
        },
      });

      expect(advisory).toMatchObject({
        status: "ready",
        baseSha: baseline.headSha,
        rootRealPath: canonicalGreenfieldRoot,
      });
      expect(fs.realpathSync(advisory.worktreePath)).toBe(
        advisory.worktreePath,
      );
      expect(git(advisory.worktreePath, "rev-parse", "HEAD")).toBe(
        baseline.headSha,
      );
      const advisoryProof = greenfieldManager.prepareNoChangeValidation(
        greenfieldScope,
        `mission-${expectedKind}`,
        "guided-advisory-opencode",
      )!;
      greenfieldManager.markValidatedNoChange(
        greenfieldScope,
        `mission-${expectedKind}`,
        "guided-advisory-opencode",
        advisoryProof.taskHeadSha,
        advisoryProof.integrationHeadSha,
      );

      const execution = await greenfieldManager.create({
        scope: greenfieldScope,
        missionId: `mission-${expectedKind}`,
        taskId: "guided-execution",
        workerId: "guided-executor",
        ownership: {
          files: [
            "src",
            "index.html",
            "eslint.config.js",
            "next.config.ts",
            "postcss.config.mjs",
            "components.json",
          ],
          symbols: [],
          domains: ["guided-implementation", "sequential-only"],
        },
        dependsOn: [
          {
            missionId: `mission-${expectedKind}`,
            taskId: "guided-advisory-opencode",
          },
        ],
      });
      expect(execution).toMatchObject({
        status: "ready",
        baseSha: baseline.headSha,
        dependencies: [
          worktreeTaskKey(
            `mission-${expectedKind}`,
            "guided-advisory-opencode",
          ),
        ],
      });
      const scaffoldFiles = [
        "index.html",
        "eslint.config.js",
        "next.config.ts",
        "postcss.config.mjs",
        "components.json",
      ];
      for (const file of scaffoldFiles) {
        write(file, `// generated ${file}\n`, execution.worktreePath);
      }
      git(execution.worktreePath, "add", ".");
      git(
        execution.worktreePath,
        "-c",
        "user.name=Nexus Test",
        "-c",
        "user.email=nexus@example.test",
        "commit",
        "-m",
        "scaffold greenfield app",
      );
      expect(
        greenfieldManager.prepareIntegration(
          greenfieldScope,
          `mission-${expectedKind}`,
          "guided-execution",
        ).changedFiles,
      ).toEqual(scaffoldFiles.slice().sort());
    },
  );

  it("gives the scheduler one exact WorktreeManager start from a dirty operator view", async () => {
    write("src/shared.ts", "export const base = 2;\n");
    write("src/staged.ts", "staged version\n");
    git(root, "add", "--", "src/staged.ts");
    write("src/staged.ts", "operator working version\n");
    write("src/untracked.ts", "operator untracked version\n");

    const baseline = ensureGuidedGitBaseline(projectScope());
    const worker = await manager.create({
      scope: projectScope(),
      missionId: "mission-guided-dirty-checkpoint",
      taskId: "task-guided-dirty-checkpoint",
      workerId: "guided-executor",
      ownership: {
        files: ["src"],
        symbols: [],
        domains: ["guided-implementation"],
      },
    });

    expect(git(root, "status", "--porcelain=v1")).toBe("");
    expect(worker.baseSha).toBe(baseline.headSha);
    expect(git(worker.worktreePath, "rev-parse", "HEAD")).toBe(
      baseline.headSha,
    );
    expect(
      fs.readFileSync(path.join(worker.worktreePath, "src/shared.ts"), "utf8"),
    ).toBe("export const base = 2;\n");
    expect(
      fs.readFileSync(path.join(worker.worktreePath, "src/staged.ts"), "utf8"),
    ).toBe("operator working version\n");
    expect(
      fs.readFileSync(
        path.join(worker.worktreePath, "src/untracked.ts"),
        "utf8",
      ),
    ).toBe("operator untracked version\n");
    expect(
      gitRunner.calls.filter(
        ({ args }) => args[0] === "worktree" && args[1] === "add",
      ),
    ).toHaveLength(1);
  });

  it("refuses to adopt untracked files into an unborn baseline", async () => {
    const greenfieldRoot = path.join(tempDir, "greenfield-user-files");
    fs.mkdirSync(greenfieldRoot);
    git(greenfieldRoot, "init", "--quiet");
    fs.writeFileSync(
      path.join(greenfieldRoot, "user-draft.txt"),
      "do not commit me\n",
    );

    expect(() =>
      ensureGuidedGitBaseline(projectScope(fs.realpathSync(greenfieldRoot))),
    ).toThrow(/primeiro commit.*arquivos existentes/i);
    expect(() => git(greenfieldRoot, "rev-parse", "HEAD")).toThrow();
    expect(
      fs.readFileSync(path.join(greenfieldRoot, "user-draft.txt"), "utf8"),
    ).toBe("do not commit me\n");
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
