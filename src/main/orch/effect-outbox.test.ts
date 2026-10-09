import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectRuntimeCapacityError,
  ProjectRuntimeManager,
} from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  createScopedEffectOutboxStore,
  effectClassFor,
  REPLAY_SAFE_EFFECT_TYPES,
  PROCESS_BOUND_EFFECT_TYPES,
  type EffectOutboxStore,
} from "./effect-outbox";
import { drainEffectOutbox } from "./effect-outbox-worker";
import {
  createScopedCommandReceiptStore,
  type CommandEffectAcceptanceInput,
} from "./command-receipts";
import {
  ProviderRuntimeRecoveryError,
  reconcileProviderRuntimeAtBoot,
  reconcileProviderRuntimesAtBoot,
} from "./provider-runtime-recovery";

const directories: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function runtime(baseDir: string): ProjectRuntimeManager {
  const manager = new ProjectRuntimeManager({
    baseDir,
    appVersion: "effect-outbox-test",
  });
  managers.push(manager);
  return manager;
}

function freshStore(): {
  manager: ProjectRuntimeManager;
  store: EffectOutboxStore;
  scope: ReturnType<typeof testProjectScope>;
} {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-effect-outbox-"));
  directories.push(baseDir);
  const scope = testProjectScope();
  const manager = runtime(baseDir);
  const store = createScopedEffectOutboxStore(manager, scope);
  return { manager, store, scope };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ORC-01 effect class policy (T3)", () => {
  it("derives class from effect type, matching the T3 lists", () => {
    for (const type of PROCESS_BOUND_EFFECT_TYPES) {
      expect(effectClassFor(type)).toBe("process_bound");
    }
    for (const type of REPLAY_SAFE_EFFECT_TYPES) {
      expect(effectClassFor(type)).toBe("replay_safe");
    }
    expect(() => effectClassFor("future.process-bound" as never)).toThrow(
      /unknown effect type/,
    );
  });
});

describe("ORC-01 effect outbox", () => {
  it("fails closed on an effect type this binary does not know", () => {
    const { manager, store, scope } = freshStore();
    const db = manager.open(scope).db;
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO effect_outbox (
         effect_id, command_id, thread_id, effect_type, payload_json,
         status, attempt_count, available_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '{}', 'pending', 0, ?, ?, ?)`,
    );
    insert.run(
      "eff-unknown",
      "cmd-unknown",
      "thread-a",
      "future.process-bound",
      now,
      now,
      now,
    );
    const known = store.enqueue({
      commandId: "cmd-known",
      threadId: "thread-a",
      type: "terminal.cleanup",
    });
    expect(() => store.get("eff-unknown")).toThrow(/effect_outbox/);
    const claimed = store.claimNext({
      workerId: "worker-1",
      leaseDurationMs: 1_000,
    });
    expect(claimed?.id).toBe(known.id);
    expect(claimed?.class).toBe("replay_safe");
    const blocked = db
      .prepare(
        `SELECT status, last_error FROM effect_outbox WHERE effect_id = ?`,
      )
      .get("eff-unknown") as { status: string; last_error: string };
    expect(blocked.status).toBe("cancelled");
    expect(blocked.last_error).toContain("not known");

    insert.run(
      "eff-unknown-boot",
      "cmd-unknown-boot",
      "thread-b",
      "future.process-bound",
      now,
      now,
      now,
    );
    expect(store.reconcileAfterProcessLoss().cancelled).toBe(1);
    const reconciled = db
      .prepare(`SELECT status, last_error FROM effect_outbox WHERE effect_id = ?`)
      .get("eff-unknown-boot") as { status: string; last_error: string };
    expect(reconciled.status).toBe("cancelled");
    expect(reconciled.last_error).toContain("not known");
    expect(store.listByStatus("pending").map((entry) => entry.id)).not.toContain(
      "eff-unknown-boot",
    );
  });

  it("enqueue ignores an existing deterministic id (T3 policy)", () => {
    const { store } = freshStore();
    const first = store.enqueue({
      id: "eff-cmd-turn-1",
      commandId: "cmd-turn-1",
      threadId: "thread-a",
      type: "turn.start",
      payload: { paneId: "pane-a" },
    });
    expect(first.status).toBe("pending");
    expect(first.class).toBe("process_bound");
    const second = store.enqueue({
      id: "eff-cmd-turn-1",
      commandId: "cmd-turn-1",
      threadId: "thread-a",
      type: "turn.start",
      payload: { paneId: "pane-other" },
    });
    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ paneId: "pane-a" });
    expect(store.listByStatus("pending")).toHaveLength(1);
  });

  it("rejects a reused id bound to another command, thread, or type", () => {
    const { store } = freshStore();
    store.enqueue({
      id: "eff-bound",
      commandId: "cmd-turn-1",
      threadId: "thread-a",
      type: "turn.start",
    });
    expect(() =>
      store.enqueue({
        id: "eff-bound",
        commandId: "cmd-other",
        threadId: "thread-a",
        type: "turn.start",
      }),
    ).toThrow(/already bound/);
    expect(() =>
      store.enqueue({
        id: "eff-bound",
        commandId: "cmd-turn-1",
        threadId: "thread-b",
        type: "turn.start",
      }),
    ).toThrow(/already bound/);
    expect(() =>
      store.enqueue({
        id: "eff-bound",
        commandId: "cmd-turn-1",
        threadId: "thread-a",
        type: "checkpoint.capture",
      }),
    ).toThrow(/already bound/);
    expect(store.get("eff-bound")?.commandId).toBe("cmd-turn-1");
    expect(store.get("eff-bound")?.threadId).toBe("thread-a");
    expect(store.get("eff-bound")?.type).toBe("turn.start");
  });

  it("claimNext is exclusive and uses a lease", () => {
    const { store } = freshStore();
    store.enqueue({
      commandId: "cmd-1",
      threadId: "thread-a",
      type: "checkpoint.capture",
    });
    const claimed = store.claimNext({
      workerId: "worker-1",
      leaseDurationMs: 30_000,
    });
    expect(claimed?.status).toBe("running");
    expect(claimed?.leaseOwner).toBe("worker-1");
    expect(claimed?.attemptCount).toBe(1);
    expect(
      store.claimNext({ workerId: "worker-2", leaseDurationMs: 30_000 }),
    ).toBeNull();
  });

  it("only the lease owner settles succeed/fail/retry", () => {
    const { store } = freshStore();
    store.enqueue({
      commandId: "cmd-2",
      threadId: "thread-a",
      type: "terminal.cleanup",
    });
    const claimed = store.claimNext({
      workerId: "worker-1",
      leaseDurationMs: 30_000,
    });
    expect(claimed).not.toBeNull();
    expect(store.succeed(claimed!.id, "worker-other", claimed!.attemptCount)).toBe(
      false,
    );
    expect(store.succeed(claimed!.id, "worker-1", claimed!.attemptCount)).toBe(
      true,
    );
    expect(store.get(claimed!.id)?.status).toBe("succeeded");
  });

  it("reconcileAfterProcessLoss: PROCESS_BOUND pending+running → cancelled; REPLAY_SAFE running → pending (T3)", () => {
    const { store } = freshStore();
    const notYet = Date.now() + 60_000;
    const boundPending = store.enqueue({
      commandId: "cmd-bound-pending",
      threadId: "thread-a",
      type: "turn.start",
      availableAt: notYet,
    });
    const boundRunning = store.enqueue({
      commandId: "cmd-bound-running",
      threadId: "thread-b",
      type: "turn.steer",
    });
    const safeRunning = store.enqueue({
      commandId: "cmd-safe-running",
      threadId: "thread-c",
      type: "checkpoint.capture",
    });
    const safePending = store.enqueue({
      commandId: "cmd-safe-pending",
      threadId: "thread-d",
      type: "runtime.continue",
      availableAt: notYet,
    });
    const claimed = [
      store.claimNext({ workerId: "dead-worker", leaseDurationMs: 30_000 })?.id,
      store.claimNext({ workerId: "dead-worker", leaseDurationMs: 30_000 })?.id,
    ].sort();
    expect(claimed).toEqual([boundRunning.id, safeRunning.id].sort());
    expect(
      store.claimNext({ workerId: "dead-worker", leaseDurationMs: 30_000 }),
    ).toBeNull();
    expect(store.get(boundPending.id)?.status).toBe("pending");
    expect(store.get(boundRunning.id)?.status).toBe("running");
    expect(store.get(safeRunning.id)?.status).toBe("running");
    expect(store.get(safePending.id)?.status).toBe("pending");

    const settled = store.reconcileAfterProcessLoss();
    expect(settled.cancelled).toBe(2);
    expect(settled.requeued).toBe(1);

    expect(store.get(boundPending.id)?.status).toBe("cancelled");
    expect(store.get(boundRunning.id)?.status).toBe("cancelled");
    expect(store.get(boundPending.id)?.lastError).toContain(
      "server process ended",
    );
    expect(store.get(safeRunning.id)?.status).toBe("pending");
    expect(store.get(safePending.id)?.status).toBe("pending");
    expect(store.get(safePending.id)?.lastError).toBeNull();
  });

  it("expired running lease fails process_bound and requeues replay_safe", () => {
    let now = 1_000_000;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-effect-lease-"));
    directories.push(baseDir);
    const scope = testProjectScope();
    const manager = runtime(baseDir);
    const store = createScopedEffectOutboxStore(manager, scope, {
      now: () => now,
    });
    const bound = store.enqueue({
      commandId: "cmd-lease-bound",
      threadId: "thread-a",
      type: "turn.start",
    });
    const blocked = store.enqueue({
      commandId: "cmd-lease-next",
      threadId: "thread-a",
      type: "terminal.cleanup",
    });
    const safe = store.enqueue({
      commandId: "cmd-lease-safe",
      threadId: "thread-b",
      type: "checkpoint.capture",
    });
    const claimed = [
      store.claimNext({ workerId: "worker-1", leaseDurationMs: 1_000 })?.id,
      store.claimNext({ workerId: "worker-1", leaseDurationMs: 1_000 })?.id,
    ].sort();
    expect(claimed).toEqual([bound.id, safe.id].sort());
    expect(
      store.claimNext({ workerId: "worker-2", leaseDurationMs: 1_000 }),
    ).toBeNull();
    now += 1_001;
    const next = store.claimNext({
      workerId: "worker-2",
      leaseDurationMs: 1_000,
    });
    expect(store.get(bound.id)?.status).toBe("failed");
    expect(store.get(bound.id)?.leaseOwner).toBeNull();
    expect(store.get(bound.id)?.completedAt).not.toBeNull();
    expect(store.get(bound.id)?.lastError).toContain("lease expired");
    expect(next?.id).toBe(blocked.id);
    expect(next?.status).toBe("running");
    const safeAfter = store.get(safe.id);
    expect(safeAfter?.status).toBe("pending");
    expect(safeAfter?.leaseOwner).toBeNull();
    expect(safeAfter?.lastError).toContain("lease expired");
  });

  it("skips excluded ids before the candidate limit", () => {
    const { store } = freshStore();
    const early = 1_000;
    const excluded = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      const id = `eff-early-${String(index).padStart(2, "0")}`;
      excluded.add(id);
      store.enqueue({
        id,
        commandId: `cmd-early-${index}`,
        threadId: `thread-early-${index}`,
        type: "checkpoint.capture",
        availableAt: early,
      });
    }
    const behind = store.enqueue({
      id: "eff-behind",
      commandId: "cmd-behind",
      threadId: "thread-behind",
      type: "terminal.cleanup",
      availableAt: early + 1,
    });
    const claimed = store.claimNext({
      workerId: "worker-1",
      leaseDurationMs: 30_000,
      excludeIds: excluded,
    });
    expect(claimed?.id).toBe(behind.id);
    expect(claimed?.status).toBe("running");
  });

  it("stale attempt cannot settle a reclaimed lease of the same worker", () => {
    let now = 1_000_000;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-effect-attempt-"));
    directories.push(baseDir);
    const scope = testProjectScope();
    const manager = runtime(baseDir);
    const store = createScopedEffectOutboxStore(manager, scope, {
      now: () => now,
    });
    const effect = store.enqueue({
      commandId: "cmd-stale-attempt",
      threadId: "thread-a",
      type: "checkpoint.capture",
    });
    const first = store.claimNext({
      workerId: "worker-1",
      leaseDurationMs: 1_000,
    });
    expect(first?.attemptCount).toBe(1);
    expect(first?.leaseExpiresAt).toBe(now + 1_000);
    now += 400;
    expect(
      store.renewLease(effect.id, "worker-1", first!.attemptCount, 1_000),
    ).toBe(true);
    const renewedExpiry = now + 1_000;
    expect(store.get(effect.id)?.leaseExpiresAt).toBe(renewedExpiry);
    now = renewedExpiry + 1;
    const reclaimed = store.claimNext({
      workerId: "worker-1",
      leaseDurationMs: 1_000,
    });
    expect(reclaimed?.id).toBe(effect.id);
    expect(reclaimed?.attemptCount).toBe(2);
    expect(reclaimed?.status).toBe("running");
    expect(store.succeed(effect.id, "worker-1", first!.attemptCount)).toBe(false);
    expect(store.retry(effect.id, "worker-1", "stale", 0, first!.attemptCount)).toBe(
      false,
    );
    expect(store.fail(effect.id, "worker-1", "stale", first!.attemptCount)).toBe(
      false,
    );
    expect(
      store.renewLease(effect.id, "worker-1", first!.attemptCount, 1_000),
    ).toBe(false);
    const current = store.get(effect.id);
    expect(current?.status).toBe("running");
    expect(current?.attemptCount).toBe(2);
    expect(current?.leaseOwner).toBe("worker-1");
    expect(current?.leaseExpiresAt).toBe(reclaimed?.leaseExpiresAt);
    expect(store.succeed(effect.id, "worker-1", reclaimed!.attemptCount)).toBe(
      true,
    );
    expect(store.get(effect.id)?.status).toBe("succeeded");
  });

  it("pruneSettled keeps failed rows and drops old succeeded/cancelled", () => {
    const { store } = freshStore();
    const done = store.enqueue({
      commandId: "cmd-prune",
      threadId: "thread-a",
      type: "terminal.cleanup",
    });
    const claimed = store.claimNext({ workerId: "w", leaseDurationMs: 1000 });
    store.succeed(done.id, "w", claimed!.attemptCount);
    // Retention 0 prunes immediately.
    expect(store.pruneSettled(0)).toBe(1);
    expect(store.get(done.id)).toBeNull();
  });
});

describe("ORC-04 command receipts (T3 policy)", () => {
  it("insertIfAbsent is first-aceite only; second call does not overwrite", () => {
    const { manager, scope } = freshStore();
    const receipts = createScopedCommandReceiptStore(manager, scope);
    expect(
      receipts.insertIfAbsent({
        commandId: "cmd-receipt-1",
        commandType: "turn.start",
        threadId: "thread-a",
      }),
    ).toBe(true);
    expect(
      receipts.insertIfAbsent({
        commandId: "cmd-receipt-1",
        commandType: "turn.start",
        threadId: "thread-b",
      }),
    ).toBe(false);
    const receipt = receipts.getByCommandId("cmd-receipt-1");
    expect(receipt?.aggregateId).toBe("thread-a");
    expect(receipt?.resultSequence).toBe(0);
    expect(receipt?.status).toBe("accepted");
  });

  it("commits the receipt and the effect in one transaction", () => {
    const { manager, store, scope } = freshStore();
    const receipts = createScopedCommandReceiptStore(manager, scope);
    const accepted = receipts.acceptCommandEffect(
      store,
      {
        commandId: "cmd-atomic",
        commandType: "turn.start",
        threadId: "thread-a",
      },
      {
        commandId: "cmd-atomic",
        threadId: "thread-a",
        type: "turn.start",
      },
    );
    expect(accepted.inserted).toBe(true);
    expect(accepted.effect?.id).toBe("cmd-atomic");
    expect(accepted.effect?.status).toBe("pending");
    expect(receipts.getByCommandId("cmd-atomic")?.resultSequence).toBe(0);
    const again = receipts.acceptCommandEffect(
      store,
      {
        commandId: "cmd-atomic",
        commandType: "turn.start",
        threadId: "thread-a",
      },
      {
        commandId: "cmd-atomic",
        threadId: "thread-a",
        type: "turn.start",
      },
    );
    expect(again.inserted).toBe(false);
    expect(again.effect?.id).toBe(accepted.effect?.id);
    expect(store.listByCommandId("cmd-atomic")).toHaveLength(1);
    expect(() =>
      receipts.acceptCommandEffect(
        store,
        {
          commandId: "cmd-atomic",
          commandType: "turn.start",
          threadId: "thread-b",
        },
        {
          commandId: "cmd-atomic",
          threadId: "thread-b",
          type: "turn.start",
        },
      ),
    ).toThrow(/already bound/);
    expect(() =>
      receipts.acceptCommandEffect(
        store,
        {
          commandId: "cmd-atomic",
          commandType: "checkpoint.capture",
          threadId: "thread-a",
        },
        {
          commandId: "cmd-atomic",
          threadId: "thread-a",
          type: "checkpoint.capture",
        },
      ),
    ).toThrow(/already bound/);
    expect(store.listByCommandId("cmd-atomic")).toHaveLength(1);
    expect(store.get("cmd-atomic")?.threadId).toBe("thread-a");
    expect(store.get("cmd-atomic")?.type).toBe("turn.start");
    expect(receipts.getByCommandId("cmd-atomic")?.aggregateId).toBe("thread-a");
    expect(receipts.getByCommandId("cmd-atomic")?.commandType).toBe("turn.start");

    store.enqueue({
      id: "eff-taken",
      commandId: "cmd-taken",
      threadId: "thread-z",
      type: "checkpoint.capture",
    });
    expect(() =>
      receipts.acceptCommandEffect(
        store,
        {
          commandId: "cmd-rollback",
          commandType: "turn.start",
          threadId: "thread-a",
        },
        {
          id: "eff-taken",
          commandId: "cmd-rollback",
          threadId: "thread-a",
          type: "turn.start",
        },
      ),
    ).toThrow(/already bound/);
    expect(receipts.getByCommandId("cmd-rollback")).toBeNull();
    expect(store.listByCommandId("cmd-rollback")).toHaveLength(0);
    expect(store.get("eff-taken")?.commandId).toBe("cmd-taken");
  });

  it("F-1045: reused commandId with another identity is a conflict, not a silent old effect", () => {
    const { manager, store, scope } = freshStore();
    const receipts = createScopedCommandReceiptStore(manager, scope);
    const first = receipts.acceptCommandEffect(
      store,
      { commandId: "cmd-reused", commandType: "turn.start", threadId: "mission-a" },
      { commandId: "cmd-reused", threadId: "mission-a", type: "turn.start" },
    );
    expect(first.inserted).toBe(true);
    expect(() =>
      receipts.acceptCommandEffect(
        store,
        {
          commandId: "cmd-reused",
          commandType: "turn.interrupt",
          threadId: "mission-b",
        },
        {
          commandId: "cmd-reused",
          threadId: "mission-b",
          type: "turn.interrupt",
        },
      ),
    ).toThrow(/already bound to another command/);
    // O recibo original permanece o único.
    expect(receipts.getByCommandId("cmd-reused")?.aggregateId).toBe("mission-a");
    expect(store.listByCommandId("cmd-reused")).toHaveLength(1);
  });

  it("does not re-enqueue a command after its settled effect is pruned", () => {
    let now = 5_000_000;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-effect-prune-"));
    directories.push(baseDir);
    const scope = testProjectScope();
    const manager = runtime(baseDir);
    const store = createScopedEffectOutboxStore(manager, scope, {
      now: () => now,
    });
    const receipts = createScopedCommandReceiptStore(manager, scope, {
      now: () => now,
    });
    const succeeded = receipts.acceptCommandEffect(
      store,
      {
        commandId: "cmd-pruned-ok",
        commandType: "turn.start",
        threadId: "thread-a",
      },
      {
        commandId: "cmd-pruned-ok",
        threadId: "thread-a",
        type: "turn.start",
      },
    );
    const claimed = store.claimNext({ workerId: "w", leaseDurationMs: 1_000 });
    expect(
      store.succeed(succeeded.effect!.id, "w", claimed!.attemptCount),
    ).toBe(true);
    const cancelled = receipts.acceptCommandEffect(
      store,
      {
        commandId: "cmd-pruned-cancel",
        commandType: "turn.steer",
        threadId: "thread-b",
      },
      {
        commandId: "cmd-pruned-cancel",
        threadId: "thread-b",
        type: "turn.steer",
      },
    );
    expect(cancelled.effect?.status).toBe("pending");
    store.reconcileAfterProcessLoss();
    expect(store.get(succeeded.effect!.id)?.status).toBe("succeeded");
    expect(store.get(cancelled.effect!.id)?.status).toBe("cancelled");
    expect(store.pruneSettled(0)).toBe(2);
    expect(store.get(succeeded.effect!.id)).toBeNull();
    expect(store.get(cancelled.effect!.id)).toBeNull();
    expect(receipts.getByCommandId("cmd-pruned-ok")).not.toBeNull();
    expect(receipts.getByCommandId("cmd-pruned-cancel")).not.toBeNull();

    const retrySucceeded = receipts.acceptCommandEffect(
      store,
      {
        commandId: "cmd-pruned-ok",
        commandType: "turn.start",
        threadId: "thread-a",
      },
      {
        commandId: "cmd-pruned-ok",
        threadId: "thread-a",
        type: "turn.start",
      },
    );
    const retryCancelled = receipts.acceptCommandEffect(
      store,
      {
        commandId: "cmd-pruned-cancel",
        commandType: "turn.steer",
        threadId: "thread-b",
      },
      {
        commandId: "cmd-pruned-cancel",
        threadId: "thread-b",
        type: "turn.steer",
      },
    );
    expect(retrySucceeded.inserted).toBe(false);
    expect(retrySucceeded.effect).toBeNull();
    expect(retryCancelled.inserted).toBe(false);
    expect(retryCancelled.effect).toBeNull();
    expect(store.listByCommandId("cmd-pruned-ok")).toHaveLength(0);
    expect(store.listByCommandId("cmd-pruned-cancel")).toHaveLength(0);
    expect(store.listByStatus("pending")).toHaveLength(0);
  });

  it("refuses to enqueue an effect for a rejected or already settled receipt", () => {
    const { manager, store, scope } = freshStore();
    const receipts = createScopedCommandReceiptStore(manager, scope);
    expect(() =>
      receipts.acceptCommandEffect(
        store,
        {
          commandId: "cmd-rejected",
          commandType: "turn.start",
          threadId: "thread-a",
          status: "rejected",
        } as unknown as CommandEffectAcceptanceInput,
        {
          commandId: "cmd-rejected",
          threadId: "thread-a",
          type: "turn.start",
        },
      ),
    ).toThrow();
    expect(() =>
      receipts.acceptCommandEffect(
        store,
        {
          commandId: "cmd-settled",
          commandType: "turn.start",
          threadId: "thread-a",
          resultSequence: 4,
        } as unknown as CommandEffectAcceptanceInput,
        {
          commandId: "cmd-settled",
          threadId: "thread-a",
          type: "turn.start",
        },
      ),
    ).toThrow();
    expect(receipts.getByCommandId("cmd-rejected")).toBeNull();
    expect(receipts.getByCommandId("cmd-settled")).toBeNull();
    expect(store.listByCommandId("cmd-rejected")).toHaveLength(0);
    expect(store.listByCommandId("cmd-settled")).toHaveLength(0);
    const accepted = receipts.acceptCommandEffect(
      store,
      {
        commandId: "cmd-explicit-accept",
        commandType: "turn.start",
        threadId: "thread-a",
        status: "accepted",
        resultSequence: 0,
      },
      {
        commandId: "cmd-explicit-accept",
        threadId: "thread-a",
        type: "turn.start",
      },
    );
    expect(accepted.inserted).toBe(true);
    expect(accepted.effect?.status).toBe("pending");
    expect(receipts.getByCommandId("cmd-explicit-accept")?.status).toBe(
      "accepted",
    );
    expect(receipts.getByCommandId("cmd-explicit-accept")?.resultSequence).toBe(
      0,
    );
  });

  it("classifies only listed replay-safe commands as replay_safe", () => {
    const { manager, scope } = freshStore();
    const receipts = createScopedCommandReceiptStore(manager, scope);
    receipts.insertIfAbsent({
      commandId: "cmd-unknown-class",
      commandType: "not.a.real.command",
      threadId: "thread-a",
    });
    receipts.insertIfAbsent({
      commandId: "cmd-safe-class",
      commandType: "checkpoint.capture",
      threadId: "thread-a",
    });
    receipts.insertIfAbsent({
      commandId: "cmd-bound-class",
      commandType: "turn.start",
      threadId: "thread-a",
    });
    expect(receipts.getByCommandId("cmd-unknown-class")?.effectClass).toBe(
      "process_bound",
    );
    expect(receipts.getByCommandId("cmd-safe-class")?.effectClass).toBe(
      "replay_safe",
    );
    expect(receipts.getByCommandId("cmd-bound-class")?.effectClass).toBe(
      "process_bound",
    );
  });

  it("upsert settles the final resultSequence and status", () => {
    const { manager, scope } = freshStore();
    const receipts = createScopedCommandReceiptStore(manager, scope);
    receipts.insertIfAbsent({
      commandId: "cmd-receipt-2",
      commandType: "checkpoint.capture",
      threadId: "thread-a",
    });
    const settled = receipts.upsert({
      commandId: "cmd-receipt-2",
      commandType: "checkpoint.capture",
      threadId: "thread-a",
      resultSequence: 7,
      status: "accepted",
    });
    expect(settled.resultSequence).toBe(7);
    expect(settled.status).toBe("accepted");
    const again = receipts.upsert({
      commandId: "cmd-receipt-2",
      commandType: "checkpoint.capture",
      threadId: "thread-a",
      resultSequence: 8,
      status: "rejected",
      error: "boom",
    });
    expect(again.resultSequence).toBe(8);
    expect(again.status).toBe("rejected");
    expect(again.error).toBe("boom");
  });

  it("upsert rejects a reused commandId bound to another aggregate or type", () => {
    const { manager, scope } = freshStore();
    const receipts = createScopedCommandReceiptStore(manager, scope);
    receipts.insertIfAbsent({
      commandId: "cmd-identity",
      commandType: "turn.start",
      threadId: "thread-a",
    });
    expect(() =>
      receipts.upsert({
        commandId: "cmd-identity",
        commandType: "checkpoint.capture",
        threadId: "thread-a",
        resultSequence: 3,
        status: "accepted",
      }),
    ).toThrow(/already bound/);
    expect(() =>
      receipts.upsert({
        commandId: "cmd-identity",
        commandType: "turn.start",
        threadId: "thread-b",
        resultSequence: 4,
        status: "rejected",
        error: "other settlement",
      }),
    ).toThrow(/already bound/);
    expect(() =>
      receipts.upsert({
        commandId: "cmd-identity",
        commandType: "turn.start",
        projectId: "project-a",
        resultSequence: 5,
        status: "accepted",
      }),
    ).toThrow(/already bound/);
    const stored = receipts.getByCommandId("cmd-identity");
    expect(stored?.commandType).toBe("turn.start");
    expect(stored?.aggregateKind).toBe("thread");
    expect(stored?.aggregateId).toBe("thread-a");
    expect(stored?.resultSequence).toBe(0);
    expect(stored?.status).toBe("accepted");
    expect(stored?.error).toBeNull();
  });

  it("unsettled receipts keep the honest sequence-0 mark", () => {
    const { manager, scope } = freshStore();
    const receipts = createScopedCommandReceiptStore(manager, scope);
    receipts.insertIfAbsent({
      commandId: "cmd-orphan",
      commandType: "turn.restart",
      threadId: "thread-dead",
    });
    expect(receipts.listUnsettled()).toHaveLength(1);
  });
});

describe("ORC-01 worker drain", () => {
  it("handler failure: process_bound fails, replay_safe retries with backoff", async () => {
    const { store, scope } = freshStore();
    store.enqueue({
      commandId: "cmd-wf-bound",
      threadId: "thread-a",
      type: "turn.start",
    });
    store.enqueue({
      commandId: "cmd-wf-safe",
      threadId: "thread-b",
      type: "checkpoint.capture",
    });
    const result = await drainEffectOutbox({
      store,
      scope,
      workerId: "worker-1",
      handler: () => {
        throw new Error("handler exploded");
      },
      retryDelayMs: 0,
    });
    expect(result.claimed).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(1);
  });

  it("drain is safe to repeat after success", async () => {
    const { store, scope } = freshStore();
    store.enqueue({
      commandId: "cmd-wok",
      threadId: "thread-a",
      type: "terminal.cleanup",
    });
    const first = await drainEffectOutbox({
      store,
      scope,
      workerId: "worker-1",
      handler: () => undefined,
    });
    expect(first.succeeded).toBe(1);
    const second = await drainEffectOutbox({
      store,
      scope,
      workerId: "worker-1",
      handler: () => undefined,
    });
    expect(second.claimed).toBe(0);
  });

  it("cancellation releases the claimed row before the abort propagates", async () => {
    const { store, scope } = freshStore();
    const bound = store.enqueue({
      commandId: "cmd-cancel-bound",
      threadId: "thread-a",
      type: "turn.start",
    });
    const safe = store.enqueue({
      commandId: "cmd-cancel-safe",
      threadId: "thread-b",
      type: "checkpoint.capture",
      availableAt: Date.now() + 60_000,
    });
    const context = {
      signal: AbortSignal.abort(new Error("periodic task aborted")),
      assertCurrent() {
        throw new Error("periodic task aborted");
      },
      async checkpoint() {},
      async wait<T>(promise: Promise<T>): Promise<T> {
        await promise;
        throw new Error("periodic task aborted");
      },
    };
    await expect(
      drainEffectOutbox(
        {
          store,
          scope,
          workerId: "worker-1",
          batchSize: 1,
          handler: () => undefined,
        },
        context,
      ),
    ).rejects.toThrow("periodic task aborted");
    expect(store.get(bound.id)?.status).toBe("failed");
    expect(store.get(bound.id)?.leaseOwner).toBeNull();
    expect(store.get(safe.id)?.status).toBe("pending");
    expect(store.get(safe.id)?.lastError).toBeNull();
  });

  it("keeps the claim until the handler settles when renewal throws", async () => {
    const { store, scope } = freshStore();
    const bound = store.enqueue({
      commandId: "cmd-renew-bound",
      threadId: "thread-a",
      type: "turn.start",
    });
    const next = store.enqueue({
      commandId: "cmd-renew-next",
      threadId: "thread-a",
      type: "terminal.cleanup",
    });
    let renewals = 0;
    const crashing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "renewLease") {
          return () => {
            renewals += 1;
            throw new Error("sqlite unavailable");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    let sawRunningClaim = false;
    try {
      const result = await drainEffectOutbox({
        store: crashing,
        scope,
        workerId: "worker-1",
        leaseDurationMs: 3,
        batchSize: 1,
        handler: () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              expect(renewals).toBeGreaterThan(0);
              sawRunningClaim = store.get(bound.id)?.status === "running";
              expect(store.get(bound.id)?.leaseOwner).toBe("worker-1");
              expect(store.get(next.id)?.status).toBe("pending");
              resolve();
            }, 40);
          }),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sawRunningClaim).toBe(true);
      expect(uncaught).toEqual([]);
      expect(result.claimed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.retried).toBe(0);
      expect(store.get(bound.id)?.status).toBe("succeeded");
      expect(store.get(next.id)?.status).toBe("pending");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("retries renewal and blocks lease expiry while the handler is in flight", async () => {
    const { manager, store, scope } = freshStore();
    const other = createScopedEffectOutboxStore(manager, scope);
    const now = Date.now();
    const bound = store.enqueue({
      commandId: "cmd-flight-bound",
      threadId: "thread-a",
      type: "turn.start",
      availableAt: now,
    });
    const next = store.enqueue({
      commandId: "cmd-flight-next",
      threadId: "thread-a",
      type: "terminal.cleanup",
      availableAt: now + 1,
    });
    let renewals = 0;
    const crashing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "renewLease") {
          return () => {
            renewals += 1;
            throw new Error("sqlite unavailable");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await drainEffectOutbox({
      store: crashing,
      scope,
      workerId: "worker-1",
      leaseDurationMs: 30,
      batchSize: 1,
      handler: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            expect(renewals).toBeGreaterThan(1);
            expect(
              other.claimNext({ workerId: "worker-2", leaseDurationMs: 1_000 }),
            ).toBeNull();
            expect(store.get(bound.id)?.status).toBe("running");
            expect(store.get(bound.id)?.leaseOwner).toBe("worker-1");
            expect(store.get(next.id)?.status).toBe("pending");
            resolve();
          }, 90);
        }),
    });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(store.get(bound.id)?.status).toBe("succeeded");
    expect(store.get(next.id)?.status).toBe("pending");

    const replay = freshStore();
    const replayOther = createScopedEffectOutboxStore(
      replay.manager,
      replay.scope,
    );
    const safe = replay.store.enqueue({
      commandId: "cmd-flight-safe",
      threadId: "thread-b",
      type: "checkpoint.capture",
    });
    let replayRenewals = 0;
    const replayCrashing = new Proxy(replay.store, {
      get(target, prop, receiver) {
        if (prop === "renewLease") {
          return () => {
            replayRenewals += 1;
            throw new Error("sqlite unavailable");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const safeResult = await drainEffectOutbox({
      store: replayCrashing,
      scope: replay.scope,
      workerId: "worker-1",
      leaseDurationMs: 30,
      batchSize: 1,
      handler: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            expect(replayRenewals).toBeGreaterThan(1);
            expect(
              replayOther.claimNext({
                workerId: "worker-2",
                leaseDurationMs: 1_000,
              }),
            ).toBeNull();
            expect(replay.store.get(safe.id)?.status).toBe("running");
            resolve();
          }, 90);
        }),
    });
    expect(safeResult.succeeded).toBe(1);
    expect(safeResult.retried).toBe(0);
    expect(replay.store.get(safe.id)?.status).toBe("succeeded");
  });

  it("pins the runtime for an in-flight handler so LRU cannot evict it", () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-effect-flight-pin-"),
    );
    directories.push(baseDir);
    const manager = new ProjectRuntimeManager({
      baseDir,
      appVersion: "effect-outbox-test",
      maxOpen: 1,
    });
    managers.push(manager);
    const scope = testProjectScope({ projectId: "project-flight-pin" });
    const store = createScopedEffectOutboxStore(manager, scope);
    const effect = store.enqueue({
      commandId: "cmd-flight-pin",
      threadId: "thread-a",
      type: "runtime.continue",
    });
    store.retainHandlerFlight(effect.id);
    const other = testProjectScope({
      projectId: "project-flight-other",
      checkoutId: "checkout-other",
    });
    expect(() => manager.open(other)).toThrow(ProjectRuntimeCapacityError);
    store.releaseHandlerFlight(effect.id);
    expect(manager.open(other).closed).toBe(false);
  });

  it("keeps the in-flight guard after the database handle is replaced", () => {
    let now = 1_700_000_000_000;
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-effect-flight-scope-"),
    );
    directories.push(baseDir);
    const manager = new ProjectRuntimeManager({
      baseDir,
      appVersion: "effect-outbox-test",
      maxOpen: 1,
      now: () => now,
    });
    managers.push(manager);
    const scope = testProjectScope({ projectId: "project-flight-scope" });
    const store = createScopedEffectOutboxStore(manager, scope, {
      now: () => now,
    });
    const bound = store.enqueue({
      id: "eff-a-bound",
      commandId: "cmd-scope-bound",
      threadId: "thread-a",
      type: "turn.start",
      availableAt: now,
    });
    const safe = store.enqueue({
      id: "eff-b-safe",
      commandId: "cmd-scope-safe",
      threadId: "thread-b",
      type: "checkpoint.capture",
      availableAt: now,
    });
    expect(
      store.claimNext({ workerId: "worker-1", leaseDurationMs: 1_000 })?.id,
    ).toBe(bound.id);
    expect(
      store.claimNext({ workerId: "worker-1", leaseDurationMs: 1_000 })?.id,
    ).toBe(safe.id);
    store.retainHandlerFlight(bound.id);
    store.retainHandlerFlight(safe.id);
    manager.closeAll();
    now += 60_000;
    const reopened = createScopedEffectOutboxStore(manager, scope, {
      now: () => now,
    });
    expect(
      reopened.claimNext({ workerId: "worker-2", leaseDurationMs: 1_000 }),
    ).toBeNull();
    expect(reopened.get(bound.id)?.status).toBe("running");
    expect(reopened.get(bound.id)?.leaseOwner).toBe("worker-1");
    expect(reopened.get(safe.id)?.status).toBe("running");
    reopened.releaseHandlerFlight(bound.id);
    reopened.releaseHandlerFlight(safe.id);
    const reclaimed = reopened.claimNext({
      workerId: "worker-2",
      leaseDurationMs: 1_000,
    });
    expect(reopened.get(bound.id)?.status).toBe("failed");
    expect(reclaimed?.id).toBe(safe.id);
    expect(reclaimed?.status).toBe("running");
  });
});

describe("ORC-06 provider runtime boot reconciliation", () => {
  it("separates dead PROCESS_BOUND from re-executable REPLAY_SAFE and keeps unsettled receipts", () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-provider-recovery-"),
    );
    directories.push(baseDir);
    const scope = testProjectScope();
    const manager = runtime(baseDir);
    const store = createScopedEffectOutboxStore(manager, scope);
    const receipts = createScopedCommandReceiptStore(manager, scope);

    store.enqueue({
      commandId: "cmd-boot-bound",
      threadId: "thread-a",
      type: "turn.start",
    });
    store.enqueue({
      commandId: "cmd-boot-safe",
      threadId: "thread-b",
      type: "checkpoint.capture",
    });
    // Claim both so they are `running` when the process dies.
    for (let i = 0; i < 2; i += 1) {
      store.claimNext({ workerId: "dead-worker", leaseDurationMs: 30_000 });
    }
    receipts.insertIfAbsent({
      commandId: "cmd-boot-orphan",
      commandType: "turn.start",
      threadId: "thread-dead",
    });

    const result = reconcileProviderRuntimeAtBoot({
      scope,
      runtimeManager: manager,
    });
    expect(result.cancelledEffects).toBe(1);
    expect(result.requeuedEffects).toBe(1);
    expect(result.unsettledReceipts).toBe(1);

    const bound = store.listByCommandId("cmd-boot-bound")[0];
    const safe = store.listByCommandId("cmd-boot-safe")[0];
    expect(bound.status).toBe("cancelled");
    expect(bound.lastError).toContain("server process ended");
    expect(safe.status).toBe("pending");
    expect(safe.lastError).toContain("Requeued");
    expect(receipts.getByCommandId("cmd-boot-orphan")?.resultSequence).toBe(0);
  });

  it("does not touch succeeded effects", () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-provider-recovery-live-"),
    );
    directories.push(baseDir);
    const scope = testProjectScope();
    const manager = runtime(baseDir);
    const store = createScopedEffectOutboxStore(manager, scope);
    const done = store.enqueue({
      commandId: "cmd-boot-done",
      threadId: "thread-a",
      type: "terminal.cleanup",
    });
    const claimed = store.claimNext({
      workerId: "worker-1",
      leaseDurationMs: 30_000,
    });
    store.succeed(done.id, "worker-1", claimed!.attemptCount);
    const result = reconcileProviderRuntimeAtBoot({
      scope,
      runtimeManager: manager,
    });
    expect(result.cancelledEffects).toBe(0);
    expect(result.requeuedEffects).toBe(0);
    expect(store.get(done.id)?.status).toBe("succeeded");
  });

  it("reconciles the scopes it can and blocks claim on the one that failed", () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-provider-recovery-partial-"),
    );
    directories.push(baseDir);
    let blockedPath: string | null = null;
    const manager = new ProjectRuntimeManager({
      baseDir,
      appVersion: "effect-outbox-test",
      databaseFactory: (filename, options) => {
        if (blockedPath === filename && options?.readonly !== true) {
          throw new Error("sqlite temporarily unavailable");
        }
        return new Database(filename, options);
      },
    });
    managers.push(manager);
    const scopeA = testProjectScope({
      projectId: "project-recovery-a",
      checkoutId: "checkout-a",
    });
    const scopeB = testProjectScope({
      projectId: "project-recovery-b",
      checkoutId: "checkout-b",
    });
    const storeA = createScopedEffectOutboxStore(manager, scopeA);
    const storeB = createScopedEffectOutboxStore(manager, scopeB);
    storeA.enqueue({
      commandId: "cmd-a-bound",
      threadId: "thread-a",
      type: "turn.start",
    });
    const live = storeA.enqueue({
      commandId: "cmd-a-live",
      threadId: "thread-live",
      type: "checkpoint.capture",
    });
    const stranded = storeB.enqueue({
      commandId: "cmd-b-bound",
      threadId: "thread-b",
      type: "turn.start",
    });
    manager.close(scopeB);
    blockedPath = manager.locationFor(scopeB).databasePath;

    expect(() =>
      reconcileProviderRuntimesAtBoot(manager, [scopeB, scopeA]),
    ).toThrow(ProviderRuntimeRecoveryError);
    let caught: ProviderRuntimeRecoveryError | null = null;
    try {
      reconcileProviderRuntimesAtBoot(manager, [scopeB, scopeA]);
    } catch (error) {
      caught = error as ProviderRuntimeRecoveryError;
    }
    expect(caught?.failedScopes).toEqual([
      { projectId: scopeB.projectId, checkoutId: scopeB.checkoutId },
    ]);
    expect(storeA.listByCommandId("cmd-a-bound")[0]?.status).toBe("cancelled");
    expect(storeA.get(live.id)?.status).toBe("pending");
    expect(
      storeA.claimNext({ workerId: "worker-a", leaseDurationMs: 1_000 })?.id,
    ).toBe(live.id);
    expect(storeB.get(stranded.id)?.status).toBe("pending");
    expect(() =>
      storeB.claimNext({ workerId: "worker-b", leaseDurationMs: 1_000 }),
    ).toThrow(/not reconciled/);

    blockedPath = null;
    manager.close(scopeB);
    reconcileProviderRuntimeAtBoot({ scope: scopeB, runtimeManager: manager });
    expect(storeB.get(stranded.id)?.status).toBe("cancelled");
    expect(
      storeB.claimNext({ workerId: "worker-b", leaseDurationMs: 1_000 }),
    ).toBeNull();
  });
});
