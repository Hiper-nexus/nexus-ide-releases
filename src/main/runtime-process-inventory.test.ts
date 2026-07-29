import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  pty: { total: 0, busy: 0 },
  sealPty: vi.fn(),
}));

vi.mock("./pty/pty-manager", () => ({
  liveSessionSummary: () => ({ ...harness.pty }),
  sealPtySessionAdmissionForShutdown: harness.sealPty,
}));

import {
  liveRuntimeProcessSummary,
  sealRuntimeProcessAdmissionForShutdown,
} from "./runtime-process-inventory";

beforeEach(() => {
  harness.pty.total = 0;
  harness.pty.busy = 0;
  vi.clearAllMocks();
});

describe("liveRuntimeProcessSummary", () => {
  it("returns the main-owned PTY inventory without renderer filtering", () => {
    harness.pty.total = 2;
    harness.pty.busy = 1;

    // Exited-but-retained entries still represent physical authority awaiting
    // its teardown receipt, while only active states affect the busy copy.
    expect(liveRuntimeProcessSummary()).toEqual({ total: 2, busy: 1 });
  });

  it("seals PTY process admission synchronously", () => {
    sealRuntimeProcessAdmissionForShutdown();

    expect(harness.sealPty).toHaveBeenCalledOnce();
  });
});
