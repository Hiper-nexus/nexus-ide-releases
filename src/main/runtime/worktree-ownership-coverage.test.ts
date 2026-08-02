/**
 * Two simultaneous missions in the SAME checkout.
 *
 * The Guided planner cannot know which files a natural-language goal will
 * touch, so it seals a bounded projection of the repository inventory (plus
 * the greenfield scaffold seed) as the executor's write permit. That permit is
 * identical for every mission on the same checkout, so treating it as an
 * exclusive claim made mission B collide with mission A by arithmetic — never
 * by an actual shared writer.
 *
 * These tests pin the split: a coverage permit is a capability, a concrete
 * file claim is still exclusive.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  OwnershipOverlapError,
  WorktreeManager,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "./worktree-manager";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Wire value of the coverage label. Written literally on purpose: it is
 * persisted inside sealed plan receipts and `ownership_json`, so renaming it
 * is a migration, not a refactor.
 */
const COVERAGE_DOMAIN = "repository-coverage";

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
}

let tempDir = "";
let root = "";
let manager: WorktreeManager;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(relativePath: string, content: string, cwd: string): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function projectScope(): ProjectExecutionScope {
  return {
    version: 1,
    installationId: "installation-test",
    projectId: PROJECT_ID,
    checkoutId: "checkout-simultaneous-missions",
    rootRealPath: fs.realpathSync(root),
    identitySource: "manifest",
  };
}

/**
 * What `ensureGuidedMissionPlan` seals for a goal that names no file: the
 * bounded repository inventory plus the greenfield scaffold seed, labelled as
 * coverage.
 */
function guidedCoverageOwnership() {
  return {
    files: [
      // Real top-level tree of this fixture checkout.
      "README.md",
      "package.json",
      "src",
      "tests",
      // Greenfield seed entries that do not exist here at all.
      "Cargo.toml",
      "App.sln",
      "Gemfile",
      "pyproject.toml",
      ".editorconfig",
    ],
    symbols: [],
    domains: ["guided-implementation", COVERAGE_DOMAIN],
  } as const;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-worktree-coverage-"));
  root = path.join(tempDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Nexus Test");
  git(root, "config", "user.email", "nexus@example.test");
  write("src/shared.ts", "export const base = 1;\n", root);
  write("tests/shared.test.ts", "export const spec = 1;\n", root);
  write("package.json", '{ "name": "fixture" }\n', root);
  write("README.md", "# Fixture\n", root);
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  manager = new WorktreeManager({
    runtimeRoot: path.join(tempDir, "runtime"),
    stateStore: new MemoryWorktreeStateStore(),
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("simultaneous missions on one checkout", () => {
  it("dispatches a second guided mission while the first holds the coverage permit", async () => {
    const missionA = await manager.create({
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "guided-implementation",
      workerId: "worker-a",
      ownership: guidedCoverageOwnership(),
    });
    expect(missionA).toMatchObject({ status: "ready", missionId: "mission-a" });

    const missionB = await manager.create({
      scope: projectScope(),
      missionId: "mission-b",
      taskId: "guided-implementation",
      workerId: "worker-b",
      ownership: guidedCoverageOwnership(),
    });
    expect(missionB).toMatchObject({ status: "ready", missionId: "mission-b" });
  });

  it("keeps blocking two tasks that name the same concrete file, naming the conflict", async () => {
    await manager.create({
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "task-precise",
      workerId: "worker-a",
      ownership: { files: ["src/shared.ts"], symbols: [], domains: [] },
    });

    const collision = manager.create({
      scope: projectScope(),
      missionId: "mission-b",
      taskId: "task-precise-too",
      workerId: "worker-b",
      ownership: { files: ["src/shared.ts"], symbols: [], domains: [] },
    });

    await expect(collision).rejects.toBeInstanceOf(OwnershipOverlapError);
    await expect(collision).rejects.toThrow(
      /mission-a[\s\S]*task-precise|task-precise/,
    );
    await expect(collision).rejects.toThrow(/src\/shared\.ts/);
  });

  it("keeps the coverage surface exclusive INSIDE one mission", async () => {
    await manager.create({
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "guided-implementation",
      workerId: "worker-a",
      ownership: guidedCoverageOwnership(),
    });

    // One mission = one sealed delivery contract = one writer on its own
    // coverage surface. Relaxing this would let a guided chain open a second
    // writer on itself.
    await expect(
      manager.create({
        scope: projectScope(),
        missionId: "mission-a",
        taskId: "guided-isolated-advisory",
        workerId: "worker-a2",
        ownership: guidedCoverageOwnership(),
      }),
    ).rejects.toBeInstanceOf(OwnershipOverlapError);
  });

  it("keeps blocking a directory claim against a nested file claim", async () => {
    await manager.create({
      scope: projectScope(),
      missionId: "mission-a",
      taskId: "task-directory",
      workerId: "worker-a",
      ownership: { files: ["src/feature"], symbols: [], domains: [] },
    });

    await expect(
      manager.create({
        scope: projectScope(),
        missionId: "mission-b",
        taskId: "task-nested",
        workerId: "worker-b",
        ownership: {
          files: ["src/feature/utils.ts"],
          symbols: [],
          domains: [],
        },
      }),
    ).rejects.toBeInstanceOf(OwnershipOverlapError);
  });

  it("never conflicts on greenfield seed entries that do not exist in the checkout", async () => {
    await manager.create({
      scope: projectScope(),
      missionId: "mission-seed-a",
      taskId: "task-a",
      workerId: "worker-a",
      ownership: {
        files: ["Cargo.toml", "App.sln", "Gemfile"],
        symbols: [],
        domains: [COVERAGE_DOMAIN],
      },
    });

    const second = await manager.create({
      scope: projectScope(),
      missionId: "mission-seed-b",
      taskId: "task-b",
      workerId: "worker-b",
      ownership: {
        files: ["Cargo.toml", "App.sln", "Gemfile"],
        symbols: [],
        domains: [COVERAGE_DOMAIN],
      },
    });
    expect(second).toMatchObject({ status: "ready" });
  });

  it("refuses to integrate a coverage task whose real diff lands on another task's exclusive claim", async () => {
    const precise = await manager.create({
      scope: projectScope(),
      missionId: "mission-precise",
      taskId: "task-precise",
      workerId: "worker-precise",
      ownership: { files: ["src/shared.ts"], symbols: [], domains: [] },
    });
    expect(precise.status).toBe("ready");

    const coverage = await manager.create({
      scope: projectScope(),
      missionId: "mission-coverage",
      taskId: "guided-implementation",
      workerId: "worker-coverage",
      ownership: guidedCoverageOwnership(),
    });

    write("src/shared.ts", "export const base = 2;\n", coverage.worktreePath);
    git(coverage.worktreePath, "add", ".");
    git(coverage.worktreePath, "commit", "-m", "touch the exclusive claim");

    expect(() =>
      manager.prepareIntegration(
        projectScope(),
        "mission-coverage",
        "guided-implementation",
      ),
    ).toThrow(OwnershipOverlapError);
  });

  it("integrates a coverage task whose real diff stays clear of exclusive claims", async () => {
    await manager.create({
      scope: projectScope(),
      missionId: "mission-precise",
      taskId: "task-precise",
      workerId: "worker-precise",
      ownership: { files: ["src/shared.ts"], symbols: [], domains: [] },
    });

    const coverage = await manager.create({
      scope: projectScope(),
      missionId: "mission-coverage",
      taskId: "guided-implementation",
      workerId: "worker-coverage",
      ownership: guidedCoverageOwnership(),
    });

    write("src/other.ts", "export const other = true;\n", coverage.worktreePath);
    git(coverage.worktreePath, "add", ".");
    git(coverage.worktreePath, "commit", "-m", "stay clear");

    expect(
      manager.prepareIntegration(
        projectScope(),
        "mission-coverage",
        "guided-implementation",
      ),
    ).toMatchObject({ changedFiles: ["src/other.ts"] });
  });
});
