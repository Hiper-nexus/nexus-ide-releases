import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import { selectMissionSchedulerWorktreeDependencies } from "../orch/mission-scheduler-worktree-dependencies";
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
    (_label, initializeGit, expectedKind) => {
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
      const advisory = greenfieldManager.create({
        scope: greenfieldScope,
        missionId: `mission-${expectedKind}`,
        taskId: "guided-advisory-omp",
        workerId: "Advisor OMP",
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
        "guided-advisory-omp",
      )!;
      greenfieldManager.markValidatedNoChange(
        greenfieldScope,
        `mission-${expectedKind}`,
        "guided-advisory-omp",
        advisoryProof.taskHeadSha,
        advisoryProof.integrationHeadSha,
      );

      const execution = greenfieldManager.create({
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
            taskId: "guided-advisory-omp",
          },
        ],
      });
      expect(execution).toMatchObject({
        status: "ready",
        baseSha: baseline.headSha,
        dependencies: [
          worktreeTaskKey(
            `mission-${expectedKind}`,
            "guided-advisory-omp",
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

  it("refuses to adopt untracked files into an unborn baseline", () => {
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

  it("never delegates versioned context authority to executor worktrees", () => {
    expect(() =>
      manager.create({
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
    ).toThrow(/context authority/i);
  });

  it("freezes the canonical base SHA and gives every task a distinct hashed worktree", () => {
    const initialHead = git(root, "rev-parse", "HEAD");
    const hostileMission = "mission/../../$(touch PWNED)";
    const first = manager.create({
      scope: projectScope(),
      missionId: hostileMission,
      taskId: "task; touch PWNED-2",
      workerId: "worker-a",
      ownership: { files: ["src/a.ts"], symbols: ["A"], domains: ["billing"] },
    });
    const second = manager.create({
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

  it("rejects a dirty primary checkout before reserving a task", () => {
    write("dirty.txt", "not committed\n");

    expect(() =>
      manager.create({
        scope: projectScope(),
        missionId: "mission-a",
        taskId: "task-a",
        workerId: "worker-a",
        ownership: { files: ["dirty.txt"], symbols: [], domains: [] },
      }),
    ).toThrow(/clean/i);
    expect(stateStore.read(manager.scopeKey(projectScope())).records).toEqual(
      [],
    );
  });

  it("requires the scope root to be the canonical Git top-level", () => {
    const nested = path.join(root, "src");

    expect(() =>
      manager.create({
        scope: projectScope(fs.realpathSync(nested)),
        missionId: "mission-a",
        taskId: "task-a",
        workerId: "worker-a",
        ownership: { files: ["src/a.ts"], symbols: [], domains: [] },
      }),
    ).toThrow(/Git top-level|canonical/i);
  });

  it("rejects a lexically non-canonical scope even when it resolves to the repository", () => {
    const canonicalRoot = fs.realpathSync(root);
    const nonCanonical = `${canonicalRoot}${path.sep}src${path.sep}..`;
    expect(nonCanonical).not.toBe(canonicalRoot);
    expect(fs.realpathSync(nonCanonical)).toBe(canonicalRoot);

    expect(() =>
      manager.create({
        scope: projectScope(nonCanonical),
        missionId: "mission-a",
        taskId: "task-a",
        workerId: "worker-a",
        ownership: { files: ["src/a.ts"], symbols: [], domains: [] },
      }),
    ).toThrow(/canonical/i);
  });

  it.skipIf(process.platform === "win32")(
    "disables repository hooks while materializing a worker worktree",
    () => {
      const marker = path.join(tempDir, "hook-executed");
      const hook = path.join(root, ".git", "hooks", "post-checkout");
      fs.writeFileSync(
        hook,
        `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
        "utf8",
      );
      fs.chmodSync(hook, 0o700);

      manager.create({
        scope: projectScope(),
        missionId: "mission-hook",
        taskId: "task-hook",
        workerId: "worker-hook",
        ownership: { files: ["hook-safe.txt"], symbols: [], domains: [] },
      });

      expect(fs.existsSync(marker)).toBe(false);
    },
  );

  it("rejects repository-local filters or merge drivers that could execute commands", () => {
    git(root, "config", "filter.evil.smudge", 'sh -c "touch escaped"');

    expect(() =>
      manager.create({
        scope: projectScope(),
        missionId: "mission-filter",
        taskId: "task-filter",
        workerId: "worker-filter",
        ownership: { files: ["filter-safe.txt"], symbols: [], domains: [] },
      }),
    ).toThrow(/executable Git config/i);
    expect(fs.existsSync(path.join(root, "escaped"))).toBe(false);
  });

  it("never assigns the same mission task worktree to another worker", () => {
    const input = {
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "task-a",
      ownership: { files: ["src/a.ts"], symbols: [], domains: [] },
    } as const;
    manager.create({ ...input, workerId: "worker-a" });

    expect(() => manager.create({ ...input, workerId: "worker-b" })).toThrow(
      WorktreeWorkerConflictError,
    );
    expect(() =>
      manager.create({
        ...input,
        workerId: "worker-a",
        ownership: { files: ["src/redefined.ts"], symbols: [], domains: [] },
      }),
    ).toThrow(/immutable/i);
  });

  it("blocks overlapping ownership unless the existing task is an explicit dependency", () => {
    manager.create({
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

    expect(() =>
      manager.create({
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
    ).toThrow(OwnershipOverlapError);

    const dependent = manager.create({
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

  it("creates the QA worktree after a completed read-only reviewer without inventing a Git dependency", () => {
    const logicalDependencies = ["guided-independent-review"];
    const worktreeDependencies =
      selectMissionSchedulerWorktreeDependencies({
        missionId: "mission-guided",
        dependsOn: logicalDependencies,
        getDispatch: (taskId) =>
          taskId === "guided-independent-review"
            ? {
                taskId,
                missionId: "mission-guided",
                state: "completed",
                executionMode: "read_only",
                integrationReceipt: {
                  kind: "read_only_validated",
                  reference: "handoff-reviewer",
                  completedAt: 10,
                },
                completedAt: 10,
              }
            : null,
      });

    expect(worktreeDependencies).toEqual([]);
    const qa = manager.create({
      scope: projectScope(),
      missionId: "mission-guided",
      taskId: "guided-quality-gate",
      workerId: "qa-independent",
      ownership: {
        files: ["src"],
        symbols: [],
        domains: ["guided-quality-gate", "sequential-only"],
      },
      dependsOn: worktreeDependencies,
    });

    expect(qa).toMatchObject({
      missionId: "mission-guided",
      taskId: "guided-quality-gate",
      status: "ready",
      dependencies: [],
    });
  });

  it("blocks a directory claim from running with a nested file claim", () => {
    manager.create({
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

    expect(() =>
      manager.create({
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
    ).toThrow(OwnershipOverlapError);
  });

  it("rejects committed files outside the declared ownership before integration", () => {
    const assignment = manager.create({
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

  it("receipts an unchanged validation worktree without weakening ordinary empty merges", () => {
    const assignment = manager.create({
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

  it("never reclassifies an isolated advisory commit as no-change", () => {
    const assignment = manager.create({
      scope: projectScope(),
      missionId: "mission-guided-advisory-mutation",
      taskId: "guided-advisory-omp",
      workerId: "Advisor OMP",
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
        "guided-advisory-omp",
      ),
    ).toBeNull();
    const unchanged = manager.get(
      projectScope(),
      "mission-guided-advisory-mutation",
      "guided-advisory-omp",
    );
    expect(unchanged).toMatchObject({ status: "ready" });
    expect(unchanged?.taskHeadSha).toBeUndefined();
    expect(unchanged?.integratedSha).toBeUndefined();
  });

  it("rejects an empty commit as fabricated no-change evidence", () => {
    const assignment = manager.create({
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

  it("rejects dirty or untracked QA worktree state as no-change evidence", () => {
    const assignment = manager.create({
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

  it("fails closed when persisted state redirects a task to another path", () => {
    const assignment = manager.create({
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
