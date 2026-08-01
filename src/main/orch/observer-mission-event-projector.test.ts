import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgentSessionInfo: vi.fn(),
  emitMissionEvent: vi.fn(() => true),
}));

vi.mock("../pty/pty-manager", () => ({
  getAgentSessionInfo: mocks.getAgentSessionInfo,
}));
vi.mock("./mission-event-emit", () => ({
  emitMissionEvent: mocks.emitMissionEvent,
}));

import {
  installObserverMissionEventProjector,
  uninstallObserverMissionEventProjector,
} from "./observer-mission-event-projector";
import {
  __resetObserverBusForTests,
  publishObserverFrame,
} from "./observer-bus";

const SCOPE = Object.freeze({
  version: 1 as const,
  installationId: "installation-a",
  projectId: "project-a",
  checkoutId: "checkout-a",
  rootRealPath: "/tmp/project-a",
  identitySource: "provisional" as const,
});

describe("observer mission event projector", () => {
  beforeEach(() => {
    uninstallObserverMissionEventProjector();
    __resetObserverBusForTests();
    mocks.getAgentSessionInfo.mockReset();
    mocks.emitMissionEvent.mockClear();
  });

  it("persists a typed frame as a durable mission event", () => {
    mocks.getAgentSessionInfo.mockReturnValue({
      missionId: "mission-a",
      scope: SCOPE,
    });
    installObserverMissionEventProjector();

    publishObserverFrame({
      sessionId: "session-a",
      paneId: "pane-a",
      missionId: "mission-a",
      kind: "tool_result",
      at: 123,
      payload: { callId: "call-1", toolName: "npm test", ok: true },
    });

    expect(mocks.emitMissionEvent).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({
        missionId: "mission-a",
        type: "observer.tool_result",
        origin: "main",
        occurredAt: 123,
        payload: expect.objectContaining({
          frameSeq: 1,
          paneId: "pane-a",
          observer: { callId: "call-1", toolName: "npm test", ok: true },
        }),
      }),
    );
  });

  it("retains detached sessions in the observer ring without inventing a mission event", () => {
    mocks.getAgentSessionInfo.mockReturnValue(null);
    installObserverMissionEventProjector();

    const frame = publishObserverFrame({
      sessionId: "user-session",
      kind: "session_exited",
      payload: { reason: "pty-exit", lastStatus: null },
    });

    expect(frame?.seq).toBe(1);
    expect(mocks.emitMissionEvent).not.toHaveBeenCalled();
  });
});
