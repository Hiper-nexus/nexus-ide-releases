import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Handoff } from "../../shared/orch-types";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import { reconcilePendingHandoffDeliveryOutbox } from "./handoff-delivery-outbox";
import { createScopedHandoffStore } from "./handoff-store";
import { createScopedMissionStore } from "./mission-store";

const directories: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function runtime(baseDir: string): ProjectRuntimeManager {
  const manager = new ProjectRuntimeManager({
    baseDir,
    appVersion: "handoff-outbox-test",
  });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable handoff delivery outbox", () => {
  it("recovers an accepted delivery after restart before consumption committed", () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-handoff-outbox-accepted-crash-"),
    );
    directories.push(baseDir);
    const scope = testProjectScope();
    const firstRuntime = runtime(baseDir);
    const missions = createScopedMissionStore(firstRuntime, scope, {
      idFactory: () => "mission-accepted-crash",
    });
    const handoffs = createScopedHandoffStore(firstRuntime, scope, {
      idFactory: () => "handoff-accepted-crash",
    });
    missions.create({
      title: "Accepted delivery crash",
      orchestratorSessionId: "orchestrator-current",
    });
    missions.setStatus("mission-accepted-crash", "running");
    const handoff = handoffs.submit({
      missionId: "mission-accepted-crash",
      sessionId: "worker-current",
      status: "success",
      summary: "Acceptance committed immediately before the main process died.",
    });
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: "mission-accepted-crash",
      orchestratorSessionId: "orchestrator-current",
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    expect(handoffs.get(handoff.id)).toMatchObject({
      delivered: true,
      deliveryState: "submitted",
    });

    // Crash before markConsumedAfterAcceptedDelivery, then reopen the same DB.
    firstRuntime.closeAll();
    const restartedRuntime = runtime(baseDir);
    const restartedHandoffs = createScopedHandoffStore(
      restartedRuntime,
      scope,
    );
    const deliver = vi.fn();
    const suites = [{ scope, handoffs: restartedHandoffs }];

    // Aceito e aguardando ACK: a reconciliação da Via Rápida nunca re-pasta
    // nem sintetiza consumo — o handoff permanece exatamente como estava.
    expect(
      reconcilePendingHandoffDeliveryOutbox({
        suites,
        deliver,
      }),
    ).toEqual({ attempted: 1, failed: 0 });
    expect(deliver).not.toHaveBeenCalled();
    expect(restartedHandoffs.get(handoff.id)).toMatchObject({
      delivered: true,
      deliveryState: "submitted",
    });
  });

  it("retries an accepted delivery requeued by orchestrator rebind", () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-handoff-outbox-rebind-"),
    );
    directories.push(baseDir);
    const scope = testProjectScope();
    const currentRuntime = runtime(baseDir);
    const missions = createScopedMissionStore(currentRuntime, scope, {
      idFactory: () => "mission-rebound",
    });
    const handoffs = createScopedHandoffStore(currentRuntime, scope, {
      idFactory: () => "handoff-rebound",
    });
    missions.create({
      title: "Rebound delivery",
      orchestratorSessionId: "orchestrator-retired",
    });
    missions.setStatus("mission-rebound", "running");
    const handoff = handoffs.submit({
      missionId: "mission-rebound",
      sessionId: "worker-rebound",
      status: "success",
      summary: "The retired orchestrator already accepted this handoff.",
    });
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: "mission-rebound",
      orchestratorSessionId: "orchestrator-retired",
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        handoff.id,
        "mission-rebound",
        "orchestrator-retired",
      ),
    ).toBe(true);

    missions.rebindOrchestratorSession(
      "mission-rebound",
      "orchestrator-current",
    );
    expect(handoffs.get(handoff.id)).toMatchObject({
      delivered: false,
      deliveryState: "queued",
    });
    const deliver = vi.fn();

    expect(
      reconcilePendingHandoffDeliveryOutbox({
        suites: [{ scope, handoffs }],
        deliver,
      }),
    ).toEqual({ attempted: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        id: handoff.id,
        deliveryState: "queued",
      }),
      scope,
    );
  });

  it("isolates an unreadable project suite and still delivers healthy suites", () => {
    const scope = testProjectScope();
    const queued: Handoff = {
      id: "handoff-healthy",
      missionId: "mission-healthy",
      sessionId: "worker-healthy",
      status: "success",
      claimTrust: "untrusted",
      summary: "Healthy project delivery remains available.",
      artifacts: [],
      evidenceIds: [],
      evidenceTrust: "unverified",
      delivered: false,
      deliveryState: "queued",
      createdAt: 1,
    };
    const deliver = vi.fn();

    expect(
      reconcilePendingHandoffDeliveryOutbox({
        suites: [
          {
            scope,
            handoffs: {
              listDeliveryOutboxCandidates: () => {
                throw new Error("synthetic unreadable project runtime");
              },
            },
          },
          {
            scope,
            handoffs: {
              listDeliveryOutboxCandidates: () => [queued],
            },
          },
        ],
        deliver,
      }),
    ).toEqual({ attempted: 1, failed: 1 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(queued, scope);
  });

  it("does not rescan accepted delivery history after its mission is terminal", () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-handoff-outbox-terminal-"),
    );
    directories.push(baseDir);
    const scope = testProjectScope();
    const currentRuntime = runtime(baseDir);
    const missions = createScopedMissionStore(currentRuntime, scope, {
      idFactory: () => "mission-terminal",
    });
    const handoffs = createScopedHandoffStore(currentRuntime, scope, {
      idFactory: (prefix) => `${prefix}-terminal`,
    });
    missions.create({
      title: "Terminal accepted delivery",
      orchestratorSessionId: "orchestrator-terminal",
    });
    const running = missions.setStatus("mission-terminal", "running")!;
    const handoff = handoffs.submit({
      missionId: "mission-terminal",
      sessionId: "worker-terminal",
      status: "success",
      summary: "Transport accepted before the mission reached done.",
    });
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: "mission-terminal",
      orchestratorSessionId: "orchestrator-terminal",
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    expect(handoffs.listDeliveryOutboxCandidates()).toHaveLength(1);

    missions.transitionLifecycle(
      "mission-terminal",
      {
        updatedAt: running.updatedAt,
        intentVersion: running.intentVersion ?? 0,
      },
      {
        status: "done",
        intentState: "done",
        learnings: "Accepted delivery verified before terminal recovery.",
        result: {
          outcome: "success",
          summary: "Accepted delivery verified before terminal recovery.",
          evidenceIds: [],
          artifactRefs: [],
        },
      },
    );

    expect(
      reconcilePendingHandoffDeliveryOutbox({
        suites: [{ scope, handoffs }],
      }),
    ).toEqual({ attempted: 0, failed: 0 });
  });

  it("recovers queued work after restart and retries a throwing callback", () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-handoff-outbox-"),
    );
    directories.push(baseDir);
    const scope = testProjectScope();
    const firstRuntime = runtime(baseDir);
    const missions = createScopedMissionStore(firstRuntime, scope, {
      idFactory: () => "mission-outbox",
    });
    missions.create({ title: "Durable outbox" });
    missions.setStatus("mission-outbox", "running");
    const firstHandoffs = createScopedHandoffStore(firstRuntime, scope, {
      idFactory: () => "handoff-outbox",
    });
    firstHandoffs.submit({
      missionId: "mission-outbox",
      sessionId: "worker-outbox",
      status: "success",
      summary: "Commit completed before the delivery callback could enqueue.",
    });

    // Simulate a main-process crash after SQLite commit and before enqueue.
    firstRuntime.closeAll();
    const restartedRuntime = runtime(baseDir);
    const restartedHandoffs = createScopedHandoffStore(
      restartedRuntime,
      scope,
    );
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("synthetic post-commit callback crash");
      })
      .mockImplementation((handoff: { id: string }) => {
        restartedHandoffs.markSubmitted(handoff.id);
      });
    const suites = [{ scope, handoffs: restartedHandoffs }];

    expect(
      reconcilePendingHandoffDeliveryOutbox({ suites, deliver }),
    ).toEqual({ attempted: 1, failed: 1 });
    expect(restartedHandoffs.list()).toHaveLength(1);

    expect(
      reconcilePendingHandoffDeliveryOutbox({ suites, deliver }),
    ).toEqual({ attempted: 1, failed: 0 });
    expect(restartedHandoffs.list()).toHaveLength(0);

    expect(
      reconcilePendingHandoffDeliveryOutbox({ suites, deliver }),
    ).toEqual({ attempted: 0, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
