import { describe, expect, it, vi } from "vitest";
import {
  buildShutdownFailureNotice,
  PhysicalPtyShutdownError,
  shutdownOrchestrationRuntimesWithProof,
  shutdownPtyRuntimeWithProof,
} from "./app-shutdown";
import type { TerminateAllSessionsResult } from "./pty/pty-manager";

function result(
  patch: Partial<TerminateAllSessionsResult> = {},
): TerminateAllSessionsResult {
  return {
    ok: true,
    attemptedSessionIds: ["pty-a", "pty-b"],
    terminatedSessionIds: ["pty-a", "pty-b"],
    failedSessionIds: [],
    ...patch,
  };
}

describe("shutdownPtyRuntimeWithProof", () => {
  it("keeps orchestration stores alive through the physical runtime proof", async () => {
    const order: string[] = [];
    const shutdown = shutdownOrchestrationRuntimesWithProof({
      quiesceOrchestration: async () => {
        order.push("quiesce");
      },
      terminateAllSessions: async () => {
        order.push("terminate-ptys");
        return result();
      },
      shutdownPtyHost: () => {
        order.push("shutdown-host");
      },
      reconcileOrchestratorExits: () => {
        order.push("reconcile-exits");
        return true;
      },
      closeOrchestration: async () => {
        order.push("close-orchestration");
      },
    });

    await expect(shutdown).resolves.toEqual(result());
    expect(order).toEqual([
      "quiesce",
      "terminate-ptys",
      "shutdown-host",
      "reconcile-exits",
      "close-orchestration",
    ]);
  });

  it("does not remove exit observers or stores when PTY proof fails", async () => {
    const reconcileOrchestratorExits = vi.fn();
    const closeOrchestration = vi.fn(async () => undefined);

    await expect(
      shutdownOrchestrationRuntimesWithProof({
        quiesceOrchestration: async () => undefined,
        terminateAllSessions: async () =>
          result({
            ok: false,
            terminatedSessionIds: ["pty-a"],
            failedSessionIds: ["pty-b"],
          }),
        shutdownPtyHost: vi.fn(),
        reconcileOrchestratorExits,
        closeOrchestration,
      }),
    ).rejects.toBeInstanceOf(PhysicalPtyShutdownError);
    expect(reconcileOrchestratorExits).not.toHaveBeenCalled();
    expect(closeOrchestration).not.toHaveBeenCalled();
  });

  it("keeps exit observers and stores alive while durable reconciliation is pending", async () => {
    const closeOrchestration = vi.fn(async () => undefined);

    await expect(
      shutdownOrchestrationRuntimesWithProof({
        quiesceOrchestration: async () => undefined,
        terminateAllSessions: async () => result(),
        shutdownPtyHost: vi.fn(),
        reconcileOrchestratorExits: () => false,
        closeOrchestration,
      }),
    ).rejects.toThrow(/not durably complete/);
    expect(closeOrchestration).not.toHaveBeenCalled();
  });

  it("awaits the physical inventory proof before shutting down the host", async () => {
    let resolve!: (value: TerminateAllSessionsResult) => void;
    const termination = new Promise<TerminateAllSessionsResult>((next) => {
      resolve = next;
    });
    const shutdownPtyHost = vi.fn();
    const attempt = shutdownPtyRuntimeWithProof({
      terminateAllSessions: () => termination,
      shutdownPtyHost,
    });

    expect(shutdownPtyHost).not.toHaveBeenCalled();
    resolve(result());
    await expect(attempt).resolves.toEqual(result());
    expect(shutdownPtyHost).toHaveBeenCalledOnce();
  });

  it("keeps the host alive and reports retained sessions when proof fails", async () => {
    const shutdownPtyHost = vi.fn();
    const failed = result({
      ok: false,
      terminatedSessionIds: ["pty-a"],
      failedSessionIds: ["pty-b"],
    });

    const attempt = shutdownPtyRuntimeWithProof({
      terminateAllSessions: async () => failed,
      shutdownPtyHost,
    });
    await expect(attempt).rejects.toBeInstanceOf(PhysicalPtyShutdownError);
    expect(shutdownPtyHost).not.toHaveBeenCalled();

    const notice = buildShutdownFailureNotice(
      new PhysicalPtyShutdownError(failed),
    );
    expect(notice.title).toContain("continua aberto");
    expect(notice.detail).toContain("pty-b");
    expect(notice.detail).toContain("não foi encerrado");
    expect(notice.detail).toContain("novos runtimes");
    expect(notice.detail).toContain("tente novamente");
  });

  it("fails closed on an internally inconsistent success result", async () => {
    const shutdownPtyHost = vi.fn();
    await expect(
      shutdownPtyRuntimeWithProof({
        terminateAllSessions: async () =>
          result({ terminatedSessionIds: ["pty-a"] }),
        shutdownPtyHost,
      }),
    ).rejects.toBeInstanceOf(PhysicalPtyShutdownError);
    expect(shutdownPtyHost).not.toHaveBeenCalled();
  });
});
