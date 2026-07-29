import { describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  getSessionState: vi.fn(() => "busy" as const),
}));

vi.mock("../pty/pty-manager", () => ({
  getSessionState: stubs.getSessionState,
}));

import { waitForIdle } from "./pane-session-output";

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
