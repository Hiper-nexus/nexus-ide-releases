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
              list: () => {
                throw new Error("synthetic unreadable project runtime");
              },
            },
          },
          {
            scope,
            handoffs: {
              list: () => [queued],
            },
          },
        ],
        deliver,
      }),
    ).toEqual({ attempted: 1, failed: 1 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(queued, scope);
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
