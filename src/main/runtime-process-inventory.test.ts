import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  pty: { total: 0, busy: 0 },
  omp: { total: 0, busy: 0 },
  sealPty: vi.fn(),
  sealOmp: vi.fn(),
}));

vi.mock("./pty/pty-manager", () => ({
  liveSessionSummary: () => ({ ...harness.pty }),
  sealPtySessionAdmissionForShutdown: harness.sealPty,
}));

vi.mock("./adapters/omp-rpc-ipc", () => ({
  liveOmpRpcRuntimeSummary: () => ({ ...harness.omp }),
  sealOmpRpcAdmissionForShutdown: harness.sealOmp,
}));

import {
  liveRuntimeProcessSummary,
  sealRuntimeProcessAdmissionForShutdown,
} from "./runtime-process-inventory";

beforeEach(() => {
  harness.pty.total = 0;
  harness.pty.busy = 0;
  harness.omp.total = 0;
  harness.omp.busy = 0;
  vi.clearAllMocks();
});

describe("liveRuntimeProcessSummary", () => {
  it("keeps an OMP-only headless mission visible to native close", () => {
    harness.omp.total = 1;
    harness.omp.busy = 1;

    expect(liveRuntimeProcessSummary()).toEqual({ total: 1, busy: 1 });
  });

  it("aggregates PTY and OMP without renderer ownership filtering", () => {
    harness.pty.total = 2;
    harness.pty.busy = 1;
    harness.omp.total = 3;
    harness.omp.busy = 1;

    // Exited-but-retained entries still represent physical authority awaiting
    // its teardown receipt, while only active states affect the busy copy.
    expect(liveRuntimeProcessSummary()).toEqual({ total: 5, busy: 2 });
  });

  it("seals both process backends synchronously", () => {
    sealRuntimeProcessAdmissionForShutdown();

    expect(harness.sealPty).toHaveBeenCalledOnce();
    expect(harness.sealOmp).toHaveBeenCalledOnce();
  });
});
