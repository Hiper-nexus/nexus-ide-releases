import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import { classifyOperationalFailure } from "../runtime/operational-failure-policy";
import {
  WorktreeManager,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "../runtime/worktree-manager";
import type { AgentGateContext } from "./gate";
import {
  assertReadOnlyLaneObservationCurrent,
  committedPhysicalWorkerHead,
  STALE_READ_ONLY_OBSERVATION_REASON,
  StaleReadOnlyObservationError,
} from "./physical-handoff-git";
import type {
  TaskDispatchRecord,
  TaskIntegrationReceipt,
} from "./task-dispatch-codec";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function dispatchRecord(
  overrides: Partial<TaskDispatchRecord> = {},
): TaskDispatchRecord {
  return {
    id: "dispatch-1",
    taskId: "task-advisor",
    missionId: "mission-1",
    intentVersion: 1,
    revision: 1,
    attempt: 1,
    state: "running",
    leaseOwner: "main-orchestration-coordinator",
    leaseExpiresAt: 1_000,
    workerId: "Advisor GLM",
    ownership: {
      files: [],
      symbols: [],
      domains: ["guided-advisory"],
    },
    executionMode: "read_only",
    agentCategory: "scout",
    createdAt: 1,
    updatedAt: 1,
    projectId: "project-a",
    checkoutId: "checkout-a",
    ...overrides,
  };
}

function integratedExecutor(
  reference: string,
  completedAt: number,
  overrides: Partial<TaskDispatchRecord> = {},
): TaskDispatchRecord {
  const receipt: TaskIntegrationReceipt = {
    kind: "worktree_integrated",
    reference,
    completedAt,
  };
  return dispatchRecord({
    id: "dispatch-executor",
    taskId: "task-executor",
    workerId: "Executor",
    executionMode: "isolated_worktree",
    agentCategory: "executor",
    ownership: {
      files: ["src"],
      symbols: [],
      domains: ["guided-implementation"],
    },
    integrationReceipt: receipt,
    state: "completed",
    completedAt,
    ...overrides,
  });
}

describe("assertReadOnlyLaneObservationCurrent", () => {
  it("rejects a read_only handoff that straddles the executor integration", () => {
    const lane = dispatchRecord();
    const executor = integratedExecutor(SHA_B, 50);
    let thrown: unknown;
    try {
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches: [lane, executor],
        worktreeHeadSha: SHA_A,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StaleReadOnlyObservationError);
    const message = (thrown as Error).message;
    expect(message).toContain(STALE_READ_ONLY_OBSERVATION_REASON);
    // The worker did nothing wrong — the message must say so, in PT-BR,
    // and the failure must classify as retryable, never terminal.
    expect(message).toMatch(/não é uma falha/i);
    expect(classifyOperationalFailure(thrown)).toBe("retryable");
  });

  it("accepts a read_only handoff that seals the integrated HEAD", () => {
    const lane = dispatchRecord();
    const executor = integratedExecutor(SHA_B, 50);
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches: [lane, executor],
        worktreeHeadSha: SHA_B,
      }),
    ).not.toThrow();
  });

  it("does not affect a handoff submitted before any integration", () => {
    const lane = dispatchRecord();
    const preIntegrationExecutor = dispatchRecord({
      id: "dispatch-executor",
      taskId: "task-executor",
      executionMode: "isolated_worktree",
      agentCategory: "executor",
      ownership: { files: ["src"], symbols: [], domains: ["guided-implementation"] },
    });
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches: [lane, preIntegrationExecutor],
        worktreeHeadSha: SHA_A,
      }),
    ).not.toThrow();
  });

  it("never rejects a replay of an already-delivered handoff", () => {
    const lane = dispatchRecord({ handoffId: "handoff-1", handoffAcceptedAt: 40 });
    const executor = integratedExecutor(SHA_B, 50);
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches: [lane, executor],
        worktreeHeadSha: SHA_A,
      }),
    ).not.toThrow();
  });

  it("never fences an implementation lane", () => {
    const lane = dispatchRecord({
      executionMode: "isolated_worktree",
      agentCategory: "executor",
      ownership: { files: ["src"], symbols: [], domains: ["guided-implementation"] },
    });
    const executor = integratedExecutor(SHA_B, 50, {
      id: "dispatch-other",
      taskId: "task-other",
    });
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches: [lane, executor],
        worktreeHeadSha: SHA_A,
      }),
    ).not.toThrow();
  });

  it("never fences a non-Guided read_only lane", () => {
    const lane = dispatchRecord({
      ownership: { files: [], symbols: [], domains: ["review-only"] },
    });
    const executor = integratedExecutor(SHA_B, 50);
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches: [lane, executor],
        worktreeHeadSha: SHA_A,
      }),
    ).not.toThrow();
  });

  it("fences Guided independent-review and read_only quality-gate lanes equally", () => {
    for (const [domains, agentCategory] of [
      [["guided-independent-review"], "reviewer"],
      [["guided-quality-gate", "sequential-only"], "reviewer"],
    ] as const) {
      const lane = dispatchRecord({
        agentCategory,
        ownership: { files: [], symbols: [], domains: [...domains] },
      });
      const executor = integratedExecutor(SHA_B, 50);
      expect(() =>
        assertReadOnlyLaneObservationCurrent({
          lane,
          missionDispatches: [lane, executor],
          worktreeHeadSha: SHA_A,
        }),
      ).toThrow(StaleReadOnlyObservationError);
    }
  });

  it("compares against the latest integration when several executors integrated", () => {
    const lane = dispatchRecord();
    const first = integratedExecutor(SHA_B, 50, {
      id: "dispatch-executor-1",
      taskId: "task-executor-1",
    });
    const latest = integratedExecutor(SHA_C, 60, {
      id: "dispatch-executor-2",
      taskId: "task-executor-2",
    });
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches: [lane, first, latest],
        worktreeHeadSha: SHA_C,
      }),
    ).not.toThrow();
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches: [lane, first, latest],
        worktreeHeadSha: SHA_B,
      }),
    ).toThrow(StaleReadOnlyObservationError);
  });
});

describe("stale-observation fence over real Git", () => {
  class MemoryWorktreeStateStore implements WorktreeStateStore {
    readonly #states = new Map<string, WorktreeStateSnapshot>();

    read(scopeKey: string): WorktreeStateSnapshot {
      return this.#states.get(scopeKey) ?? { revision: 0, records: [] };
    }

    compareAndSwap(
      scopeKey: string,
      expectedRevision: number,
      records: WorktreeStateSnapshot["records"],
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

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-stale-observation-"));
    root = path.join(tempDir, "repo");
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Nexus Test");
    git(root, "config", "user.email", "nexus@example.test");
    fs.writeFileSync(path.join(root, "README.md"), "# Test\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "initial");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects the straddling handoff, re-anchors on re-dispatch and seals the final HEAD", async () => {
    const rootRealPath = fs.realpathSync(root);
    const scope: ProjectExecutionScope = {
      version: 1,
      installationId: "installation-test",
      projectId: "11111111-1111-4111-8111-111111111111",
      checkoutId: "checkout-stale-observation",
      rootRealPath,
      identitySource: "manifest",
    };
    const manager = new WorktreeManager({
      runtimeRoot: path.join(tempDir, "runtime"),
      stateStore: new MemoryWorktreeStateStore(),
      now: () => 1_700_000_000_000,
    });
    // Kickoff wave: the advisor claims its worktree at the initial HEAD and
    // its session is bound BEFORE the executor integrates (the GLM race).
    const advisor = await manager.create({
      scope,
      missionId: "mission-stale",
      taskId: "task-advisor",
      workerId: "Advisor GLM",
      ownership: { files: [], symbols: [], domains: ["guided-advisory"] },
    });
    const initialHead = advisor.baseSha;
    const ctx: AgentGateContext = {
      token: "token",
      label: "Advisor GLM",
      role: "worker",
      scope,
      executionScope: { ...scope, rootRealPath: advisor.worktreePath },
      allowedTools: null,
      allowedSkills: null,
      stopAttempts: 0,
      handoffSubmitted: false,
    };
    // The executor integrates while the advisor is still working.
    fs.writeFileSync(path.join(root, "src.ts"), "export const x = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "executor integration");
    const finalHead = git(root, "rev-parse", "HEAD");
    expect(finalHead).not.toBe(initialHead);

    const lane = dispatchRecord({ taskId: "task-advisor", missionId: "mission-stale" });
    const executor = integratedExecutor(finalHead, 1_700_000_000_000, {
      missionId: "mission-stale",
    });
    const missionDispatches = [lane, executor];

    // The honestly-observed tree is stale: the handoff is refused and nothing
    // is sealed against the initial HEAD with a post-integration timestamp.
    const staleHead = await committedPhysicalWorkerHead(ctx, true);
    expect(staleHead).toBe(initialHead);
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches,
        worktreeHeadSha: staleHead!,
      }),
    ).toThrow(StaleReadOnlyObservationError);
    expect(advisor.baseSha).toBe(initialHead);

    // The scheduler re-dispatches: the (re)bind re-anchors the claim-time
    // worktree to the integrated HEAD.
    const reanchored = manager.reanchorReadyWorktreeToIntegrationHead(
      scope,
      "mission-stale",
      "task-advisor",
    );
    expect(reanchored?.baseSha).toBe(finalHead);

    // The retried review reads and seals the final HEAD honestly — exactly
    // the chronology the completion invariant demands post-integration.
    const finalRead = await committedPhysicalWorkerHead(ctx, true);
    expect(finalRead).toBe(finalHead);
    expect(() =>
      assertReadOnlyLaneObservationCurrent({
        lane,
        missionDispatches,
        worktreeHeadSha: finalRead!,
      }),
    ).not.toThrow();
  });
});
