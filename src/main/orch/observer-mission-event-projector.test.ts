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

  it("F-780: lifts the tool name and kind to the top of the payload, keeping the frame intact", () => {
    mocks.getAgentSessionInfo.mockReturnValue({
      missionId: "mission-a",
      scope: SCOPE,
    });
    installObserverMissionEventProjector();

    publishObserverFrame({
      sessionId: "session-a",
      paneId: "pane-a",
      missionId: "mission-a",
      kind: "tool_call",
      at: 200,
      payload: { callId: "call-1", toolName: "mcp__nexus__nexus_browser_read" },
    });
    publishObserverFrame({
      sessionId: "session-a",
      paneId: "pane-a",
      missionId: "mission-a",
      kind: "tool_result",
      at: 201,
      payload: { callId: "call-1", toolName: "WebFetch", ok: false },
    });
    publishObserverFrame({
      sessionId: "session-a",
      kind: "status_changed",
      payload: {
        paneId: "pane-a",
        status: "working",
        previousStatus: null,
        transitioned: true,
      },
    });

    const payloads = mocks.emitMissionEvent.mock.calls.map(
      (call) => (call as unknown as [unknown, { payload: Record<string, unknown> }])[1].payload,
    );
    expect(payloads[0]).toMatchObject({
      toolName: "mcp__nexus__nexus_browser_read",
      toolKind: "nexus-browser",
      observer: { callId: "call-1", toolName: "mcp__nexus__nexus_browser_read" },
    });
    expect(payloads[1]).toMatchObject({ toolName: "WebFetch", toolKind: "fetch" });
    // Só quadros de tool ganham os campos; status segue como era.
    expect(payloads[2]).not.toHaveProperty("toolName");
    expect(payloads[2]).not.toHaveProperty("toolKind");
  });

  it("F-780: skillName e shell-http sobem revalidados; rótulo inválido não sobe", () => {
    mocks.getAgentSessionInfo.mockReturnValue({
      missionId: "mission-a",
      scope: SCOPE,
    });
    installObserverMissionEventProjector();

    publishObserverFrame({
      sessionId: "session-a",
      kind: "tool_call",
      payload: { callId: "call-1", toolName: "Skill", skillName: "ponytail" },
    });
    publishObserverFrame({
      sessionId: "session-a",
      kind: "tool_call",
      payload: { callId: "call-2", toolName: "Bash", toolKind: "shell-http" },
    });
    publishObserverFrame({
      sessionId: "session-a",
      kind: "tool_call",
      // Um quadro adulterado não faz a projeção gravar texto livre.
      payload: { callId: "call-3", toolName: "Skill", skillName: "Deploy Prod; rm -rf /" },
    });

    const payloads = mocks.emitMissionEvent.mock.calls.map(
      (call) => (call as unknown as [unknown, { payload: Record<string, unknown> }])[1].payload,
    );
    expect(payloads[0]).toMatchObject({ toolName: "Skill", toolKind: "skill", skillName: "ponytail" });
    expect(payloads[1]).toMatchObject({ toolName: "Bash", toolKind: "shell-http" });
    expect(payloads[2]).toMatchObject({ toolName: "Skill", toolKind: "skill" });
    expect(payloads[2]).not.toHaveProperty("skillName");
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
