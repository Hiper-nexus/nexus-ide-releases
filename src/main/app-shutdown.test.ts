import { describe, expect, it, vi } from "vitest";
import {
  buildShutdownFailureNotice,
  PhysicalOmpShutdownError,
  PhysicalPtyShutdownError,
  shutdownOrchestrationRuntimesWithProof,
  shutdownPtyRuntimeWithProof,
} from "./app-shutdown";
import type { PhysicalSessionShutdownResult } from "./app-shutdown";
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

function ompResult(
  patch: Partial<PhysicalSessionShutdownResult> = {},
): PhysicalSessionShutdownResult {
  return {
    ok: true,
    attemptedSessionIds: ["omp-a"],
    terminatedSessionIds: ["omp-a"],
    failedSessionIds: [],
    ...patch,
  };
}

describe("shutdownPtyRuntimeWithProof", () => {
  it("keeps orchestration stores alive through both physical runtime proofs", async () => {
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
      terminateAllOmpSessions: async () => {
        order.push("terminate-omp");
        return ompResult();
      },
      closeOrchestration: async () => {
        order.push("close-orchestration");
      },
    });

    await expect(shutdown).resolves.toEqual({
      pty: result(),
      omp: ompResult(),
    });
    expect(order).toEqual([
      "quiesce",
      "terminate-ptys",
      "shutdown-host",
      "reconcile-exits",
      "terminate-omp",
      "close-orchestration",
    ]);
  });

  it("does not remove exit observers or stores when PTY proof fails", async () => {
    const reconcileOrchestratorExits = vi.fn();
    const terminateAllOmpSessions = vi.fn(async () => ompResult());
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
        terminateAllOmpSessions,
        closeOrchestration,
      }),
    ).rejects.toBeInstanceOf(PhysicalPtyShutdownError);
    expect(reconcileOrchestratorExits).not.toHaveBeenCalled();
    expect(terminateAllOmpSessions).not.toHaveBeenCalled();
    expect(closeOrchestration).not.toHaveBeenCalled();
  });

  it("keeps exit observers and stores alive while durable reconciliation is pending", async () => {
    const terminateAllOmpSessions = vi.fn(async () => ompResult());
    const closeOrchestration = vi.fn(async () => undefined);

    await expect(
      shutdownOrchestrationRuntimesWithProof({
        quiesceOrchestration: async () => undefined,
        terminateAllSessions: async () => result(),
        shutdownPtyHost: vi.fn(),
        reconcileOrchestratorExits: () => false,
        terminateAllOmpSessions,
        closeOrchestration,
      }),
    ).rejects.toThrow(/not durably complete/);
    expect(terminateAllOmpSessions).not.toHaveBeenCalled();
    expect(closeOrchestration).not.toHaveBeenCalled();
  });

  it("retains the registry after OMP failure so the native retry can reconcile again", async () => {
    let registryAlive = true;
    let ompAttempt = 0;
    const reconciledWithLiveRegistry: boolean[] = [];
    const closeOrchestration = vi.fn(async () => {
      registryAlive = false;
    });
    const deps = {
      quiesceOrchestration: async () => undefined,
      terminateAllSessions: async () => result(),
      shutdownPtyHost: vi.fn(),
      reconcileOrchestratorExits: () => {
        reconciledWithLiveRegistry.push(registryAlive);
        return registryAlive;
      },
      terminateAllOmpSessions: async () => {
        ompAttempt += 1;
        return ompAttempt === 1
          ? ompResult({
              ok: false,
              terminatedSessionIds: [],
              failedSessionIds: ["omp-a"],
            })
          : ompResult();
      },
      closeOrchestration,
    };

    await expect(
      shutdownOrchestrationRuntimesWithProof(deps),
    ).rejects.toBeInstanceOf(PhysicalOmpShutdownError);
    expect(registryAlive).toBe(true);
    expect(closeOrchestration).not.toHaveBeenCalled();

    await expect(
      shutdownOrchestrationRuntimesWithProof(deps),
    ).resolves.toEqual({
      pty: result(),
      omp: ompResult(),
    });
    expect(reconciledWithLiveRegistry).toEqual([true, true]);
    expect(closeOrchestration).toHaveBeenCalledOnce();
    expect(registryAlive).toBe(false);
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
