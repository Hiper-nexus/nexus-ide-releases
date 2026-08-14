import { describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  getSessionState: vi.fn(() => "busy" as const),
}));

vi.mock("../pty/pty-manager", () => ({
  getSessionState: stubs.getSessionState,
}));

import {
  __evictExitedBufferForTests,
  paneSessionStateForEntry,
  recordPaneSessionExit,
  recordPaneSessionState,
  waitForIdle,
} from "./pane-session-output";

describe("pane session idle wait cancellation", () => {
  it("rejects immediately with the exact abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("orchestration coordinator stopped");
    const pending = waitForIdle(
      "session-aborted-during-boot",
      60_000,
      controller.signal,
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});


// Campo (14/08): o ring de sessão morta sai após 5min e o state do pane caía
// de volta pro último entry.state ('idle') — pane morto ressuscitava como
// vivo no snapshot e o watcher da Via Rápida nunca via livePanes===0.
describe("marca de exit persiste além do TTL do buffer", () => {
  it("pane morto continua 'exited' depois da evicção do ring", () => {
    // duas consultas: antes e depois da evicção do ring
    stubs.getSessionState.mockReturnValueOnce(null as unknown as "busy");
    stubs.getSessionState.mockReturnValueOnce(null as unknown as "busy");
    recordPaneSessionState("pane-morto", "idle");
    recordPaneSessionExit("pane-morto");
    const entry = {
      paneId: "pane-morto",
      title: "pane morto",
      kind: "cli-agent",
      sessionId: "pane-morto",
      state: "idle" as const,
    } satisfies Parameters<typeof paneSessionStateForEntry>[0];
    expect(paneSessionStateForEntry(entry)).toBe("exited");
    __evictExitedBufferForTests("pane-morto");
    expect(paneSessionStateForEntry(entry)).toBe("exited");
  });
});
